import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { projectDeclarations, projectToolCall } from "../src/core/tools/cc-surface.ts";
import { CC_TOOL_TEXT } from "../src/core/tools/cc-text.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createReadState } from "../src/core/tools/read-state.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

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
