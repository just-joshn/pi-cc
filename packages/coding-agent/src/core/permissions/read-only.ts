/**
 * What a command does to files, from its words alone: whether Claude Code would run it without
 * asking, and which operands it reads and writes. Read-only commands with an option table accept
 * only the options in it; the others take any option.
 */

import { type FlagKind, type FlagTable, SAFE_FLAGS } from "./safe-flags.ts";

export interface CommandEffect {
	readonly readOnly: boolean;
	readonly reads: readonly string[];
	readonly writes: readonly string[];
}

const NOT_READ_ONLY_NO_OPERANDS: CommandEffect = { readOnly: false, reads: [], writes: [] };

const READ_ONLY_COMMANDS = new Set([
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"find",
	"ls",
	"whoami",
	"uname",
	"which",
	"cut",
	"tr",
	"stat",
	"du",
	"echo",
	"printf",
	"true",
	"false",
	"sleep",
	"[",
	"diff",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"jq",
]);

const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe"]);
const GIT_WRITING_OPTION = /^(?:--output|--ext-diff|--textconv|--exec|-o)/;
const PRINT_SCRIPT = /^(?:\$|\d+)(?:,(?:\$|\d+))?p$/;
const FIND_WRITES = /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/;
const VERSION_ONLY = new Set(["node", "python", "python3"]);

const FILE_COMMANDS = new Set(["touch", "mkdir", "rm", "rmdir", "mv", "cp", "sed"]);

