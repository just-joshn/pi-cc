/**
 * The Bash tool's own permission check: split a command line into its simple commands, match the
 * rules against each command as written, and decide the commands no rule covers.
 *
 * "As written" is the rule semantics Claude Code measures: `Bash(echo:*)` authorizes `echo hi` and
 * not `/bin/echo hi`, `FOO=1 echo hi`, `time echo hi` or `\echo hi`. Deny and ask rules also look
 * through env assignments and wrappers, so a wrapper cannot hide a denied command.
 *
 * The read-only command table, the working-directory checks and the file-command messages cover
 * what the conformance cases measure. Full shell analysis (heredocs, process substitution, the
 * remaining commands) belongs to the Bash unit.
 */

import { canonicalPath, insideDirectories } from "./paths.ts";
import type { PermissionRule } from "./rules.ts";

export interface ParsedCommand {
	/** Simple commands in order, without redirections, trimmed. */
	readonly parts: readonly string[];
	/** Every redirection target that writes a file, in order. */
	readonly writeTargets: readonly string[];
	/** `$(...)`, backticks or process substitution: a command the check cannot see. */
	readonly nested: boolean;
	/** `( ... )` grouping or a `{ ...; }` block. */
	readonly grouped: boolean;
	/** A lone `&`. */
	readonly background: boolean;
	/** A here-document, whose body the check does not read. */
	readonly heredoc: boolean;
	/**
	 * The commands inside substitutions and groups, as well as the outer ones. Deny and ask rules
	 * are matched against these, so a denied command cannot hide inside `$(...)` or `( ... )`.
	 */
	readonly looseParts: readonly string[];
}

const WRITING_OPERATORS = new Set([">", ">>", ">|", "<>"]);

/** Scans a command line once: simple commands, redirections, and what hides a command from the check. */
export function parseCommand(command: string): ParsedCommand {
	const parts: string[] = [];
	const writeTargets: string[] = [];
	const flags = { nested: false, grouped: false, background: false, heredoc: false };
	let current = "";
	let quote: string | undefined;
	const flush = (): void => {
		if (current.trim() !== "") parts.push(current.trim());
		current = "";
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index] as string;
		const next = command[index + 1];
		if (quote === "'") {
			current += char;
			if (char === "'") quote = undefined;
		} else if (char === "\\" && next !== undefined) {
			current += char + next;
			index++;
		} else if (char === "`" || (char === "$" && next === "(")) {
			flags.nested = true;
			current += char;
		} else if (quote === '"') {
			current += char;
			if (char === '"') quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if ((char === "<" || char === ">") && next === "(") {
			flags.nested = true;
			current += char;
		} else if (char === "(" || char === ")" || char === "{" || char === "}") {
			flags.grouped = true;
			current += char;
		} else if (char === "<" || char === ">") {
			const redirect = readRedirection(command, index, current);
			flags.heredoc = flags.heredoc || redirect.heredoc;
			if (redirect.target !== undefined) writeTargets.push(redirect.target);
			current = redirect.before;
			index = redirect.end - 1;
		} else if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
			flush();
			index++;
		} else if (char === ";" || char === "\n" || char === "|") {
			flush();
		} else if (char === "&" && next === ">") {
			current += char;
		} else if (char === "&") {
			flags.background = true;
			flush();
		} else current += char;
	}
	flush();
	return { parts, writeTargets, looseParts: loosePartsOf(command), ...flags };
}

/**
 * Every command that appears anywhere in the line, inside substitutions and groups too, found by
 * cutting at every shell metacharacter. It over-splits on purpose: it only feeds deny and ask rules.
 */
function loosePartsOf(command: string): string[] {
	let cut = "";
	let single = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index] as string;
		if (single) {
			cut += char;
			if (char === "'") single = false;
		} else if (char === "'") {
			single = true;
			cut += char;
		} else if (char === "\\" && command[index + 1] !== undefined) {
			cut += char + command[++index];
		} else if (char === "$" && command[index + 1] === "(") {
			cut += "\n";
			index++;
		} else if ("`(){};|&<>\n".includes(char)) cut += "\n";
		else cut += char;
	}
	return cut
		.split("\n")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

interface Redirection {
	/** The command text before the operator, without the descriptor that belonged to it. */
	readonly before: string;
	/** The file it writes, when it writes one. */
	readonly target?: string;
	readonly heredoc: boolean;
	/** The index after the redirection. */
	readonly end: number;
}

const REDIRECTION_OPERATORS = ["<<<", "<<", ">>", ">|", "<>", ">", "<"];

