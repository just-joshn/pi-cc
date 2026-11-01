import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { PermissionState } from "../src/core/permissions/context.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { declaredToolName } from "../src/core/tools/cc-surface.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const provider = "search-test-provider";
const model: Model<Api> = {
	id: "search-test",
	name: "search-test",
	api: "anthropic-messages",
	provider,
	baseUrl: "https://search-test.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("CC search session loadouts", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-cc-search-session-"));
		vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "");
		vi.stubEnv("CLAUDE_CODE_SIMPLE", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
	});
	async function loadout(options: Partial<CreateAgentSessionOptions>) {
		const auth = AuthStorage.create(join(cwd, "auth.json"));
		await auth.modify(provider, async () => ({ type: "api_key", key: "local-test-key" }));
		const registry = await createModelRegistry(auth, join(cwd, "models.json"));
		let requested: string[] = [];
		registry.registerProvider(provider, {
			api: "anthropic-messages",
			streamSimple: (model, context) => {
				requested = context.messages.flatMap((message) =>
					message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
				);
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				return stream;
			},
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model,
			modelRuntime: getModelRuntime(registry),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
			...options,
		});
		try {
			const initNames = session.getActiveToolNames().map(declaredToolName);
			await session.prompt("local test");
			return { initNames, requested };
		} finally {
			session.dispose();
			registry.unregisterProvider(provider);
		}
	}
	it("preserves noTools despite search opt-in and local-agent", async () => {
		vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "local-agent");
		const result = await loadout({
			noTools: "all",
			permissions: { state: new PermissionState({ cwd, allowedTools: ["Grep"] }), prompts: "none" },
		});
		expect(result.initNames).toEqual([]);
		expect(result.requested).toEqual([]);
	});
	it.each(["all", "builtin"] as const)("preserves noTools %s in simple mode", async (noTools) => {
		vi.stubEnv("CLAUDE_CODE_SIMPLE", "1");
		expect((await loadout({ noTools })).initNames).toEqual([]);
	});
	it("keeps default search absent in init and request", async () => {
		const result = await loadout({});
		for (const names of [result.initNames, result.requested]) {
			expect(names).not.toContain("Grep");
			expect(names).not.toContain("Glob");
		}
	});
	it("jointly exposes an allowed search tool in init and request", async () => {
		const result = await loadout({
			permissions: { state: new PermissionState({ cwd, allowedTools: ["Grep(src/**)"] }), prompts: "none" },
		});
		for (const names of [result.initNames, result.requested]) {
			expect(names).toContain("Grep");
			expect(names).toContain("Glob");
		}
	});
	it("uses explicit tools without re-adding search when Bash is omitted", async () => {
		const result = await loadout({ tools: ["Read", "Edit"] });
		expect(result.initNames.sort()).toEqual(["Edit", "Read"]);
		expect(result.requested).not.toContain("Grep");
		expect(result.requested).not.toContain("Glob");
	});
	it("exposes only the requested search tool", async () => {
		const result = await loadout({ tools: ["Glob", "Read"] });
		expect(result.initNames.sort()).toEqual(["Glob", "Read"]);
		expect(result.requested).toContain("Glob");
		expect(result.requested).not.toContain("Grep");
	});
	it("uses independent explicit subagent search exposure despite the parent denylist", async () => {
		const result = await loadout({
			tools: ["Grep", "Glob"],
			toolContext: "subagent",
			excludeTools: ["Grep"],
			permissions: { state: new PermissionState({ cwd, disallowedTools: ["Grep"] }), prompts: "none" },
		});
		expect(result.initNames.sort()).toEqual(["Glob", "Grep"]);
		expect(result.requested.filter((name) => name !== "DeferredToolPlaceholder")).toEqual(["Glob", "Grep"]);
	});
	it("drops subagent search when its explicit list includes Bash", async () => {
		const result = await loadout({ tools: ["Bash", "Grep", "Glob"], toolContext: "subagent" });
		expect(result.initNames).toEqual(["Bash"]);
		expect(result.requested.filter((name) => name !== "DeferredToolPlaceholder")).toEqual(["Bash"]);
	});
	it("simple mode ignores an explicit subagent list", async () => {
		vi.stubEnv("CLAUDE_CODE_SIMPLE", "1");
		const result = await loadout({ tools: ["Grep", "Glob"], toolContext: "subagent" });
		expect(result.initNames.sort()).toEqual(["Bash", "Edit", "Read"]);
	});
	it("Bash denial re-adds search but a simultaneous Grep denial removes only Grep", async () => {
		const result = await loadout({
			excludeTools: ["Bash", "Grep"],
			permissions: { state: new PermissionState({ cwd, disallowedTools: ["Bash", "Grep"] }), prompts: "none" },
		});
		expect(result.initNames).toContain("Glob");
		expect(result.initNames).not.toContain("Grep");
		expect(result.initNames).not.toContain("Bash");
	});
});
