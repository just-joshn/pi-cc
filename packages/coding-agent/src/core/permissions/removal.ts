/**
 * The dangerous-removal breaker: `rm` and `rmdir` commands whose target is a critical directory, a
 * workspace directory or one of its parents, or a path the check cannot place.
 *
 * Claude Code finds these in every nested command of a line (groups, substitutions, loop bodies,
 * `bash -c` scripts, `eval`) and holds them against every rule and, unless the operator waived the
 * check, against `bypassPermissions` too. The words below are Claude Code's own.
 *
 * Invariant: when this model is unsure whether Claude Code binds a variable or follows an assignment, it
 * does not bind. A variable set anywhere but a plain top-level `NAME=value` (compound, opaque, piped or
 * nested context, an unproven declaration keyword, a value with `$`, `~`, quotes, escapes or globs) stays
 * uncertain, and a removal target that uses it is refused. A stricter ask is recorded debt (P04b); an
 * allow where Claude Code asks is a safety bug.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { canonicalPath, isInside } from "./paths.ts";

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

/** Substitutions counted across a line, nested and quoted ones included. */
export interface Tally {
	substitutions: number;
	/** A `${ cmd; }` body declared a variable, which Claude Code cannot check and asks about when nothing else is wrong. */
	uncheckable?: true;
	/** Offsets of the top-level `|` operators, outside any group or subshell. */
	pipeBars?: number[];
}

/** `$( )` unbinds on `||` as well, a process substitution is the plain rule, and backticks and here-document bodies never bind. */
type SubstitutionKind = "dollar" | "backtick" | "process" | "heredoc";

export interface ScanOptions {
	readonly kind?: SubstitutionKind;
	readonly depth?: number;
	readonly tally?: Tally;
	/** What an enclosing line had set, for a script it hands to a shell or `eval`. */
	readonly inherited?: Pick<SimpleCommand, "variables" | "assigned">;
	readonly home?: string;
}