/** Reads the redirection that starts at `start`: `>`, `>>`, `>|`, `<>`, `&>`, `<`, `<<`, `<<<` and `n>&m`. */
function readRedirection(command: string, start: number, before: string): Redirection {
	const operator = REDIRECTION_OPERATORS.find((candidate) => command.startsWith(candidate, start)) as string;
	let end = start + operator.length;
	const descriptor = /(?:^|\s)(\d+|&)$/.exec(before);
	const stripped = descriptor ? before.slice(0, before.length - (descriptor[1] as string).length) : before;
	if (operator === "<<") return { before: stripped, heredoc: true, end };
	if (command[end] === "&" && operator !== "<<<") {
		end++;
		while (end < command.length && /[\d-]/.test(command[end] as string)) end++;
		return { before: stripped, heredoc: false, end };
	}
	while (command[end] === " " || command[end] === "\t") end++;
	let word = "";
	let quote: string | undefined;
	for (; end < command.length; end++) {
		const char = command[end] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else word += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (/[\s;&|<>()]/.test(char)) break;
		else word += char;
	}
	const writes = WRITING_OPERATORS.has(operator) || descriptor?.[1] === "&";
	return {
		before: stripped,
		...(writes && word !== "" && word !== "/dev/null" ? { target: word } : {}),
		heredoc: false,
		end,
	};
}

/** Shell words with quotes removed. `$` and glob characters are kept as written. */
export function shellWords(part: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: string | undefined;
	for (let index = 0; index < part.length; index++) {
		const char = part[index] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && char === "\\" && index + 1 < part.length) word += part[++index];
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && index + 1 < part.length) {
			word += part[++index];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (started) words.push(word);
	return words;
}

// -- rules ----------------------------------------------------------------------------------------

type RuleShape =
	| { readonly kind: "exact"; readonly command: string }
	| { readonly kind: "prefix"; readonly prefix: string }
	| { readonly kind: "wildcard"; readonly pattern: RegExp };

function ruleShape(content: string): RuleShape {
	if (content.endsWith(":*") && !content.slice(0, -2).includes("*")) {
		return { kind: "prefix", prefix: content.slice(0, -2).replace(/[ \t]+/g, " ") };
	}
	if (content.includes("*")) {
		const source = content
			.split("*")
			.map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return { kind: "wildcard", pattern: new RegExp(`^${source}$`, "s") };
	}
	return { kind: "exact", command: content };
}

function shapeMatches(shape: RuleShape, command: string): boolean {
	const normal = command.replace(/[ \t]+/g, " ");
	switch (shape.kind) {
		case "exact":
			return shape.command === command || shape.command === normal;
		case "prefix":
			return normal === shape.prefix || normal.startsWith(`${shape.prefix} `);
		case "wildcard":
			return shape.pattern.test(normal);
	}
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)*\s+/;
const WRAPPERS =
	/^(?:command|builtin|nohup|time|exec|env|sudo|doas|pkexec|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|timeout(?:\s+-\S+)*\s+\S+|stdbuf(?:\s+-\S+)*)\s+(?:-\S+\s+)*/;

/**
 * The spellings of a command a deny or ask rule is tried against: as written, with its quotes and
 * backslashes removed, and each of those with env assignments and wrappers peeled off.
 */
function looseSpellings(command: string): string[] {
	const spellings = new Set<string>();
	for (const start of [command, shellWords(command).join(" ")]) {
		let current = start;
		spellings.add(current);
		for (let guard = 0; guard < 8; guard++) {
			const stripped = current.replace(ENV_ASSIGNMENT, "").replace(WRAPPERS, "");
			if (stripped === current) break;
			spellings.add(stripped);
			spellings.add(shellWords(stripped).join(" "));
			current = stripped;
		}
	}
	return [...spellings];
}

/** The first rule that matches the command. Deny and ask rules see through wrappers, allow rules do not. */
export function matchRule(rules: readonly PermissionRule[], command: string): PermissionRule | undefined {
	return rules.find((rule) => {
		if (rule.content === undefined) return false;
		const shape = ruleShape(rule.content);
		const candidates = rule.behavior === "allow" ? [command] : looseSpellings(command);
		return candidates.some((candidate) => shapeMatches(shape, candidate));
	});
}

// -- read-only and file commands --------------------------------------------------------------------

/** What each command does to a path operand, in the words of the refusal for a path outside the working directories. */
const READ_VERBS: Readonly<Record<string, string>> = {
	cat: "concatenate files from",
	ls: "list files in",
	grep: "search for patterns in files from",
};

const READ_ONLY_COMMANDS = new Set([
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"find",
	"ls",
	"date",
	"whoami",
	"uname",
	"which",
	"sort",
	"cut",
	"tr",
	"stat",
	"file",
	"du",
	"echo",
	"printf",
	"true",
	"false",
	"sleep",
	"test",
	"[",
	"diff",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"jq",
	"tree",
	"uniq",
]);

