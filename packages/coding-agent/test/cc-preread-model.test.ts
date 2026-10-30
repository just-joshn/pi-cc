import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	// Dated first-party forms, which Claude Code resolves to the bare family name before testing.
	"claude-haiku-4-5-20251001",
	"claude-sonnet-4-5-20250929",
	"claude-opus-4-5-20251101",
	"claude-sonnet-4-20250514",
	// Mixed case, which Claude Code lowercases before testing.
	"Claude-Haiku-4-5",
];

const ungatedModels = ["claude-opus-4-7", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-5", "my-gpt-5-20251001"];

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
			const { session, tool, args } = await sessionWithTool(cwd, id, "edit");
			try {
				await tool.execute("read", { path: "a.txt" });
				writeFileSync(join(cwd, "a.txt"), "changed before\n");
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
			const { session, tool } = await sessionWithTool(cwd, id, "edit");
			try {
				await tool.execute("read", { path: "a.txt" });
				writeFileSync(join(cwd, "a.txt"), "moved away\n");
				await expect(
					tool.execute("stale", { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] }),
				).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("moved away\n");
			} finally {
				session.dispose();
			}
		},
	);

	it.each(["claude-haiku-4-5", "claude-opus-5-5"])("refuses a stale Write on %s for every model", async (id) => {
		const { session, tool, args } = await sessionWithTool(cwd, id, "write");
		try {
			await tool.execute("read", { path: "a.txt" });
			writeFileSync(join(cwd, "a.txt"), "changed before\n");
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

function tooBigError(field: "limit" | "offset"): string {
	return `<tool_use_error>InputValidationError: ${JSON.stringify(
		[
			{
				code: "too_big",
				maximum: Number.MAX_SAFE_INTEGER,
				note: "Integers must be within the safe integer range.",
				origin: "int",
				inclusive: true,
				path: [field],
				message: `Too big: expected int to be <=9007199254740991`,
			},
		],
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
