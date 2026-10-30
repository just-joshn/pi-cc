import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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
];

describe("CC model-specific prior-read checks", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-cc-preread-"));
		writeFileSync(join(cwd, "a.txt"), "before\n");
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it.each(["edit", "write"])("checks the current model for every %s path and preserves stale checks", async (name) => {
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
		try {
			const tool = session.agent.state.tools.find((tool) => tool.name === name)!;
			const args =
				name === "edit"
					? { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] }
					: { path: "a.txt", content: "after\n" };
			for (const id of gatedModels) {
				session.agent.state.model = { ...base, id };
				await expect(tool.execute("unread", args)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editNotRead));
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before\n");
			}
			session.agent.state.model = { ...base, id: "claude-opus-5-5" };
			await tool.execute("new-model", args);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
			session.agent.state.model = base;
			writeFileSync(join(cwd, "a.txt"), "before\n");
			await expect(tool.execute("stale", args)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
			await session.agent.state.tools.find((tool) => tool.name === "read")!.execute("read", { path: "a.txt" });
			await tool.execute("read-first", args);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
		} finally {
			session.dispose();
		}
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
			expect(call.inputError).toBe(
				`<tool_use_error>InputValidationError: ${JSON.stringify(
					[
						{
							code: "too_big",
							maximum: Number.MAX_SAFE_INTEGER,
							note: "Integers must be within the safe integer range.",
							origin: "int",
							path: ["limit"],
							message: "Too big: expected int to be <9007199254740991",
						},
					],
					null,
					2,
				)}</tool_use_error>`,
			);
		},
	);

	it.each([0, 1, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
		"accepts the safe Read limit %s",
		(limit) => {
			expect(projectToolCall({ name: "Read", arguments: { file_path: "a.txt", limit } }).inputError).toBeUndefined();
		},
	);
});
