/**
 * What a parsed command line does to shell variables, read as Claude Code's removal check reads it.
 *
 * `commandsOf` walks the tree in execution order and yields every simple command with the variable
 * values it can be followed to and the names it knows are assigned. Where that knowledge comes from is a
 * table of contexts, not scattered conditions. A context decides whether a value is followed into a
 * command, whether an assignment counts as made, and which operators undo it.
 *
 * Invariant: when this model is unsure what a variable holds, the value is `null` and a removal target
 * that uses it is refused.
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import type { Command, List, Part, Pipeline, Simple, Substitution, Word as SyntaxWord } from "./shell-syntax.ts";

/** A word as the removal check reads it: its text with substitutions as a marker, and where its `$` signs are literal. */
export interface Word {
	readonly text: string;
	readonly literalDollars?: readonly number[];
	/** Offsets of `$` signs written inside double quotes. */
	readonly quotedDollars?: readonly number[];
	/** The word held a quote, escape, `$`, backtick or substitution, so its text is not what the source said. */
	readonly decorated?: true;
}

/** What the line has set a variable to by the time a command runs: its text, or `null` when unknowable. */
export type Variables = ReadonlyMap<string, string | null>;

export interface SimpleCommand {
	readonly words: readonly Word[];
	/** The command as written, for the messages that quote it. */
	readonly text: string;
	/** Values Claude Code can follow here, empty when something in the line stops it following any. */
	readonly variables: Variables;
	/** Variables an earlier command in the line gave a non-empty literal value, wherever they were set. */
	readonly assigned: ReadonlySet<string>;
	readonly substitution?: true;
	/** Inside a function body or a case item, which Claude Code reads only for variable-root targets, never for literal ones. */
	readonly opaque?: true;
	/** What the stage before this command's `|` was, for a pipeline Claude Code splits into parts instead of reading whole. */
	readonly pipedFrom?: "assignment" | "declaration";
}

export const SUBSTITUTION = "__CMDSUB__";
/** Stands for a `$` a value wrote literally (`'$HOME'`, `\$HOME`), so a target that follows the value does not expand it. */
export const LITERAL_DOLLAR = "\uE000";
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const DECLARATIONS = new Set(["export", "local", "readonly", "declare", "typeset"]);

/** Where a command runs, which decides what Claude Code does with the variables set around it. */
type Context = "line" | "body" | "case" | "dollar" | "process" | "blind";

interface Policy {
	/** An assignment made here counts as made for the commands after it. */
	readonly counts: boolean;
	/** A `||` after an assignment undoes it. */
	readonly orUndoes: boolean;
}

const POLICY: Readonly<Record<Context, Policy>> = {
	line: { counts: true, orUndoes: false },
	body: { counts: true, orUndoes: false },
	case: { counts: false, orUndoes: false },
	dollar: { counts: true, orUndoes: true },
	process: { counts: true, orUndoes: false },
	blind: { counts: false, orUndoes: false },
};

const CONTEXT_OF: Readonly<Record<Substitution, Context>> = {
	dollar: "dollar",
	backtick: "blind",
	process: "process",
	funsub: "blind",
	heredoc: "blind",
	arith: "blind",
};

