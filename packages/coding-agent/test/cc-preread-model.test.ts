import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { claudeModelFamily, isCcLegacyMutationModel } from "../src/core/tools/cc-model-family.ts";
import { projectToolCall } from "../src/core/tools/cc-surface.ts";
import { CC_TOOL_TEXT, toolUseError } from "../src/core/tools/cc-text.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const gatedModels = [
	"claude-opus-4-6",
	"claude-haiku-4-5",
	"claude-opus-4-5",
	"claude-opus-4-1",
	"claude-opus-4-0",
	"claude-sonnet-4-5",
	"claude-sonnet-4-0",
	"claude-3-7-sonnet",
	"claude-3-5-sonnet",
	"claude-3-5-haiku",
	"claude-haiku-4-5[1m]",
	"claude-opus-4-6[1M]",
	"claude-haiku-4-5-20251001",
	"claude-sonnet-4-5-20250929",
	"claude-opus-4-5-20251101",
	"claude-sonnet-4-20250514",
	"Claude-Haiku-4-5",
];

const ungatedModels = [
	"claude-opus-4-7",
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"gpt-5",
	"my-gpt-5-20251001",
	"claude-opus-4-10",
	"claude-opus-40",
	"claude-sonnet-40",
	"claude-sonnet-4-10-20251001",
];

