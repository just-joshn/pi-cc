import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const PROVIDER = "fixed-tools-provider";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: PROVIDER,
		baseUrl: "https://fixed-tools.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: { supportsMidConvoToolChanges: true },
	};
}

describe("fixedTools", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-fixed-tools-"));
		mkdirSync(join(tempDir, "agent"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps mid-conversation tool changes off after a model switch", async () => {
		const agentDir = join(tempDir, "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const sent: Model<"anthropic-messages">[] = [];
		modelRegistry.registerProvider(PROVIDER, {
			api: "anthropic-messages",
			streamSimple: (requestModel) => {
				sent.push(requestModel as Model<"anthropic-messages">);
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
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
			cwd: tempDir,
			agentDir,
			model: createModel("first"),
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(tempDir),
			fixedTools: true,
		});
		try {
			await session.prompt("one");
			await session.setModel(createModel("second"));
			await session.prompt("two");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(PROVIDER);
		}

		expect(sent.map((model) => [model.id, model.compat?.supportsMidConvoToolChanges])).toEqual([
			["first", false],
			["second", false],
		]);
	});
});
