import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const haiku = getModel("anthropic", "claude-haiku-4-5")!;
const sonnet = getModel("anthropic", "claude-sonnet-4-5")!;

describe("ANTHROPIC_MODEL against a resumed session", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-anthropic-model-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/** A session that already ran, with a model the transcript names. */
	async function resumedSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		sessionManager.appendModelChange("anthropic", sonnet.id);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});
		return session;
	}

	it("restores the session's model when the environment names none", async () => {
		const session = await resumedSession();

		expect(session.model?.id).toBe(sonnet.id);
		session.dispose();
	});

	it("takes the environment's model instead, as Claude Code does on `-c`", async () => {
		vi.stubEnv("ANTHROPIC_MODEL", haiku.id);

		const session = await resumedSession();

		expect(session.model?.id).toBe(haiku.id);
		session.dispose();
	});
});
