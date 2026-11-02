/**
 * A shell parser for permission checks: command lines in, a syntax tree out.
 *
 * It reads the Bash subset a permission check has to tell apart: lists, pipelines, subshells and groups,
 * `if`, `while`, `until`, `for`, `select`, `case`, function definitions, redirections, here-documents and
 * every kind of substitution. A word keeps its parts (literal text with the quoting it was written in,
 * parameters, substitutions), so analysis reads the structure instead of re-scanning text.
 *
 * Input it cannot trust fails instead of guessing. `parse` never throws: it returns the tree, or the way
 * the parse failed.
 *
 * Limits are Claude Code's: input over 10,000 UTF-16 units, a 50,000-node budget and a 50 ms deadline end the
 * parse as `aborted`. Node costs are calibrated to the two budget probes the behavioral spec reports, not
 * derived, because the original counts nodes of a different tree shape.
 */

/** Longest input the parser reads, in UTF-16 units. */
export const MAX_INPUT = 10_000;
export const MAX_NODES = 50_000;
export const DEADLINE_MS = 50;
const CHECK_EVERY = 128;

export type Quoting = "bare" | "single" | "double" | "escaped" | "ansi";

export type Part =
	| { readonly kind: "text"; readonly text: string; readonly quoting: Quoting }
	| {
			readonly kind: "param";
			/** The name for `$NAME` and `${NAME}`, otherwise empty. */
			readonly name: string;
			/** The text as written, `$NAME` or `${...}`. */
			readonly source: string;
			readonly quoted: boolean;
			/** A `${...}` that is more than a plain name: an operator, an indirection, a slice. */
			readonly complex: boolean;
	  }
	| {
			readonly kind: "substitution";
			readonly form: Substitution;
			readonly body: List | undefined;
			readonly quoted: boolean;
	  };

export type Substitution = "dollar" | "backtick" | "process" | "funsub" | "arith" | "heredoc";

export interface Word {
	readonly parts: readonly Part[];
	/** `{a,b}` or `{1..3}` written outside quotes. */
	readonly brace: boolean;
}

export interface Redirect {
	readonly operator: string;
	readonly target: Word | undefined;
	readonly heredoc?: { readonly delimiter: string; readonly quoted: boolean; readonly body: readonly Part[] };
}

export interface Simple {
	readonly type: "simple";
	readonly words: readonly Word[];
	readonly redirects: readonly Redirect[];
	/** The command as written, trimmed. */
	readonly source: string;
}
export interface Compound {
	readonly type: "subshell" | "group";
	readonly body: List;
	readonly redirects: readonly Redirect[];
}
export interface If {
	readonly type: "if";
	readonly branches: readonly { readonly condition: List; readonly body: List }[];
	readonly otherwise: List | undefined;
	readonly redirects: readonly Redirect[];
}
export interface While {
	readonly type: "while";
	readonly condition: List;
	readonly body: List;
	readonly redirects: readonly Redirect[];
}
export interface For {
	readonly type: "for";
	readonly variable: string;
	readonly items: readonly Word[];
	readonly body: List;
	readonly redirects: readonly Redirect[];
}
export interface Case {
	readonly type: "case";
	readonly subject: Word;
	readonly items: readonly { readonly patterns: readonly Word[]; readonly body: List }[];
	readonly redirects: readonly Redirect[];
}
export interface FunctionDefinition {
	readonly type: "function";
	readonly name: string;
	readonly body: Command;
	readonly redirects: readonly Redirect[];
}
export type Command = Simple | Compound | If | While | For | Case | FunctionDefinition;

export interface Pipeline {
	readonly stages: readonly Command[];
	/** Where each stage starts and ends in the text the pipeline was parsed from. */
	readonly spans: readonly { readonly start: number; readonly stop: number }[];
	/** What follows each stage but the last: `|` or `|&`. */
	readonly operators: readonly string[];
	readonly negated: boolean;
}

export interface AndOr {
	readonly first: Pipeline;
	readonly rest: readonly { readonly operator: "&&" | "||"; readonly pipeline: Pipeline }[];
}

export interface Item {
	readonly chain: AndOr;
	/** What ended the item: `;`, `&`, a newline, or nothing at the end of the input. */
	readonly end: ";" | "&" | "\n" | "";
	/** Where the item's source starts and ends in the text it was parsed from. */
	readonly start: number;
	readonly stop: number;
}

export interface List {
	readonly items: readonly Item[];
	readonly source: string;
}

export type ParseFailure = "aborted" | "error";
export type ParseResult =
	| { readonly ok: true; readonly root: List; readonly substitutions: number; readonly funsubDeclares: boolean }
	| { readonly ok: false; readonly failure: ParseFailure; readonly reason: string };

