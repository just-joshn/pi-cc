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

const gatewaySonnet = {
	...sonnet,
	id: "glm-4.6",
	name: "Sonnet Gateway",
	provider: "vercel-ai-gateway",
};

/** Anthropic serves only haiku, so a search for `sonnet` can only find the gateway's model. */
function gatewayRuntime() {
	const models = [haiku, gatewaySonnet];
	return {
		getModel: (provider: string, modelId: string) =>
			models.find((model) => model.provider === provider && model.id === modelId),
		getModels: () => models,
		hasConfiguredAuth: () => true,
		getAvailableSnapshot: () => models,
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

	test("sends a name outside the catalog as a custom model id on the provider", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: sonnet.id,
			modelRuntime: anthropicRuntime(),
			env: { ANTHROPIC_MODEL: "claude-not-a-model" },
		});

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-not-a-model");
	});

	test("resolves a bare family alias to the build's default for that family", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: sonnet.id,
			modelRuntime: anthropicRuntime(),
			env: { ANTHROPIC_MODEL: "opus" },
		});

		expect(result.model?.id).toBe("claude-opus-5-5");
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

	test("keeps a rewritten family alias on the Anthropic provider", () => {
		vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.6");

		const result = resolveCliModel({ cliModel: "sonnet", modelRuntime: gatewayRuntime() });

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("glm-4.6");
	});

	test("keeps pi's model search for a family alias when no model variable is set", () => {
		const result = resolveCliModel({ cliModel: "sonnet", modelRuntime: gatewayRuntime() });

		expect(result.model?.provider).toBe("vercel-ai-gateway");
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

	test("ANTHROPIC_BASE_URL beats a models.json baseUrl, as the environment does in Claude Code", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { anthropic: { baseUrl: "https://configured.example" } } }),
		);

		vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example");

		await expect(requestUrls(modelsPath)).resolves.toEqual(["https://ambient.example/v1/messages?beta=true"]);
	});

	test("a models.json apiKey still serves another provider, which the environment does not outrank", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { apiKey: "models-json-key" } } }));

		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory({}), modelsPath));
		vi.stubEnv("OPENAI_API_KEY", "env-key");

		expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("models-json-key");
	});

	test("ANTHROPIC_AUTH_TOKEN beats a models.json apiKey", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { apiKey: "models-json-key" } } }));

		const runtime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory({ anthropic: { type: "api_key", key: "key" } }), modelsPath),
		);
		let headers: Headers | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			headers = new Headers(init?.headers);
			return sseResponse();
		};
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-bearer");

		await runtime.streamSimple(runtime.getModel("anthropic", haiku.id)!, { messages: [] }, { fetch }).result();

		expect(headers?.get("authorization")).toBe("Bearer env-bearer");
		expect(headers?.get("x-api-key")).toBeNull();
	});

	test("ANTHROPIC_BASE_URL serves a model that models.json leaves alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-env-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { apiKey: "models-json-key" } } }));

		vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example");

		await expect(requestUrls(modelsPath)).resolves.toEqual(["https://ambient.example/v1/messages?beta=true"]);
	});
});