/** Operators after which the names the command before them assigned are not set. */
const UNDOING: ReadonlySet<string> = new Set(["|", "|&", "&"]);
const UNSAFE_WORD = /[ \t\n*?[]/;
/** Variables Claude Code reads in double quotes without knowing the value. */
const ALWAYS_SET = new Set([
	"HOME",
	"PWD",
	"OLDPWD",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"HOSTNAME",
	"UID",
	"EUID",
	"PPID",
	"RANDOM",
	"SECONDS",
	"LINENO",
	"TMPDIR",
	"BASH_VERSION",
	"BASHPID",
	"SHLVL",
	"HISTFILE",
	"IFS",
]);

/** The text and literal-dollar offsets a word reads as. */
export function flatten(word: SyntaxWord): Word {
	let text = "";
	const literalDollars: number[] = [];
	const quotedDollars: number[] = [];
	let decorated = false;
	for (const part of word.parts) {
		if (part.kind === "text") {
			if (part.quoting !== "bare") decorated = true;
			if (part.quoting === "single" || part.quoting === "escaped")
				for (let index = 0; index < part.text.length; index++)
					if (part.text[index] === "$") literalDollars.push(text.length + index);
			text += part.text;
		} else if (part.kind === "param") {
			decorated = true;
			if (part.quoted) quotedDollars.push(text.length);
			text += part.source;
		} else {
			decorated = true;
			text += SUBSTITUTION;
		}
	}
	return { text, literalDollars, quotedDollars, ...(decorated ? { decorated: true as const } : {}) };
}

export interface FlowOptions {
	readonly home?: string;
	/** What an enclosing line had set, for a script it hands to a shell or `eval`. */
	readonly inherited?: Pick<SimpleCommand, "variables" | "assigned">;
}

interface Found {
	command: SimpleCommand;
	/** Written on the line itself, not inside a substitution. */
	own: boolean;
	top: boolean;
	uncertain: Variables;
}

/** Every simple command of a parsed line in execution order, a substitution's commands ahead of the command that holds it. */
export function commandsOf(root: List, options: FlowOptions = {}): { commands: SimpleCommand[]; pipeBars: number[] } {
	const flow = new Flow(options, root.source);
	return { commands: flow.run(root), pipeBars: flow.pipeBars };
}

class Flow {
	private readonly home: string;
	private readonly found: Found[] = [];
	/** Set when the line holds something that stops Claude Code following any value. */
	private untrackable = false;
	private subshelled = false;
	private values: Map<string, string | null> = new Map();
	private assigned: Set<string> = new Set();
	private assignedStart: Set<string> = new Set();
	private commands = 0;
	private orList = false;
	private inPipeline = false;
	private pipelineStart: Map<string, string | null> = new Map();
	private stageAssigned: Set<string> = new Set();
	/** Contexts from the outermost in. A value is followed only when every one is `line`. */
	private readonly contexts: Context[] = ["line"];
	/** Nesting of subshells and groups, which decides what a value is followed through. */
	private subshells = 0;
	private groups = 0;
	private bodies = 0;
	private opaque = 0;
	/** Nesting of `if`, `while`, `until`, `for` and `select`. */
	private loops = 0;
	/** A `&` ended a command inside one of those, after which Claude Code reads the rest of it only for variable-root targets. */
	private backgrounded = false;
	/** An assignment with `${...}` stood inside a group, subshell or compound, after which the rest of the line reads that way. */
	private braced = false;
	private nested = false;
	private pipedFrom: SimpleCommand["pipedFrom"];
	/** Offsets of the `|` operators outside any group, subshell or substitution. */
	readonly pipeBars: number[] = [];

	private readonly source: string;

	constructor(options: FlowOptions, source: string) {
		this.source = source;
		this.home = options.home ?? homedir();
		if (options.inherited) {
			this.values = new Map(options.inherited.variables);
			this.assigned = new Set(options.inherited.assigned);
			this.assignedStart = new Set(this.assigned);
			this.pipelineStart = this.values;
			this.commands = 1;
		}
	}

	run(root: List): SimpleCommand[] {
		this.list(root, "");
		return this.found.map(({ command, own, top, uncertain }) =>
			own && (this.untrackable || (top && this.subshelled)) ? { ...command, variables: uncertain } : command,
		);
	}

	private get policy(): Policy {
		let counts = true;
		let orUndoes = false;
		for (const context of this.contexts) {
			counts &&= POLICY[context].counts;
			orUndoes ||= POLICY[context].orUndoes;
		}
		return { counts, orUndoes };
	}

	private get following(): boolean {
		return this.contexts.every((context) => context === "line");
	}

	private get topLevel(): boolean {
		return !this.nested && this.subshells <= 1 && this.groups <= 1 && this.bodies === 0 && this.following;
	}

	private list(list: List, trailing: string): void {
		list.items.forEach((item, index) => {
			const last = index === list.items.length - 1;
			const after =
				item.end === "&"
					? "&"
					: last && item.end === ""
						? trailing
						: item.end === ";" || item.end === "\n"
							? ";"
							: trailing;
			const chain = item.chain;
			this.pipeline(chain.first, chain.rest[0]?.operator ?? after);
			chain.rest.forEach((entry, position) => {
				if (entry.operator === "||") this.orBegins();
				this.pipeline(entry.pipeline, chain.rest[position + 1]?.operator ?? after);
			});
			if (item.end === "&" && this.loops > 0) this.backgrounded = true;
			this.endItem(item.end);
		});
	}

	private pipeline(pipeline: Pipeline, after: string): void {
		const lastStage = pipeline.stages.length - 1;
		if (lastStage > 0 && this.topLevelForPipe() && this.contexts.length === 1)
			for (const span of pipeline.spans.slice(1)) this.pipeBars.push(this.barBefore(span.start));
		pipeline.stages.forEach((stage, index) => {
			const operator = index === lastStage ? after : (pipeline.operators[index] as string);
			if (index > 0) {
				this.enterPipeline();
				this.pipedFrom = this.stagePipedFrom(pipeline.stages[index - 1] as Command);
			}
			if (index === 0 && lastStage > 0) this.enterPipeline();
			this.command(stage, operator);
			this.pipedFrom = undefined;
		});
		if (lastStage > 0) this.leavePipeline(true);
	}

	private stagePipedFrom(stage: Command): SimpleCommand["pipedFrom"] {
		if (!this.topLevelForPipe() || stage.type !== "simple") return undefined;
		const words = stage.words.map(flatten);
		const head = basename(words.find((word) => !ASSIGNMENT.test(word.text))?.text ?? "");
		if (words.length > 0 && words.every((word) => ASSIGNMENT.test(word.text))) return "assignment";
		if (DECLARATIONS.has(head) && words[0]?.text === head) return head === "local" ? undefined : "declaration";
		return undefined;
	}

	private barBefore(start: number): number {
		return this.source.lastIndexOf("|", start - 1);
	}

	private topLevelForPipe(): boolean {
		return this.subshells === 0 && this.groups === 0 && !this.nested;
	}

	private command(command: Command, operator: string): void {
		switch (command.type) {
			case "simple":
				this.simple(command, operator);
				break;
			case "subshell":
				this.subshell(command.body, operator);
				break;
			case "group":
				this.group(command.body, operator);
				break;
			case "if":
				this.compound(operator, () => {
					for (const branch of command.branches) {
						this.list(branch.condition, ";");
						this.list(branch.body, ";");
					}
					if (command.otherwise) this.list(command.otherwise, ";");
				});
				break;
			case "while":
				this.compound(operator, () => {
					this.list(command.condition, ";");
					this.list(command.body, ";");
				});
				break;
			case "for":
				this.compound(operator, () => {
					for (const item of command.items) this.words([item]);
					this.forget(command.variable);
					this.list(command.body, ";");
				});
				break;
			case "case":
				this.words([command.subject]);
				this.untrackable = true;
				this.compound(
					operator,
					() => {
						for (const item of command.items) {
							this.words(item.patterns);
							this.list(item.body, ";");
						}
					},
					"case",
					false,
				);
				break;
			case "function":
				this.untrackable = true;
				this.opaque++;
				this.compound(operator, () => this.command(command.body, ";"), "body", false);
				this.opaque--;
				break;
		}
		for (const redirect of command.redirects) {
			if (redirect.target) this.words([redirect.target]);
			if (redirect.heredoc) this.parts(redirect.heredoc.body);
		}
	}

	/** An `if`, loop, `case` or function body: assignments count inside it and are not followed. */
	private compound(operator: string, walk: () => void, context: Context = "body", loop = true): void {
		const before = this.assigned;
		this.bodies++;
		if (loop) this.loops++;
		this.contexts.push(context);
		if (context === "case") this.opaque++;
		this.assignedStart = this.assigned;
		walk();
		if (context === "case") this.opaque--;
		this.contexts.pop();
		this.bodies--;
		if (loop && --this.loops === 0) this.backgrounded = false;
		if (UNDOING.has(operator)) this.assigned = before;
		this.assignedStart = this.assigned;
	}

	private subshell(body: List, operator: string): void {
		const saved = this.save();
		this.subshells++;
		if (this.subshells > 1) this.untrackable = true;
		else {
			this.subshelled = !this.nested && this.groups === 0 && this.bodies === 0;
			this.values = new Map();
			this.commands = 0;
		}
		this.orList = false;
		this.inPipeline = false;
		this.pipelineStart = this.values;
		this.stageAssigned = new Set();
		this.list(body, ";");
		this.subshells--;
		this.restore(saved);
		if (UNDOING.has(operator)) this.assigned = saved.assigned;
		this.assignedStart = this.assigned;
	}

	private group(body: List, operator: string): void {
		const saved = { values: this.values, commands: this.commands, assigned: this.assigned };
		this.groups++;
		this.values = new Map();
		this.commands = 0;
		this.pipelineStart = this.values;
		this.list(body, ";");
		this.groups--;
		this.values = saved.values;
		this.commands = saved.commands;
		this.pipelineStart = this.values;
		if (UNDOING.has(operator)) this.assigned = saved.assigned;
		this.assignedStart = this.assigned;
	}

	private save() {
		return {
			values: this.values,
			pipelineStart: this.pipelineStart,
			orList: this.orList,
			inPipeline: this.inPipeline,
			commands: this.commands,
			assigned: this.assigned,
		};
	}

	private restore(saved: ReturnType<Flow["save"]>): void {
		this.values = saved.values;
		this.commands = saved.commands;
		this.orList = saved.orList;
		this.inPipeline = saved.inPipeline;
		this.pipelineStart = saved.pipelineStart;
	}

	private simple(command: Simple, operator: string): void {
		const words = command.words.map(flatten);
		for (const syntax of command.words) this.parts(syntax.parts, syntax);
		for (const redirect of command.redirects) {
			if (redirect.target) this.words([redirect.target]);
			if (redirect.heredoc) this.parts(redirect.heredoc.body);
		}
		if (
			(this.subshells > 0 || this.groups > 0 || this.loops > 0) &&
			words.some((word) => /^[A-Za-z_]\w*=.*\$\{/.test(word.text))
		)
			this.braced = true;
		const uncertain: Variables = new Map();
		const record: SimpleCommand = {
			words,
			...(this.pipedFrom === undefined ? {} : { pipedFrom: this.pipedFrom }),
			text: command.source,
			variables: new Map(this.values),
			assigned: this.assigned,
			...(this.opaque > 0 || this.backgrounded || this.braced ? { opaque: true as const } : {}),
			...(this.nested ? { substitution: true as const } : {}),
		};
		this.found.push({ command: record, own: !this.nested, top: this.subshells === 0, uncertain });
		if (this.apply(command.words)) {
			this.commands++;
		}
		this.endCommand(operator);
	}

	private apply(words: readonly SyntaxWord[]): boolean {
		const flat = words.map(flatten);
		const head = flat.findIndex((word) => !ASSIGNMENT.test(word.text));
		if (head === -1) {
			flat.forEach((word, index) => {
				this.assign(word, words[index] as SyntaxWord);
			});
			return false;
		}
		const name = basename(flat[head]?.text ?? "");
		if (DECLARATIONS.has(name)) {
			let anyNonAssign = false;
			for (let index = head + 1; index < flat.length; index++) {
				if (ASSIGNMENT.test((flat[index] as Word).text)) {
					this.assign(flat[index] as Word, words[index] as SyntaxWord);
				} else {
					anyNonAssign = true;
				}
			}
			return anyNonAssign;
		} else if (name === "unset" || name === "read") {
			for (const word of flat.slice(head + 1)) if (!word.text.startsWith("-")) this.forget(word.text);
		}
		return true;
	}

	private assign(word: Word, syntax: SyntaxWord): void {
		const equals = word.text.indexOf("=");
		const name = word.text.slice(0, equals);
		const value = this.valueOf(word, syntax, equals);
		this.stageAssigned.add(name);
		const followed = this.topLevel && this.commands === 0 && !this.inPipeline && !this.orList;
		if (this.following && !this.inPipeline) {
			const next = new Map(this.values);
			if (!followed) next.delete(name);
			else if (value === undefined) next.delete(name);
			else {
				const known = this.values.get(name);
				next.set(name, known === undefined || known === value ? value : null);
			}
			this.values = next;
		}
		const written = word.text.slice(equals + 1);
		const counted =
			this.policy.counts &&
			!this.inPipeline &&
			value !== null &&
			written !== "" &&
			!(word.literalDollars ?? []).some((index) => index > equals) &&
			(value === undefined || value !== "");
		if (counted) this.assigned = new Set(this.assigned).add(name);
	}

	/**
	 * What an assignment gives the name, as Claude Code follows it: the text with `$HOME` left for the target to
	 * expand, `undefined` when the value is one it does not follow (a tilde, an unquoted glob or brace), and `null`
	 * when it is text it cannot know.
	 */
	private valueOf(word: Word, syntax: SyntaxWord, equals: number): string | null | undefined {
		let offset = 0;
		for (const part of syntax.parts) {
			if (part.kind === "text" && part.quoting === "bare") {
				const special = /[*?[{]/.exec(part.text.slice(Math.max(0, equals + 1 - offset)));
				if (special) return undefined;
				if (
					offset <= equals + 1 &&
					offset + part.text.length > equals + 1 &&
					part.text[equals + 1 - offset] === "~"
				) {
					const rest = word.text.slice(equals + 2);
					if (this.subshells > 0 && /^(?:\/|$)/.test(rest)) return this.home + rest;
					this.untrackable = true;
					return undefined;
				}
				offset += part.text.length;
			} else if (part.kind === "text") offset += part.text.length;
			else if (part.kind === "param") offset += part.source.length;
			else offset += SUBSTITUTION.length;
		}
		const literals = (word.literalDollars ?? []).map((index) => index - equals - 1);
		return this.expanded(word.text.slice(equals + 1), literals);
	}

	/** A value with the known variables put in, or `null` when a `$` in it names an unknown text. */
	private expanded(value: string, literals: readonly number[]): string | null {
		let known = true;
		const text = value.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$|__CMDSUB__/g,
			(match, braced: string | undefined, bare: string | undefined, offset: number) => {
				if (literals.includes(offset)) return LITERAL_DOLLAR + match.slice(1);
				const name = braced ?? bare;
				if (name === "HOME") return match;
				const found = name === undefined ? undefined : this.values.get(name);
				if (typeof found !== "string") known = false;
				return found ?? "";
			},
		);
		return known ? text : null;
	}

	private forget(name: string | undefined): void {
		if (name === undefined || !this.values.has(name)) return;
		const next = new Map(this.values);
		next.delete(name);
		this.values = next;
	}

	private endCommand(operator: string): void {
		if (UNDOING.has(operator) || (operator === "||" && this.policy.orUndoes)) this.assigned = this.assignedStart;
		this.assignedStart = this.assigned;
		if (operator === "&") this.untrackable = true;
		if (operator === "|" || operator === "|&") return;
		if (operator === "&") this.leavePipeline(true);
		else if (operator === "||") {
			this.orBegins();
		} else if (operator === ";" || operator === "") {
		}
	}

	private orBegins(): void {
		this.orList = true;
		this.values = new Map([...this.values].filter(([name]) => !this.stageAssigned.has(name)));
		this.pipelineStart = this.values;
		this.stageAssigned = new Set();
	}

	private endItem(end: string): void {
		if (this.orList && (end === ";" || end === "\n")) {
			this.values = new Map();
			this.orList = false;
		}
		this.pipelineStart = this.values;
		this.stageAssigned = new Set();
	}

	private enterPipeline(): void {
		if (this.inPipeline) return;
		this.leavePipeline(false);
		this.inPipeline = true;
	}

	/** Names set in the stages of a pipeline, or before a `&`, are unknowable after it. */
	private leavePipeline(force: boolean): void {
		if (!force && !this.inPipeline) return;
		const merged = new Map(this.pipelineStart);
		for (const name of this.stageAssigned) merged.delete(name);
		this.pipelineStart = merged;
		this.values = merged;
		this.stageAssigned = new Set();
		this.inPipeline = false;
	}

	private words(words: readonly SyntaxWord[]): void {
		for (const word of words) this.parts(word.parts, word);
	}

	/** Substitutions inside a word run before the command that holds them. */
	private parts(parts: readonly Part[], word?: SyntaxWord): void {
		if (word?.brace) this.untrackable = true;
		for (const part of parts) {
			if (part.kind === "param") {
				if (part.complex || part.source.startsWith("${")) this.untrackable = true;
				this.reference(part.name, part.quoted);
			} else if (part.kind === "text") {
				if (part.quoting === "ansi") this.untrackable = true;
			} else {
				if (part.form !== "arith") this.untrackable = true;
				if (part.body) this.substitution(part.form, part.body);
			}
		}
	}

	private substitution(form: Substitution, body: List): void {
		const saved = {
			values: this.values,
			assigned: this.assigned,
			assignedStart: this.assignedStart,
			commands: this.commands,
			orList: this.orList,
			inPipeline: this.inPipeline,
			pipelineStart: this.pipelineStart,
			stageAssigned: this.stageAssigned,
			nested: this.nested,
			pipedFrom: this.pipedFrom,
			bodies: this.bodies,
			groups: this.groups,
			subshells: this.subshells,
		};
		this.contexts.push(CONTEXT_OF[form]);
		this.nested = true;
		this.assigned = new Set();
		this.assignedStart = this.assigned;
		this.commands = 0;
		this.orList = false;
		this.inPipeline = false;
		this.values = new Map();
		this.pipelineStart = this.values;
		this.stageAssigned = new Set();
		this.pipedFrom = undefined;
		this.list(body, "");
		this.contexts.pop();
		Object.assign(this, saved);
	}

	/** A `$NAME` the line reads, in or out of double quotes. One whose value Claude Code cannot know ends value following. */
	private reference(name: string, quoted: boolean): void {
		if (name === "HOME" || name === "") return;
		const value = this.values.get(name);
		if (typeof value === "string") {
			if (quoted || !UNSAFE_WORD.test(value)) return;
		} else if (quoted && (value === null || ALWAYS_SET.has(name) || /^(?:[0-9]+|[?$!#-])$/.test(name))) return;
		this.untrackable = true;
	}
}