const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "rg"]);
const PATTERN_OPTIONS = new Set(["-e", "--regexp", "-f", "--file"]);
const FILE_VALUED_OPTIONS = new Set(["-f", "--file", "--exclude-from"]);
const ARITHMETIC_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const RUNTIME_VALUE = /[$`]/;

interface ParsedFlags {
	readonly positionals: string[];
	readonly valued: { readonly flag: string; readonly value: string }[];
}

function parseFlags(command: string, args: readonly string[], table: FlagTable): ParsedFlags | undefined {
	const positionals: string[] = [];
	const valued: { flag: string; value: string }[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "") continue;
		if (arg === "--") {
			if (table.respectsDoubleDash) {
				positionals.push(...args.slice(index + 1).filter((rest) => rest !== ""));
				break;
			}
			continue;
		}
		if (!/^-[a-zA-Z0-9_-]/.test(arg)) {
			if (RUNTIME_VALUE.test(arg)) return undefined;
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const kind = table.flags[flag];
		if (kind === undefined) {
			if (!shortFlagsAllowed(command, flag, table)) return undefined;
			continue;
		}
		if (kind === "none") {
			if (equals !== -1) return undefined;
			continue;
		}
		let value: string;
		if (equals !== -1) value = arg.slice(equals + 1);
		else {
			const following = args[index + 1];
			if (following === undefined || /^-[a-zA-Z0-9_-]/.test(following)) return undefined;
			value = following;
			index++;
		}
		if (RUNTIME_VALUE.test(value) || !valueFits(value, kind)) return undefined;
		valued.push({ flag, value });
	}
	return { positionals, valued };
}

function valueFits(value: string, kind: FlagKind): boolean {
	if (kind === "number") return /^\d+$/.test(value);
	if (kind === "char") return value.length === 1;
	return !value.startsWith("-");
}

/** `-abc` is `-a -b -c` when each is a switch, and grep's `-A5` is `-A 5`. */
function shortFlagsAllowed(command: string, flag: string, table: FlagTable): boolean {
	if (flag.startsWith("--") || flag.length <= 2) return false;
	if (GREP_FAMILY.has(command)) {
		const kind = table.flags[flag.slice(0, 2)];
		if ((kind === "number" || kind === "string") && /^\d+$/.test(flag.slice(2))) return true;
	}
	return [...flag.slice(1)].every((letter) => table.flags[`-${letter}`] === "none");
}

/** `test` fails the table's check on options that read variables or other shell state. */
function testIsPlain(args: readonly string[]): boolean {
	if (args.some((arg) => ["-v", "-R", "-a", "-o"].includes(arg) || arg.includes("["))) return false;
	return args.every((arg, index) => {
		const integer = /^-?\d+$/;
		if (ARITHMETIC_TEST_OPERATORS.has(arg))
			return [args[index - 1], args[index + 1]].every((side) => side === undefined || integer.test(side));
		if (arg === "-t") return args[index + 1] === undefined || integer.test(args[index + 1] as string);
		return true;
	});
}

function dateIsPlain(args: readonly string[]): boolean {
	const withValue = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg.startsWith("--") && arg.includes("=")) continue;
		if (arg.startsWith("-")) {
			if (withValue.has(arg)) index++;
			continue;
		}
		if (!arg.startsWith("+")) return false;
	}
	return true;
}

function tabled(head: string, args: readonly string[]): CommandEffect {
	const table = SAFE_FLAGS[head] as FlagTable;
	const parsed = parseFlags(head, args, table);
	if (parsed === undefined) return NOT_READ_ONLY_NO_OPERANDS;
	if (head === "test" && !testIsPlain(args)) return NOT_READ_ONLY_NO_OPERANDS;
	if (head === "date" && !dateIsPlain(args)) return NOT_READ_ONLY_NO_OPERANDS;
	if (head === "test" || head === "date") return { readOnly: true, reads: [], writes: [] };
	const reads = parsed.valued.filter(({ flag }) => FILE_VALUED_OPTIONS.has(flag)).map(({ value }) => value);
	let operands = parsed.positionals;
	if (GREP_FAMILY.has(head)) {
		const patternGiven = parsed.valued.some(({ flag }) => PATTERN_OPTIONS.has(flag)) || args.includes("--files");
		if (!patternGiven) operands = operands.slice(1);
	}
	return { readOnly: true, reads: [...reads, ...operands], writes: [] };
}

function nonFlags(args: readonly string[]): string[] {
	const doubleDash = args.indexOf("--");
	const options = doubleDash === -1 ? args : args.slice(0, doubleDash);
	const rest = doubleDash === -1 ? [] : args.slice(doubleDash + 1);
	return [...options.filter((arg) => !arg.startsWith("-")), ...rest];
}

function gitEffect(args: readonly string[]): CommandEffect {
	const subcommand = args[0] ?? "";
	const none = { reads: [], writes: [] };
	if (READ_ONLY_GIT.has(subcommand))
		return { readOnly: !args.slice(1).some((arg) => GIT_WRITING_OPTION.test(arg)), ...none };
	if (subcommand === "branch" || subcommand === "remote") {
		const listing = args
			.slice(1)
			.every(
				(arg) =>
					arg.startsWith("-") && !/^-[a-zA-Z]*[dDmMfcC]|^--(?:delete|move|copy|force|set-upstream)/.test(arg),
			);
		return { readOnly: listing, ...none };
	}
	return { readOnly: subcommand === "config" && args[1] === "--get", ...none };
}

export function commandEffect(words: readonly string[]): CommandEffect {
	const [head = "", ...args] = words;
	if (SAFE_FLAGS[head] !== undefined) return tabled(head, args);
	if (head === "find") {
		const readOnly = !args.some((arg) => FIND_WRITES.test(arg));
		const expression = args.findIndex((arg) => /^(?:-|\(|!)/.test(arg));
		return { readOnly, reads: expression === -1 ? args : args.slice(0, expression), writes: [] };
	}
	if (head === "uniq") return { readOnly: nonFlags(args).length === 0, reads: [], writes: [] };
	if (READ_ONLY_COMMANDS.has(head)) return { readOnly: true, reads: nonFlags(args), writes: [] };
	if (head === "git") return gitEffect(args);
	if (head === "sed") {
		const inPlace = args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === "--in-place");
		if (inPlace) return { readOnly: false, reads: [], writes: nonFlags(args).slice(1) };
		const printOnly = args.length === 3 && args[0] === "-n" && PRINT_SCRIPT.test(args[1] ?? "");
		return printOnly ? { readOnly: true, reads: [args[2] as string], writes: [] } : NOT_READ_ONLY_NO_OPERANDS;
	}
	if (VERSION_ONLY.has(head)) {
		const version = args.length === 1 && ["--version", "-v", "-V"].includes(args[0] as string);
		return { readOnly: version, reads: [], writes: [] };
	}
	if (FILE_COMMANDS.has(head)) {
		const operands = nonFlags(args);
		if (head === "cp") return { readOnly: false, reads: operands.slice(0, -1), writes: operands.slice(-1) };
		return { readOnly: false, reads: [], writes: operands };
	}
	return NOT_READ_ONLY_NO_OPERANDS;
}
