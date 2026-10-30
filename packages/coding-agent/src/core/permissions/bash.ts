/**
 * The Bash tool's own permission check: split a command line into its simple commands, match the
 * rules against each command as written, and decide the commands no rule covers.
 *
 * "As written" is the rule semantics Claude Code measures: `Bash(echo:*)` authorizes `echo hi` and
 * not `/bin/echo hi`, `FOO=1 echo hi`, `time echo hi` or `\echo hi`. Deny and ask rules also look
 * through env assignments and wrappers, so a wrapper cannot hide a denied command.
 *
 * What a command must not do is not decided here. `command-safety.ts` gives each simple command and
 * each redirection a verdict from its words alone, and a rule or the read-only table only answers
 * what that verdict leaves open, as far as the verdict's tier allows. Full shell analysis
 * (heredocs, process substitution, the remaining commands) belongs to the Bash unit.
 */

import { homedir } from "node:os";
import { type Breaker, isBypassImmune, unanalyzableUnderReadBlock } from "./breakers.ts";
import {
	constructVerdict,
	fileOperandVerdict,
	inputRedirectionVerdict,
	outputRedirectionVerdict,
	readOperandVerdict,
	type Scope,
	severity,
	strictest,
	type Tier,
	type Verdict,
} from "./command-safety.ts";
import { commandEffect } from "./read-only.ts";
import { dangerousRemoval } from "./removal.ts";
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
	const read = readWord(command, end, (char) => /[\s;&|<>()]/.test(char));
	const word = read.word;
	end = read.end;
	const base = { before: stripped, heredoc: false, end };
	if (operator === "<<<" || word === "" || NON_FILES.has(word)) return base;
	if (duplicating) {
		const writesFile = operator === ">" && !FD_WORD.test(word);
		return writesFile ? { ...base, target: word } : base;
	}
	if (operator === "<") return { ...base, target: word, reads: true };
	return { ...base, target: word };
}

const DOUBLE_QUOTE_ESCAPES = '$`"\\\n';

/**
 * One shell word starting at `start`, with its quotes and backslashes taken out, ending at the first
 * unquoted character `stopsAt` accepts. Words and redirection targets both come from here, so a
 * spelling means the same file in either place.
 */
function readWord(text: string, start: number, stopsAt: (char: string) => boolean): { word: string; end: number } {
	let word = "";
	let quote: string | undefined;
	let index = start;
	for (; index < text.length; index++) {
		const char = text[index] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && char === "\\" && DOUBLE_QUOTE_ESCAPES.includes(text[index + 1] ?? ""))
				word += text[++index];
			else word += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (char === "\\" && index + 1 < text.length) word += text[++index];
		else if (stopsAt(char)) break;
		else word += char;
	}
	return { word, end: index };
}

