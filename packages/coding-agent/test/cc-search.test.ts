import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionState } from "../src/core/permissions/context.ts";
import { evaluatePermission } from "../src/core/permissions/evaluate.ts";
import { RuleSet, rulesFromTexts } from "../src/core/permissions/rules.ts";
import {
	createSearchToolDefinitions,
	SEARCH_TOOLS,
	type SearchExposure,
	selectSearchTools,
} from "../src/core/tools/cc-search.ts";
import { declaredToolName, projectDeclarations, projectToolCall } from "../src/core/tools/cc-surface.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const rules = (allow: string[] = [], deny: string[] = []) =>
	new RuleSet([...rulesFromTexts(allow, "allow", "cliArg"), ...rulesFromTexts(deny, "deny", "settings")]);
const exposureCases: [string, SearchExposure, string[]][] = [
	["default", { kind: "session", simple: false }, []],
	["bare", { kind: "session", simple: true }, []],
	["joint Grep opt-in", { kind: "session", simple: false, rules: rules(["Grep"]) }, ["Glob", "Grep"]],
	["joint Glob opt-in", { kind: "session", simple: false, rules: rules(["Glob"]) }, ["Glob", "Grep"]],
	["scoped opt-in", { kind: "session", simple: false, rules: rules(["Grep(src/**)"]) }, ["Glob", "Grep"]],
	["Glob allowlist", { kind: "session", simple: false, tools: ["Glob", "Read"] }, ["Glob"]],
	["search allowlist", { kind: "session", simple: false, tools: ["Grep", "Glob", "Read"] }, ["Glob", "Grep"]],
	["local-agent", { kind: "session", simple: false, entrypoint: "local-agent" }, ["Glob", "Grep"]],
	["local_agent", { kind: "session", simple: false, entrypoint: "local_agent" }, ["Glob", "Grep"]],
	["Bash deny", { kind: "session", simple: false, rules: rules([], ["Bash"]) }, ["Glob", "Grep"]],
	["Bash removed by allowlist", { kind: "session", simple: false, tools: ["Read", "Edit"] }, []],
	["both denied", { kind: "session", simple: false, rules: rules([], ["Bash", "Grep"]) }, ["Glob"]],
	["Grep denied alone", { kind: "session", simple: false, rules: rules([], ["Grep"]) }, []],
	["Bash explicit", { kind: "session", simple: false, tools: ["Bash", "Read"] }, []],
	["default explicit", { kind: "session", simple: false, tools: ["default"] }, []],
	["Read explicit", { kind: "session", simple: false, tools: ["Read"] }, []],
	["simple beats opt-in", { kind: "session", simple: true, rules: rules(["Grep"]) }, []],
	["subagent explicit", { kind: "subagent", simple: false, tools: ["Grep", "Glob"] }, ["Glob", "Grep"]],
	[
		"subagent parent deny",
		{ kind: "subagent", simple: false, tools: ["Grep", "Glob"], rules: rules([], ["Grep"]) },
		["Glob", "Grep"],
	],
	["subagent Bash", { kind: "subagent", simple: false, tools: ["Bash", "Grep", "Glob"] }, []],
	["simple subagent", { kind: "subagent", simple: true, tools: ["Grep", "Glob"] }, []],
];

