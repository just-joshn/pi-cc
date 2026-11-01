import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { ensureTool, toolUnavailableMessage } from "../../utils/tools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PermissionContext, PermissionState } from "../permissions/context.ts";
import { evaluatePermission } from "../permissions/evaluate.ts";
import type { RuleSet } from "../permissions/rules.ts";
import { resolveToCwd } from "./path-utils.ts";

const globSchema = Type.Object(
	{
		pattern: Type.String({ description: "The glob pattern to match files against" }),
		path: Type.Optional(
			Type.String({
				description:
					'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
			}),
		),
	},
	{ additionalProperties: false, $schema: "https://json-schema.org/draft/2020-12/schema" },
);
const grepSchema = Type.Object(
	{
		pattern: Type.String({ description: "The regular expression pattern to search for in file contents" }),
		path: Type.Optional(
			Type.String({
				description: "File or directory to search in (rg PATH). Defaults to current working directory.",
			}),
		),
		glob: Type.Optional(
			Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob' }),
		),
		output_mode: Type.Optional(
			Type.String({
				description:
					'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
				enum: ["content", "files_with_matches", "count"],
			}),
		),
		"-B": Type.Optional(
			Type.Number({
				description:
					'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
			}),
		),
		"-A": Type.Optional(
			Type.Number({
				description:
					'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
			}),
		),
		"-C": Type.Optional(Type.Number({ description: "Alias for context." })),
		context: Type.Optional(
			Type.Number({
				description:
					'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
			}),
		),
		"-n": Type.Optional(
			Type.Boolean({
				description:
					'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
			}),
		),
		"-i": Type.Optional(Type.Boolean({ description: "Case insensitive search (rg -i)" })),
		"-o": Type.Optional(
			Type.Boolean({
				description:
					'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
			}),
		),
		type: Type.Optional(
			Type.String({
				description:
					"File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
			}),
		),
		head_limit: Type.Optional(
			Type.Number({
				description:
					'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description:
					'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
			}),
		),
		multiline: Type.Optional(
			Type.Boolean({
				description:
					"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
			}),
		),
	},
	{ additionalProperties: false, $schema: "https://json-schema.org/draft/2020-12/schema" },
);
export type GlobInput = Static<typeof globSchema>;
export type GrepInput = Omit<Static<typeof grepSchema>, "output_mode"> &
	({ output_mode?: "files_with_matches" } | { output_mode: "content" } | { output_mode: "count" });
export type SearchInput = { kind: "glob"; input: GlobInput } | { kind: "grep"; input: GrepInput };

type SearchOutput =
	| { mode: "files_with_matches"; entries: string[] }
	| { mode: "content"; entries: string[] }
	| { mode: "count"; entries: string[]; occurrences: number; files: number };

export const SEARCH_TOOLS = [
	{
		pi: "cc_glob",
		name: "Glob",
		eagerInputStreaming: false,
		parameters: globSchema,
		description:
			"Find files by glob pattern including hidden and ignored files. Lists up to 100 paths, oldest first. Set path to choose the search directory.",
	},
	{
		pi: "cc_grep",
		name: "Grep",
		eagerInputStreaming: false,
		parameters: grepSchema,
		description:
			"Search file contents with ripgrep regular expressions. Return file paths, matching lines, or per-file counts with output_mode. Narrow searches with path, glob, or type. Hidden files are included; repository ignore rules apply. Use -i for case-insensitive matching and multiline for matches spanning lines. Content mode supports -n, -o, and before/after context. Paginate with head_limit and offset; head_limit defaults to 250, and 0 removes the limit. Read denials are honored.",
	},
] as const;

export type SearchToolName = (typeof SEARCH_TOOLS)[number]["pi"];
export type SearchExposure = {
	simple: boolean;
	entrypoint?: string;
	rules?: RuleSet;
} & ({ kind: "session"; tools?: readonly string[] } | { kind: "subagent"; tools: readonly string[] });