describe("CC model-specific prior-read checks", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-cc-preread-"));
		writeFileSync(join(cwd, "a.txt"), "before\n");
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it.each(gatedModels)("gates unread mutations on %s like Claude Code's family set", async (id) => {
		expect(isCcLegacyMutationModel(id)).toBe(true);
		const { session, tool, args } = await sessionWithTool(cwd, id, "edit");
		try {
			await expect(tool.execute("unread", args)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editNotRead));
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before\n");
		} finally {
			session.dispose();
		}
	});

	it.each(ungatedModels)("applies unread mutations on %s", async (id) => {
		expect(isCcLegacyMutationModel(id)).toBe(false);
		const { session, tool, args } = await sessionWithTool(cwd, id, "write");
		try {
			await tool.execute("unread", args);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
		} finally {
			session.dispose();
		}
	});

	it.each(["claude-haiku-4-5", "claude-opus-5-5"])(
		"recovers a stale Edit on %s with Claude Code's note for every model",
		async (id) => {
			const { session, tool, readTool, args } = await sessionWithTool(cwd, id, "edit");
			try {
				await readTool.execute("read", { path: "a.txt" });
				rewriteLater(join(cwd, "a.txt"), "changed before\n");
				const result = await tool.execute("stale", args);
				const text = result.content[0].type === "text" ? result.content[0].text : "";
				expect(text).toContain("(note: the file had been modified on disk since you last read it");
				expect(text).toContain("the edit applied cleanly");
				expect(text).not.toContain("file state is current in your context");
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed after\n");
			} finally {
				session.dispose();
			}
		},
	);

	it.each(["claude-haiku-4-5", "claude-opus-5-5"])(
		"refuses a stale Edit on %s whose old_string no longer matches",
		async (id) => {
			const { session, tool, readTool } = await sessionWithTool(cwd, id, "edit");
			try {
				await readTool.execute("read", { path: "a.txt" });
				rewriteLater(join(cwd, "a.txt"), "moved away\n");
				await expect(
					tool.execute("stale", { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] }),
				).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("moved away\n");
			} finally {
				session.dispose();
			}
		},
	);

	describe.each(["claude-haiku-4-5", "claude-opus-5-5"])("stale detection by modification time on %s", (id) => {
		const touch = (file: string) => {
			const later = new Date(Date.now() + 5000);
			utimesSync(file, later, later);
		};
		const readCases = [
			["offset 2", { path: "a.txt", offset: 2 }],
			["limit 1", { path: "a.txt", limit: 1 }],
		] as const;

		it.each(readCases)("a %s read then a touch recovers the Edit and refuses the Write", async (_name, readArgs) => {
			writeFileSync(join(cwd, "a.txt"), "before\nsecond\nthird\n");
			const edit = await sessionWithTool(cwd, id, "edit");
			const write = await sessionWithTool(cwd, id, "write");
			try {
				await edit.readTool.execute("read", readArgs);
				await write.readTool.execute("read", readArgs);
				touch(join(cwd, "a.txt"));
				const result = await edit.tool.execute("edit", edit.args);
				expect(result.content[0]).toMatchObject({
					text: expect.stringContaining("the file had been modified on disk"),
				});
				writeFileSync(join(cwd, "a.txt"), "before\nsecond\nthird\n");
				touch(join(cwd, "a.txt"));
				await expect(write.tool.execute("write", write.args)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
			} finally {
				edit.session.dispose();
				write.session.dispose();
			}
		});

		it("a full read then a touch applies both tools with the file state suffix", async () => {
			const edit = await sessionWithTool(cwd, id, "edit");
			const write = await sessionWithTool(cwd, id, "write");
			try {
				await edit.readTool.execute("read", { path: "a.txt" });
				touch(join(cwd, "a.txt"));
				const edited = await edit.tool.execute("edit", edit.args);
				expect(edited.content[0]).toMatchObject({ text: expect.stringContaining("file state is current") });
				await write.readTool.execute("read", { path: "a.txt" });
				touch(join(cwd, "a.txt"));
				await write.tool.execute("write", write.args);
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
			} finally {
				edit.session.dispose();
				write.session.dispose();
			}
		});

		it("changed content with an unadvanced modification time is not stale", async () => {
			const { session, tool, readTool, args } = await sessionWithTool(cwd, id, "write");
			try {
				await readTool.execute("read", { path: "a.txt" });
				const before = new Date(Date.now() - 60_000);
				writeFileSync(join(cwd, "a.txt"), "changed before\n");
				utimesSync(join(cwd, "a.txt"), before, before);
				await tool.execute("write", args);
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
			} finally {
				session.dispose();
			}
		});
	});

	it.each(["claude-haiku-4-5", "claude-opus-5-5"])("refuses a stale Write on %s for every model", async (id) => {
		const { session, tool, readTool, args } = await sessionWithTool(cwd, id, "write");
		try {
			await readTool.execute("read", { path: "a.txt" });
			rewriteLater(join(cwd, "a.txt"), "changed before\n");
			await expect(tool.execute("stale", args)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed before\n");
		} finally {
			session.dispose();
		}
	});

	it.each([
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		"eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
		"global.anthropic.claude-opus-4-5-20251101-v1:0",
		"claude-haiku-4-5@20251001",
		"claude-3-5-sonnet-v2@20241022",
	])("maps the provider form %s into the gated family", (id) => {
		expect(isCcLegacyMutationModel(id)).toBe(true);
	});

	it.each([
		["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
		["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
		["claude-opus-4-5-20251101", "claude-opus-4-5"],
		["claude-sonnet-4-20250514", "claude-sonnet-4-0"],
		["Claude-Haiku-4-5", "claude-haiku-4-5"],
		["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
		["eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
		["claude-haiku-4-5@20251001", "claude-haiku-4-5"],
		["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet"],
		["claude-haiku-4-5[1m]", "claude-haiku-4-5"],
		["claude-opus-4", "claude-opus-4-0"],
		["claude-opus-4-10", "claude-opus-4-10"],
		["claude-opus-40", "claude-opus-40"],
		["claude-sonnet-40", "claude-sonnet-40"],
		["claude-sonnet-4-10-20251001", "claude-sonnet-4-10"],
		["us.anthropic.claude-opus-4-10-v1:0", "claude-opus-4-10"],
		["claude-haiku-4-5-latest", "claude-haiku-4-5"],
		["claude-opus-4-7", "claude-opus-4-7"],
		["gpt-5", "gpt-5"],
	])("resolves %s to Claude Code's family name %s", (id, family) => {
		expect(claudeModelFamily(id)).toBe(family);
	});

	it.each([-1, "-1"])("reads through the trailing empty line for limit %s", async (limit) => {
		const call = projectToolCall({ name: "Read", arguments: { file_path: "a.txt", limit } });
		expect(call.inputError).toBeUndefined();
		const result = await createReadTool(cwd).execute("read", call.arguments as { path: string; limit: number });
		expect(result.content).toEqual([{ type: "text", text: "1\tbefore\n2\t" }]);
	});

	it.each(["99999999999999999999999", Number.MAX_SAFE_INTEGER + 1])(
		"rejects an unsafe Read limit %s with CC's Zod message",
		(limit) => {
			const call = projectToolCall({ name: "Read", arguments: { file_path: "a.txt", limit } });
			expect(call.inputError).toBe(tooBigError("limit"));
		},
	);

	it("reports an unsafe offset and an unsafe limit together, offset first", () => {
		const call = projectToolCall({
			name: "Read",
			arguments: { file_path: "a.txt", limit: "9007199254740992", offset: 9007199254740992 },
		});
		expect(call.inputError).toBe(tooBigError("offset", "limit"));
	});

	it.each(["9007199254740992", "99999999999999999999"])(
		"rejects an unsafe Read offset %s with CC's Zod message",
		(offset) => {
			const call = projectToolCall({ name: "Read", arguments: { file_path: "a.txt", offset } });
			expect(call.inputError).toBe(tooBigError("offset"));
		},
	);

	it.each([0, 1, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
		"accepts the safe Read limit %s",
		(limit) => {
			expect(projectToolCall({ name: "Read", arguments: { file_path: "a.txt", limit } }).inputError).toBeUndefined();
		},
	);

	it.each([0, 1, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
		"accepts the safe Read offset %s",
		(offset) => {
			expect(
				projectToolCall({ name: "Read", arguments: { file_path: "a.txt", offset } }).inputError,
			).toBeUndefined();
		},
	);
});

describe("a Read cut at the token cap is an unfinished view", () => {
	const big = `one\ntwo\nthree\n${"abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(6001)}`;
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-cc-capped-"));
		writeFileSync(join(dir, "s.txt"), big);
		writeFileSync(join(dir, "w.txt"), big);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const editArgs = { path: "s.txt", edits: [{ oldText: "two", newText: "TWO" }] };
	const writeArgs = { path: "w.txt", content: "after\n" };
	const notRead = toolUseError(CC_TOOL_TEXT.editNotRead);

	async function cappedRead(id: string, touchAfter: boolean) {
		const edit = await sessionWithTool(dir, id, "edit");
		const write = await sessionWithTool(dir, id, "write");
		const first = await edit.readTool.execute("read", { path: "s.txt" });
		expect(first.details).toMatchObject({ truncation: { truncated: true } });
		await write.readTool.execute("read", { path: "w.txt" });
		if (touchAfter) {
			const later = new Date(Date.now() + 5000);
			utimesSync(join(dir, "s.txt"), later, later);
			utimesSync(join(dir, "w.txt"), later, later);
		}
		return {
			edit,
			write,
			dispose: () => {
				edit.session.dispose();
				write.session.dispose();
			},
		};
	}

	it.each([true, false])("claude-haiku-4-5 refuses both tools, touched: %s", async (touched) => {
		const { edit, write, dispose } = await cappedRead("claude-haiku-4-5", touched);
		try {
			await expect(edit.tool.execute("edit", editArgs)).rejects.toThrow(notRead);
			await expect(write.tool.execute("write", writeArgs)).rejects.toThrow(notRead);
			expect(readFileSync(join(dir, "s.txt"), "utf8")).toBe(big);
			expect(readFileSync(join(dir, "w.txt"), "utf8")).toBe(big);
		} finally {
			dispose();
		}
	});

	it("claude-opus-5-5 applies the Edit with no file state suffix and refuses the Write", async () => {
		const { edit, write, dispose } = await cappedRead("claude-opus-5-5", false);
		try {
			const result = await edit.tool.execute("edit", editArgs);
			expect(result.content[0]).toMatchObject({ text: "The file s.txt has been updated successfully." });
			await expect(write.tool.execute("write", writeArgs)).rejects.toThrow(notRead);
			expect(readFileSync(join(dir, "w.txt"), "utf8")).toBe(big);
		} finally {
			dispose();
		}
	});

	it("claude-opus-5-5 after a touch recovers the Edit with the stale note and refuses the Write as unread", async () => {
		const { edit, write, dispose } = await cappedRead("claude-opus-5-5", true);
		try {
			const result = await edit.tool.execute("edit", editArgs);
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("the file had been modified on disk"),
			});
			await expect(write.tool.execute("write", writeArgs)).rejects.toThrow(notRead);
		} finally {
			dispose();
		}
	});

	it("an Edit keeps the unfinished view, so a later Write to the same file is refused", async () => {
		const { edit, dispose } = await cappedRead("claude-opus-5-5", false);
		try {
			await edit.tool.execute("edit", editArgs);
			const write = edit.session.agent.state.tools.find((tool) => tool.name === "write")!;
			await expect(write.execute("write", { path: "s.txt", content: "after\n" })).rejects.toThrow(notRead);
		} finally {
			dispose();
		}
	});

	it("an Edit result has no file state suffix when the bytes changed under an unchanged modification time", async () => {
		const small = join(dir, "t.txt");
		writeFileSync(small, "one\ntwo\nthree\n");
		const { session, tool, readTool } = await sessionWithTool(dir, "claude-opus-5-5", "edit");
		try {
			await readTool.execute("read", { path: "t.txt" });
			const { mtime } = statSync(small);
			writeFileSync(small, "Zone\ntwo\nthree\n");
			utimesSync(small, mtime, mtime);
			const result = await tool.execute("edit", { path: "t.txt", edits: [{ oldText: "two", newText: "TWO" }] });
			expect(result.content[0]).toMatchObject({ text: "The file t.txt has been updated successfully." });
		} finally {
			session.dispose();
		}
	});
});

function rewriteLater(file: string, text: string): void {
	writeFileSync(file, text);
	const later = new Date(Date.now() + 5000);
	utimesSync(file, later, later);
}

function tooBigError(...fields: Array<"limit" | "offset">): string {
	return `<tool_use_error>InputValidationError: ${JSON.stringify(
		fields.map((field) => ({
			code: "too_big",
			maximum: Number.MAX_SAFE_INTEGER,
			note: "Integers must be within the safe integer range.",
			origin: "int",
			inclusive: true,
			path: [field],
			message: "Too big: expected int to be <=9007199254740991",
		})),
		null,
		2,
	)}</tool_use_error>`;
}

async function sessionWithTool(cwd: string, modelId: string, name: "edit" | "write") {
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const base = getModel("anthropic", "claude-haiku-4-5")!;
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: base,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const tool = session.agent.state.tools.find((tool) => tool.name === name)!;
	const readTool = session.agent.state.tools.find((tool) => tool.name === "read")!;
	const args =
		name === "edit"
			? { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] }
			: { path: "a.txt", content: "after\n" };
	session.agent.state.model = { ...base, id: modelId };
	return { session, tool, readTool, args };
}
