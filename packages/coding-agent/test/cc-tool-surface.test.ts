import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { convertMessages as convertOpenAIMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { getModel } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	projectAssistantMessageForPi,
	projectDeclarations,
	projectMessagesForModel,
	projectToolCall,
	wrapStreamFn,
} from "../src/core/tools/cc-surface.ts";
import { CC_FILE_STATE_SUFFIX, CC_TOOL_TEXT } from "../src/core/tools/cc-text.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createReadState } from "../src/core/tools/read-state.ts";
import { createWriteTool, createWriteToolDefinition } from "../src/core/tools/write.ts";

function assistantCall(name: string, args: Record<string, string | number | boolean>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function callOf(message: { content?: unknown }): { name?: string; arguments?: unknown } {
	const block = (message.content as Array<{ type?: string; name?: string; arguments?: unknown }> | undefined)?.find(
		(part) => part.type === "toolCall",
	);
	return { name: block?.name, arguments: block?.arguments };
}

describe("Claude Code tool surface", () => {
	it("rejects an unexpected field and coerces a numeric string", () => {
		const unexpected = projectToolCall({
			name: "Read",
			arguments: { file_path: "a.txt", bogus_field: 1 },
		});
		expect(unexpected.inputError).toContain("An unexpected parameter `bogus_field` was provided");
		expect(unexpected.name).toBe("read");

		const coerced = projectToolCall({
			name: "Read",
			arguments: { file_path: "a.txt", limit: "2", offset: -1 },
		});
		expect(coerced.inputError).toBeUndefined();
		expect(coerced.arguments).toEqual({ path: "a.txt", limit: 2, offset: -1 });

		const timeout = projectToolCall({
			name: "Bash",
			arguments: { command: "echo t", timeout: "1000" },
		});
		expect(timeout.inputError).toBeUndefined();
		expect(timeout.arguments).toEqual({ command: "echo t", timeout: 1 });
	});

	it("rejects a pi name of a covered tool with the name the model used", () => {
		const result = projectToolCall({ name: "read", arguments: { path: "five.txt" } });
		expect(result.inputError).toBe(
			"<tool_use_error>Error: No such tool available: read. Tool names are case-sensitive: call Read instead.</tool_use_error>",
		);
		expect(result.arguments).toEqual({});
	});

	it("reports a disabled Claude Code name with that name, not the pi name", () => {
		const result = projectToolCall({
			name: "Bash",
			arguments: { command: "echo x" },
			active: new Set(["read"]),
		});
		expect(result.inputError).toBe(
			"<tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>",
		);
	});

	it("echoes the model's call, with Claude Code's defaults, on the next request", () => {
		const history = projectMessagesForModel([
			projectAssistantMessageForPi(
				assistantCall("Edit", {
					file_path: "q.txt",
					old_string: "a",
					new_string: "b",
				}),
			),
			projectAssistantMessageForPi(
				assistantCall("Bash", {
					command: "echo t",
					timeout: 1000,
					description: "say hi",
					run_in_background: false,
				}),
			),
		]);
		expect(callOf(history[0])).toEqual({
			name: "Edit",
			arguments: { file_path: "q.txt", old_string: "a", new_string: "b", replace_all: false },
		});
		expect(callOf(history[1])).toEqual({
			name: "Bash",
			arguments: {
				command: "echo t",
				timeout: 1000,
				description: "say hi",
				run_in_background: false,
			},
		});
	});

	it("rewrites pi's tool rules in the machine context as it does in a section", () => {
		const [head] = projectMessagesForModel([
			{
				role: "system",
				content: "",
				context:
					"# Environment\n\n- Use read to examine files instead of cat or sed.\n- Use edit for precise changes (edits[].oldText must match exactly)",
				timestamp: 1,
			},
		]);

		const context = (head as { context: string }).context;
		expect(context).toContain("- Use Read to examine files");
		expect(context).not.toContain("oldText");
	});

	it("replays a recorded Claude Code call through the OpenAI provider", () => {
		const model = { ...getModel("openai", "gpt-4o-mini"), api: "openai-completions" as const };
		const history = projectMessagesForModel([
			projectAssistantMessageForPi(
				assistantCall("Bash", {
					command: "echo t",
					timeout: 1200,
					description: "say hi",
				}),
			),
		]);
		const messages = convertOpenAIMessages(model, normalizeContext({ messages: history }), {} as never);
		const assistant = messages.find((message) => message.role === "assistant");
		const toolCall = assistant?.role === "assistant" ? assistant.tool_calls?.[0] : undefined;
		expect(toolCall).toMatchObject({
			function: {
				name: "Bash",
				arguments: JSON.stringify({ command: "echo t", timeout: 1200, description: "say hi" }),
			},
		});
	});

	it("reverse-maps a session written before the original call was recorded", () => {
		const history = projectMessagesForModel([
			assistantCall("write", { path: "n.txt", content: "z" }),
			assistantCall("bash", { command: "echo t", timeout: 1 }),
		]);
		expect(callOf(history[0])).toEqual({ name: "Write", arguments: { file_path: "n.txt", content: "z" } });
		expect(callOf(history[1])).toEqual({ name: "Bash", arguments: { command: "echo t", timeout: 1000 } });
	});

	it("says number for a non-numeric limit and int for a fractional one", () => {
		const text = projectToolCall({ name: "Read", arguments: { file_path: "five.txt", limit: "abc" } }).inputError;
		expect(text).toContain("expected as `number` but provided as `string`");
		const fraction = projectToolCall({ name: "Read", arguments: { file_path: "five.txt", limit: 1.5 } }).inputError;
		expect(fraction).toContain("expected as `int` but provided as `number`");
	});

	// Measured against claude 2.1.312 through the conformance harness, one Read offset per form.
	it.each([
		["2", 2],
		["2.0", 2],
		[" 2", 2],
		["2 ", 2],
		["\t2", 2],
		["2\n", 2],
		["\u00a02", 2],
		["+2", 2],
		["02", 2],
		["-1", -1],
	])("reads the numeric string %j as %d", (offset, expected) => {
		const result = projectToolCall({ name: "Read", arguments: { file_path: "n.txt", offset } });
		expect(result.inputError).toBeUndefined();
		expect(result.arguments).toEqual({ path: "n.txt", offset: expected });
	});

	it.each(["2.", ".5", "-.5", "1e0", "0x2", "1_0", "Infinity", ""])("refuses the string %j as a string", (offset) => {
		const result = projectToolCall({ name: "Read", arguments: { file_path: "n.txt", offset } });
		expect(result.inputError).toContain(
			"The parameter `offset` type is expected as `number` but provided as `string`",
		);
	});

	it("reports a numeric string for a boolean field as a string", () => {
		const result = projectToolCall({
			name: "Edit",
			arguments: { file_path: "r.txt", old_string: "a", new_string: "b", replace_all: "1" },
		});
		expect(result.inputError).toContain(
			"The parameter `replace_all` type is expected as `boolean` but provided as `string`",
		);
	});

	it("accepts replace_all as the string true", () => {
		const result = projectToolCall({
			name: "Edit",
			arguments: { file_path: "r.txt", old_string: "a", new_string: "b", replace_all: "true" },
		});
		expect(result.inputError).toBeUndefined();
		expect(result.arguments).toMatchObject({ replaceAll: true });
	});

	it("sends the partial-view notice as a separate system message", () => {
		const history = projectMessagesForModel([
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "1\tfirst" }],
				isError: false,
				timestamp: 0,
				details: { ccNotice: "[Truncated: PARTIAL view]" },
			},
		]);
		expect(history).toMatchObject([
			{ role: "toolResult", content: [{ text: "1\tfirst" }] },
			{ role: "system", content: "[Truncated: PARTIAL view]" },
		]);
	});

	it("folds the partial-view notice into the tool result when the model takes no mid-conversation system messages", () => {
		const read = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "1\tfirst" }],
			isError: false,
			timestamp: 0,
			details: { ccNotice: "[Truncated: PARTIAL view]" },
		};
		const history = projectMessagesForModel([read], { midConversationSystemMessages: false });
		expect(history).toEqual([
			{
				...read,
				content: [
					{ type: "text", text: "1\tfirst\n\n<system-reminder>\n[Truncated: PARTIAL view]\n</system-reminder>" },
				],
			},
		]);
	});

	describe("nested memory", () => {
		const reminder = (path: string, text = "RULES") =>
			`<system-reminder>\nContents of ${path}:\n\n${text}\n</system-reminder>`;
		const result = (id: string, ...texts: string[]) => ({
			role: "toolResult" as const,
			toolCallId: id,
			toolName: "read",
			content: texts.map((text) =>
				text.includes("Contents of ")
					? { type: "text" as const, text, ccMemoryReminder: true as const }
					: { type: "text" as const, text },
			),
			isError: false,
			timestamp: 0,
		});
		const bash = (id: string, ...texts: string[]) => ({
			role: "toolResult" as const,
			toolCallId: id,
			toolName: "bash",
			content: texts.map((text) => ({ type: "text" as const, text })),
			isError: false,
			timestamp: 0,
		});
		const texts = (message: { content: unknown } | undefined) =>
			(message?.content as Array<{ text: string }>).map((block) => block.text);

		it("follows the tool results as one text block per reminder on a model that takes system messages", () => {
			const history = projectMessagesForModel([
				result("a", "first", reminder("/w/a/CLAUDE.md")),
				result("b", "second", reminder("/w/b/CLAUDE.md")),
			]);
			expect(history.map((message) => message.role)).toEqual(["toolResult", "toolResult", "user"]);
			expect(texts(history[0])).toEqual(["first"]);
			expect(texts(history[1])).toEqual(["second"]);
			expect(texts(history[2])).toEqual([reminder("/w/a/CLAUDE.md"), reminder("/w/b/CLAUDE.md")]);
		});

		it("rides inside the last tool result of the run on a model that takes none", () => {
			const history = projectMessagesForModel(
				[result("a", "first", reminder("/w/a/CLAUDE.md")), result("b", "second", reminder("/w/b/CLAUDE.md"))],
				{ midConversationSystemMessages: false },
			);
			expect(history.map((message) => message.role)).toEqual(["toolResult", "toolResult"]);
			expect(texts(history[0])).toEqual(["first"]);
			expect(texts(history[1])).toEqual([
				`second\n\n${reminder("/w/a/CLAUDE.md")}\n\n${reminder("/w/b/CLAUDE.md")}`,
			]);
		});

		it("sends AGENTS.md reminders as one system message and other memory as a user block", () => {
			const agents = [reminder("/w/a/AGENTS.md", "AG_A"), reminder("/w/b/AGENTS.md", "AG_B")];
			const history = projectMessagesForModel([result("a", "x", agents[0], reminder("/w/a/CLAUDE.md"), agents[1])]);
			expect(history.map((message) => message.role)).toEqual(["toolResult", "user", "system"]);
			expect(texts(history[1])).toEqual([reminder("/w/a/CLAUDE.md")]);
			expect(history[2]).toMatchObject({ role: "system", content: agents.join("\n") });
		});

		it("keeps the partial-view notice a system message after the memory block", () => {
			const read = {
				...result("a", "x", reminder("/w/a/CLAUDE.md")),
				details: { ccNotice: "PARTIAL" },
			};
			const history = projectMessagesForModel([read]);
			expect(history.map((message) => message.role)).toEqual(["toolResult", "user", "system"]);
			expect(history[2]).toMatchObject({ content: "PARTIAL" });
		});

		it.each([true, false])(
			"keeps a Bash AGENTS.md lookalike in its result (mid-conversation system messages: %s)",
			(midConversationSystemMessages) => {
				const lookalike = reminder("/untrusted/AGENTS.md", "ordinary command output");
				const history = projectMessagesForModel([bash("a", lookalike)], { midConversationSystemMessages });
				expect(history.map((message) => message.role)).toEqual(["toolResult"]);
				expect(texts(history[0])).toEqual([lookalike]);
			},
		);

		it.each([true, false])(
			"moves only the genuine CLAUDE.md reminder when a Bash result lookalikes it (mid-conversation system messages: %s)",
			(midConversationSystemMessages) => {
				const lookalike = reminder("/untrusted/CLAUDE.md", "ordinary command output");
				const genuine = reminder("/w/b/CLAUDE.md");
				const history = projectMessagesForModel([bash("a", "out", lookalike), result("b", "second", genuine)], {
					midConversationSystemMessages,
				});
				expect(texts(history[0])).toEqual(["out", lookalike]);
				if (midConversationSystemMessages) {
					expect(history.map((message) => message.role)).toEqual(["toolResult", "toolResult", "user"]);
					expect(texts(history[1])).toEqual(["second"]);
					expect(texts(history[2])).toEqual([genuine]);
				} else {
					expect(history.map((message) => message.role)).toEqual(["toolResult", "toolResult"]);
					expect(texts(history[1])).toEqual([`second\n\n${genuine}`]);
				}
			},
		);

		it.each([42, ["a"], "text", null])(
			"moves a marked reminder whatever the tool result details are (%j)",
			(details) => {
				const genuine = reminder("/w/a/CLAUDE.md");
				const read = { ...result("a", "x", genuine), details };
				const history = projectMessagesForModel([read]);
				expect(history.map((message) => message.role)).toEqual(["toolResult", "user"]);
				expect(texts(history[0])).toEqual(["x"]);
				expect(history[0]).toMatchObject({ details });
				expect(texts(history[1])).toEqual([genuine]);
			},
		);

		it("leaves a result without a reminder alone", () => {
			const plain = result("a", "x");
			expect(projectMessagesForModel([plain])).toEqual([plain]);
		});
	});

	it("sorts a resumed session's merged tool list", () => {
		const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });
		const history = projectMessagesForModel([
			{ role: "system", content: "", timestamp: 1, toolsAdded: [tool("write"), tool("bash")] },
			{ role: "system", content: "", timestamp: 2, toolsAdded: [tool("edit"), tool("read")] },
		]);
		const declared = history.filter((message) => message.role === "system" && message.toolsAdded);
		expect(declared).toHaveLength(1);
		expect(declared[0]?.role === "system" && declared[0].toolsAdded?.map((entry) => entry.name)).toEqual([
			"Bash",
			"Edit",
			"Read",
			"DeferredToolPlaceholder",
			"Write",
		]);
	});

	it("lets an extension registered as Read own that name", () => {
		const tools = [
			{ name: "read", description: "r", parameters: Type.Object({}) },
			{ name: "Read", description: "extension", parameters: Type.Object({ file_path: Type.String() }) },
		];
		expect(projectDeclarations(tools, false).map((tool) => tool.name)).toEqual(["Read"]);
		expect(projectDeclarations(tools, false)[0]?.description).toBe("extension");
		const call = projectToolCall({
			name: "Read",
			arguments: { file_path: "a.txt" },
			ownedNames: new Set(["Read"]),
		});
		expect(call.name).toBe("Read");
		expect(call.arguments).toEqual({ file_path: "a.txt" });
	});

	it("reports every validation issue, one line each", () => {
		const result = projectToolCall({
			name: "Edit",
			arguments: { file_path: 5, old_string: 1, new_string: null },
		});
		expect(result.inputError).toContain("failed due to the following issues:");
		expect(result.inputError?.split("\n").slice(1)).toHaveLength(3);
	});

	// Lithuanian collation sorts "y" with "i", ahead of "j", so a default-locale sort reorders these.
	it.each(["en_US.UTF-8", "lt_LT.UTF-8"])("orders declarations the same under %s", (locale) => {
		const script = `
			import { projectDeclarations } from ${JSON.stringify(new URL("../src/core/tools/cc-surface.ts", import.meta.url).href)};
			const tool = (name) => ({ name, description: name, parameters: {} });
			console.log(JSON.stringify(projectDeclarations([tool("yank"), tool("jq")], false).map((entry) => entry.name)));
		`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, LANG: locale, LC_ALL: locale },
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toEqual(["jq", "yank"]);
	});

	it("declares the placeholder second to last, with defer loading, and omits it when asked", () => {
		const tools = [
			{ name: "write", description: "w", parameters: Type.Object({}) },
			{ name: "read", description: "r", parameters: Type.Object({}) },
			{ name: "bash", description: "b", parameters: Type.Object({}) },
		];
		const declared = projectDeclarations(tools, true);
		expect(declared.map((tool) => tool.name)).toEqual(["Bash", "Read", "DeferredToolPlaceholder", "Write"]);
		expect(declared.find((tool) => tool.name === "DeferredToolPlaceholder")?.deferLoading).toBe(true);

		expect(projectDeclarations(tools, false).map((tool) => tool.name)).toEqual(["Bash", "Read", "Write"]);
	});
});

