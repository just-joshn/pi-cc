import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionState, type SettingsPermissions } from "../src/core/permissions/context.ts";
import { PermissionGate } from "../src/core/permissions/gate.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { CC_TOOL_TEXT, toolUseError } from "../src/core/tools/cc-text.ts";

let cwd: string;
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-readgate-")));
	writeFileSync(join(cwd, "a.txt"), "before\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("Claude Code's TSe: may a file the model never read be edited", () => {
	const gateFor = (settings: SettingsPermissions, mode?: "bypassPermissions") =>
		new PermissionGate({ state: new PermissionState({ cwd, settings, ...(mode ? { cliMode: mode } : {}) }) });

	it("is true for a path inside the working directory that no Read rule covers", () => {
		expect(gateFor({}).readAutoAllowed(join(cwd, "a.txt"))).toBe(true);
	});

	it("is false when a whole-tool or path Read deny or ask rule covers the path", () => {
		const path = join(cwd, "a.txt");
		expect(gateFor({ deny: ["Read"] }).readAutoAllowed(path)).toBe(false);
		expect(gateFor({ ask: ["Read"] }).readAutoAllowed(path)).toBe(false);
		expect(gateFor({ deny: ["Read(./a.txt)"] }).readAutoAllowed(path)).toBe(false);
		expect(gateFor({ ask: ["Read(./a.txt)"] }).readAutoAllowed(path)).toBe(false);
	});

	it("is false outside the working directory, unless a Read allow rule covers it or bypassPermissions is on", () => {
		expect(gateFor({}).readAutoAllowed("/etc/hosts")).toBe(false);
		expect(gateFor({ allow: ["Read(//etc/hosts)"] }).readAutoAllowed("/etc/hosts")).toBe(true);
		expect(gateFor({}, "bypassPermissions").readAutoAllowed("/etc/hosts")).toBe(true);
	});
});

async function session(
	modelId: string,
	settings: SettingsPermissions,
	active?: string[],
	mode: "acceptEdits" | "default" = "acceptEdits",
) {
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const base = getModel("anthropic", "claude-haiku-4-5")!;
	const { session: created } = await createAgentSession({
		cwd,
		agentDir,
		model: base,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		permissions: { state: new PermissionState({ cwd, settings, cliMode: mode }) },
	});
	created.agent.state.model = { ...base, id: modelId };
	if (active) created.setActiveToolsByName(active);
	const tool = (name: string) => created.agent.state.tools.find((candidate) => candidate.name === name)!;
	return { session: created, edit: tool("edit"), write: tool("write"), read: tool("read") };
}

const editArgs = { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] };

describe("the gate in a session", () => {
	it("lets an ungated model edit an unread file when Read would run without asking", async () => {
		const { session: s, edit } = await session("claude-opus-5-5", {});
		try {
			await edit.execute("edit", editArgs);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after\n");
		} finally {
			s.dispose();
		}
	});

	it("refuses an unread edit on an ungated model when a Read rule asks about the path", async () => {
		const { session: s, edit } = await session("claude-opus-5-5", { ask: ["Read(./a.txt)"] });
		try {
			await expect(edit.execute("edit", editArgs)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editNotRead));
		} finally {
			s.dispose();
		}
	});

	it("refuses an unread edit on an ungated model when no Read tool is active", async () => {
		const { session: s, edit } = await session("claude-opus-5-5", {}, ["edit", "write"]);
		try {
			await expect(edit.execute("edit", editArgs)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editNotRead));
		} finally {
			s.dispose();
		}
	});

	it("recovers a stale Edit only while Read would run without asking, and refuses a stale Write either way", async () => {
		const later = () => {
			writeFileSync(join(cwd, "a.txt"), "changed before\n");
			const time = new Date(Date.now() + 5000);
			utimesSync(join(cwd, "a.txt"), time, time);
		};
		const open = await session("claude-opus-5-5", {});
		try {
			await open.read.execute("read", { path: "a.txt" });
			later();
			const result = await open.edit.execute("edit", editArgs);
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("the file had been modified on disk"),
			});
		} finally {
			open.session.dispose();
		}

		const asking = await session("claude-opus-5-5", { ask: ["Read(./a.txt)"] });
		try {
			writeFileSync(join(cwd, "a.txt"), "before\n");
			await asking.read.execute("read", { path: "a.txt" });
			later();
			await expect(asking.edit.execute("edit", editArgs)).rejects.toThrow(toolUseError(CC_TOOL_TEXT.editStale));
			await expect(asking.write.execute("write", { path: "a.txt", content: "x\n" })).rejects.toThrow(
				toolUseError(CC_TOOL_TEXT.editStale),
			);
		} finally {
			asking.session.dispose();
		}
	});
});

describe("validation before permission", () => {
	it("reports a failed match before it asks, and asks only for an edit that would apply", async () => {
		const { session: s, edit } = await session("claude-opus-5-5", {}, undefined, "default");
		try {
			await expect(
				edit.execute("miss", { path: "a.txt", edits: [{ oldText: "absent", newText: "x" }] }),
			).rejects.toThrow("String to replace not found");
			await expect(edit.execute("ask", editArgs)).rejects.toThrow(
				/Claude requested permissions to write to .*a\.txt, but you haven't granted it yet\./,
			);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before\n");
		} finally {
			s.dispose();
		}
	});
});
