import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { convertMessages as convertOpenAIMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { getModel } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	projectAssistantMessageForPi,
	projectDeclarations,
	projectMessagesForModel,
	projectToolCall,
} from "../src/core/tools/cc-surface.ts";
import { CC_TOOL_TEXT } from "../src/core/tools/cc-text.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createReadState } from "../src/core/tools/read-state.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

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
		await expect(write.execute("5", { path: file, content: "overwrite\n" })).rejects.toThrow(CC_TOOL_TEXT.editStale);
		expect(readFileSync(file, "utf-8")).toBe("changed-underneath\n");
	});
});
