import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { discoverMemory } from "../src/core/memory/discover.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function blocks(message: TranscriptContext["messages"][number] | undefined): Array<{ type: string; text?: string }> {
	if (message === undefined || !("content" in message)) return [];
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

async function memoryHarness(): Promise<{ harness: Harness; workspace: string; memoryDir: string }> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-session-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	const memoryDir = `${join(root, "auto-memory")}/`;
	mkdirSync(join(workspace, "sub"), { recursive: true });
	writeFileSync(join(workspace, "CLAUDE.md"), "PROJECT_MEMORY");
	writeFileSync(join(workspace, "sub", "CLAUDE.md"), "SUB_MEMORY");
	writeFileSync(join(workspace, "sub", "file.txt"), "file body");
	mkdirSync(join(workspace, "w"), { recursive: true });
	writeFileSync(join(workspace, "w", "CLAUDE.md"), "WRITE_MEMORY");
	mkdirSync(join(workspace, "e"), { recursive: true });
	writeFileSync(join(workspace, "e", "CLAUDE.md"), "EDIT_MEMORY");
	writeFileSync(join(workspace, "e", "file.txt"), "old");
	const snapshot = discoverMemory({
		cwd: workspace,
		home: join(root, "home"),
		configDir: join(root, "config"),
		managedDir: undefined,
		sources: { user: true, project: true, local: true },
		excludes: [],
		autoMemory: { dir: memoryDir },
		disabled: false,
		instructionFiles: "claude-md",
	});
	const resourceLoader: ResourceLoader = { ...createTestResourceLoader(), getMemory: () => snapshot };
	const harness = await createHarness({ resourceLoader });
	cleanups.push(() => harness.cleanup());
	return { harness, workspace, memoryDir };
}

describe("memory in an agent session", () => {
	test("startup memory leads the first user message on every request and stays out of the transcript", async () => {
		const { harness, workspace, memoryDir } = await memoryHarness();
		const requests: TranscriptContext[] = [];
		const file = join(workspace, "sub", "file.txt");
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(context);
				return fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("done");
			},
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("again");
			},
		]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");

		expect(requests).toHaveLength(4);
		for (const request of requests) {
			const firstUser = blocks(request.messages.find((message) => message.role === "user"));
			expect(firstUser[0]?.text).toMatch(
				new RegExp(
					`^<system-reminder>\\n[^\\n]+\\n\\nContents of ${escapeRegExp(join(workspace, "CLAUDE.md"))} \\(`,
				),
			);
			expect(firstUser[0]?.text).toContain("PROJECT_MEMORY");
			expect(firstUser[1]?.text).toBe("first prompt");
			const systemPrompt = getCurrentSystemPrompt(request.messages) ?? "";
			expect(systemPrompt).not.toContain("PROJECT_MEMORY");
			expect(systemPrompt).toContain(`<memory>\nAuto memory directory: ${memoryDir}`);
		}
		expect(existsSync(memoryDir)).toBe(true);

		const nested = `<system-reminder>\nContents of ${join(workspace, "sub", "CLAUDE.md")}:\n\nSUB_MEMORY\n</system-reminder>`;
		const toolResults = requests[3].messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((result) => blocks(result).map((block) => block.text))).toEqual([
			[expect.stringContaining("file body"), nested],
			[expect.stringContaining("file body")],
		]);

		const stored = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(stored.map((message) => (message.details as { ccMemoryReminders?: number[] })?.ccMemoryReminders)).toEqual(
			[[1], undefined],
		);

		const storedUser = harness.session.messages.find((message) => message.role === "user");
		expect(JSON.stringify(storedUser)).not.toContain("PROJECT_MEMORY");
	});

	test("a successful write or edit brings in the memory of its directory once", async () => {
		const { harness, workspace } = await memoryHarness();
		const requests: TranscriptContext[] = [];
		const respond = (call?: ReturnType<typeof fauxToolCall>) => (context: TranscriptContext) => {
			requests.push(context);
			return call ? fauxAssistantMessage([call], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		};
		harness.setResponses([
			respond(fauxToolCall("write", { path: join(workspace, "w", "a.txt"), content: "a" })),
			respond(fauxToolCall("write", { path: join(workspace, "w", "b.txt"), content: "b" })),
			respond(
				fauxToolCall("edit", {
					path: join(workspace, "e", "file.txt"),
					edits: [{ oldText: "old", newText: "new" }],
				}),
			),
			respond(),
		]);

		await harness.session.prompt("go");

		const results = requests[3].messages.filter((message) => message.role === "toolResult");
		const text = results.map((result) =>
			blocks(result)
				.map((block) => block.text ?? "")
				.join("\n"),
		);
		expect(text[0]).toContain(`Contents of ${join(workspace, "w", "CLAUDE.md")}:\n\nWRITE_MEMORY`);
		expect(text[1]).not.toContain("WRITE_MEMORY");
		expect(text[2]).toContain(`Contents of ${join(workspace, "e", "CLAUDE.md")}:\n\nEDIT_MEMORY`);
	});
});

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
