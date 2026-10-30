/**
 * The Bash tool's own permission check: split a command line into its simple commands, match the
 * rules against each command as written, and decide the commands no rule covers.
 *
 * "As written" is the rule semantics Claude Code measures: `Bash(echo:*)` authorizes `echo hi` and
 * not `/bin/echo hi`, `FOO=1 echo hi`, `time echo hi` or `\echo hi`. Deny and ask rules also look
 * through env assignments and wrappers, so a wrapper cannot hide a denied command.
 *
 * Every file a command line touches comes out of one place: `commandEffect` for a command's own
 * operands and `parseCommand` for its redirections. Reads and writes then go through the same
 * working-directory and sensitive-file checks the file tools use. Full shell analysis (heredocs,
 * process substitution, the remaining commands) belongs to the Bash unit.
 */

import { resolve } from "node:path";
import { canonicalPath, editSafetyMessage, insideDirectories } from "./paths.ts";
import { commandEffect } from "./read-only.ts";
import type { PermissionRule } from "./rules.ts";

export interface ParsedCommand {
	readonly parts: readonly string[];
	readonly writeTargets: readonly string[];
	readonly readTargets: readonly string[];
	/** `$(...)`, backticks or process substitution: a command the check cannot see. */
	readonly nested: boolean;
	readonly grouped: boolean;
	readonly background: boolean;
	/** A here-document, whose body the check does not read. */
	readonly heredoc: boolean;
	/**
	 * The commands inside substitutions and groups, as well as the outer ones. Deny and ask rules
	 * are matched against these, so a denied command cannot hide inside `$(...)` or `( ... )`.
	 */
	readonly looseParts: readonly string[];
}

export function parseCommand(command: string): ParsedCommand {
	const parts: string[] = [];
	const writeTargets: string[] = [];
	const readTargets: string[] = [];
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
			if (redirect.target !== undefined) (redirect.reads ? readTargets : writeTargets).push(redirect.target);
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
	return { parts, writeTargets, readTargets, looseParts: loosePartsOf(command), ...flags };
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
	readonly before: string;
	readonly target?: string;
	readonly reads?: boolean;
	readonly heredoc: boolean;
	readonly end: number;
}

const REDIRECTION_OPERATORS = ["<<<", "<<", ">>", ">|", "<>", ">", "<"];
const FD_WORD = /^(?:\d+-?|-)$/;
const NON_FILES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);

function readRedirection(command: string, start: number, before: string): Redirection {
	const operator = REDIRECTION_OPERATORS.find((candidate) => command.startsWith(candidate, start)) as string;
	let end = start + operator.length;
	const descriptor = /(?:^|\s)(\d+|&)$/.exec(before);
	const stripped = descriptor ? before.slice(0, before.length - (descriptor[1] as string).length) : before;
	if (operator === "<<") return { before: stripped, heredoc: true, end };
	const duplicating = command[end] === "&" && operator !== "<<<";
	if (duplicating) end++;
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
	const base = { before: stripped, heredoc: false, end };
	if (operator === "<<<" || word === "" || NON_FILES.has(word)) return base;
	if (duplicating) {
		const writesFile = operator === ">" && !FD_WORD.test(word);
		return writesFile ? { ...base, target: word } : base;
	}
	if (operator === "<") return { ...base, target: word, reads: true };
	return { ...base, target: word };
}

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

/** What each command does to a path operand, in the words of the refusal for a path outside the working directories. */
const READ_VERBS: Readonly<Record<string, string>> = {
	cat: "concatenate files from",
	ls: "list files in",
	grep: "search for patterns in files from",
};

/** Options a prefix rule cannot auto-allow: the command runs programs or writes files with them. */
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

/** Whether the command line has `*`, `?` or a `[...]` outside quotes, which the shell expands before the command runs. */
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

/**
 * Why a prefix rule cannot allow this command as written, or undefined when it can. The commands
 * are the ones whose options or program text can run another program or write a file.
 */