const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe"]);
/** Options that make an otherwise read-only git command write a file or run a program. */
const GIT_WRITING_OPTION = /^(?:--output|--ext-diff|--textconv|--exec|-o)/;
/** Commands whose `-oFILE` or `--output` writes a file. */
const OUTPUT_FLAG_COMMANDS = new Set(["sort", "tree"]);
const PRINT_SCRIPT = /^(?:\$|\d+)(?:,(?:\$|\d+))?p$/;
const FIND_WRITES = /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/;
const VERSION_ONLY = new Set(["node", "python", "python3"]);

/** Commands whose operands are files the command creates, changes or removes. acceptEdits allows them inside the working directories. */
const FILE_COMMANDS = new Set(["touch", "mkdir", "rm", "rmdir", "mv", "cp", "sed"]);

function isReadOnly(words: readonly string[]): boolean {
	const [head = "", ...args] = words;
	if (READ_ONLY_COMMANDS.has(head)) {
		if (head === "find") return !args.some((arg) => FIND_WRITES.test(arg));
		return !(OUTPUT_FLAG_COMMANDS.has(head) && args.some((arg) => /^(?:--output|-o)/.test(arg)));
	}
	if (head === "git") {
		const subcommand = args[0] ?? "";
		if (READ_ONLY_GIT.has(subcommand)) return !args.slice(1).some((arg) => GIT_WRITING_OPTION.test(arg));
		if (subcommand === "branch" || subcommand === "remote")
			return args
				.slice(1)
				.every(
					(arg) =>
						arg.startsWith("-") && !/^-[a-zA-Z]*[dDmMfcC]|^--(?:delete|move|copy|force|set-upstream)/.test(arg),
				);
		return subcommand === "config" && args[1] === "--get";
	}
	if (head === "sed") return args.length === 3 && args[0] === "-n" && PRINT_SCRIPT.test(args[1] ?? "");
	if (VERSION_ONLY.has(head))
		return args.length === 1 && (args[0] === "--version" || args[0] === "-v" || args[0] === "-V");
	return false;
}

/** The operands of a command that name files. `grep` takes its pattern first. */
function pathOperands(words: readonly string[]): string[] {
	const [head = "", ...args] = words;
	const operands = args.filter((arg) => !arg.startsWith("-"));
	return head === "grep" ? operands.slice(1) : operands;
}

