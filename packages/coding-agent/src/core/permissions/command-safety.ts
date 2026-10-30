/**
 * What a command line must not do, whatever the rules and the read-only table say.
 *
 * Every verdict here comes from the command's words and redirections, the working directories and
 * the mode alone. Each carries a tier, which is how far an answer can reach to clear it:
 *
 *   safety     a settings or shell-startup file, `&`, a dangerous removal, a blocked read. No rule clears it and a
 *              whole-tool allow does not. Only bypass does, except for a breaker that is bypass-immune (see breakers.ts).
 *   path       an operand the check cannot place inside the working directories, or cannot resolve.
 *              A whole-tool allow clears it. A prefix or exact rule does not.
 *   construct  an option or program text that runs another program or writes a file.
 *              An exact rule clears it too. A prefix rule does not.
 *   approval   nothing is wrong, the command only needs a yes. Any rule clears it, and so does the read-only table.
 */

import { dirname, resolve } from "node:path";
import { type Breaker, isBypassImmune, READ_BLOCK_MESSAGE, unanalyzableUnderReadBlock } from "./breakers.ts";
import { canonicalPath, editSafetyMessage, insideDirectories } from "./paths.ts";
import type { CommandEffect } from "./read-only.ts";

export type Tier = "safety" | "path" | "construct" | "approval";

export type Verdict =
	| { readonly kind: "none" }
	| { readonly kind: "allowed" }
	| { readonly kind: "ask"; readonly tier: Tier; readonly message?: string; readonly breaker?: Breaker };

export interface Scope {
	readonly directories: readonly string[];
	readonly cwd: string;
	readonly home: string;
	readonly acceptEdits: boolean;
	/** `permissions.blockReadsOutsideWorkingDirectories`: a read outside the working directories asks and bypass does not clear it. */
	readonly blockReads?: boolean;
}

const NONE: Verdict = { kind: "none" };
const TIER_ORDER: readonly Tier[] = ["approval", "construct", "path", "safety"];

/**
 * How hard a verdict is to clear. An ask outranks an allowed, which outranks none, and among asks the
 * tier decides, with a bypass-immune breaker above every other safety check. Precedence is this
 * number alone, so no check order can let a milder verdict win.
 */
export function severity(verdict: Verdict): number {
	if (verdict.kind === "none") return -1;
	if (verdict.kind === "allowed") return 0;
	return (TIER_ORDER.indexOf(verdict.tier) + 1) * 2 + (isBypassImmune(verdict.breaker) ? 1 : 0);
}

/** The verdict that is hardest to clear, the first of them on a tie. */
export function strictest(verdicts: readonly Verdict[]): Verdict {
	let found: Verdict = NONE;
	let rank = -1;
	for (const verdict of verdicts) {
		const here = severity(verdict);
		if (here > rank) {
			found = verdict;
			rank = here;
		}
	}
	return found;
}

const VARIABLE = "A variable in this command can't be checked before it runs";
const EXPANSION = "Shell expansion syntax in paths requires manual approval";
const CONCATENATION = "Redirect target concatenation contains $/` \u2014 unanalyzable gap or substitution";
const GLOB_WRITE = "Glob patterns are not allowed in write operations. Please specify an exact file path.";

const READ_VERBS: Readonly<Record<string, string>> = {
	cat: "concatenate files from",
	ls: "list files in",
	grep: "search for patterns in files from",
};

const OUTSIDE_NOTE = (cwd: string): string =>
	`The path is outside the working directories for this session ('${cwd}').`;
const INSIDE_NOTE = (cwd: string): string =>
	`The path is inside the working directories for this session ('${cwd}'), and Claude Code asks before a shell command creates, changes or removes files there.`;

function quotedDirectories(scope: Scope): string {
	return scope.directories.map((directory) => `'${directory}'`).join(", ");
}