export function shellWords(part: string): string[] {
	const words: string[] = [];
	let index = 0;
	while (index < part.length) {
		if (/\s/.test(part[index] as string)) index++;
		else {
			const read = readWord(part, index, (char) => /\s/.test(char));
			words.push(read.word);
			index = read.end;
		}
	}
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

export type SubcommandVerdict =
	| { readonly kind: "allowed"; readonly rule?: PermissionRule; readonly readOnly: boolean }
	| { readonly kind: "ask"; readonly tier: Tier; readonly message?: string; readonly breaker?: Breaker };

export interface BashCheckInput {
	readonly command: string;
	readonly deny: readonly PermissionRule[];
	readonly ask: readonly PermissionRule[];
	readonly allow: readonly PermissionRule[];
	readonly acceptEdits: boolean;
	readonly directories: readonly string[];
	readonly cwd: string;
	readonly home?: string;
	readonly blockReads?: boolean;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export type BashCheck =
	| { readonly behavior: "deny"; readonly message: string; readonly rule?: PermissionRule }
	| {
			readonly behavior: "ask";
			readonly message: string | undefined;
			readonly rule?: PermissionRule;
			readonly safety?: boolean;
			readonly breaker?: Breaker;
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
	const scope: Scope = {
		directories: input.directories,
		cwd: input.cwd,
		home: input.home ?? homedir(),
		acceptEdits: input.acceptEdits,
		blockReads: input.blockReads === true,
	};
	const judged: Judged[] = [
		...parsed.parts.map((part) => ({ subject: part, verdict: checkPart(part, input, scope) })),
		...parsed.readTargets.map((target) => ({
			subject: target,
			verdict: ruled(inputRedirectionVerdict(target, scope), true),
		})),
		...parsed.writeTargets.map((target) => ({
			subject: target,
			verdict: ruled(outputRedirectionVerdict(target, scope), false),
		})),
	];
	const structural = structuralAsk(parsed, scope);
	// Measured: claude reads no path or redirection inside a group or substitution, so only a breaker
	// that is bypass-immune (a removal, the read block) can still be seen there.
	const blind = structural !== undefined && structural.tier !== "safety";
	const pending = judged.filter(
		({ verdict }) => verdict.kind === "ask" && !(blind && !isBypassImmune(verdict.breaker)),
	);
	const removal = removalAsk(command, input, scope);
	const worstPending = Math.max(-1, ...pending.map(({ verdict }) => severity(verdict)));
	if (removal && severity(removal) >= Math.max(worstPending, structural ? severity(structural) : -1)) {
		return { behavior: "ask", message: removal.message, safety: true, breaker: removal.breaker };
	}
	if (
		structural &&
		(severity(structural) > worstPending || (severity(structural) === worstPending && structural.tier !== "safety"))
	) {
		return {
			behavior: "ask",
			message: structural.message,
			safety: structural.tier === "safety",
			...(structural.breaker ? { breaker: structural.breaker } : {}),
		};
	}
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
	const worst = strictest(pending.map(({ verdict }) => verdict));
	const safety = worst.kind === "ask" && worst.tier === "safety";
	const breaker = worst.kind === "ask" ? worst.breaker : undefined;
	const named =
		pending.length === 1 &&
		only?.kind === "ask" &&
		only.message !== undefined &&
		only.breaker !== "outsideReadsBlocked";
	if (judged.length === 1 || named) {
		return {
			behavior: "ask",
			message: (only?.kind === "ask" ? only.message : undefined) ?? NEEDS_APPROVAL,
			safety,
			...(breaker ? { breaker } : {}),
		};
	}
	const subjects = pending.map(({ subject }) => subject);
	const part = subjects.length === 1 ? "part requires" : "parts require";
	return {
		behavior: "ask",
		message: `This Bash command contains multiple operations. The following ${part} approval: ${subjects.join(", ")}`,
		safety,
		...(breaker ? { breaker } : {}),
	};
}

type AskVerdict = Extract<Verdict, { kind: "ask" }> & { readonly message: string };

function removalAsk(command: string, input: BashCheckInput, scope: Scope): AskVerdict | undefined {
	const found = dangerousRemoval(command, {
		cwd: input.cwd,
		home: scope.home,
		directories: input.directories,
		env: input.env ?? process.env,
	});
	return found ? { kind: "ask", tier: "safety", message: found.message, breaker: "dangerousRemoval" } : undefined;
}

function structuralAsk(parsed: ParsedCommand, scope: Scope): AskVerdict | undefined {
	if (parsed.nested) {
		const message = "A nested command in this command can't be checked before it runs";
		return scope.blockReads
			? { kind: "ask", tier: "safety", message: unanalyzableUnderReadBlock(message), breaker: "outsideReadsBlocked" }
			: { kind: "ask", tier: "path", message };
	}
	if (parsed.grouped)
		return {
			kind: "ask",
			tier: "path",
			message: "This command uses shell operators that require approval for safety",
		};
	if (parsed.background) {
		return {
			kind: "ask",
			tier: "safety",
			message:
				"This command uses the `&` background operator, which defers execution past approval-time safety checks. Approve only if you trust it.",
			breaker: "backgroundOperator",
		};
	}
	return undefined;
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

function ruled(verdict: Verdict, readOnly: boolean): SubcommandVerdict {
	if (verdict.kind === "ask")
		return { kind: "ask", tier: verdict.tier, message: verdict.message, breaker: verdict.breaker };
	return { kind: "allowed", readOnly };
}

/**
 * One simple command. Its safety verdict comes first and does not look at the rules. Only then
 * does a rule or the read-only table get to answer what is left, and each reaches only as far as
 * the verdict's tier lets it.
 */
function checkPart(part: string, input: BashCheckInput, scope: Scope): SubcommandVerdict {
	const words = shellWords(part);
	const effect = commandEffect(words);
	const head = words[0] ?? "";
	if (scope.blockReads && (head === "cd" || head === "pushd")) {
		const moved = readOperandVerdict(
			head,
			words.slice(1).filter((word) => !word.startsWith("-")),
			scope,
		);
		if (moved.kind === "ask")
			return { kind: "ask", tier: moved.tier, message: moved.message, breaker: moved.breaker };
	}
	const files = effect.readOnly
		? readOperandVerdict(head, effect.reads, scope)
		: fileOperandVerdict(head, effect, scope);
	const verdict = strictest([constructVerdict(words, part), files]);
	const rule = matchRule(input.allow, part);
	const exact = rule?.content !== undefined && ruleShape(rule.content).kind === "exact";
	if (verdict.kind === "ask") {
		const cleared = verdict.tier === "approval" ? rule !== undefined : verdict.tier === "construct" ? exact : false;
		if (!cleared) return { kind: "ask", tier: verdict.tier, message: verdict.message, breaker: verdict.breaker };
	}
	if (rule) return { kind: "allowed", rule, readOnly: effect.readOnly };
	if (verdict.kind === "allowed") return { kind: "allowed", readOnly: false };
	if (effect.readOnly) return { kind: "allowed", readOnly: true };
	return { kind: "ask", tier: "approval" };
}
