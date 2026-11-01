/**
 * The dangerous-removal breaker: `rm` and `rmdir` commands whose target is a critical directory, a
 * workspace directory or one of its parents, or a path the check cannot place.
 *
 * Claude Code finds these in every nested command of a line (groups, substitutions, loop bodies,
 * `bash -c` scripts, `eval`) and holds them against every rule and, unless the operator waived the
 * check, against `bypassPermissions` too. The words below are Claude Code's own.
 *
 * The line is parsed (`shell-syntax.ts`) and its variable flow read from the tree (`shell-flow.ts`). This
 * module decides what each removal command targets.
 *
 * Invariant: when the model is unsure what a variable holds, its value is unknown and a target that uses
 * it is refused. A stricter ask is recorded debt; an allow where Claude Code asks is a safety bug.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { canonicalPath, isInside } from "./paths.ts";
import { ASSIGNMENT, commandsOf, LITERAL_DOLLAR, type SimpleCommand, type Variables, type Word } from "./shell-flow.ts";
import { parse } from "./shell-syntax.ts";

const KEYWORDS = new Set(["{", "}", "do", "then", "else", "elif", "fi", "done", "if", "while", "until", "!", "time"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "command", "builtin", "exec", "timeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_INLINE_DEPTH = 4;
const MAX_SUBSTITUTIONS = 64;

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
	const parsed = parse(line);
	if (!parsed.ok) {
		return {
			command: "rm",
			message:
				parsed.failure === "aborted"
					? "Parser aborted (timeout, resource limit, or over-length)"
					: "This command could not be checked for dangerous rm operations: the shell may read it differently than it was parsed. This requires explicit approval.",
		};
	}
	const { commands, pipeBars } = commandsOf(parsed.root, { home: scope.home });
	const found = dangerousIn(commands, scope, 0);
	if (parsed.substitutions <= MAX_SUBSTITUTIONS || found?.emptyVariable) {
		if (found?.pipedFrom !== undefined && pipeBars.length > 0 && !found.emptyVariable) {
			return { command: found.command, message: pipelineParts(line, pipeBars) };
		}
		if (found === undefined && parsed.funsubDeclares) {
			return {
				command: "rm",
				message: `This command could not be checked for dangerous rm operations: the shell may read it differently than it was parsed. This requires explicit approval.`,
			};
		}
		return found;
	}
	return {
		command: "rm",
		message: `This command contains ${parsed.substitutions} command substitutions \u2014 too many to analyze for catastrophic removals. This requires explicit approval.`,
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
			const inner = script === undefined ? undefined : parse(script);
			const found = inner?.ok
				? dangerousIn(commandsOf(inner.root, { inherited: command, home: scope.home }).commands, scope, depth + 1)
				: undefined;
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
		const target = followed(operand, line.variables);
		if (target !== operand) {
			const unplaced = inspectVariables(command, operand, line, scope);
			if (unplaced) return unplaced;
		}
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
	const variables = inspectVariables(command, operand, line, scope);
	if (variables) return variables;
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

/** A target that names a variable the shell may leave empty, or one this line set where its value is unknown. */
function inspectVariables(
	command: string,
	operand: Word,
	line: SimpleCommand,
	scope: RemovalScope,
): Removal | undefined {
	if (operand.literalDollars?.includes(0)) return undefined;
	const target = followed(operand, line.variables);
	// A literal dollar introduced by an assignment is not an inherited environment variable.
	const text = target.literalDollars?.includes(0) ? operand.text : target.text;
	return variableTarget(command, text, line, scope) ?? uncertainTarget(command, operand, line);
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
function followed(word: Word, variables: Variables): Word {
	if (variables.size === 0) return word;
	const text = word.text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string, offset: number) => {
		if (word.literalDollars?.includes(offset)) return match;
		const value = variables.get(name);
		if (value === "" && (word.text !== `$${name}` || !word.quotedDollars?.includes(offset))) return match;
		return typeof value === "string" ? value : match;
	});
	if (text === word.text) return word;
	const literalDollars: number[] = [];
	for (let index = 0; index < text.length; index++) if (text[index] === LITERAL_DOLLAR) literalDollars.push(index);
	return { ...word, text: text.replaceAll(LITERAL_DOLLAR, "$"), literalDollars };
}

function variableNames(target: string): string[] {
	const names = new Set<string>();
	for (const match of target.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g))
		names.add((match[1] ?? match[2]) as string);
	return [...names];
}