/** Resolve search exposure once for the active loadout used by init and provider requests. */
export function selectSearchTools(context: SearchExposure): SearchToolName[] {
	if (context.simple) return [];
	const explicit = context.tools !== undefined && !context.tools.includes("default");
	const named = (name: string) =>
		context.tools?.some(
			(tool) => tool === name || tool === SEARCH_TOOLS.find((entry) => entry.name === name)?.pi || tool === "*",
		) === true;
	if (context.kind === "subagent") {
		if (named("Bash") || named("bash")) return [];
		return SEARCH_TOOLS.filter((tool) => named(tool.name)).map((tool) => tool.pi);
	}
	const optedIn =
		context.rules?.of("allow").some((rule) => SEARCH_TOOLS.some((tool) => tool.name === rule.toolName)) === true;
	const local = context.entrypoint?.replaceAll("_", "-") === "local-agent";
	const bashDenied = context.rules?.wholeTool("deny", "Bash") !== undefined;
	return SEARCH_TOOLS.filter(
		(tool) =>
			(explicit ? named(tool.name) : optedIn || local || bashDenied) && !context.rules?.wholeTool("deny", tool.name),
	).map((tool) => tool.pi);
}

/** Additional search checks after the CC boundary has coerced schema fields. */
export function searchInputError(name: string, args: Record<string, unknown>): string | undefined {
	if (name !== "Grep") return undefined;
	const modes = ["content", "files_with_matches", "count"];
	if (args.output_mode !== undefined && !modes.includes(String(args.output_mode))) {
		return `<tool_use_error>InputValidationError: ${JSON.stringify([{ code: "invalid_value", values: modes, path: ["output_mode"], message: 'Invalid option: expected one of "content"|"files_with_matches"|"count"' }], null, 2)}</tool_use_error>`;
	}
	for (const field of ["head_limit", "offset"]) {
		const value = args[field];
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
			return `<tool_use_error>${field} must be a whole number of 0 or more, got ${value}.${field === "head_limit" ? " Pass 0 for unlimited." : ""}</tool_use_error>`;
		}
	}
	return undefined;
}

export interface SearchToolOptions {
	permissions?: PermissionState;
	resultDirectory?: string;
}