const SUBSTITUTION = "__CMDSUB__";
const KEYWORDS = new Set(["{", "}", "do", "then", "else", "elif", "fi", "done", "if", "while", "until", "!", "time"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "command", "builtin", "exec", "timeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_INLINE_DEPTH = 4;
/** Operators after which the name a command assigned is not one Claude Code treats as set. Substitutions differ, see {@link SubstitutionKind}. */
const BINDING_ENDS: ReadonlySet<string> = new Set(["|", "|&", "&"]);
const SUBSTITUTION_BINDING_ENDS: ReadonlySet<string> = new Set(["|", "|&", "&", "||"]);

/** Declaration keywords after which a corpus row shows Claude Code following the assignment at the top level. */
const BOUND_KEYWORDS: ReadonlySet<string> = new Set(["", "declare", "readonly", "typeset", "export", "local"]);
const DECLARATIONS = new Set(["export", "local", "readonly", "declare", "typeset"]);
const LOOPS = new Set(["for", "select"]);
const OPENERS = new Set(["if", "while", "until", ...LOOPS]);
const CLOSERS = new Set(["fi", "done"]);
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
const UNSAFE_WORD = /[ \t\n*?[]/;
const MAX_SUBSTITUTIONS = 64;

/**
 * The variables Claude Code follows through a line, to read what `rm -rf $X` removes.
 *
 * It follows only a plain `NAME=value` (or one after `export`, `local`, `readonly`, `declare`, `typeset`)
 * made before any command has run, and gives up on a name the moment its value could differ: a second
 * value, a `||` or `&` list, a pipeline stage, a branch or loop body, `unset`, `read`, a `for` variable.
 * A subshell keeps what it sets to itself. It gives up on the whole line when it meets a construct it
 * cannot read: a substitution, `${...}`, a group, `case`, a function, `$'...'`, or a variable it does
 * not hold a value for.
 */
class Tracker {
	untrackable = false;
	variables: Variables = new Map();
	/**
	 * Names assigned where it is neither known that Claude Code follows them nor known that it does not. A target
	 * that uses one is refused, even once the line gives up on variables. A subshell's names end at its `)`.
	 */
	uncertain: ReadonlySet<string> = new Set();
	/** Names this command bound in a proven context, which a function or case body may still read. */
	provenNames: string[] = [];
	assigned: ReadonlySet<string> = new Set();
	/** The names the line had assigned when the current command began, which a pipeline stage or `||` list gives back. */
	private readonly groups: { variables: Variables; commands: number }[] = [];
	private assignedStart: ReadonlySet<string> = new Set();
	/** Set once a subshell stands at the top of the line, where Claude Code reads each part on its own. */
	private subshelled = false;
	private commands = 0;
	private compound = 0;
	private orList = false;
	private inPipeline = false;
	private pipelineStart: Variables = this.variables;
	private stageAssigned = new Set<string>();
	private readonly frames: {
		variables: Variables;
		pipelineStart: Variables;
		orList: boolean;
		inPipeline: boolean;
		commands: number;
		compound: number;
		uncertain: ReadonlySet<string>;
	}[] = [];

	private readonly home: string;
	private readonly nestedScan: boolean;
	private readonly unbinding: ReadonlySet<string>;

	constructor(
		home: string,
		inherited?: Pick<SimpleCommand, "variables" | "assigned">,
		unbinding: ReadonlySet<string> = BINDING_ENDS,
		nestedScan = false,
	) {
		this.home = home;
		this.nestedScan = nestedScan;
		this.unbinding = unbinding;
		if (inherited) {
			this.variables = inherited.variables;
			this.assigned = inherited.assigned;
			this.assignedStart = inherited.assigned;
			this.pipelineStart = this.variables;
			this.commands = 1;
		}
	}

	/** How many subshells deep the scan is. */
	get depth(): number {
		return this.frames.length;
	}

	/** Whether the scan is inside a `{ }` group. */
	get inGroup(): boolean {
		return this.groups.length > 0;
	}

	/** Whether the scan is inside an `if`, loop or `select` body. */
	get inCompound(): boolean {
		return this.compound > 0;
	}

	/** Whether a subshell stood at the top of the line. */
	get topLevelSubshell(): boolean {
		return this.subshelled;
	}

	/** A `$NAME` the scanner met, in or out of double quotes. */
	reference(name: string, quoted: boolean): void {
		if (name === "HOME") return;
		const value = this.variables.get(name);
		if (typeof value === "string") {
			if (quoted || !UNSAFE_WORD.test(value)) return;
		} else if (quoted && (value === null || ALWAYS_SET.has(name) || /^(?:[0-9]+|[?$!#-])$/.test(name))) return;
		this.untrackable = true;
	}

	/** A `{` group reads its own assignments only, and gives the line's back at its `}`. */
	groupBoundary(words: readonly Word[]): void {
		for (const { text } of words) {
			if (text === "{") {
				this.groups.push({ variables: this.variables, commands: this.commands });
				this.variables = new Map();
				this.commands = 0;
			} else if (text === "}") {
				const group = this.groups.pop();
				if (group) {
					this.variables = group.variables;
					this.commands = group.commands;
				}
			} else if (!KEYWORDS.has(text)) break;
		}
	}

	command(words: readonly Word[]): void {
		const texts = words.map((word) => word.text);
		let first = 0;
		for (; first < texts.length; first++) {
			const head = texts[first] as string;
			if (OPENERS.has(head)) this.compound++;
			else if (CLOSERS.has(head)) this.compound = Math.max(0, this.compound - 1);
			else if (head === "case" || head === "function") this.untrackable = true;

			if (LOOPS.has(head)) {
				this.forget(texts[first + 1]);
				return;
			}
			if (!KEYWORDS.has(head)) break;
		}
		const rest = texts.slice(first);
		if (rest.length === 0) return;
		if (rest.every((text) => ASSIGNMENT.test(text))) {
			for (const word of words.slice(first)) this.assign(word, "");
			return;
		}
		const head = basename(rest[0] as string);
		if (DECLARATIONS.has(head)) {
			for (const word of words.slice(first + 1)) if (ASSIGNMENT.test(word.text)) this.assign(word, head);
		} else if (head === "unset" || head === "read") {
			for (const text of rest.slice(1)) if (!text.startsWith("-")) this.forget(text);
		}
		this.commands++;
	}

	separator(operator: string): void {
		if (this.unbinding.has(operator)) this.assigned = this.assignedStart;
		this.assignedStart = this.assigned;
		if (operator === "&") this.untrackable = true;
		if (operator === "(") {
			this.frames.push({
				variables: this.variables,
				pipelineStart: this.pipelineStart,
				orList: this.orList,
				inPipeline: this.inPipeline,
				commands: this.commands,
				compound: this.compound,
				uncertain: this.uncertain,
			});
			if (this.frames.length > 1) this.untrackable = true;
			else if (this.frames.length === 1) {
				this.subshelled = true;
				this.variables = new Map();
				this.commands = 0;
				this.compound = 0;
			}
			this.orList = false;
			this.inPipeline = false;
			this.pipelineStart = this.variables;
			this.stageAssigned = new Set();
			return;
		}
		if (operator === "|" || operator === "|&") {
			this.leavePipeline(true);
			this.inPipeline = true;
			return;
		}
		this.leavePipeline(operator === "&");
		this.inPipeline = false;
		if (operator === ")") {
			const frame = this.frames.pop();
			if (frame) {
				this.variables = frame.variables;
				this.commands = frame.commands;
				this.compound = frame.compound;
				this.uncertain = frame.uncertain;
				this.orList = frame.orList;
				this.inPipeline = frame.inPipeline;
				this.pipelineStart = frame.pipelineStart;
			}
		} else if (operator === "||") {
			this.orList = true;
			this.variables = new Map(
				[...this.variables].map(([name, value]) => [name, this.stageAssigned.has(name) ? null : value]),
			);
		} else if (this.orList && (operator === ";" || operator === "\n")) {
			this.variables = new Map([...this.variables.keys()].map((name) => [name, null]));
			this.orList = false;
		}
		this.pipelineStart = this.variables;
		this.stageAssigned = new Set();
	}

	/** Names set in the stages of a pipeline, or before a `&`, are unknowable after it. */
	private leavePipeline(force: boolean): void {
		if (!force && !this.inPipeline) return;
		const merged = new Map(this.pipelineStart);
		for (const name of this.stageAssigned) merged.set(name, null);
		this.pipelineStart = merged;
		this.variables = merged;
		this.stageAssigned = new Set();
	}

	private forget(name: string | undefined): void {
		if (name === undefined || !this.variables.has(name)) return;
		const next = new Map(this.variables);
		next.delete(name);
		this.variables = next;
	}

	private assign(word: Word, keyword: string): void {
		const equals = word.text.indexOf("=");
		const name = word.text.slice(0, equals);
		const source = word.text.slice(equals + 1);
		const tilde = /^~(?=\/|$)/.test(source);
		if (source.startsWith("~") && !(tilde && this.frames.length > 0)) this.untrackable = true;
		const value = this.expanded(
			tilde && this.frames.length > 0 ? this.home + source.slice(1) : source,
			(word.literalDollars ?? []).map((index) => index - equals - 1),
		);
		this.stageAssigned.add(name);
		const topLevel = !this.nestedScan && this.frames.length === 0 && this.groups.length === 0 && this.compound === 0;
		const plain = !word.decorated && !/[~*?[{]/.test(source);
		const bound =
			topLevel && plain && this.commands === 0 && !this.inPipeline && !this.orList && BOUND_KEYWORDS.has(keyword);
		/** A bare `NAME=value` that Claude Code is known not to follow: after a command, in a pipeline or `||` list. */
		const unfollowed = topLevel && plain && keyword === "";
		if ((!bound && !unfollowed) || (bound && value === null)) this.uncertain = new Set(this.uncertain).add(name);
		if (this.inPipeline) return;
		const known = this.variables.get(name);
		const next = new Map(this.variables);
		if (!bound) next.set(name, null);
		else if (known === undefined) next.set(name, value);
		else next.set(name, known === value ? value : null);
		this.variables = next;
		if (bound && value !== null && value !== "") {
			this.assigned = new Set(this.assigned).add(name);
			this.provenNames.push(name);
		}
	}

	/** A value with the variables it names put in, or `null` when one of them is not a known text. */
	private expanded(value: string, literals: readonly number[]): string | null {
		let known = true;
		const text = value.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$/g,
			(match, braced: string | undefined, bare: string | undefined, offset: number) => {
				if (literals.includes(offset)) return match;
				const name = braced ?? bare;
				const found = name === "HOME" ? this.home : name === undefined ? undefined : this.variables.get(name);
				if (typeof found !== "string") known = false;
				return found ?? "";
			},
		);
		return known ? text : null;
	}
}

/** Every simple command in a line, nested ones included, with substitutions replaced by a marker. */
export function simpleCommands(line: string, options: ScanOptions = {}): SimpleCommand[] {
	const depth = options.depth ?? 0;
	const tally = options.tally ?? { substitutions: 0 };
	/** Commands in the order they appear, a substitution's commands ahead of the command that holds it. */
	const found: { command: SimpleCommand; own: boolean; top: boolean; uncertain: Variables }[] = [];
	const uncertainNow = (): Variables => new Map([...tracker.uncertain].map((name) => [name, null]));
	const tracker = new Tracker(
		options.home ?? homedir(),
		options.inherited,
		options.kind === "dollar" ? SUBSTITUTION_BINDING_ENDS : BINDING_ENDS,
		options.kind !== undefined,
	);
	let words: Word[] = [];
	let text = "";
	let literalDollars: number[] = [];
	let quotedDollars: number[] = [];
	let started = false;
	let decorated = false;
	let brace = -1;
	let commandStart = 0;
	let functionBraces = -1;
	let inCase = false;
	let backgroundedCompound = false;
	let bracedHome = false;
	let lastOperator = "";
	let previous: readonly string[] = [];
	let everAssigned: ReadonlySet<string> = new Set();
	const endWord = (): void => {
		if (started)
			words.push({ text, literalDollars, quotedDollars, ...(decorated ? { decorated: true as const } : {}) });
		decorated = false;
		text = "";
		literalDollars = [];
		quotedDollars = [];
		started = false;
		brace = -1;
	};
	const endCommand = (index: number, operator: string): void => {
		endWord();
		const source = line.slice(commandStart, index).trim();
		if (words.length > 0) {
			tracker.groupBoundary(words);
			const heads = words.map((word) => word.text);
			if (operator === "(" && words.length === 1 && /^\s*\)/.test(line.slice(index + 1))) functionBraces = 0;
			const wasOpaque = functionBraces >= 0 || inCase || backgroundedCompound || bracedHome;
			if (
				!bracedHome &&
				heads.some((head) => /^[A-Za-z_]\w*=.*\$\{/.test(head)) &&
				(tracker.inCompound || tracker.depth > 0 || tracker.inGroup)
			)
				bracedHome = true;
			if (heads[0] === "case") inCase = true;
			if (functionBraces >= 0) {
				for (const head of heads) functionBraces += head === "{" ? 1 : head === "}" ? -1 : 0;
				if (functionBraces <= 0 && heads.includes("}")) functionBraces = -1;
			}
			if (heads[0] === "esac") inCase = false;
			const isOpaque = wasOpaque || heads[0] === "case" || bracedHome;
			const stage = previous.filter((head) => !KEYWORDS.has(head));
			const pipedFrom =
				(lastOperator === "|" || lastOperator === "|&") && tracker.depth === 0 && !tracker.inGroup
					? DECLARATIONS.has(basename(stage[0] ?? ""))
						? stage[0] === "local"
							? undefined
							: ("declaration" as const)
						: stage.length > 0 && stage.every((head) => ASSIGNMENT.test(head))
							? ("assignment" as const)
							: undefined
					: undefined;
			const command: SimpleCommand = {
				words,
				...(pipedFrom === undefined ? {} : { pipedFrom }),
				text: source,
				variables: new Map([...uncertainNow(), ...tracker.variables]),
				assigned: functionBraces >= 0 || inCase ? everAssigned : tracker.assigned,
				...(isOpaque ? { opaque: true as const } : {}),
			};
			found.push({ command, own: true, top: tracker.depth === 0, uncertain: uncertainNow() });
			tracker.provenNames = [];
			tracker.command(words);
			if (operator !== "&" && operator !== "|" && operator !== "|&" && !isOpaque)
				for (const name of tracker.provenNames) everAssigned = new Set(everAssigned).add(name);
		}
		if ((operator === "|" || operator === "|&") && depth === 0 && tracker.depth === 0 && !tracker.inGroup) {
			tally.pipeBars = [...(tally.pipeBars ?? []), index];
		}
		previous = words.map((word) => word.text);
		lastOperator = operator;
		if (operator === "&" && tracker.inCompound) backgroundedCompound = true;
		tracker.separator(operator);
		if (!tracker.inCompound) backgroundedCompound = false;
		words = [];
		commandStart = index + operator.length;
	};
	const nested = (inner: string, counted = true, kind: SubstitutionKind = "dollar"): void => {
		const inside = simpleCommands(inner, { depth: depth + 1, tally, home: options.home, kind });
		for (const command of inside)
			found.push({
				command: {
					...command,
					substitution: true,
					variables: new Map([...uncertainNow(), ...command.variables]),
					assigned: new Set(),
				},
				own: false,
				top: false,
				uncertain: uncertainNow(),
			});
		if (counted) {
			tally.substitutions++;
			tracker.untrackable = true;
		}
		text += SUBSTITUTION;
		started = true;
		decorated = true;
	};
	const dollar = (at: number, quoted: boolean): void => {
		const after = line[at + 1];
		if (after === "{") {
			tracker.untrackable = true;
			if (/[ \t\n|]/.test(line[at + 2] ?? "")) {
				tally.substitutions++;
				let close = at + 2;
				for (let level = 1; close < line.length && level > 0; close++) {
					if (line[close] === "{") level++;
					else if (line[close] === "}") level--;
				}
				if (
					/(?:^|[\s;&|])(?:export|local|readonly|declare|typeset)\s+[A-Za-z_]\w*=/.test(line.slice(at + 2, close))
				)
					tally.uncheckable = true;
			}
		} else if (after === "'") {
			tracker.untrackable = true;
		} else {
			const found = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|([0-9@*?$!#-]))/.exec(line.slice(at, at + 256));
			if (found) tracker.reference((found[1] ?? found[2]) as string, quoted);
		}
	};
	let index = 0;
	while (index < line.length) {
		const char = line[index] as string;
		const next = line[index + 1];
		if (char === "\\" && next !== undefined) {
			if (next === "$") literalDollars.push(text.length);
			text += next;
			started = true;
			decorated = true;
			index += 2;
		} else if (char === "'") {
			const close = line.indexOf("'", index + 1);
			const end = close === -1 ? line.length : close;
			for (let at = index + 1; at < end; at++)
				if (line[at] === "$") literalDollars.push(text.length + at - index - 1);
			text += line.slice(index + 1, end);
			started = true;
			decorated = true;
			index = end + 1;
		} else if (char === '"') {
			started = true;
			decorated = true;
			index++;
			while (index < line.length && line[index] !== '"') {
				const inner = line[index] as string;
				if (inner === "\\" && line[index + 1] !== undefined) {
					if (line[index + 1] === "$") literalDollars.push(text.length);
					text += line[index + 1];
					index += 2;
				} else if (inner === "$" && line[index + 1] === "(") {
					const end = matching(line, index + 1);
					nested(line.slice(index + 2, end), line[index + 2] !== "(");
					index = end + 1;
				} else if (inner === "`") {
					const end = closingBacktick(line, index);
					nested(line.slice(index + 1, end), true, "backtick");
					index = end + 1;
				} else {
					if (inner === "$") {
						dollar(index, true);
						quotedDollars.push(text.length);
					}
					text += inner;
					index++;
				}
			}
			index++;
		} else if (char === "$" && next === "(") {
			const end = matching(line, index + 1);
			nested(line.slice(index + 2, end), line[index + 2] !== "(");
			index = end + 1;
		} else if (char === "`") {
			const end = closingBacktick(line, index);
			nested(line.slice(index + 1, end), true, "backtick");
			index = end + 1;
		} else if ((char === "<" || char === ">") && next === "(") {
			const end = matching(line, index + 1);
			nested(line.slice(index + 2, end), true, "process");
			index = end + 1;
		} else if (char === "<" || char === ">") {
			index = skipRedirection(line, index, nested);
			endWord();
		} else if (char === "#" && !started) {
			const newline = line.indexOf("\n", index);
			index = newline === -1 ? line.length : newline;
		} else if (char === " " || char === "\t") {
			endWord();
			index++;
		} else if (";&|\n()".includes(char)) {
			const operator =
				next === char && (char === "&" || char === "|") ? char + char : char === "|" && next === "&" ? "|&" : char;
			endCommand(index, operator);
			index += operator.length;
		} else {
			if (char === "$") {
				dollar(index, false);
				decorated = true;
			} else if (char === "{") brace = text.length;
			else if (char === "}" && brace !== -1 && /,|\.\./.test(text.slice(brace))) tracker.untrackable = true;
			text += char;
			started = true;
			index++;
		}
	}
	endCommand(line.length, "");
	return found.map(({ command, own, top, uncertain }) =>
		own && (tracker.untrackable || (top && tracker.topLevelSubshell))
			? { ...command, variables: uncertain }
			: command,
	);
}

/** The index of the `)` that closes the `(` at `open`. */
function matching(line: string, open: number): number {
	let depth = 0;
	for (let index = open; index < line.length; index++) {
		const char = line[index];
		if (char === "\\") index++;
		else if (char === "'") index = Math.max(index, line.indexOf("'", index + 1));
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return index;
	}
	return line.length;
}

function closingBacktick(line: string, open: number): number {
	for (let index = open + 1; index < line.length; index++) {
		if (line[index] === "\\") index++;
		else if (line[index] === "`") return index;
	}
	return line.length;
}

/** Past a redirection operator and its target word, and past a here-document's body. */
function skipRedirection(
	line: string,
	start: number,
	nested: (inner: string, counted?: boolean, kind?: SubstitutionKind) => void,
): number {
	let index = start;
	while (line[index] === "<" || line[index] === ">" || line[index] === "&" || line[index] === "|") index++;
	const heredoc = line.slice(start, index).startsWith("<<") && !line.slice(start, index).startsWith("<<<");
	while (line[index] === " " || line[index] === "\t") index++;
	let word = "";
	while (index < line.length && !/[\s;&|()<>]/.test(line[index] as string)) word += line[index++];
	if (!heredoc) return index;
	const delimiter = word.replace(/^["']|["']$/g, "");
	const newline = line.indexOf("\n", index);
	if (newline === -1 || delimiter === "") return index;
	const rest = line.slice(newline + 1);
	const body = new RegExp(`^\\t*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m").exec(rest);
	if (word === delimiter && !word.includes("\\")) {
		const text = body === null ? rest : rest.slice(0, body.index);
		for (let at = 0; at < text.length; at++) {
			if (text[at] === "\\") at++;
			else if (text[at] === "$" && text[at + 1] === "(" && text[at + 2] !== "(") {
				const end = matching(text, at + 1);
				nested(text.slice(at + 2, end), true, "heredoc");
				at = end;
			} else if (text[at] === "`") {
				const end = closingBacktick(text, at);
				nested(text.slice(at + 1, end), true, "heredoc");
				at = end;
			}
		}
	}
	return body === null ? line.length : newline + 1 + body.index + body[0].length;
}

/** The words of a command after keywords, assignments and wrappers such as `sudo` or `env`. */
function stripped(words: readonly Word[]): Word[] {
	let rest = [...words];
	for (let guard = 0; guard < 16; guard++) {
		const head = rest[0]?.text ?? "";
		if (KEYWORDS.has(head) || ASSIGNMENT.test(head)) rest = rest.slice(1);
		else if (WRAPPERS.has(basename(head))) {
			const wrapper = basename(head);
			rest = rest.slice(1);
			while ((rest[0]?.text ?? "").startsWith("-") || (wrapper === "env" && ASSIGNMENT.test(rest[0]?.text ?? ""))) {
				const option = rest[0]?.text ?? "";
				rest = rest.slice(1);
				if (wrapper === "nice" && option === "-n") rest = rest.slice(1);
			}
			if (wrapper === "timeout" && /^\d/.test(rest[0]?.text ?? "")) rest = rest.slice(1);
		} else break;
	}
	return rest;
}

export interface RemovalScope {
	readonly cwd: string;
	readonly home: string;
	readonly directories: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Removal {
	readonly command: "rm" | "rmdir";
	readonly message: string;
	/** A target that expands from a variable the shell may leave empty. Claude Code reports it before it counts substitutions. */
	readonly emptyVariable?: true;
	readonly pipedFrom?: SimpleCommand["pipedFrom"];
}

export function dangerousRemoval(line: string, scope: RemovalScope): Removal | undefined {
	const tally: Tally = { substitutions: 0 };
	const found = dangerousIn(simpleCommands(line, { tally, home: scope.home }), scope, 0);
	if (tally.substitutions <= MAX_SUBSTITUTIONS || found?.emptyVariable) {
		if (found?.pipedFrom !== undefined && tally.pipeBars !== undefined && !found.emptyVariable) {
			return { command: found.command, message: pipelineParts(line, tally.pipeBars) };
		}
		if (found === undefined && tally.uncheckable) {
			return {
				command: "rm",
				message: `This command could not be checked for dangerous rm operations: the shell may read it differently than it was parsed. This requires explicit approval.`,
			};
		}
		return found;
	}
	return {
		command: "rm",
		message: `This command contains ${tally.substitutions} command substitutions \u2014 too many to analyze for catastrophic removals. This requires explicit approval.`,
	};
}

const NEEDS_APPROVAL = /(?:^|;\s*|\b(?:do|then|else|elif)\s+)(?:export|local|readonly|declare|typeset)\s/;

/** Claude Code's text for a pipeline it cannot read whole: the stages that declare a variable or remove something. */
function pipelineParts(line: string, bars: readonly number[]): string {
	const edges = [0, ...bars.flatMap((bar) => [bar, bar + 1]), line.length];
	const stages: string[] = [];
	for (let at = 0; at < edges.length; at += 2) stages.push(line.slice(edges[at], edges[at + 1]).trim());
	const listed = stages.filter((stage) => NEEDS_APPROVAL.test(stage) || /\brm(?:dir)?\b/.test(stage));
	const [verb, noun] = listed.length === 1 ? ["requires", "part"] : ["require", "parts"];
	return `This Bash command contains multiple operations. The following ${noun} ${verb} approval: ${listed.join(", ")}`;
}

function dangerousIn(commands: readonly SimpleCommand[], scope: RemovalScope, depth: number): Removal | undefined {
	let changedDirectory = false;
	for (const command of commands) {
		const words = stripped(command.words);
		const head = basename(words[0]?.text ?? "");
		if (head === "cd" || head === "pushd") changedDirectory = true;
		if (head === "rm" || head === "rmdir") {
			const found = inspectRemoval(head, words.slice(1), command, changedDirectory, scope);
			if (found) return command.pipedFrom === undefined ? found : { ...found, pipedFrom: command.pipedFrom };
		} else if (depth < MAX_INLINE_DEPTH) {
			const script = inlineScript(head, words);
			const found =
				script === undefined
					? undefined
					: dangerousIn(simpleCommands(script, { inherited: command, home: scope.home }), scope, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

function inlineScript(head: string, words: readonly Word[]): string | undefined {
	if (head === "eval")
		return words
			.slice(1)
			.map((word) => word.text)
			.join(" ");
	if (!SHELLS.has(head)) return undefined;
	const flag = words.findIndex((word, position) => position > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text));
	return flag === -1 ? undefined : words[flag + 1]?.text;
}

const RECURSIVE_FLAG = /^--r|^-[a-zA-Z]*[rR]/;
const VARIABLE_ROOT =
	/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|[A-Za-z_][A-Za-z0-9_]*)\/(?:[*?[{]|\$|\/|$)/;
const TOP_LEVEL =
	"bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive";
const VARIABLE_ROOT_CHILD = new RegExp(
	String.raw`^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|([A-Za-z_][A-Za-z0-9_]*))\/(${TOP_LEVEL})(?:\/+\*+)*\/?$`,
	"i",
);
const MOUNTED =
	/^\/(?:system\/)?volumes(?:\/[^/]+){0,2}$|^\/mnt\/(?:[^/]+|[a-z]\/[^/]+)$|^\/(?:run\/)?media(?:\/[^/]+){0,3}$/i;
const NORMALLY_SET = new Set([
	"HOME",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
]);

function operandsOf(args: readonly Word[]): Word[] {
	const operands: Word[] = [];
	let afterDoubleDash = false;
	let afterOperand = false;
	for (const arg of args) {
		if (afterDoubleDash || afterOperand) operands.push(arg);
		else if (arg.text === "--") afterDoubleDash = true;
		else if (arg.text === "-" || !arg.text.startsWith("-")) {
			operands.push(arg);
			afterOperand = true;
		}
	}
	return operands;
}

function refusal(command: string, operand: string, body: string): Removal {
	return {
		command: command as Removal["command"],
		message: `Dangerous ${command} operation detected: '${operand}'\n\n${body}`,
	};
}

const NO_AUTO_ALLOW = "This requires explicit approval and cannot be auto-allowed by permission rules.";

function inspectRemoval(
	command: string,
	args: readonly Word[],
	line: SimpleCommand,
	changedDirectory: boolean,
	scope: RemovalScope,
): Removal | undefined {
	const beforeDoubleDash = args.slice(
		0,
		args.findIndex((arg) => arg.text === "--") === -1 ? args.length : args.findIndex((arg) => arg.text === "--"),
	);
	const flags = beforeDoubleDash.map((arg) => arg.text);
	const recursive = flags.some((flag) => RECURSIVE_FLAG.test(flag));
	const operands = operandsOf(args);
	for (const operand of operands) {
		if (command === "rm" && recursive && /^(?:__CMDSUB__[/*.]*)+$/.test(operand.text)) {
			return {
				command: "rm",
				message: `Dangerous rm operation detected: the target is the output of a command substitution (\`$(...)\` or backticks) and cannot be checked before the command runs. ${NO_AUTO_ALLOW}\n\nRun the substitution on its own first, then remove the literal paths it prints.`,
			};
		}
		const replaced = followed(operand, line.variables);
		const target =
			replaced !== operand.text && replaced.startsWith("$")
				? { ...operand, text: replaced, literalDollars: [0] }
				: { ...operand, text: replaced };
		const emptied = target.text.replace(/(.)(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$/, "$1$2");
		for (const candidate of emptied === target.text ? [target] : [{ ...target, text: emptied }, target]) {
			const found = inspectOperand(command, candidate, line, recursive, flags, changedDirectory, scope);
			if (found) return found;
		}
	}
	return undefined;
}

function inspectOperand(
	command: string,
	operand: Word,
	line: SimpleCommand,
	recursive: boolean,
	flags: readonly string[],
	changedDirectory: boolean,
	scope: RemovalScope,
): Removal | undefined {
	const variable = operand.literalDollars?.includes(0)
		? undefined
		: variableTarget(command, operand.text, line, scope);
	if (variable) return variable;
	const uncertain = operand.literalDollars?.includes(0) ? undefined : uncertainTarget(command, operand, line);
	if (uncertain) return uncertain;
	if (line.opaque) return undefined;
	const written = operand.literalDollars?.includes(0) ? operand.text : expand(operand.text, scope);
	const absolute = isAbsolute(written) ? written : resolve(scope.cwd, written);
	let stem = absolute;
	for (let previous = ""; previous !== stem; ) {
		previous = stem;
		const cut = stem.replace(/([\\/]\*+)+[\\/]*$/, "") || "/";
		if (cut !== stem) stem = /[\\/]/.test(cut) ? normalize(cut).replace(/(.)\/$/, "$1") : cut;
	}
	const stripped = stem !== absolute;
	const wildcard = stripped;
	if (wildcard && !isAbsolute(written) && /[\\/]\*$/.test(absolute) && changedDirectory) {
		return refusal(
			command,
			absolute,
			`This command changes directories before the removal, so the relative glob target cannot be statically resolved. ${NO_AUTO_ALLOW}`,
		);
	}
	if (
		wildcard &&
		(/\$|__CMDSUB__/.test(absolute) ||
			operand.text.startsWith("~") ||
			(!isAbsolute(written) && /(^|[\\/])\.\.([\\/]|$)/.test(written) && /[\\/]\*$/.test(absolute)) ||
			(command === "rmdir" &&
				/[\\/]\*$/.test(absolute) &&
				flags.some((flag) => /^--p/.test(flag) || /^-[a-z]*p/.test(flag))) ||
			(!isAbsolute(written) && /\*[\\/]+$/.test(written) && /[\\/]\*$/.test(absolute)))
	) {
		return refusal(
			command,
			absolute,
			`This command's removal target cannot be statically resolved to a directory. ${NO_AUTO_ALLOW}`,
		);
	}
	const remainder = isAbsolute(written)
		? stem
		: stem.startsWith(scope.cwd.endsWith("/") ? scope.cwd : `${scope.cwd}/`)
			? stem.slice(scope.cwd.length + 1)
			: stem === scope.cwd
				? ""
				: stem;
	let mounted: Removal | undefined;
	if (!wildcard || !/[*?[]/.test(remainder)) {
		const targets = [stem];
		const real = wildcard ? canonicalPath(stem, scope.cwd) : stem;
		if (real !== stem) targets.push(real);
		for (const target of targets) {
			if (isCriticalPath(target, scope.home)) {
				return refusal(
					command,
					absolute,
					`This command would remove a critical system directory. ${NO_AUTO_ALLOW}`,
				);
			}
			const directories = wildcard ? scope.directories : [scope.cwd, canonicalPath(scope.cwd, scope.cwd)];
			if (directories.some((directory) => isInside(normalize(target), directory))) {
				return refusal(
					command,
					absolute,
					`This command would remove a workspace directory (the working directory, an additional working directory, or one of their parent directories). ${NO_AUTO_ALLOW}`,
				);
			}
		}
		if (
			mounted === undefined &&
			command === "rm" &&
			(recursive || wildcard) &&
			targets.some((target) => MOUNTED.test(normalize(target).replace(/(.)\/$/, "$1")))
		) {
			mounted = refusal(
				command,
				absolute,
				`This command would remove a mounted drive, the folder that holds mounted drives, or a file or folder at the top level of a drive. ${NO_AUTO_ALLOW}\n\nIf you meant something deeper inside, name it by its full path.`,
			);
		}
	}
	if (wildcard && /[\\/]\*$/.test(absolute)) {
		const significant = (path: string): number =>
			path.split(/[\\/]+/).filter((part) => part !== "" && part !== ".").length;
		const globbed = remainder.split(/[\\/]+/).filter((part) => /[*?[]/.test(part)).length;
		if (significant(absolute) - significant(stem) + globbed > 1) {
			return refusal(
				command,
				absolute,
				`This command's glob pattern traverses directories that cannot be statically enumerated. ${NO_AUTO_ALLOW}`,
			);
		}
	}
	return mounted;
}

/** `~` and a leading `$HOME`-style variable put in, the way the shell would before `rm` runs. */
function expand(path: string, scope: RemovalScope): string {
	const home = scope.home || homedir();
	if (/^~(?=\/|$)/.test(path)) return home + path.slice(1);
	const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?=\/|$)/.exec(path);
	if (variable) {
		const name = (variable[1] ?? variable[2]) as string;
		const value = name === "HOME" ? home : scope.env[name];
		if (value !== undefined && value !== "") return value + path.slice(variable[0].length);
	}
	return path;
}

function isCriticalPath(path: string, home: string): boolean {
	const macOS = process.platform === "darwin";
	const flat = (value: string): string =>
		macOS ? value.replace(/^\/private\/(etc|var|tmp|home)(\/|$)/i, "/$1$2") : value;
	if (path === "*" || path.endsWith("/*")) return true;
	const target = flat(path).replace(/\/{2,}/g, "/");
	const trimmed = target === "/" ? target : target.replace(/\/$/, "");
	if (trimmed === "/") return true;
	if (macOS && /^\/\.(?:vol|file)(?:\/|$)/i.test(trimmed)) return true;
	const homes = new Set([flat(home).replace(/\/$/, ""), flat(canonicalPath(home, home)).replace(/\/$/, "")]);
	if (homes.has(trimmed)) return true;
	return dirname(trimmed) === "/";
}

/** A target that starts with a variable the shell may leave empty, which would remove `/` or a top-level directory. */
function variableTarget(
	command: string,
	target: string,
	line: SimpleCommand,
	scope: RemovalScope,
): Removal | undefined {
	const child = VARIABLE_ROOT_CHILD.exec(target);
	const rooted = child === null && VARIABLE_ROOT.test(target);
	if (child === null && !rooted) return undefined;
	const names = child === null ? variableNames(target) : [(child[1] ?? child[2]) as string];
	if (
		names.some(
			(name) =>
				NORMALLY_SET.has(name.toUpperCase()) ||
				(child !== null && line.assigned.has(name)) ||
				(scope.env[name] ?? "") !== "",
		)
	)
		return undefined;
	return emptyVariableRefusal(command, target, line, names, child === null ? undefined : (child[3] as string));
}

/** A target that uses a variable this line set where Claude Code may not have followed it, so its value is unknown. */
function uncertainTarget(command: string, operand: Word, line: SimpleCommand): Removal | undefined {
	const names: string[] = [];
	for (const match of operand.text.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
		if (operand.literalDollars?.includes(match.index)) continue;
		const name = (match[1] ?? match[2]) as string;
		if (line.variables.get(name) === null && !names.includes(name)) names.push(name);
	}
	return names.length === 0 ? undefined : emptyVariableRefusal(command, operand.text, line, names, undefined);
}

function emptyVariableRefusal(
	command: string,
	target: string,
	line: SimpleCommand,
	names: readonly string[],
	rootChild: string | undefined,
): Removal {
	const text = line.text;
	const joined = names.map((name) => `$${name}`).join(" or ");
	const rewritten = target.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/,
		(_match, braced, bare) => `"\${${braced ?? bare}:?}"`,
	);
	const advice =
		rootChild === undefined
			? `rewrite it as \`${rewritten}\`, which makes the shell stop with an error instead of running ${command} when ${joined} is unset or empty, or use a literal absolute path`
			: `rewrite it as \`${rewritten}\`, which makes the shell stop with an error instead of removing /${rootChild} when ${joined} is unset or empty (it is not set in the environment this command inherits), or use a literal absolute path`;
	const becomes = rootChild === undefined ? "becomes `/`, `/*` or a top-level path. " : `becomes \`/${rootChild}\`. `;
	const doesNotFire =
		rootChild === undefined
			? "This check does not fire on a target that cannot expand to the filesystem root"
			: "This check does not fire on a target that cannot expand to a top-level directory";
	return {
		command: command as Removal["command"],
		emptyVariable: true,
		message: `Dangerous ${command} operation detected in \`${text}\`${line.substitution ? " (inside a command substitution)" : ""}. The target '${target}' is a shell variable expansion: when ${joined} is unset or empty it ${becomes}${NO_AUTO_ALLOW}\n\n${doesNotFire}: ${advice}.`,
	};
}

/** `$NAME` put in as the value Claude Code followed the line to give it. */
function followed(word: Word, variables: Variables): string {
	if (variables.size === 0) return word.text;
	return word.text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string, offset: number) => {
		if (word.literalDollars?.includes(offset)) return match;
		const value = variables.get(name);
		if (value === "" && (word.text !== `$${name}` || !word.quotedDollars?.includes(offset))) return match;
		return typeof value === "string" ? value : match;
	});
}

function variableNames(target: string): string[] {
	const names = new Set<string>();
	for (const match of target.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g))
		names.add((match[1] ?? match[2]) as string);
	return [...names];
}