function hasUnresolvable(path: string): boolean {
	return /[$`*?[]|^~/.test(path);
}

/** The path an operand names, as it really lands. Refusals name this path, as Claude Code's do. */
function absoluteOperand(path: string, cwd: string): string {
	return canonicalPath(path, cwd);
}

// -- the check --------------------------------------------------------------------------------------

export type SubcommandVerdict =
	| { readonly kind: "allowed"; readonly rule?: PermissionRule }
	| { readonly kind: "blocked"; readonly message: string }
	| { readonly kind: "needs-approval"; readonly message?: string; readonly rule?: PermissionRule };

export interface BashCheckInput {
	readonly command: string;
	readonly deny: readonly PermissionRule[];
	readonly ask: readonly PermissionRule[];
	readonly allow: readonly PermissionRule[];
	readonly acceptEdits: boolean;
	readonly directories: readonly string[];
	readonly cwd: string;
}

export type BashCheck =
	| { readonly behavior: "deny"; readonly message: string; readonly rule?: PermissionRule }
	| { readonly behavior: "ask"; readonly message: string | undefined; readonly rule?: PermissionRule }
	| { readonly behavior: "allow"; readonly rule?: PermissionRule };

const NEEDS_APPROVAL = "This command requires approval";

/** Checks one Bash command against the rules, the read-only table and the mode. */
export function checkBash(input: BashCheckInput): BashCheck {
	const command = input.command.trim();
	const parsed = parseCommand(command);
	const denied = firstMatch(input.deny, command, parsed);
	if (denied) {
		return {
			behavior: "deny",
			rule: denied,
			message: `Permission to use Bash with command ${command} has been denied.`,
		};
	}
	const asked = firstMatch(input.ask, command, parsed);
	if (asked) return { behavior: "ask", rule: asked, message: undefined };
	if (parsed.nested)
		return { behavior: "ask", message: "A nested command in this command can't be checked before it runs" };
	if (parsed.grouped)
		return { behavior: "ask", message: "This command uses shell operators that require approval for safety" };
	if (parsed.background) {
		return {
			behavior: "ask",
			message: "This command uses the `&` background operator, which defers execution past approval",
		};
	}
	const judged: Judged[] = [
		...parsed.parts.map((part) => ({ subject: part, verdict: checkPart(part, input) })),
		...parsed.writeTargets.map((target) => ({ subject: target, verdict: checkRedirection(target, input) })),
	];
	const blocked = judged.find(({ verdict }) => verdict.kind === "blocked");
	if (blocked?.verdict.kind === "blocked") return { behavior: "deny", message: blocked.verdict.message };
	const pending = judged.filter(({ verdict }) => verdict.kind === "needs-approval");
	if (pending.length === 0) {
		const rule = judged
			.map(({ verdict }) => (verdict.kind === "allowed" ? verdict.rule : undefined))
			.find((found) => found !== undefined);
		return rule ? { behavior: "allow", rule } : { behavior: "allow" };
	}
	const only = pending[0]?.verdict;
	if (judged.length === 1 || (pending.length === 1 && only?.kind === "needs-approval" && only.message !== undefined)) {
		return {
			behavior: "ask",
			message: (only?.kind === "needs-approval" ? only.message : undefined) ?? NEEDS_APPROVAL,
		};
	}
	const subjects = pending.map(({ subject }) => subject);
	const part = subjects.length === 1 ? "part requires" : "parts require";
	return {
		behavior: "ask",
		message: `This Bash command contains multiple operations. The following ${part} approval: ${subjects.join(", ")}`,
	};
}

interface Judged {
	readonly subject: string;
	readonly verdict: SubcommandVerdict;
}

function firstMatch(
	rules: readonly PermissionRule[],
	whole: string,
	parsed: ParsedCommand,
): PermissionRule | undefined {
	const spellings = [whole, ...parsed.parts, ...parsed.looseParts];
	return spellings.map((spelling) => matchRule(rules, spelling)).find((rule) => rule !== undefined);
}

function checkPart(part: string, input: BashCheckInput): SubcommandVerdict {
	const rule = matchRule(input.allow, part);
	if (rule) return { kind: "allowed", rule };
	const words = shellWords(part);
	const head = words[0] ?? "";
	if (isReadOnly(words)) return checkReadOperands(head, words, input);
	if (
		FILE_COMMANDS.has(head) &&
		!(head === "sed" && !words.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place"))
	) {
		return checkFileOperands(head, words, input);
	}
	return { kind: "needs-approval" };
}

function checkReadOperands(head: string, words: readonly string[], input: BashCheckInput): SubcommandVerdict {
	const operands = pathOperands(words);
	if (operands.some(hasUnresolvable)) return { kind: "needs-approval" };
	for (const operand of operands) {
		const absolute = absoluteOperand(operand, input.cwd);
		const verb = READ_VERBS[head];
		if (!insideDirectories(input.directories, absolute) && head !== "echo" && head !== "printf") {
			if (verb === undefined) return { kind: "needs-approval" };
			return {
				kind: "blocked",
				message: `${head} in '${absolute}' was blocked. For security, Claude Code may only ${verb} the allowed working directories for this session: ${input.directories.map((d) => `'${d}'`).join(", ")}.`,
			};
		}
	}
	return { kind: "allowed" };
}

function checkFileOperands(head: string, words: readonly string[], input: BashCheckInput): SubcommandVerdict {
	const operands = words.slice(1).filter((word) => !word.startsWith("-"));
	const targets = (head === "sed" ? operands.slice(1) : operands).map((operand) => ({
		operand,
		absolute: absoluteOperand(operand, input.cwd),
	}));
	if (targets.length === 0 || targets.some((target) => hasUnresolvable(target.operand)))
		return { kind: "needs-approval" };
	const outside = targets.find((target) => !insideDirectories(input.directories, target.absolute));
	if (outside) {
		return {
			kind: "needs-approval",
			message: `${head} in '${outside.absolute}' needs approval. The path is outside the working directories for this session ('${input.cwd}'). Allowing runs the command as written.`,
		};
	}
	if (input.acceptEdits) return { kind: "allowed" };
	const first = targets[0];
	return { kind: "needs-approval", message: fileCommandAsk(head, first?.absolute ?? "", input.cwd) };
}

function checkRedirection(target: string, input: BashCheckInput): SubcommandVerdict {
	if (hasUnresolvable(target)) return { kind: "needs-approval" };
	const absolute = absoluteOperand(target, input.cwd);
	if (!insideDirectories(input.directories, absolute)) {
		return {
			kind: "needs-approval",
			message: `Output redirection to '${absolute}' needs approval. The path is outside the working directories for this session ('${input.cwd}'). Allowing runs the command as written.`,
		};
	}
	if (input.acceptEdits) return { kind: "allowed" };
	return { kind: "needs-approval", message: redirectionAsk(absolute, input.cwd) };
}

const INSIDE_NOTE = (cwd: string): string =>
	`The path is inside the working directories for this session ('${cwd}'), and Claude Code asks before a shell command creates, changes or removes files there.`;

function fileCommandAsk(command: string, absolute: string, cwd: string): string {
	return `${command} in '${absolute}' needs approval. ${INSIDE_NOTE(cwd)}`;
}

function redirectionAsk(absolute: string, cwd: string): string {
	return `Output redirection to '${absolute}' needs approval. ${INSIDE_NOTE(cwd)}`;
}