export interface ParseOptions {
	readonly now?: () => number;
	readonly maxNodes?: number;
}

class Failure extends Error {
	readonly failure: ParseFailure;
	readonly reason: string;

	constructor(failure: ParseFailure, reason: string) {
		super(reason);
		this.failure = failure;
		this.reason = reason;
	}
}

const RESERVED = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"for",
	"select",
	"case",
	"esac",
	"in",
	"{",
	"}",
	"!",
	"time",
	"function",
]);
const CLOSING = new Set(["then", "else", "elif", "fi", "do", "done", "esac", "}"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METACHARACTER = /[ \t\n;&|()<>]/;
const DECLARATION = /^(?:export|local|readonly|declare|typeset)$/;

interface Budget {
	nodes: number;
	readonly limit: number;
	readonly deadline: number;
	readonly now: () => number;
	substitutions: number;
	funsubDeclares: boolean;
}

function cost(budget: Budget, nodes: number): void {
	const before = budget.nodes;
	budget.nodes += nodes;
	if (budget.nodes > budget.limit) throw new Failure("aborted", "node budget");
	if (Math.floor(before / CHECK_EVERY) !== Math.floor(budget.nodes / CHECK_EVERY) && budget.now() > budget.deadline)
		throw new Failure("aborted", "deadline");
}

/** Parse a command line. Never throws. */
export function parse(source: string, options: ParseOptions = {}): ParseResult {
	if (source.length > MAX_INPUT) return { ok: false, failure: "aborted", reason: "over-length" };
	const now = options.now ?? (() => performance.now());
	const budget: Budget = {
		nodes: 0,
		limit: options.maxNodes ?? MAX_NODES,
		deadline: now() + DEADLINE_MS,
		now,
		substitutions: 0,
		funsubDeclares: false,
	};
	try {
		const parser = new Parser(source, budget, 0);
		const root = parser.script();
		return { ok: true, root, substitutions: budget.substitutions, funsubDeclares: budget.funsubDeclares };
	} catch (error) {
		if (error instanceof Failure) return { ok: false, failure: error.failure, reason: error.reason };
		if (error instanceof RangeError) return { ok: false, failure: "aborted", reason: "nesting" };
		throw error;
	}
}

/** A parse of a text nested inside the command line, such as a here-document body or an `eval` string. */
export function parseNested(source: string, budget: Budget, base: number): List {
	return new Parser(source, budget, base).script();
}

class Parser {
	private at = 0;
	private readonly pending: { delimiter: string; quoted: boolean; body: Part[] }[] = [];
	private readonly inBacktick: boolean;
	private readonly text: string;
	private readonly budget: Budget;
	private readonly depth: number;

	constructor(text: string, budget: Budget, depth: number, backtick = false) {
		this.text = text;
		this.budget = budget;
		this.depth = depth;
		this.inBacktick = backtick;
	}

	script(): List {
		const list = this.list(undefined);
		this.skipBlanks();
		if (this.at < this.text.length) throw new Failure("error", "unconsumed input");
		return list;
	}

	/** Items up to a closing token. `stop` is the reserved word or character that ends the list. */
	private list(stop: ")" | "}" | "reserved" | undefined): List {
		const items: Item[] = [];
		const begin = this.at;
		for (;;) {
			this.skipSeparatorsAndComments();
			if (this.at >= this.text.length) break;
			if (stop === ")" && this.peek() === ")") break;
			if (stop === "reserved" && this.atClosingWord()) break;
			if (stop === "}" && this.atClosingWord()) break;
			const start = this.at;
			const chain = this.andOr();
			const stopAt = this.at;
			this.skipBlanks();
			let end: Item["end"] = "";
			const char = this.peek();
			if (char === ";" && this.text[this.at + 1] !== ";") {
				this.at++;
				end = ";";
			} else if (char === "&" && this.text[this.at + 1] !== "&") {
				this.at++;
				end = "&";
			} else if (char === "\n") {
				this.at++;
				this.readHeredocs();
				end = "\n";
			}
			cost(this.budget, 1);
			items.push({ chain, end, start, stop: stopAt });
			if (end === "") {
				this.skipBlanks();
				break;
			}
		}
		return { items, source: this.text.slice(begin, this.at) };
	}

	private andOr(): AndOr {
		const first = this.pipeline();
		const rest: { operator: "&&" | "||"; pipeline: Pipeline }[] = [];
		for (;;) {
			this.skipBlanks();
			const operator = this.text.startsWith("&&", this.at)
				? "&&"
				: this.text.startsWith("||", this.at)
					? "||"
					: undefined;
			if (operator === undefined) break;
			this.at += 2;
			this.skipSeparatorsAndComments(false);
			rest.push({ operator, pipeline: this.pipeline() });
		}
		return { first, rest };
	}

	private pipeline(): Pipeline {
		this.skipBlanks();
		let negated = false;
		for (;;) {
			const word = this.peekReserved();
			if (word === "!") {
				negated = !negated;
				this.at++;
				this.skipBlanks();
			} else if (word === "time") {
				this.at += 4;
				this.skipBlanks();
				while (this.text[this.at] === "-" && /\s/.test(this.text[this.at + 2] ?? " ")) {
					this.at += 2;
					this.skipBlanks();
				}
			} else break;
		}
		const stages: Command[] = [];
		const spans: { start: number; stop: number }[] = [];
		const operators: string[] = [];
		const stage = (): void => {
			this.skipBlanks();
			const start = this.at;
			stages.push(this.command());
			spans.push({ start, stop: this.at });
		};
		stage();
		for (;;) {
			this.skipBlanks();
			const char = this.peek();
			if (char === "|" && this.text[this.at + 1] !== "|") {
				const operator = this.text[this.at + 1] === "&" ? "|&" : "|";
				this.at += operator.length;
				operators.push(operator);
				this.skipSeparatorsAndComments(false);
				stage();
			} else break;
		}
		return { stages, spans, operators, negated };
	}

	private command(): Command {
		if (this.depth > 100) throw new Failure("aborted", "nesting");
		this.skipBlanks();
		const char = this.peek();
		if (char === "(" && this.text[this.at + 1] === "(") return this.arithmeticCommand();
		if (char === "(") {
			this.at++;
			const body = this.list(")");
			this.expect(")");
			cost(this.budget, 2);
			return { type: "subshell", body, redirects: this.redirects() };
		}
		const reserved = this.peekReserved();
		switch (reserved) {
			case "{": {
				this.at++;
				const body = this.list("}");
				this.expectWord("}");
				cost(this.budget, 2);
				return { type: "group", body, redirects: this.redirects() };
			}
			case "if":
				return this.ifCommand();
			case "while":
			case "until":
				return this.whileCommand(reserved);
			case "for":
			case "select":
				return this.forCommand(reserved);
			case "case":
				return this.caseCommand();
			case "function":
				return this.functionKeyword();
			default:
				if (reserved !== undefined && CLOSING.has(reserved)) throw new Failure("error", `unexpected ${reserved}`);
		}
		const definition = this.tryFunctionDefinition();
		if (definition) return definition;
		return this.simple();
	}

	private ifCommand(): If {
		this.at += 2;
		const branches: { condition: List; body: List }[] = [];
		let otherwise: List | undefined;
		let condition = this.list("reserved");
		this.expectWord("then");
		let body = this.list("reserved");
		branches.push({ condition, body });
		for (;;) {
			const word = this.peekReserved();
			if (word === "elif") {
				this.at += 4;
				condition = this.list("reserved");
				this.expectWord("then");
				body = this.list("reserved");
				branches.push({ condition, body });
			} else if (word === "else") {
				this.at += 4;
				otherwise = this.list("reserved");
			} else break;
		}
		this.expectWord("fi");
		cost(this.budget, 3);
		return { type: "if", branches, otherwise, redirects: this.redirects() };
	}

	private whileCommand(word: "while" | "until"): While {
		this.at += word.length;
		const condition = this.list("reserved");
		this.expectWord("do");
		const body = this.list("reserved");
		this.expectWord("done");
		cost(this.budget, 3);
		return { type: "while", condition, body, redirects: this.redirects() };
	}

	private forCommand(word: "for" | "select"): For {
		this.at += word.length;
		this.skipBlanks();
		const variable = this.bareWord();
		if (variable === undefined || !NAME.test(variable)) throw new Failure("error", "for variable");
		this.skipBlanks();
		const items: Word[] = [];
		if (this.peekReserved() === "in") {
			this.at += 2;
			for (;;) {
				this.skipBlanks();
				const char = this.peek();
				if (char === undefined || char === ";" || char === "\n") break;
				items.push(this.word());
			}
		}
		this.skipSeparatorsAndComments();
		this.expectWord("do");
		const body = this.list("reserved");
		this.expectWord("done");
		cost(this.budget, 3);
		return { type: "for", variable, items, body, redirects: this.redirects() };
	}

	private caseCommand(): Case {
		this.at += 4;
		this.skipBlanks();
		const subject = this.word();
		this.skipSeparatorsAndComments();
		this.expectWord("in");
		const items: { patterns: Word[]; body: List }[] = [];
		for (;;) {
			this.skipSeparatorsAndComments();
			if (this.peekReserved() === "esac") break;
			if (this.peek() === "(") this.at++;
			const patterns: Word[] = [];
			for (;;) {
				this.skipBlanks();
				patterns.push(this.word());
				this.skipBlanks();
				if (this.peek() === "|") this.at++;
				else break;
			}
			this.expect(")");
			const body = this.caseBody();
			cost(this.budget, 2);
			items.push({ patterns, body });
			this.skipBlanks();
			if (this.text.startsWith(";;&", this.at) || this.text.startsWith(";&", this.at))
				this.at += this.text[this.at + 2] === "&" ? 3 : 2;
			else if (this.text.startsWith(";;", this.at)) this.at += 2;
			else if (this.peekReserved() !== "esac") throw new Failure("error", "case item end");
		}
		this.expectWord("esac");
		cost(this.budget, 3);
		return { type: "case", subject, items, redirects: this.redirects() };
	}

	/** A case item's commands, which end at `;;`, `;&`, `;;&` or `esac`. */
	private caseBody(): List {
		const items: Item[] = [];
		const begin = this.at;
		for (;;) {
			this.skipSeparatorsAndComments();
			if (
				this.at >= this.text.length ||
				this.text.startsWith(";;", this.at) ||
				this.text.startsWith(";&", this.at) ||
				this.peekReserved() === "esac"
			)
				break;
			const start = this.at;
			const chain = this.andOr();
			const stop = this.at;
			this.skipBlanks();
			let end: Item["end"] = "";
			if (this.peek() === ";" && this.text[this.at + 1] !== ";" && this.text[this.at + 1] !== "&") {
				this.at++;
				end = ";";
			} else if (this.peek() === "&" && this.text[this.at + 1] !== "&") {
				this.at++;
				end = "&";
			} else if (this.peek() === "\n") {
				this.at++;
				this.readHeredocs();
				end = "\n";
			}
			cost(this.budget, 1);
			items.push({ chain, end, start, stop });
			if (end === "") break;
		}
		return { items, source: this.text.slice(begin, this.at) };
	}

	private functionKeyword(): FunctionDefinition {
		this.at += 8;
		this.skipBlanks();
		const name = this.bareWord();
		if (name === undefined || name === "") throw new Failure("error", "function name");
		this.skipBlanks();
		if (this.peek() === "(" && this.text[this.at + 1] === ")") this.at += 2;
		this.skipSeparatorsAndComments();
		cost(this.budget, 3);
		return { type: "function", name, body: this.command(), redirects: [] };
	}

	private tryFunctionDefinition(): FunctionDefinition | undefined {
		const save = this.at;
		const name = this.bareWord();
		if (name !== undefined && name !== "" && !/[$`'"\\]/.test(name)) {
			this.skipBlanks();
			if (this.peek() === "(" && /^\(\s*\)/.test(this.text.slice(this.at, this.at + 64))) {
				this.at = this.text.indexOf(")", this.at) + 1;
				this.skipSeparatorsAndComments();
				cost(this.budget, 3);
				return { type: "function", name, body: this.command(), redirects: [] };
			}
		}
		this.at = save;
		return undefined;
	}

	private arithmeticCommand(): Simple {
		const open = this.at;
		let level = 0;
		for (let index = open; index < this.text.length; index++) {
			const char = this.text[index];
			if (char === "(") level++;
			else if (char === ")" && --level === 0) {
				if (this.text[index - 1] !== ")") break;
				this.at = index + 1;
				cost(this.budget, 3);
				const raw = this.text.slice(open, this.at);
				const nested = this.nestedSubstitutions(this.text.slice(open + 2, index - 1));
				if (nested.length === 0)
					nested.push({ kind: "substitution", form: "arith", body: undefined, quoted: false });
				return {
					type: "simple",
					source: raw,
					words: [
						{
							parts: [...nested, { kind: "text", text: raw, quoting: "bare" }],
							brace: false,
						},
					],
					redirects: this.redirects(),
				};
			}
		}
		throw new Failure("error", "arithmetic command");
	}

	private simple(): Simple {
		const begin = this.at;
		const words: Word[] = [];
		const redirects: Redirect[] = [];
		for (;;) {
			this.skipBlanks();
			const char = this.peek();
			if (char === undefined || ";&|)\n".includes(char)) break;
			if (char === "(") throw new Failure("error", "unexpected (");
			if (words.length === 0 && this.atClosingWord()) break;
			if (this.atRedirect()) {
				redirects.push(this.redirect());
				continue;
			}
			words.push(this.word());
			cost(this.budget, 2);
			if (words.length === 1 && this.isConditional(words[0] as Word)) this.conditionalRest(words);
		}
		if (words.length === 0 && redirects.length === 0) throw new Failure("error", "empty command");
		cost(this.budget, 1);
		return { type: "simple", words, redirects, source: this.text.slice(begin, this.at).trim() };
	}

	/** At `<`, `>` or `N<` that starts a redirection, not a process substitution. */
	private atRedirect(): boolean {
		const char = this.peek();
		if (char === "<" || char === ">") return this.text[this.at + 1] !== "(";
		return /^[0-9]+[<>]/.test(this.text.slice(this.at, this.at + 8));
	}

	private isConditional(word: Word): boolean {
		const only = word.parts.length === 1 ? word.parts[0] : undefined;
		return only?.kind === "text" && only.quoting === "bare" && only.text === "[[";
	}

	/** Inside `[[ ]]`: operators are words, and words run to the closing `]]`. */
	private conditionalRest(words: Word[]): void {
		for (;;) {
			this.skipBlanksAndNewlines();
			if (this.at >= this.text.length) throw new Failure("error", "unterminated [[");
			if (this.text.startsWith("]]", this.at) && /[\s;&|)]|$/.test(this.text[this.at + 2] ?? " ")) {
				this.at += 2;
				words.push({ parts: [{ kind: "text", text: "]]", quoting: "bare" }], brace: false });
				return;
			}
			const char = this.peek() as string;
			if (char === "(" || char === ")" || char === "<" || char === ">" || char === "&" || char === "|") {
				const length = this.text.startsWith("&&", this.at) || this.text.startsWith("||", this.at) ? 2 : 1;
				words.push({
					parts: [{ kind: "text", text: this.text.slice(this.at, this.at + length), quoting: "bare" }],
					brace: false,
				});
				this.at += length;
			} else words.push(this.word(true));
			cost(this.budget, 2);
		}
	}

	private redirects(): Redirect[] {
		const redirects: Redirect[] = [];
		for (;;) {
			this.skipBlanks();
			if (this.atRedirect()) redirects.push(this.redirect());
			else break;
		}
		return redirects;
	}

	private redirect(): Redirect {
		const start = this.at;
		while (/[0-9]/.test(this.text[this.at] ?? "")) this.at++;
		while (
			this.text[this.at] === "<" ||
			this.text[this.at] === ">" ||
			this.text[this.at] === "&" ||
			this.text[this.at] === "|"
		) {
			const next = this.text[this.at] as string;
			this.at++;
			if (next === "&" || next === "|") break;
			if (
				this.text[this.at] !== next &&
				this.text[this.at] !== "&" &&
				this.text[this.at] !== "|" &&
				this.text[this.at] !== ">"
			)
				break;
		}
		const operator = this.text.slice(start, this.at).replace(/^[0-9]+/, "");
		if (operator === "") throw new Failure("error", "redirect");
		this.skipBlanks();
		cost(this.budget, 2);
		if (operator === "<<<" || !operator.startsWith("<<")) {
			if (this.at >= this.text.length || METACHARACTER.test(this.text[this.at] as string))
				throw new Failure("error", "redirect target");
			return { operator, target: this.word() };
		}
		const begin = this.at;
		const delimiterWord = this.word();
		const raw = this.text.slice(begin, this.at);
		const quoted = /['"\\]/.test(raw);
		if (operator === "<<-") throw new Failure("aborted", "tab-stripped heredoc");
		if (quoted && /[`$\n]/.test(raw)) throw new Failure("aborted", "heredoc delimiter");
		if (this.inBacktick) throw new Failure("aborted", "heredoc in backticks");
		const delimiter = delimiterWord.parts
			.map((part) => (part.kind === "text" ? part.text : part.kind === "param" ? part.source : ""))
			.join("");
		if (/[\ud800-\udfff]/.test(delimiter)) throw new Failure("aborted", "astral heredoc delimiter");
		const body: Part[] = [];
		this.pending.push({ delimiter, quoted, body });
		return { operator, target: delimiterWord, heredoc: { delimiter, quoted, body } };
	}

	/** At a newline that ends a command line: read the bodies of the here-documents it opened. */
	private readHeredocs(): void {
		for (const pending of this.pending.splice(0)) {
			const lines: string[] = [];
			let found = false;
			while (this.at <= this.text.length) {
				const newline = this.text.indexOf("\n", this.at);
				const line = this.text.slice(this.at, newline === -1 ? this.text.length : newline);
				this.at = newline === -1 ? this.text.length + 1 : newline + 1;
				if (line === pending.delimiter) {
					found = true;
					break;
				}
				lines.push(line);
				if (newline === -1) break;
			}
			if (!found) throw new Failure("aborted", "heredoc terminator");
			if (this.at > this.text.length) this.at = this.text.length;
			if (!pending.quoted)
				pending.body.push(...this.heredocParts(lines.join("\n") + (lines.length > 0 ? "\n" : "")));
		}
	}

	private heredocParts(body: string): Part[] {
		const parts: Part[] = [];
		const inner = new Parser(body, this.budget, this.depth + 1, this.inBacktick);
		let literal = "";
		const flush = (): void => {
			if (literal !== "") parts.push({ kind: "text", text: literal, quoting: "bare" });
			literal = "";
		};
		while (inner.at < body.length) {
			const char = body[inner.at] as string;
			if (char === "\\" && inner.at + 1 < body.length) {
				literal += body.slice(inner.at, inner.at + 2);
				inner.at += 2;
			} else if (char === "$" || char === "`") {
				flush();
				parts.push(...inner.dollarOrBacktick(true, "heredoc"));
			} else {
				literal += char;
				inner.at++;
			}
		}
		flush();
		return parts;
	}

	/** A word of plain characters, for names. */
	private bareWord(): string | undefined {
		const start = this.at;
		while (
			this.at < this.text.length &&
			!METACHARACTER.test(this.text[this.at] as string) &&
			!"'\"".includes(this.text[this.at] as string)
		) {
			if (this.text[this.at] === "$" || this.text[this.at] === "`") break;
			this.at++;
		}
		return this.at === start ? undefined : this.text.slice(start, this.at);
	}

	private word(inConditional = false): Word {
		const parts: Part[] = [];
		let brace = false;
		let literal = "";
		const flush = (quoting: Quoting = "bare"): void => {
			if (literal !== "") parts.push({ kind: "text", text: literal, quoting });
			literal = "";
		};
		const start = this.at;
		while (this.at < this.text.length) {
			const char = this.text[this.at] as string;
			if (METACHARACTER.test(char)) {
				if ((char === "<" || char === ">") && this.text[this.at + 1] === "(") {
					flush();
					parts.push(this.processSubstitution());
					continue;
				}
				if (
					inConditional &&
					(char === "<" || char === ">" || char === "(" || char === ")" || char === "&" || char === "|")
				)
					break;
				break;
			}
			if (char === "\\") {
				if (this.text[this.at + 1] === "\n") {
					this.at += 2;
					continue;
				}
				flush();
				if (this.at + 1 < this.text.length)
					parts.push({ kind: "text", text: this.text[this.at + 1] as string, quoting: "escaped" });
				this.at += 2;
			} else if (char === "'") {
				flush();
				const close = this.text.indexOf("'", this.at + 1);
				if (close === -1) throw new Failure("error", "unterminated quote");
				parts.push({ kind: "text", text: this.text.slice(this.at + 1, close), quoting: "single" });
				this.at = close + 1;
			} else if (char === '"') {
				flush();
				this.at++;
				this.doubleQuoted(parts);
			} else if (char === "$" || char === "`") {
				flush();
				parts.push(...this.dollarOrBacktick(false));
			} else if (char === "#" && this.at === start) {
				break;
			} else {
				if (char === "{") {
					const close = this.text.indexOf("}", this.at);
					if (
						close !== -1 &&
						!/[\s]/.test(this.text.slice(this.at, close)) &&
						/,|\.\./.test(this.text.slice(this.at, close))
					)
						brace = true;
				}
				literal += char;
				this.at++;
			}
		}
		flush();
		if (parts.length === 0 && this.at === start) throw new Failure("error", "empty word");
		return { parts, brace };
	}

	private doubleQuoted(parts: Part[]): void {
		const before = parts.length;
		let literal = "";
		const flush = (): void => {
			if (literal !== "") parts.push({ kind: "text", text: literal, quoting: "double" });
			literal = "";
		};
		for (;;) {
			if (this.at >= this.text.length) throw new Failure("error", "unterminated quote");
			const char = this.text[this.at] as string;
			if (char === '"') {
				this.at++;
				break;
			}
			const next = this.text[this.at + 1];
			if (char === "\\" && next !== undefined) {
				if (next === "\n") this.at += 2;
				else if ('$`"\\'.includes(next)) {
					flush();
					parts.push({ kind: "text", text: next, quoting: "escaped" });
					this.at += 2;
				} else {
					literal += char;
					this.at++;
				}
			} else if (char === "$" || char === "`") {
				flush();
				parts.push(...this.dollarOrBacktick(true));
			} else {
				literal += char;
				this.at++;
			}
		}
		flush();
		if (parts.length === before) parts.push({ kind: "text", text: "", quoting: "double" });
	}

	private dollarOrBacktick(quoted: boolean, form?: "heredoc"): Part[] {
		const char = this.text[this.at];
		if (char === "`") return [this.backtick(quoted, form)];
		const next = this.text[this.at + 1];
		if (next === "(") {
			if (this.text[this.at + 2] === "(") return this.arithmetic(quoted);
			this.at += 2;
			return [this.substitution("dollar", quoted, form)];
		}
		if (next === "{") return this.braced(quoted, form);
		if (next === "'" && !quoted) {
			const close = this.closingQuote(this.at + 2);
			const text = this.text.slice(this.at + 2, close);
			this.at = close + 1;
			return [{ kind: "text", text: `$${text}`, quoting: "ansi" }];
		}
		if (next === '"' && !quoted) {
			this.at++;
			return [];
		}
		const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*?$!#-])/.exec(this.text.slice(this.at + 1, this.at + 258));
		if (name) {
			this.at += 1 + name[0].length;
			cost(this.budget, 14);
			return [{ kind: "param", name: name[0], source: `$${name[0]}`, quoted, complex: false }];
		}
		this.at++;
		return [{ kind: "text", text: "$", quoting: quoted ? "double" : "bare" }];
	}

	private closingQuote(from: number): number {
		for (let index = from; index < this.text.length; index++) {
			if (this.text[index] === "\\") index++;
			else if (this.text[index] === "'") return index;
		}
		throw new Failure("error", "unterminated $'");
	}

	private arithmetic(quoted: boolean): Part[] {
		const open = this.at + 1;
		let level = 0;
		for (let index = open; index < this.text.length; index++) {
			const char = this.text[index];
			if (char === "(") level++;
			else if (char === ")" && --level === 0) {
				if (this.text[index - 1] === ")" && index - 1 > open + 1) {
					this.at = index + 1;
					cost(this.budget, 3);
					const nested = this.nestedSubstitutions(this.text.slice(open + 2, index - 1));
					return nested.length > 0 ? nested : [{ kind: "substitution", form: "arith", body: undefined, quoted }];
				}
				break;
			}
		}
		// Not arithmetic: a command substitution that opens with a subshell.
		this.at += 2;
		return [this.substitution("dollar", quoted)];
	}

	private substitution(form: Substitution, quoted: boolean, kind?: "heredoc"): Part {
		this.budget.substitutions++;
		cost(this.budget, 4);
		const inner = new Parser(this.text, this.budget, this.depth + 1, this.inBacktick);
		inner.at = this.at;
		const body = inner.list(")");
		inner.skipBlanks();
		if (inner.peek() !== ")") throw new Failure("error", "unterminated substitution");
		this.at = inner.at + 1;
		return { kind: "substitution", form: kind ?? form, body, quoted };
	}

	private processSubstitution(): Part {
		this.at += 2;
		return this.substitution("process", false);
	}

	private backtick(quoted: boolean, form?: "heredoc"): Part {
		let index = this.at + 1;
		let body = "";
		for (; index < this.text.length; index++) {
			const char = this.text[index] as string;
			if (char === "\\") {
				const next = this.text[index + 1];
				if (next === "`" || next === "\\" || next === "$") {
					body += next;
					index++;
				} else if (next === undefined) body += char;
				else body += char;
			} else if (char === "`") break;
			else body += char;
		}
		if (index >= this.text.length) throw new Failure("error", "unterminated backtick");
		this.at = index + 1;
		if (body.trim() === "") throw new Failure("aborted", "empty backtick body");
		if (/\\`/.test(this.text.slice(this.at - body.length - 2, this.at)))
			throw new Failure("aborted", "escaped backtick");
		this.budget.substitutions++;
		cost(this.budget, 4);
		const inner = new Parser(body, this.budget, this.depth + 1, true);
		return { kind: "substitution", form: form ?? "backtick", body: inner.script(), quoted };
	}

	private braced(quoted: boolean, form?: "heredoc"): Part[] {
		const open = this.at;
		const lead = this.text[open + 2];
		if (lead === " " || lead === "\t" || lead === "\n" || lead === "|") {
			this.at += 2;
			if (lead === "|") this.at++;
			this.budget.substitutions++;
			cost(this.budget, 4);
			const inner = new Parser(this.text, this.budget, this.depth + 1, this.inBacktick);
			inner.at = this.at;
			const body = inner.list("}");
			inner.skipBlanks();
			if (inner.peek() !== "}") throw new Failure("error", "unterminated ${ ");
			if (declares(body)) this.budget.funsubDeclares = true;
			this.at = inner.at + 1;
			return [{ kind: "substitution", form: form ?? "funsub", body, quoted }];
		}
		let level = 0;
		let index = open + 1;
		for (; index < this.text.length; index++) {
			const char = this.text[index] as string;
			if (char === "\\") index++;
			else if (char === "'" && !quoted) {
				const close = this.text.indexOf("'", index + 1);
				if (close === -1) throw new Failure("error", "unterminated ${");
				index = close;
			} else if (char === "{") level++;
			else if (char === "}" && --level === 0) break;
		}
		if (index >= this.text.length) throw new Failure("error", "unterminated ${");
		const source = this.text.slice(open, index + 1);
		this.at = index + 1;
		cost(this.budget, 14);
		const plain = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(source);
		const operand = /^\$\{(?:[!#])?([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}$/.exec(source);
		const nested = this.nestedSubstitutions(source);
		if (nested.length > 0) return nested;
		return [
			{
				kind: "param",
				name: plain ? (plain[1] as string) : (operand?.[1] ?? ""),
				source,
				quoted,
				complex: !plain,
			},
		];
	}

	/** Executable substitutions nested inside a parameter or arithmetic operand. */
	private nestedSubstitutions(source: string): Part[] {
		if (!/\$\(|`/.test(source)) return [];
		const inner = new Parser(source, this.budget, this.depth + 1, this.inBacktick);
		const found: Part[] = [];
		while (inner.at < source.length) {
			const char = source[inner.at];
			if (char === "\\") inner.at += 2;
			else if (char === "'") inner.at = Math.max(inner.at, source.indexOf("'", inner.at + 1)) + 1;
			else if ((char === "$" && source[inner.at + 1] === "(") || char === "`") {
				found.push(...inner.dollarOrBacktick(false));
			} else inner.at++;
		}
		return found;
	}

	private peek(): string | undefined {
		return this.text[this.at];
	}

	private skipBlanks(): void {
		for (;;) {
			const char = this.text[this.at];
			if (char === " " || char === "\t") this.at++;
			else if (char === "\\" && this.text[this.at + 1] === "\n") this.at += 2;
			else break;
		}
	}

	private skipBlanksAndNewlines(): void {
		for (;;) {
			this.skipBlanks();
			if (this.text[this.at] === "\n") {
				this.at++;
				this.readHeredocs();
			} else break;
		}
	}

	private skipSeparatorsAndComments(allowSemicolon = true): void {
		for (;;) {
			this.skipBlanks();
			const char = this.text[this.at];
			if (char === "\n") {
				this.at++;
				this.readHeredocs();
			} else if (char === ";" && allowSemicolon && this.text[this.at + 1] !== ";" && this.text[this.at + 1] !== "&")
				this.at++;
			else if (char === "#") {
				const newline = this.text.indexOf("\n", this.at);
				this.at = newline === -1 ? this.text.length : newline;
			} else break;
		}
	}

	private peekReserved(): string | undefined {
		const match = /^(?:[a-z]+|\{|\}|!)(?=[ \t\n;&|()<>]|$)/.exec(this.text.slice(this.at, this.at + 10));
		return match && RESERVED.has(match[0]) ? match[0] : undefined;
	}

	private atClosingWord(): boolean {
		const word = this.peekReserved();
		return word !== undefined && CLOSING.has(word);
	}

	private expect(char: string): void {
		this.skipBlanks();
		if (this.text[this.at] !== char) throw new Failure("error", `expected ${char}`);
		this.at++;
	}

	private expectWord(word: string): void {
		this.skipSeparatorsAndComments();
		if (this.peekReserved() !== word) throw new Failure("error", `expected ${word}`);
		this.at += word.length;
	}
}