describe("read and write gates", () => {
	let dir: string;

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns Claude Code's read warnings and keeps a partial record only when the read was partial", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-read-"));
		const state = createReadState();
		const read = createReadTool(dir, { readState: state });
		writeFileSync(join(dir, "empty.txt"), "");
		writeFileSync(join(dir, "five.txt"), "1\n2\n3\n4\n5\n");
		mkdirSync(join(dir, "sub"));

		await expect(read.execute("1", { path: "missing.txt" })).rejects.toThrow(CC_TOOL_TEXT.readMissing(dir));
		await expect(read.execute("2", { path: "sub" })).rejects.toThrow(/EISDIR/);
		const empty = await read.execute("3", { path: "empty.txt" });
		expect(empty.content).toEqual([{ type: "text", text: CC_TOOL_TEXT.readEmptyFile }]);

		const numbered = await read.execute("4", { path: "five.txt" });
		expect(numbered.content[0]).toEqual({ type: "text", text: "1\t1\n2\t2\n3\t3\n4\t4\n5\t5\n6\t" });
		expect(state.get(join(dir, "five.txt"))?.partial).toBe(false);

		const page = await read.execute("5", { path: "five.txt", limit: 1 });
		expect(page.content[0]).toEqual({ type: "text", text: "1\t1" });
		expect(state.get(join(dir, "five.txt"))?.partial).toBe(true);
	});

	it("refuses a limited read whose selected text exceeds the token cap", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-read-cap-"));
		writeFileSync(join(dir, "huge.txt"), "y".repeat(3 * 1024 * 1024));
		const read = createReadTool(dir);
		await expect(read.execute("1", { path: "huge.txt", limit: 1 })).rejects.toThrow(
			/File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\)/,
		);
	});

	it("refuses an offset read that still exceeds the token cap, instead of a partial notice", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-read-off-"));
		const line = `x`.repeat(60);
		writeFileSync(join(dir, "wide.txt"), `${Array.from({ length: 3001 }, (_, i) => `${i} ${line}`).join("\n")}\n`);
		const read = createReadTool(dir);
		await expect(read.execute("1", { path: "wide.txt", offset: 1000 })).rejects.toThrow(
			/File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\)/,
		);
	});

	it("creates missing directories when Edit creates a file", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-edit-mkdir-"));
		const edit = createEditTool(dir);
		const result = await edit.execute("1", {
			path: "new/deep.txt",
			edits: [{ oldText: "", newText: "made\n" }],
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(readFileSync(join(dir, "new/deep.txt"), "utf-8")).toBe("made\n");
	});

	it("creates parent directories through a custom edit operation", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-edit-ops-"));
		const calls: string[] = [];
		let written: string | undefined;
		const edit = createEditTool(dir, {
			operations: {
				access: async () => {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				},
				readFile: async () => {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				},
				mkdir: async (path) => {
					calls.push(path);
				},
				writeFile: async (_path, content) => {
					written = content;
				},
			},
		});
		await edit.execute("1", { path: "new/deep.txt", edits: [{ oldText: "", newText: "made\n" }] });
		expect(calls).toEqual([join(dir, "new")]);
		expect(written).toBe("made\n");
	});

	it("reads prior content through a custom write operation", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-write-ops-"));
		let written: string | undefined;
		const write = createWriteTool(dir, {
			operations: {
				readFile: async () => Buffer.from("old\n"),
				writeFile: async (_path, content) => {
					written = content;
				},
				mkdir: async () => {},
			},
		});
		const result = await write.execute("1", { path: "remote.txt", content: "new\n" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("has been updated successfully") });
		expect(written).toBe("new\n");
	});

	it("applies an edit whose straight quotes match curly quotes in the file", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-edit-quotes-"));
		writeFileSync(join(dir, "q.txt"), "say \u2018hi\u2019 and \u201cbye\u201d\n");
		const edit = createEditTool(dir);
		await edit.execute("1", {
			path: "q.txt",
			edits: [{ oldText: "say 'hi' and \"bye\"", newText: "say 'yo' and \"bye\"" }],
		});
		expect(readFileSync(join(dir, "q.txt"), "utf-8")).toBe("say \u2018yo\u2019 and \u201cbye\u201d\n");
	});

	it("refuses a gated write when the file content is not the content that was read", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-gate-"));
		const file = join(dir, "f.txt");
		writeFileSync(file, "orig\n");
		const state = createReadState();
		const gated = (path: string) => path === file;
		const read = createReadTool(dir, { readState: state });
		const edit = createEditTool(dir, { readState: state, isReadGated: gated });
		const write = createWriteTool(dir, { readState: state, isReadGated: gated });

		await expect(edit.execute("1", { path: file, edits: [{ oldText: "orig", newText: "next" }] })).rejects.toThrow(
			CC_TOOL_TEXT.editNotRead,
		);

		await read.execute("2", { path: file });
		writeFileSync(file, "orig\n");
		const edited = await edit.execute("3", { path: file, edits: [{ oldText: "orig", newText: "next" }] });
		expect(edited.content[0]).toMatchObject({ type: "text" });
		expect(readFileSync(file, "utf-8")).toBe("next\n");

		await read.execute("4", { path: file });
		writeFileSync(file, "changed-underneath\n");
		utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
		await expect(write.execute("5", { path: file, content: "overwrite\n" })).rejects.toThrow(CC_TOOL_TEXT.editStale);
		expect(readFileSync(file, "utf-8")).toBe("changed-underneath\n");
	});
});

