/**
 * The dangerous-removal breaker: `rm` and `rmdir` commands whose target is a critical directory, a
 * workspace directory or one of its parents, or a path the check cannot place.
 *
 * Claude Code finds these in every nested command of a line (groups, substitutions, loop bodies,
 * `bash -c` scripts, `eval`) and holds them against every rule and, unless the operator waived the
 * check, against `bypassPermissions` too. The words below are Claude Code's own.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { canonicalPath, isInside } from "./paths.ts";

export interface Word {
	readonly text: string;
	/** An unquoted `*`, `?` or `[`. */
	readonly glob: boolean;
}

export interface SimpleCommand {
	readonly words: readonly Word[];
	/** The command as written, for the messages that quote it. */
	readonly text: string;
}

const SUBSTITUTION = "__CMDSUB__";
const KEYWORDS = new Set(["{", "}", "do", "then", "else", "elif", "fi", "done", "if", "while", "until", "!", "time"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "command", "builtin", "exec", "timeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 4;

/** Every simple command in a line, nested ones included, with substitutions replaced by a marker. */
export function simpleCommands(line: string, depth = 0): SimpleCommand[] {
	const commands: SimpleCommand[] = [];
	if (depth > MAX_DEPTH) return commands;
	let words: Word[] = [];
	let text = "";
	let glob = false;
	let started = false;
	let commandStart = 0;
	const endWord = (): void => {
		if (started) words.push({ text, glob });
		text = "";
		glob = false;
		started = false;
	};
	const endCommand = (index: number): void => {
		endWord();
		const source = line.slice(commandStart, index).trim();
		if (words.length > 0) commands.push({ words, text: source });
		words = [];
		commandStart = index + 1;
	};
	const nested = (inner: string): void => {
		commands.push(...simpleCommands(inner, depth + 1));
		text += SUBSTITUTION;
		started = true;
	};
	let index = 0;
	while (index < line.length) {
		const char = line[index] as string;
		const next = line[index + 1];
		if (char === "\\" && next !== undefined) {
			text += next;
			started = true;
			index += 2;
		} else if (char === "'") {
			const close = line.indexOf("'", index + 1);
			const end = close === -1 ? line.length : close;
			text += line.slice(index + 1, end);
			started = true;
			index = end + 1;
		} else if (char === '"') {
			started = true;
			index++;
			while (index < line.length && line[index] !== '"') {
				const inner = line[index] as string;
				if (inner === "\\" && line[index + 1] !== undefined) {
					text += line[index + 1];
					index += 2;
				} else if (inner === "$" && line[index + 1] === "(") {
					const end = matching(line, index + 1);
					nested(line.slice(index + 2, end));
					index = end + 1;
				} else if (inner === "`") {
					const end = closingBacktick(line, index);
					nested(line.slice(index + 1, end));
					index = end + 1;
				} else {
					text += inner;
					index++;
				}
			}
			index++;
		} else if (char === "$" && next === "(") {
			const end = matching(line, index + 1);
			nested(line.slice(index + 2, end));
			index = end + 1;
		} else if (char === "`") {
			const end = closingBacktick(line, index);
			nested(line.slice(index + 1, end));
			index = end + 1;
		} else if ((char === "<" || char === ">") && next === "(") {
			const end = matching(line, index + 1);
			nested(line.slice(index + 2, end));
			index = end + 1;
		} else if (char === "<" || char === ">") {
			index = skipRedirection(line, index);
			endWord();
		} else if (char === "#" && !started) {
			const newline = line.indexOf("\n", index);
			index = newline === -1 ? line.length : newline;
		} else if (char === " " || char === "\t") {
			endWord();
			index++;
		} else if (";&|\n()".includes(char)) {
			endCommand(index);
			index++;
		} else {
			if (char === "*" || char === "?" || char === "[") glob = true;
			text += char;
			started = true;
			index++;
		}
	}
	endCommand(line.length);
	return commands;
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
function skipRedirection(line: string, start: number): number {
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
	const body = new RegExp(`^\\t*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m").exec(
		line.slice(newline + 1),
	);
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
}

export function dangerousRemoval(line: string, scope: RemovalScope): Removal | undefined {
	return dangerousIn(simpleCommands(line), scope, 0);
}

function dangerousIn(commands: readonly SimpleCommand[], scope: RemovalScope, depth: number): Removal | undefined {
	let changedDirectory = false;
	for (const command of commands) {
		const words = stripped(command.words);
		const head = basename(words[0]?.text ?? "");
		if (head === "cd" || head === "pushd") changedDirectory = true;
		if (head === "rm" || head === "rmdir") {
			const found = inspectRemoval(head, words.slice(1), command.text, changedDirectory, scope);
			if (found) return found;
		} else if (depth < MAX_DEPTH) {
			const script = inlineScript(head, words);
			const found = script === undefined ? undefined : dangerousIn(simpleCommands(script), scope, depth + 1);
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
	text: string,
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
		const emptied = operand.text.replace(/(.)(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$/, "$1$2");
		for (const candidate of emptied === operand.text ? [operand] : [{ ...operand, text: emptied }, operand]) {
			const found = inspectOperand(command, candidate, text, recursive, flags, changedDirectory, scope);
			if (found) return found;
		}
	}
	return undefined;
}

function inspectOperand(
	command: string,
	operand: Word,
	text: string,
	recursive: boolean,
	flags: readonly string[],
	changedDirectory: boolean,
	scope: RemovalScope,
): Removal | undefined {
	const variable = variableTarget(command, operand.text, text, scope);
	if (variable) return variable;
	const written = expand(operand.text, scope);
	const absolute = isAbsolute(written) ? normalize(written) : resolve(scope.cwd, written);
	let stem = absolute;
	for (let previous = ""; previous !== stem; ) {
		previous = stem;
		const cut = stem.replace(/([\\/]\*+)+[\\/]*$/, "") || "/";
		if (cut !== stem) stem = /[\\/]/.test(cut) ? normalize(cut).replace(/(.)\/$/, "$1") : cut;
	}
	const stripped = stem !== absolute;
	const wildcard = operand.glob && stripped;
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
		const real = canonicalPath(stem, scope.cwd);
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
			if (directories.some((directory) => isInside(target, directory))) {
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
	const target = flat(path);
	const trimmed = target === "/" ? target : target.replace(/\/$/, "");
	if (trimmed === "/") return true;
	if (macOS && /^\/\.(?:vol|file)(?:\/|$)/i.test(trimmed)) return true;
	const homes = new Set([flat(home).replace(/\/$/, ""), flat(canonicalPath(home, home)).replace(/\/$/, "")]);
	if (homes.has(trimmed)) return true;
	return dirname(trimmed) === "/";
}

/** A target that starts with a variable the shell may leave empty, which would remove `/` or a top-level directory. */
function variableTarget(command: string, target: string, text: string, scope: RemovalScope): Removal | undefined {
	const child = VARIABLE_ROOT_CHILD.exec(target);
	const rooted = child === null && VARIABLE_ROOT.test(target);
	if (child === null && !rooted) return undefined;
	const names = child === null ? variableNames(target) : [(child[1] ?? child[2]) as string];
	if (names.some((name) => NORMALLY_SET.has(name.toUpperCase()) || (scope.env[name] ?? "") !== "")) return undefined;
	const rootChild = child === null ? undefined : (child[3] as string);
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
		message: `Dangerous ${command} operation detected in \`${text}\`. The target '${target}' is a shell variable expansion: when ${joined} is unset or empty it ${becomes}${NO_AUTO_ALLOW}\n\n${doesNotFire}: ${advice}.`,
	};
}

function variableNames(target: string): string[] {
	const names = new Set<string>();
	for (const match of target.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g))
		names.add((match[1] ?? match[2]) as string);
	return [...names];
}