/** Build pi-native search implementations without changing the existing grep and find contracts. */
export function createSearchToolDefinitions(
	cwd: string,
	names: readonly SearchToolName[],
	options: SearchToolOptions = {},
): ToolDefinition[] {
	return SEARCH_TOOLS.filter((tool) => names.includes(tool.pi)).map(
		(tool): ToolDefinition => ({
			name: tool.pi,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			async execute(id, args, signal, _onUpdate, ctx) {
				const currentCwd = ctx?.cwd ?? cwd;
				const request: SearchInput =
					tool.name === "Glob"
						? { kind: "glob", input: args as GlobInput }
						: { kind: "grep", input: args as GrepInput };
				const text = await search(request, currentCwd, options.permissions?.current(), signal);
				const cap = tool.name === "Grep" ? 20_000 : 100_000;
				let output = text;
				if (text.length > cap) {
					const directory = options.resultDirectory ?? (await mkdtemp(join(tmpdir(), "pi-search-")));
					await mkdir(directory, { recursive: true });
					const file = join(directory, `${basename(id)}.txt`);
					await writeFile(file, text, "utf8");
					const preview = Buffer.from(text).subarray(0, 2048).toString("utf8");
					output = `<persisted-output>\nOutput too large (${(Buffer.byteLength(text) / 1024).toFixed(1)}KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
				}
				return { content: [{ type: "text", text: output }], details: undefined };
			},
		}),
	);
}

async function search(
	request: SearchInput,
	cwd: string,
	permissions: PermissionContext | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const input = request.input;
	const target = resolveToCwd(input.path || ".", cwd);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new Error(
			`${request.kind === "glob" ? "Directory" : "Path"} does not exist: ${input.path ?? "."}. Note: your current working directory is ${cwd}.`,
		);
	}
	if (request.kind === "glob" && !info.isDirectory()) throw new Error(`Path is not a directory: ${input.path ?? "."}`);
	if ((info.mode & 0o444) === 0) {
		throw new Error(
			info.isDirectory()
				? `Refusing to search ${target}: it could not be opened (EACCES) — it is unreadable, or is being replaced concurrently.`
				: `EACCES: permission denied, stat '${target}'`,
		);
	}
	const allowed = (file: string) =>
		!permissions ||
		evaluatePermission({ name: "Read", input: { file_path: file } }, permissions).decision.behavior !== "deny";
	if (!allowed(target)) throw new Error(`Permission to read ${target} has been denied.`);
	const root = info.isDirectory() ? target : dirname(target);
	const shownPath = (file: string) => {
		const absolute = resolve(root, file);
		const local = relative(cwd, absolute);
		return (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : absolute)
			.split(sep)
			.join("/");
	};
	const rg = await ensureTool("rg");
	if (!rg) throw new Error(toolUnavailableMessage("rg"));
	if (request.kind === "glob") {
		let pattern = input.pattern;
		let globRoot = root;
		if (isAbsolute(pattern)) {
			const wildcard = pattern.search(/[?*{[]/);
			const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
			globRoot = prefix.endsWith(sep) ? prefix.slice(0, -1) || sep : dirname(prefix);
			pattern = relative(globRoot, pattern);
		}
		const raw = await runRipgrep(
			rg,
			[
				"--no-config",
				"--files",
				"--null",
				"--glob",
				pattern || "**",
				"--sort=modified",
				"--no-ignore",
				"--hidden",
				".",
			],
			globRoot,
			signal,
		);
		const files = raw
			.split("\0")
			.filter(Boolean)
			.map((file) => resolve(globRoot, file))
			.filter(allowed);
		const entries = files.slice(0, 100).map((file) => shownPath(file));
		if (entries.length === 0) return "No files found";
		if (files.length > 100) {
			const denied =
				permissions &&
				(permissions.rules.wholeTool("deny", "Read") || permissions.rules.withContent("deny", "Read").length > 0);
			entries.push(
				denied
					? "(Showing the first 100 files; there are more than 100 matches. Narrow the pattern or path to see the rest.)"
					: `(Showing 100 of ${files.length} matching files; ${files.length - 100} more are not listed. Narrow the pattern or path to see the rest.)`,
			);
		}
		return entries.join("\n");
	}
	const grep = request.input;
	const mode = grep.output_mode ?? "files_with_matches";
	const fileArgs = [
		"--no-config",
		"--hidden",
		...[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"].flatMap((vcs) => ["--glob", `!${vcs}`]),
	];
	if (grep.type !== undefined) fileArgs.push("--type", grep.type);
	if (grep.glob !== undefined) fileArgs.push("--glob", grep.glob);
	const targets = [info.isDirectory() ? "." : basename(target)];
	const args = [...fileArgs, "--max-columns", "500"];
	if (grep["-i"]) args.push("-i");
	if (mode === "files_with_matches") args.push("-l", "--null");
	else if (mode === "count") args.push("-c", "-H", "--null");
	else {
		args.push("--json", "-n");
		const context = grep["-C"] ?? grep.context;
		if (context !== undefined) args.push("-C", String(context));
		else {
			if (grep["-B"] !== undefined) args.push("-B", String(grep["-B"]));
			if (grep["-A"] !== undefined) args.push("-A", String(grep["-A"]));
		}
	}
	if (grep.multiline) args.push("-U", "--multiline-dotall");
	if (!grep.multiline && (grep.pattern.includes("\n") || /(^|[^\\])(\\\\)*\\n/.test(grep.pattern))) {
		return renderGrep(
			mode === "count" ? { mode, entries: [], occurrences: 0, files: 0 } : { mode, entries: [] },
			grep.head_limit ?? 250,
			grep.offset ?? 0,
		);
	}
	args.push("-e", grep.pattern);
	args.push("--", ...targets);
	const raw = await runRipgrep(rg, args, root, signal);
	let output: SearchOutput;
	if (mode === "files_with_matches") {
		const files: { file: string; modified: number }[] = [];
		for (const file of raw.split("\0").filter(Boolean)) {
			if (!allowed(resolve(root, file))) continue;
			files.push({ file, modified: (await stat(resolve(root, file)).catch(() => undefined))?.mtimeMs ?? 0 });
		}
		files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file, "en"));
		output = { mode, entries: files.map(({ file }) => shownPath(file)) };
	} else if (mode === "count") {
		const counts = [...raw.matchAll(/([^\0]+)\0(\d+)\n/g)].filter((match) => allowed(resolve(root, match[1])));
		output = {
			mode,
			entries: counts.map((match) => `${shownPath(match[1])}:${match[2]}`),
			occurrences: counts.reduce((sum, match) => sum + Number(match[2]), 0),
			files: counts.length,
		};
	} else {
		output = {
			mode,
			entries: contentEntries(raw, grep, info.isDirectory(), shownPath, (file) => allowed(resolve(root, file))),
		};
	}
	return renderGrep(output, grep.head_limit ?? 250, grep.offset ?? 0);
}

interface RgText {
	text?: string;
	bytes?: string;
}
interface RgEvent {
	type: string;
	data: {
		path?: RgText;
		lines?: RgText;
		line_number?: number;
		submatches?: { match: RgText; start: number; end: number }[];
	};
}

function rgText(value: RgText | undefined): string {
	return value?.text ?? (value?.bytes ? Buffer.from(value.bytes, "base64").toString("utf8") : "");
}

function contentEntries(
	raw: string,
	input: GrepInput,
	directory: boolean,
	path: (file: string) => string,
	allowed: (file: string) => boolean,
): string[] {
	const entries: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const event = JSON.parse(line) as RgEvent;
		if (event.type !== "match" && event.type !== "context") continue;
		const file = rgText(event.data.path);
		if (!allowed(file)) continue;
		const separator = event.type === "match" ? ":" : "-";
		const prefix = directory ? `${path(file)}${separator}` : "";
		const text = rgText(event.data.lines).replace(/\r?\n$/, "");
		const lines =
			input["-o"] && event.type === "match"
				? (event.data.submatches ?? []).flatMap((match) => rgText(match.match).split("\n"))
				: text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const number =
				input["-n"] === false ? "" : `${(event.data.line_number ?? 1) + (input["-o"] ? 0 : index)}${separator}`;
			const body =
				lines[index].length > 500
					? `[Omitted long ${event.type === "match" ? "matching" : "context"} line]`
					: lines[index];
			entries.push(`${prefix}${number}${body}`);
		}
	}
	return entries;
}

function renderGrep(output: SearchOutput, limit: number, offset: number): string {
	const entries = output.entries.slice(offset, limit === 0 ? undefined : offset + limit);
	const paginated = (limit > 0 && output.entries.length > offset + limit) || (offset > 0 && output.entries.length > 0);
	const pagination = [
		...(limit > 0 && output.entries.length > offset + limit ? [`limit: ${limit}`] : []),
		...(offset > 0 ? [`offset: ${offset}`] : []),
	].join(", ");
	const empty =
		output.entries.length > 0
			? "No entries at this offset"
			: output.mode === "files_with_matches"
				? "No files found"
				: "No matches found";
	const text = entries.length > 0 ? entries.join("\n") : empty;
	if (output.mode === "files_with_matches") {
		if (entries.length === 0) return paginated ? `${text}. [Showing results with pagination = ${pagination}]` : text;
		return `Found ${entries.length} ${entries.length === 1 ? "file" : "files"}${paginated ? ` ${pagination}` : ""}\n${text}`;
	}
	if (output.mode === "count")
		return `${text}\n\nFound ${output.occurrences} total ${output.occurrences === 1 ? "occurrence" : "occurrences"} across ${output.files} ${output.files === 1 ? "file" : "files"}.${paginated ? ` with pagination = ${pagination}` : ""}`;
	return `${text}${paginated ? `\n\n[Showing results with pagination = ${pagination}]` : ""}`;
}

// The RE limit is provisional; GREPGLOB-buffer tracks the different observed cutoff.
const SEARCH_BUFFER_BYTES = 20_000_000;
const SEARCH_TIMEOUT =
	"Ripgrep search timed out after 20 seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.";

async function runRipgrep(binary: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let capped = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 20_000);
		const abort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (capped) return;
			const bytes = Buffer.from(chunk);
			stdout += bytes.subarray(0, SEARCH_BUFFER_BYTES - stdoutBytes).toString("utf8");
			stdoutBytes += bytes.length;
			if (stdoutBytes > SEARCH_BUFFER_BYTES) {
				capped = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			const bytes = Buffer.from(chunk);
			if (stderrBytes < SEARCH_BUFFER_BYTES)
				stderr += bytes.subarray(0, SEARCH_BUFFER_BYTES - stderrBytes).toString("utf8");
			stderrBytes += bytes.length;
		});
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			if (timedOut || capped) {
				if (!stdout.trim()) {
					reject(new Error(SEARCH_TIMEOUT));
					return;
				}
				if (!stdout.endsWith("\n")) {
					const lastLine = stdout.lastIndexOf("\n");
					const lastNul = stdout.lastIndexOf("\0");
					stdout = stdout.slice(0, Math.max(lastLine, lastNul) + 1);
				}
				resolve(stdout);
				return;
			}
			if (
				code === 2 &&
				/regex parse error|unrecognized file type|error parsing glob|invalid.*(?:flag|value)/i.test(stderr)
			) {
				reject(
					new Error(
						`Search failed — ripgrep rejected the pattern, glob, or file type without searching:\n${stderr.trim()}`,
					),
				);
				return;
			}
			if (code !== 0 && code !== 1 && code !== 2) {
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
				return;
			}
			resolve(stdout);
		});
	});
}