/** Whether a list declares a variable with `export`, `local`, `readonly`, `declare` or `typeset` anywhere in it. */
function declares(list: List): boolean {
	let found = false;
	walkSimple(list, (command) => {
		const head = command.words[0];
		const text = head === undefined ? "" : wordText(head);
		if (DECLARATION.test(text) && command.words.slice(1).some((word) => /^[A-Za-z_]\w*=/.test(wordText(word))))
			found = true;
	});
	return found;
}

function wordText(word: Word): string {
	return word.parts
		.map((part) => (part.kind === "text" ? part.text : part.kind === "param" ? part.source : ""))
		.join("");
}

/** Visit every simple command in a list, compound bodies included, substitutions excluded. */
export function walkSimple(list: List, visit: (command: Simple) => void): void {
	const walkCommand = (command: Command): void => {
		switch (command.type) {
			case "simple":
				visit(command);
				break;
			case "subshell":
			case "group":
				walkSimple(command.body, visit);
				break;
			case "if":
				for (const branch of command.branches) {
					walkSimple(branch.condition, visit);
					walkSimple(branch.body, visit);
				}
				if (command.otherwise) walkSimple(command.otherwise, visit);
				break;
			case "while":
				walkSimple(command.condition, visit);
				walkSimple(command.body, visit);
				break;
			case "for":
				walkSimple(command.body, visit);
				break;
			case "case":
				for (const item of command.items) walkSimple(item.body, visit);
				break;
			case "function":
				walkCommand(command.body);
				break;
		}
	};
	for (const item of list.items) {
		for (const pipeline of [item.chain.first, ...item.chain.rest.map((entry) => entry.pipeline)]) {
			for (const stage of pipeline.stages) walkCommand(stage);
		}
	}
}