describe("Claude Code read advice, edit suffix, and custom operations", () => {
	let dir: string;

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const advice = { retry: "call Read again with allow_large: true", noRoom: "Even with allow_large, this is more" };

	it("suggests allow_large only when the content fits the context left", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-room-"));
		writeFileSync(join(dir, "mid.txt"), "y".repeat(400_000));
		writeFileSync(join(dir, "mega.txt"), "y".repeat(3 * 1024 * 1024));
		const read = createReadTool(dir, { contextRoomTokens: () => 140_000 });
		await expect(read.execute("1", { path: "mid.txt", limit: 1 })).rejects.toThrow(advice.retry);
		await expect(read.execute("2", { path: "mega.txt", limit: 1 })).rejects.toThrow(advice.noRoom);
		await expect(read.execute("3", { path: "mega.txt", allowLarge: true })).rejects.toThrow(
			/exceeds maximum allowed size \(1\.6MB\)\..*Even with allow_large/,
		);
		writeFileSync(
			join(dir, "tall.txt"),
			`${Array.from({ length: 12_000 }, (_, i) => `${i} ${"z".repeat(60)}`).join("\n")}\n`,
		);
		const cut = await read.execute("5", { path: "tall.txt", allowLarge: true });
		expect(cut.details?.ccNotice).toMatch(
			/tokens, allow_large had room for 140000 tokens this turn\)\..*Even with allow_large/,
		);
		const tight = createReadTool(dir, { contextRoomTokens: () => 20_000 });
		await expect(tight.execute("4", { path: "mid.txt", limit: 1 })).rejects.toThrow(advice.noRoom);
	});

	it("leaves the file-state suffix off an edit of a file the model never read", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-suffix-"));
		writeFileSync(join(dir, "e.txt"), "abc\n");
		const edit = createEditTool(dir, { readState: createReadState() });
		const first = await edit.execute("1", { path: "e.txt", edits: [{ oldText: "abc", newText: "xyz" }] });
		const second = await edit.execute("2", {
			path: "e.txt",
			edits: [{ oldText: "xyz", newText: "q" }],
			replaceAll: true,
		});
		expect(first.content[0]).toEqual({ type: "text", text: "The file e.txt has been updated successfully." });
		expect(second.content[0]).toEqual({
			type: "text",
			text: "The file e.txt has been updated. All occurrences were successfully replaced.",
		});
	});

	it("names a fractional numeric string for an integer field as a number", () => {
		const result = projectToolCall({ name: "Read", arguments: { file_path: "five.txt", limit: "1.5" } });
		expect(result.inputError).toContain("expected as `int` but provided as `number`");
	});

	it("creates a file in an existing directory through custom edit operations that have no mkdir", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-edit-nomkdir-"));
		const missing = async () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		};
		const writes: Array<[string, string]> = [];
		const edit = createEditTool(dir, {
			operations: {
				access: missing,
				readFile: missing,
				writeFile: async (path, content) => {
					writes.push([path, content]);
				},
			},
		});
		await edit.execute("1", { path: "made.txt", edits: [{ oldText: "", newText: "made\n" }] });
		expect(writes).toEqual([[join(dir, "made.txt"), "made\n"]]);
	});

	it("writes through custom operations that have no readFile without reading the local file", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-write-noread-"));
		writeFileSync(join(dir, "local.txt"), "local\n");
		const writes: string[] = [];
		const operations = {
			writeFile: async (_path: string, content: string) => {
				writes.push(content);
			},
			mkdir: async () => {},
		};
		const write = createWriteTool(dir, { operations, readState: createReadState() });
		const result = await write.execute("1", { path: "local.txt", content: "new\n" });
		expect(result.content[0]).toEqual({
			type: "text",
			text: `File written successfully at: local.txt ${CC_FILE_STATE_SUFFIX}`,
		});
		expect(writes).toEqual(["new\n"]);
		expect(readFileSync(join(dir, "local.txt"), "utf8")).toBe("local\n");

		const gated = createWriteTool(dir, { operations, readState: createReadState(), isReadGated: () => true });
		await expect(gated.execute("2", { path: "local.txt", content: "gated\n" })).rejects.toThrow(/readFile/);
		expect(writes).toEqual(["new\n"]);
	});

	it("records a refused call under pi's name and keeps the model's name for replay", () => {
		const disabled = projectToolCall({ name: "Bash", arguments: { command: "x" }, active: new Set(["read"]) });
		expect(disabled.name).toBe("bash");
		expect(disabled.modelCall?.name).toBe("Bash");
		const wrongCase = projectToolCall({ name: "BASH", arguments: { command: "x" } });
		expect(wrongCase.name).toBe("bash");
		expect(wrongCase.modelCall?.name).toBe("BASH");
	});

	it("orders built-in tools before MCP tools, each by locale, with the placeholder second to last", () => {
		const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });
		const declared = projectDeclarations(
			[tool("mcp__srv__b"), tool("write"), tool("mcp__srv__A"), tool("read"), tool("grep")],
			true,
		);
		expect(declared.map((entry) => entry.name)).toEqual([
			"grep",
			"Read",
			"Write",
			"mcp__srv__A",
			"DeferredToolPlaceholder",
			"mcp__srv__b",
		]);
	});

	it("names the model's tools in the system prompt's tool list and tool rules", () => {
		const history = projectMessagesForModel([
			{
				role: "system",
				content: "",
				timestamp: 0,
				sections: {
					preamble: "p",
					tools: "<tools>\n- read: Read file contents\n- grep: Search\n- write: Write files\n\nMore.\n</tools>",
					rules: "<rules>\n- Use read to examine files.\n- Use grep to search.\n- Be concise\n</rules>",
				},
			},
		]);
		expect(history[0]).toMatchObject({
			sections: {
				tools: "<tools>\n- Read: Read file contents\n- grep: Search\n- Write: Write files\n\nMore.\n</tools>",
				rules: "<rules>\n- Use Read to examine files.\n- Use grep to search.\n- Be concise\n</rules>",
			},
		});
	});
});