const GLOB_CHARACTER = /[*?[]/;
const EXPANDED_AT_RUNTIME = /[$`]/;

/** `~`, `~/x`, `$HOME/x` and `${HOME}/x` with the home directory put in, or undefined when the path starts otherwise. */
function expandHome(path: string, home: string, variables: boolean): string | undefined {
	const tilde = /^~(?=\/|$)/.exec(path);
	if (tilde) return home + path.slice(1);
	const variable = variables ? /^\$(?:HOME|\{HOME\})(?=\/|$)/.exec(path) : null;
	return variable ? home + path.slice(variable[0].length) : undefined;
}

/** The ask for a read the read block does not allow. Nothing but a person's answer clears it, bypass included. */
const READ_BLOCKED: Verdict = {
	kind: "ask",
	tier: "safety",
	message: READ_BLOCK_MESSAGE,
	breaker: "outsideReadsBlocked",
};

function unanalyzable(message: string, scope: Scope): Verdict {
	if (!scope.blockReads) return { kind: "ask", tier: "path", message };
	return {
		kind: "ask",
		tier: "safety",
		message: unanalyzableUnderReadBlock(message),
		breaker: "outsideReadsBlocked",
	};
}

function landing(path: string, scope: Scope): string {
	return canonicalPath(path, scope.cwd);
}

function unsafeWrite(path: string, scope: Scope): string | undefined {
	return editSafetyMessage(resolve(scope.cwd, path)) ?? editSafetyMessage(landing(path, scope));
}

/** The directory a glob lists: everything before the first glob character, up to its last slash. */
function globDirectory(path: string): string {
	const prefix = path.slice(0, path.search(GLOB_CHARACTER));
	return prefix.endsWith("/") ? prefix : dirname(prefix === "" ? "." : prefix);
}

/** What a read-only command's file operands may name. */
export function readOperandVerdict(head: string, operands: readonly string[], scope: Scope): Verdict {
	const verb = READ_VERBS[head];
	const textOnly = head === "echo" || head === "printf";
	for (const operand of operands) {
		const home = expandHome(operand, scope.home, true);
		const written = home ?? operand;
		if (EXPANDED_AT_RUNTIME.test(written)) {
			if (textOnly) return { kind: "ask", tier: "approval" };
			return unanalyzable(VARIABLE, scope);
		}
		if (textOnly) continue;
		const place = GLOB_CHARACTER.test(written) ? globDirectory(written) : written;
		const absolute = landing(place, scope);
		if (insideDirectories(scope.directories, absolute)) continue;
		if (scope.blockReads) return READ_BLOCKED;
		return { kind: "ask", tier: "path", message: blockedRead(head, verb, absolute, scope) };
	}
	return NONE;
}

function blockedRead(head: string, verb: string | undefined, absolute: string, scope: Scope): string | undefined {
	if (verb === undefined) return undefined;
	return `${head} in '${absolute}' was blocked. For security, Claude Code may only ${verb} the allowed working directories for this session: ${quotedDirectories(scope)}.`;
}

/** What a command that writes files may name. Reads are held to the same directories. */
export function fileOperandVerdict(
	head: string,
	effect: Pick<CommandEffect, "reads" | "writes">,
	scope: Scope,
): Verdict {
	if (effect.writes.length === 0) return NONE;
	const resolved: string[] = [];
	for (const operand of [...effect.reads, ...effect.writes]) {
		const written = expandHome(operand, scope.home, true) ?? operand;
		if (EXPANDED_AT_RUNTIME.test(written)) return { kind: "ask", tier: "path", message: VARIABLE };
		if (GLOB_CHARACTER.test(written)) return { kind: "ask", tier: "path", message: GLOB_WRITE };
		resolved.push(written);
	}
	const writes = resolved.slice(effect.reads.length);
	for (const path of writes) {
		const unsafe = unsafeWrite(path, scope);
		if (unsafe !== undefined) return { kind: "ask", tier: "safety", message: unsafe };
	}
	const absolute = resolved.map((path) => landing(path, scope));
	if (
		scope.blockReads &&
		absolute.slice(0, effect.reads.length).some((path) => !insideDirectories(scope.directories, path))
	)
		return READ_BLOCKED;
	const outside = absolute.find((path) => !insideDirectories(scope.directories, path));
	if (outside !== undefined) {
		return {
			kind: "ask",
			tier: "path",
			message: `${head} in '${outside}' needs approval. ${OUTSIDE_NOTE(scope.cwd)} Allowing runs the command as written.`,
		};
	}
	if (scope.acceptEdits) return { kind: "allowed" };
	const first = absolute[effect.reads.length] ?? "";
	return {
		kind: "ask",
		tier: "approval",
		message: `${head} in '${first}' needs approval. ${INSIDE_NOTE(scope.cwd)}`,
	};
}

export function inputRedirectionVerdict(target: string, scope: Scope): Verdict {
	const written = expandHome(target, scope.home, false) ?? target;
	if (EXPANDED_AT_RUNTIME.test(written)) return unanalyzable(VARIABLE, scope);
	if (GLOB_CHARACTER.test(written)) return { kind: "ask", tier: "path", message: EXPANSION };
	const absolute = landing(written, scope);
	if (insideDirectories(scope.directories, absolute)) return NONE;
	if (scope.blockReads) return READ_BLOCKED;
	return {
		kind: "ask",
		tier: "path",
		message: `Input redirection from '${absolute}' was blocked. For security, Claude Code may only read files in the allowed working directories for this session: ${quotedDirectories(scope)}.`,
	};
}

export function outputRedirectionVerdict(target: string, scope: Scope): Verdict {
	const home = expandHome(target, scope.home, false);
	if (home !== undefined) {
		const unsafe = unsafeWrite(home, scope);
		return unsafe === undefined
			? { kind: "ask", tier: "path", message: EXPANSION }
			: { kind: "ask", tier: "safety", message: unsafe };
	}
	if (/^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(target)) return { kind: "ask", tier: "path", message: VARIABLE };
	if (EXPANDED_AT_RUNTIME.test(target)) return { kind: "ask", tier: "path", message: CONCATENATION };
	if (GLOB_CHARACTER.test(target)) return { kind: "ask", tier: "path", message: EXPANSION };
	const unsafe = unsafeWrite(target, scope);
	if (unsafe !== undefined) return { kind: "ask", tier: "safety", message: unsafe };
	const absolute = landing(target, scope);
	if (!insideDirectories(scope.directories, absolute)) {
		return {
			kind: "ask",
			tier: "path",
			message: `Output redirection to '${absolute}' needs approval. ${OUTSIDE_NOTE(scope.cwd)} Allowing runs the command as written.`,
		};
	}
	if (scope.acceptEdits) return { kind: "allowed" };
	return {
		kind: "ask",
		tier: "approval",
		message: `Output redirection to '${absolute}' needs approval. ${INSIDE_NOTE(scope.cwd)}`,
	};
}

const FIND_UNSAFE_OPTIONS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-rm",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
	"-files0-from",
]);

const JQ_DANGEROUS_OPTION = /^(?:-[A-Za-z]*[fL]|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/;
const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);
const AWK_UNCHECKABLE_OPTION = /^-[bcCghIkMnNOPrsStV]*[fEileDW]|^--(?:fil|e|i|lo|s|de)/;

/** Whether the command text has `*`, `?` or a `[...]` outside quotes, which the shell expands before the command runs. */
function hasUnquotedGlob(text: string): boolean {
	let quote: string | undefined;
	let bracket = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (quote !== undefined) {
			if (char === "\\" && quote === '"') index++;
			else if (char === quote) quote = undefined;
		} else if (char === "\\") index++;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "*" || char === "?") return true;
		else if (char === "[") bracket = true;
		else if (char === "]" && bracket) return true;
	}
	return false;
}

function awkProgramRefusal(program: string): string | undefined {
	if (/(?<![A-Za-z_])system[\s\\]*\(/.test(program))
		return "awk program contains system() which executes arbitrary commands";
	if (/(?:^|[^|])\|&?[^/|%";#{}]*"/.test(program) || /(?:^|[^|])\|&?[\s\\]*getline\b/.test(program))
		return 'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands';
	if (/@[\s\\]*(?:load|include)\b|@[\s\\]*\w+(?:::\w+)?(?:\[[^\]]*\])*[\s\\]*\(/.test(program))
		return "awk program contains @load/@include or an @indirect call which can execute arbitrary code";
	if (/(?<![A-Za-z_])extension[\s\\]*\(/.test(program))
		return "awk program contains extension() which loads arbitrary native code (legacy gawk)";
	if (/"\/inet[46]?\//.test(program))
		return "awk program opens a gawk /inet/ network socket which can exfiltrate data";
	return undefined;
}

/** The options and program text that make `find`, `jq` and `awk` run another program or write a file. */
export function constructVerdict(words: readonly string[], text: string): Verdict {
	const message = constructRefusal(words, text);
	return message === undefined ? NONE : { kind: "ask", tier: "construct", message };
}

function constructRefusal(words: readonly string[], text: string): string | undefined {
	const [head = "", ...args] = words;
	if (head === "find") {
		const option = args.find((word) => FIND_UNSAFE_OPTIONS.has(word));
		if (option !== undefined)
			return `find with '${option}' executes commands or modifies files \u2014 cannot be auto-allowed by a Bash(find:*) prefix rule`;
		if (hasUnquotedGlob(text))
			return "find contains unquoted glob characters \u2014 could glob-expand to a dangerous action before find runs";
	}
	if (head === "jq") {
		if (args.some((arg) => /\bsystem\s*\(/.test(arg)))
			return "jq command contains system() function which executes arbitrary commands";
		if (args.some((arg) => /\b(?:include|import)\b/.test(arg)))
			return 'jq command contains include/import \u2014 modules can load arbitrary .jq files via {search:"."} and call env or other builtins';
		if (args.some((arg) => JQ_DANGEROUS_OPTION.test(arg)))
			return "jq command contains dangerous flags that could execute code or read arbitrary files";
	}
	if (AWK_COMMANDS.has(head)) {
		if (hasUnquotedGlob(text))
			return "awk command contains unquoted glob characters \u2014 could glob-expand to a planted program or flag before awk runs";
		for (const arg of args) {
			const refusal = awkProgramRefusal(arg);
			if (refusal !== undefined) return refusal;
		}
		if (args.some((arg) => AWK_UNCHECKABLE_OPTION.test(arg)))
			return "awk has an option that can't be checked before it runs";
	}
	return undefined;
}
