import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel, resolveCliModel } from "../src/core/model-resolver.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const haiku = getModel("anthropic", "claude-haiku-4-5")!;
const sonnet = getModel("anthropic", "claude-sonnet-4-5")!;

function anthropicRuntime(authenticated = true) {
	return {
		getModel: (provider: string, modelId: string) =>
			provider === "anthropic" ? [haiku, sonnet].find((model) => model.id === modelId) : undefined,
		getModels: () => [haiku, sonnet],
		hasConfiguredAuth: (provider: string) => authenticated && provider === "anthropic",
		getAvailableSnapshot: () => [sonnet],
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
}

describe("ANTHROPIC_MODEL in initial model selection", () => {
	test("beats the saved default", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: sonnet.id,
			modelRuntime: anthropicRuntime(),
			env: { ANTHROPIC_MODEL: haiku.id },
		});

		expect(result.model?.id).toBe(haiku.id);
	});

	test("resolves a family alias through its variable", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: sonnet.id,
			modelRuntime: anthropicRuntime(),
			env: { ANTHROPIC_MODEL: "haiku", ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id },
		});

		expect(result.model?.id).toBe(haiku.id);
	});

	test("falls through to the saved default when the id is not in the catalog", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: sonnet.id,
			modelRuntime: anthropicRuntime(),
			env: { ANTHROPIC_MODEL: "claude-not-a-model" },
		});

		expect(result.model?.id).toBe(sonnet.id);
	});

	test("does not apply without Anthropic auth", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: anthropicRuntime(false),
			env: { ANTHROPIC_MODEL: haiku.id },
		});

		expect(result.model?.id).toBe(sonnet.id);
	});

	test("loses to an explicit --model, which resolves before the initial model is chosen", () => {
		vi.stubEnv("ANTHROPIC_MODEL", haiku.id);

		const result = resolveCliModel({ cliModel: sonnet.id, modelRuntime: anthropicRuntime() });

		expect(result.model?.id).toBe(sonnet.id);
		vi.unstubAllEnvs();
	});
});

describe("model env alongside models.json", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function sseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	async function requestUrls(modelsPath: string | undefined): Promise<string[]> {
		const runtime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory({ anthropic: { type: "api_key", key: "key" } }), modelsPath),
		);
		const urls: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			urls.push(String(input));
			return sseResponse();
		};

		await runtime.streamSimple(runtime.getModel("anthropic", haiku.id)!, { messages: [] }, { fetch }).result();

		return urls;
	}

	test("an explicit models.json baseUrl beats ANTHROPIC_BASE_URL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { anthropic: { baseUrl: "https://configured.example" } } }),
		);

		vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example");

		await expect(requestUrls(modelsPath)).resolves.toEqual(["https://configured.example/v1/messages?beta=true"]);
	});

	test("ANTHROPIC_BASE_URL serves a model that models.json leaves alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { apiKey: "models-json-key" } } }));

		vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example");

		await expect(requestUrls(modelsPath)).resolves.toEqual(["https://ambient.example/v1/messages?beta=true"]);
	});
});