describe("model-facing prompt text", () => {
	it("describes the Claude Code schema and names, not pi's, in declarations and the system prompt", () => {
		const definitions = [
			createReadToolDefinition("/w"),
			createBashToolDefinition("/w"),
			createEditToolDefinition("/w"),
			createWriteToolDefinition("/w"),
		];
		const sections = buildSystemPromptSections({
			cwd: "/w",
			selectedTools: definitions.map((tool) => tool.name),
			toolSnippets: Object.fromEntries(definitions.map((tool) => [tool.name, tool.promptSnippet ?? ""])),
			toolGuidelines: Object.fromEntries(definitions.map((tool) => [tool.name, tool.promptGuidelines ?? []])),
			skills: [
				{
					name: "s",
					description: "d",
					filePath: "/w/s/SKILL.md",
					baseDir: "/w/s",
					sourceInfo: { path: "/w/s/SKILL.md", source: "local", scope: "project", origin: "top-level" },
					disableModelInvocation: false,
				},
			],
		});
		const [projected] = projectMessagesForModel([
			{
				role: "system",
				content: "",
				timestamp: 0,
				sections,
				toolsAdded: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })),
			},
		]);
		const text = JSON.stringify(projected);
		for (const piTerm of [
			/edits\[\]/,
			/oldText/,
			/newText/,
			/allowLarge/,
			/the read tool/,
			/edit call/,
			/in seconds/,
		]) {
			expect(text).not.toMatch(piTerm);
		}
		expect(text).toContain("old_string");
		expect(text).toContain("Use the Read tool to load a skill's file");
	});
});

describe("streaming previews", () => {
	it("shows a still-streaming call under pi's name and argument shape", async () => {
		const partial = assistantCall("Read", { file_path: "a.txt", limit: 2 });
		const source = new AssistantMessageEventStream();
		const model = getModel("anthropic", "claude-haiku-4-5");
		const stream = await wrapStreamFn(() => source)(model, normalizeContext({ messages: [] }), {});
		source.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial });
		source.end(partial);
		const previews: unknown[] = [];
		for await (const event of stream) if (event.type === "toolcall_delta") previews.push(event.partial.content[0]);
		expect(previews).toEqual([expect.objectContaining({ name: "read", arguments: { path: "a.txt", limit: 2 } })]);
	});
});
