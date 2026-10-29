import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthContext } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { recordFetch } from "./anthropic-utils.ts";

const signal = new AbortController().signal;

function envContext(env: Record<string, string | undefined>): AuthContext {
	return { env: async (name) => env[name], fileExists: async () => false };
}

async function storedKey(key: string): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic", async () => ({ type: "api_key", key }));
	return store;
}

const GATEWAY_ENV = {
	ANTHROPIC_BASE_URL: "https://gateway.example",
	ANTHROPIC_CUSTOM_HEADERS: "x-case: one",
};
const GATEWAY_AUTH = { baseUrl: "https://gateway.example", headers: { "x-case": "one" } };

describe("provider environment at auth resolution", () => {
	it("applies the environment on top of a stored credential", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			await storedKey("stored-key"),
			envContext(GATEWAY_ENV),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "stored-key", ...GATEWAY_AUTH });
	});

	it("applies the environment on top of an --api-key override", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext(GATEWAY_ENV),
			{ apiKey: "override-key", signal },
		);

		expect(result?.auth).toEqual({ apiKey: "override-key", ...GATEWAY_AUTH });
	});

	it("applies the environment on top of an ambient API key", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ...GATEWAY_ENV, ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result?.auth).toEqual({ apiKey: "env-key", ...GATEWAY_AUTH });
		expect(result?.source).toBe("ANTHROPIC_API_KEY");
	});

	it("keeps the ANTHROPIC_AUTH_TOKEN bearer over a custom authorization header", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_AUTH_TOKEN: "case-bearer", ANTHROPIC_CUSTOM_HEADERS: "authorization: Bearer custom" }),
			{ signal },
		);

		expect(result?.auth.headers).toEqual({ Authorization: "Bearer case-bearer" });
	});

	it("adds no baseUrl key when the environment names no endpoint", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_API_KEY: "env-key" }),
			{ signal },
		);

		expect(result === undefined ? true : "baseUrl" in result.auth).toBe(false);
	});

	it("configures the provider from custom headers alone", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key" }),
			{ signal },
		);

		expect(result).toEqual({ auth: { headers: { "x-api-key": "header-key" } }, source: "environment" });
	});

	it("stays unconfigured for custom headers that carry no request auth", async () => {
		const result = await resolveProviderAuth(
			anthropicProvider(),
			new InMemoryCredentialStore(),
			envContext({ ANTHROPIC_CUSTOM_HEADERS: "x-trace: 1" }),
			{ signal },
		);

		expect(result).toBeUndefined();
	});
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

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

const transcript = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

describe("custom headers on the wire", () => {
	it("lets a custom x-api-key override the key-derived one", async () => {
		const recorder = recordFetch(() => sseResponse());
		const models = createModels({
			authContext: envContext({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-key" }),
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, transcript, { fetch: recorder.fetch }).result();

		expect(recorder.requests).toHaveLength(1);
		expect(recorder.requests[0].headers.get("x-api-key")).toBe("header-key");
	});

	it("lets a custom anthropic-version override the transport default", async () => {
		const recorder = recordFetch(() => sseResponse());

		await streamAnthropic(anthropicModel, transcript, {
			apiKey: "key",
			headers: { "anthropic-version": "2024-01-01" },
			fetch: recorder.fetch,
		}).result();

		expect(recorder.requests[0].headers.get("anthropic-version")).toBe("2024-01-01");
	});
});