function prefixRefusal(rule: PermissionRule, words: readonly string[], text: string): string | undefined {
	if (rule.content === undefined || ruleShape(rule.content).kind !== "prefix") return undefined;
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

function hasUnresolvable(path: string): boolean {
	return /[$`*?[]|^~/.test(path);
}

function absoluteOperand(path: string, cwd: string): string {
	return canonicalPath(path, cwd);
}

export type SubcommandVerdict =
	| { readonly kind: "allowed"; readonly rule?: PermissionRule; readonly readOnly: boolean }
	| { readonly kind: "blocked"; readonly message: string }
	| {
			readonly kind: "needs-approval";
			readonly message?: string;
			/** A settings or shell-startup file is involved: bypass mode may still run it. */
			readonly safety?: boolean;
	  };

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
	| {
			readonly behavior: "ask";
			readonly message: string | undefined;
			readonly rule?: PermissionRule;
			readonly safety?: boolean;
	  }
	| { readonly behavior: "allow"; readonly rule?: PermissionRule; readonly readOnly: boolean };

const NEEDS_APPROVAL = "This command requires approval";

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
		...parsed.readTargets.map((target) => ({ subject: target, verdict: checkInputRedirection(target, input) })),
		...parsed.writeTargets.map((target) => ({ subject: target, verdict: checkRedirection(target, input) })),
	];
	const blocked = judged.find(({ verdict }) => verdict.kind === "blocked");
	if (blocked?.verdict.kind === "blocked") return { behavior: "deny", message: blocked.verdict.message };
	const pending = judged.filter(({ verdict }) => verdict.kind === "needs-approval");
	if (pending.length === 0) {
		const rule = judged
			.map(({ verdict }) => (verdict.kind === "allowed" ? verdict.rule : undefined))
			.find((found) => found !== undefined);
		const readOnly =
			parsed.writeTargets.length === 0 &&
			judged.every(({ verdict }) => verdict.kind === "allowed" && verdict.readOnly);
		return rule ? { behavior: "allow", rule, readOnly } : { behavior: "allow", readOnly };
	}
	const only = pending[0]?.verdict;
	const safety = pending.some(({ verdict }) => verdict.kind === "needs-approval" && verdict.safety === true);
	if (judged.length === 1 || (pending.length === 1 && only?.kind === "needs-approval" && only.message !== undefined)) {
		return {
			behavior: "ask",
			message: (only?.kind === "needs-approval" ? only.message : undefined) ?? NEEDS_APPROVAL,
			safety,
		};
	}
	const subjects = pending.map(({ subject }) => subject);
	const part = subjects.length === 1 ? "part requires" : "parts require";
	return {
		behavior: "ask",
		message: `This Bash command contains multiple operations. The following ${part} approval: ${subjects.join(", ")}`,
		safety,
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
	const words = shellWords(part);
	const head = words[0] ?? "";
	const effect = commandEffect(words);
	const rule = matchRule(input.allow, part);
	if (rule) {
		const refusal = prefixRefusal(rule, words, part);
		if (refusal !== undefined) return { kind: "needs-approval", message: refusal };
		return { kind: "allowed", rule, readOnly: effect.readOnly };
	}
	if (effect.readOnly) return checkReadOperands(head, effect.reads, input);
	if (effect.reads.length + effect.writes.length > 0) return checkFileOperands(head, effect, input);
	return { kind: "needs-approval" };
}

function checkReadOperands(head: string, operands: readonly string[], input: BashCheckInput): SubcommandVerdict {
	if (operands.some(hasUnresolvable)) return { kind: "needs-approval" };
	for (const operand of operands) {
		const absolute = absoluteOperand(operand, input.cwd);
		const verb = READ_VERBS[head];
		if (!insideDirectories(input.directories, absolute) && head !== "echo" && head !== "printf") {
			if (verb === undefined) return { kind: "needs-approval" };
			return {
				kind: "blocked",
				message: `${head} in '${absolute}' was blocked. For security, Claude Code may only ${verb} the allowed working directories for this session: ${quotedDirectories(input)}.`,
			};
		}
	}
	return { kind: "allowed", readOnly: true };
}

function checkFileOperands(
	head: string,
	effect: { readonly reads: readonly string[]; readonly writes: readonly string[] },
	input: BashCheckInput,
): SubcommandVerdict {
	const operands = [...effect.reads, ...effect.writes];
	if (effect.writes.length === 0 || operands.some(hasUnresolvable)) return { kind: "needs-approval" };
	const absolute = operands.map((operand) => absoluteOperand(operand, input.cwd));
	const outside = absolute.find((path) => !insideDirectories(input.directories, path));
	if (outside !== undefined) {
		return {
			kind: "needs-approval",
			message: `${head} in '${outside}' needs approval. ${OUTSIDE_NOTE(input.cwd)} Allowing runs the command as written.`,
		};
	}
	const unsafe = firstUnsafeWrite(effect.writes, input);
	if (unsafe !== undefined) return { kind: "needs-approval", message: unsafe, safety: true };
	if (input.acceptEdits) return { kind: "allowed", readOnly: false };
	return { kind: "needs-approval", message: fileCommandAsk(head, absolute[0] ?? "", input.cwd) };
}

function checkInputRedirection(target: string, input: BashCheckInput): SubcommandVerdict {
	if (hasUnresolvable(target)) return { kind: "needs-approval" };
	const absolute = absoluteOperand(target, input.cwd);
	if (insideDirectories(input.directories, absolute)) return { kind: "allowed", readOnly: true };
	return {
		kind: "blocked",
		message: `Input redirection from '${absolute}' was blocked. For security, Claude Code may only read files in the allowed working directories for this session: ${quotedDirectories(input)}.`,
	};
}

function checkRedirection(target: string, input: BashCheckInput): SubcommandVerdict {
	if (hasUnresolvable(target)) return { kind: "needs-approval" };
	const absolute = absoluteOperand(target, input.cwd);
	if (!insideDirectories(input.directories, absolute)) {
		return {
			kind: "needs-approval",
			message: `Output redirection to '${absolute}' needs approval. ${OUTSIDE_NOTE(input.cwd)} Allowing runs the command as written.`,
		};
	}
	const unsafe = firstUnsafeWrite([target], input);
	if (unsafe !== undefined) return { kind: "needs-approval", message: unsafe, safety: true };
	if (input.acceptEdits) return { kind: "allowed", readOnly: false };
	return { kind: "needs-approval", message: redirectionAsk(absolute, input.cwd) };
}

function firstUnsafeWrite(operands: readonly string[], input: BashCheckInput): string | undefined {
	for (const operand of operands) {
		const written = resolve(input.cwd, operand);
		const unsafe = editSafetyMessage(written) ?? editSafetyMessage(absoluteOperand(operand, input.cwd));
		if (unsafe !== undefined) return unsafe;
	}
	return undefined;
}

function quotedDirectories(input: BashCheckInput): string {
	return input.directories.map((directory) => `'${directory}'`).join(", ");
}

const OUTSIDE_NOTE = (cwd: string): string =>
	`The path is outside the working directories for this session ('${cwd}').`;

const INSIDE_NOTE = (cwd: string): string =>
	`The path is inside the working directories for this session ('${cwd}'), and Claude Code asks before a shell command creates, changes or removes files there.`;

function fileCommandAsk(command: string, absolute: string, cwd: string): string {
	return `${command} in '${absolute}' needs approval. ${INSIDE_NOTE(cwd)}`;
}

function redirectionAsk(absolute: string, cwd: string): string {
	return `Output redirection to '${absolute}' needs approval. ${INSIDE_NOTE(cwd)}`;
}