describe("CC search declarations and exposure", () => {
	it.each(exposureCases)("selects %s", (_name, context, expected) => {
		expect(selectSearchTools(context).map(declaredToolName)).toEqual(expected);
	});
	it.each([
		["Glob", "glob", 140],
		["Grep", "grep", 477],
	] as const)("declares the recorded %s schema and a native description", (name, fixture, length) => {
		const tool = SEARCH_TOOLS.find((tool) => tool.name === name)!;
		const declared = projectDeclarations(
			[{ name: tool.pi, description: tool.description, parameters: tool.parameters }],
			false,
		)[0];
		expect(JSON.parse(JSON.stringify(declared.parameters))).toEqual(
			JSON.parse(readFileSync(new URL(`./fixtures/cc-search/${fixture}.json`, import.meta.url), "utf8")),
		);
		expect(declared.description.length).toBe(length);
		expect(declared.constrainedSampling).toBe(false);
		expect(declared.deferLoading).toBeUndefined();
	});
	it("sends the recorded search schemas without strict, deferred, or eager streaming flags", async () => {
		const declarations = projectDeclarations(
			SEARCH_TOOLS.map((tool) => ({ name: tool.pi, description: tool.description, parameters: tool.parameters })),
			false,
		);
		let request: Record<string, unknown> | undefined;
		await streamAnthropic(
			{
				id: "search-wire",
				name: "Search wire",
				api: "anthropic-messages",
				provider: "search-wire-test",
				baseUrl: "https://search-wire.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 100,
				compat: { supportsStrictTools: true },
			},
			normalizeContext({ messages: [{ role: "user", content: "Search", timestamp: 1 }], tools: declarations }),
			{
				apiKey: "local-test-key",
				cacheRetention: "none",
				maxRetries: 0,
				fetch: async (_input, init) => {
					request = JSON.parse(String(init?.body));
					return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
				},
			},
		).result();
		expect(request?.tools).toEqual(
			SEARCH_TOOLS.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: JSON.parse(
					readFileSync(new URL(`./fixtures/cc-search/${tool.name.toLowerCase()}.json`, import.meta.url), "utf8"),
				),
			})),
		);
	});
	it("coerces pagination and rejects invalid inputs before execution", () => {
		expect(projectToolCall({ name: "Grep", arguments: { pattern: "x", head_limit: "3" } }).arguments.head_limit).toBe(
			3,
		);
		expect(projectToolCall({ name: "Grep", arguments: { pattern: "x", head_limit: -1 } }).inputError).toBe(
			"<tool_use_error>head_limit must be a whole number of 0 or more, got -1. Pass 0 for unlimited.</tool_use_error>",
		);
		expect(projectToolCall({ name: "Grep", arguments: { pattern: "x", offset: -1 } }).inputError).toBe(
			"<tool_use_error>offset must be a whole number of 0 or more, got -1.</tool_use_error>",
		);
		expect(projectToolCall({ name: "Grep", arguments: {} }).inputError).toBe(
			"<tool_use_error>InputValidationError: Grep failed due to the following issue:\nThe required parameter `pattern` is missing</tool_use_error>",
		);
		expect(projectToolCall({ name: "Grep", arguments: { pattern: "x", output_mode: "bad" } }).inputError).toContain(
			'"code": "invalid_value"',
		);
		expect(projectToolCall({ name: "Glob", arguments: { pattern: "*", limit: 3 } }).inputError).toContain(
			"unexpected parameter `limit`",
		);
	});
	it("keeps a separately exposed native grep callable", () => {
		expect(
			projectToolCall({ name: "grep", arguments: { pattern: "x" }, active: new Set(["grep"]) }).inputError,
		).toBeUndefined();
	});
});

describe("CC search results through pi native tools", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-cc-search-"));
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src/a.ts"), "alpha\nneedle old\n");
		writeFileSync(join(cwd, "src/b.ts"), "ALPHA\nneedle new\n");
		utimesSync(join(cwd, "src/a.ts"), new Date("2020-01-01"), new Date("2020-01-01"));
		utimesSync(join(cwd, "src/b.ts"), new Date("2024-01-01"), new Date("2024-01-01"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	async function call(
		name: "Glob" | "Grep",
		args: Record<string, unknown>,
		permissions?: PermissionState,
		signal?: AbortSignal,
	) {
		const projected = projectToolCall({ name, arguments: args });
		if (projected.inputError) throw new Error(projected.inputError);
		const definition = createSearchToolDefinitions(cwd, ["cc_grep", "cc_glob"], {
			permissions,
			resultDirectory: join(cwd, "results"),
		}).find((tool) => tool.name === projected.name)!;
		const result = await wrapToolDefinition(definition).execute("call-test", projected.arguments, signal);
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	it("orders Glob oldest first and Grep files newest first", async () => {
		expect(await call("Glob", { pattern: "**/*.ts" })).toBe("src/a.ts\nsrc/b.ts");
		expect(await call("Grep", { pattern: "needle" })).toBe("Found 2 files\nsrc/b.ts\nsrc/a.ts");
		expect(await call("Glob", { pattern: "*.TS" })).toBe("No files found");
		expect(await call("Glob", { pattern: "src/../src/*.ts" })).toBe("No files found");
	});
	it("renders content, context precedence, only matches, and line-number suppression", async () => {
		writeFileSync(join(cwd, "ctx.txt"), "before\nneedle needle\nafter\nextra\n");
		expect(await call("Grep", { pattern: "needle", path: "ctx.txt", output_mode: "content", "-C": 1, "-A": 3 })).toBe(
			"1-before\n2:needle needle\n3-after",
		);
		expect(
			await call("Grep", { pattern: "needle", path: "ctx.txt", output_mode: "content", "-n": false, "-o": true }),
		).toBe("needle\nneedle");
		expect(await call("Grep", { pattern: "needle", path: "src/a.ts", output_mode: "content" })).toBe("2:needle old");
		expect(await call("Grep", { pattern: "needle", glob: "src/a.ts", output_mode: "content" })).toBe(
			"src/a.ts:2:needle old",
		);
	});
	it("counts matching lines across all files before pagination", async () => {
		expect(await call("Grep", { pattern: "needle", path: "src/a.ts", output_mode: "count" })).toBe(
			"src/a.ts:1\n\nFound 1 total occurrence across 1 file.",
		);
		expect(await call("Grep", { pattern: "alpha|needle", path: "src/a.ts", output_mode: "count" })).toBe(
			"src/a.ts:2\n\nFound 2 total occurrences across 1 file.",
		);
		const counted = await call("Grep", { pattern: "needle", output_mode: "count", head_limit: 1 });
		expect(counted).toMatch(
			/^src\/[ab]\.ts:1\n\nFound 2 total occurrences across 2 files\. with pagination = limit: 1$/,
		);
	});
	it("paginates each mode and handles offsets past the end", async () => {
		expect(await call("Grep", { pattern: "needle", head_limit: 1, offset: 1 })).toBe(
			"Found 1 file offset: 1\nsrc/a.ts",
		);
		expect(await call("Grep", { pattern: "needle", offset: 500 })).toBe(
			"No entries at this offset. [Showing results with pagination = offset: 500]",
		);
		expect(await call("Grep", { pattern: "needle", path: "src/a.ts", output_mode: "content", offset: 500 })).toBe(
			"No entries at this offset\n\n[Showing results with pagination = offset: 500]",
		);
		expect(await call("Grep", { pattern: "missing", output_mode: "count" })).toBe(
			"No matches found\n\nFound 0 total occurrences across 0 files.",
		);
	});
	it("caps Glob at 100 and uses the incomplete count notice when Read denies exist", async () => {
		mkdirSync(join(cwd, "many"));
		for (let index = 0; index < 120; index++) writeFileSync(join(cwd, "many", `${index}.txt`), "needle\n");
		const all = await call("Glob", { pattern: "many/*.txt" });
		expect(all.split("\n")).toHaveLength(101);
		expect(all).toContain(
			"(Showing 100 of 120 matching files; 20 more are not listed. Narrow the pattern or path to see the rest.)",
		);
		const permissions = new PermissionState({ cwd, settings: { deny: ["Read(many/0.txt)"] } });
		const denied = await call("Glob", { pattern: "many/*.txt" }, permissions);
		expect(denied.split("\n")).not.toContain("many/0.txt");
		expect(denied).toContain(
			"(Showing the first 100 files; there are more than 100 matches. Narrow the pattern or path to see the rest.)",
		);
	});
	it("anchors multi-segment relative Read rules for every reading tool", () => {
		const permissions = new PermissionState({ cwd, settings: { deny: ["Read(src/a.ts)"] } }).current();
		for (const name of ["Read", "Grep", "Glob"]) {
			expect(
				evaluatePermission({ name, input: { file_path: join(cwd, "src/a.ts") } }, permissions).decision.behavior,
			).toBe("deny");
			expect(
				evaluatePermission({ name, input: { file_path: join(cwd, "src/b.ts") } }, permissions).decision.behavior,
			).toBe("allow");
		}
	});
	it("filters denied files from all modes and refuses a denied explicit target", async () => {
		const permissions = new PermissionState({ cwd, settings: { deny: ["Read(src/a.ts)"] } });
		expect(await call("Glob", { pattern: "**/*.ts" }, permissions)).toBe("src/b.ts");
		expect(await call("Grep", { pattern: "needle" }, permissions)).toBe("Found 1 file\nsrc/b.ts");
		expect(await call("Grep", { pattern: "needle", output_mode: "content" }, permissions)).toBe(
			"src/b.ts:2:needle new",
		);
		expect(await call("Grep", { pattern: "needle", output_mode: "count" }, permissions)).toBe(
			"src/b.ts:1\n\nFound 1 total occurrence across 1 file.",
		);
		await expect(call("Grep", { pattern: "needle", path: "src/a.ts" }, permissions)).rejects.toThrow(
			`Permission to read ${join(cwd, "src/a.ts")} has been denied.`,
		);
	});
	it("includes hidden and ignored files in Glob, but honors git ignores in Grep", async () => {
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git/HEAD"), "needle\n");
		writeFileSync(join(cwd, ".hidden"), "needle\n");
		writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(cwd, "ignored.txt"), "needle\n");
		expect(await call("Glob", { pattern: "**/.git/*" })).toBe(".git/HEAD");
		expect(await call("Glob", { pattern: "ignored.txt" })).toBe("ignored.txt");
		const files = await call("Grep", { pattern: "needle" });
		expect(files).toContain(".hidden");
		expect(files).not.toContain("ignored.txt");
		expect(files).not.toContain(".git/HEAD");
		rmSync(join(cwd, ".git"), { recursive: true });
		expect(await call("Grep", { pattern: "needle" })).toContain("ignored.txt");
	});
	it("supports multiline patterns, case folding, file types and negative patterns", async () => {
		writeFileSync(join(cwd, "multi.txt"), "foo\nbar\n");
		expect(await call("Grep", { pattern: "foo\\nbar", path: "multi.txt", output_mode: "content" })).toBe(
			"No matches found",
		);
		expect(
			await call("Grep", { pattern: "foo.bar", path: "multi.txt", output_mode: "content", multiline: true }),
		).toBe("1:foo\n2:bar");
		expect(await call("Grep", { pattern: "alpha", "-i": true, type: "ts" })).toBe(
			"Found 2 files\nsrc/b.ts\nsrc/a.ts",
		);
		writeFileSync(join(cwd, "dash.txt"), "-needle\n");
		expect(await call("Grep", { pattern: "-needle", glob: "!*.ts" })).toBe("Found 1 file\ndash.txt");
	});
	it("elides long matching lines and persists oversized output", async () => {
		writeFileSync(join(cwd, "long.txt"), `${"x".repeat(501)}\n`);
		expect(await call("Grep", { pattern: "x", path: "long.txt", output_mode: "content" })).toBe(
			"1:[Omitted long matching line]",
		);
		writeFileSync(join(cwd, "big.txt"), `${"x".repeat(108)}\n`.repeat(400));
		const result = await call("Grep", { pattern: "x", path: "big.txt", output_mode: "content", head_limit: 0 });
		expect(result).toContain("<persisted-output>\nOutput too large (");
		expect(result).toContain(join(cwd, "results/call-test.txt"));
		expect(readFileSync(join(cwd, "results/call-test.txt"), "utf8").split("\n")).toHaveLength(400);
	});
	it("returns complete records when large content reaches the provisional backend buffer", async () => {
		writeFileSync(join(cwd, "buffer.txt"), `${"needle ".padEnd(25, "x")}\n`.repeat(1_000_000));
		const result = await call("Grep", {
			pattern: "needle",
			path: "buffer.txt",
			output_mode: "content",
			head_limit: 0,
		});
		expect(result).toContain("<persisted-output>");
		const persisted = readFileSync(join(cwd, "results/call-test.txt"), "utf8");
		expect(persisted.split("\n").every((line) => /^\d+:needle x+$/.test(line))).toBe(true);
		expect(await call("Grep", { pattern: "needle", path: "buffer.txt", output_mode: "count" })).toBe(
			"buffer.txt:1000000\n\nFound 1000000 total occurrences across 1 file.",
		);
	});
	it("uses default 250-entry pages and zero for unlimited", async () => {
		writeFileSync(join(cwd, "pages.txt"), "needle\n".repeat(260));
		const page = await call("Grep", { pattern: "needle", path: "pages.txt", output_mode: "content" });
		expect(page).toContain("250:needle\n\n[Showing results with pagination = limit: 250]");
		expect(page).not.toContain("251:needle");
		expect(
			await call("Grep", { pattern: "needle", path: "pages.txt", output_mode: "content", head_limit: 0 }),
		).toContain("260:needle");
	});
	it("handles absolute Glob patterns and external search roots", async () => {
		expect(await call("Glob", { pattern: join(cwd, "src/**/*.ts") })).toBe("src/a.ts\nsrc/b.ts");
		expect(await call("Glob", { pattern: join(cwd, "src/a.ts") })).toBe("src/a.ts");
		const external = mkdtempSync(join(tmpdir(), "pi-cc-search-external-"));
		try {
			writeFileSync(join(external, "file.txt"), "needle\n");
			expect(await call("Glob", { pattern: "*", path: external })).toBe(join(external, "file.txt"));
			expect(await call("Grep", { pattern: "needle", path: external })).toBe(
				`Found 1 file\n${join(external, "file.txt")}`,
			);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
	it("reports missing, invalid, unreadable, and regex inputs", async () => {
		await expect(call("Glob", { pattern: "*", path: "missing" })).rejects.toThrow(
			`Directory does not exist: missing. Note: your current working directory is ${cwd}.`,
		);
		await expect(call("Glob", { pattern: "*", path: "src/a.ts" })).rejects.toThrow(
			"Path is not a directory: src/a.ts",
		);
		await expect(call("Grep", { pattern: "(foo" })).rejects.toThrow(
			"Search failed — ripgrep rejected the pattern, glob, or file type without searching:\nrg: regex parse error:\n    (?:(foo)\n    ^\nerror: unclosed group",
		);
		await expect(call("Grep", { pattern: "needle", type: "nope" })).rejects.toThrow(
			"rg: unrecognized file type: nope",
		);
		mkdirSync(join(cwd, "unreadable"));
		chmodSync(join(cwd, "unreadable"), 0);
		try {
			await expect(call("Glob", { pattern: "*", path: "unreadable" })).rejects.toThrow(
				"it could not be opened (EACCES)",
			);
		} finally {
			chmodSync(join(cwd, "unreadable"), 0o700);
		}
	});
	it.skipIf(process.platform === "win32")(
		"times out a blocked native rg with the recorded error",
		async () => {
			execFileSync("mkfifo", [join(cwd, "timeout-pipe")]);
			await expect(call("Grep", { pattern: "needle", path: "timeout-pipe" })).rejects.toThrow(
				"Ripgrep search timed out after 20 seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.",
			);
		},
		25_000,
	);
	it.skipIf(process.platform === "win32")("aborts a blocked native rg without leaving it running", async () => {
		execFileSync("mkfifo", [join(cwd, "pipe")]);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 100);
		try {
			await expect(call("Grep", { pattern: "needle", path: "pipe" }, undefined, controller.signal)).rejects.toThrow(
				"Operation aborted",
			);
		} finally {
			clearTimeout(timer);
		}
	});
});
