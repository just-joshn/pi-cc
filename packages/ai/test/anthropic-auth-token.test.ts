import { beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { formatUserAgent } from "../src/utils/identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { type RecordedAnthropicRequest, recordFetch } from "./anthropic-utils.ts";

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

let requests: RecordedAnthropicRequest[];
let fetch: ReturnType<typeof recordFetch>["fetch"];

beforeEach(() => {
	const recorder = recordFetch(() => sseResponse());
	requests = recorder.requests;
	fetch = recorder.fetch;
});

const PI_USER_AGENT = formatUserAgent();
const neverAbortedSignal = new AbortController().signal;

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

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

const kimiCodingModel: Model<"anthropic-messages"> = {
	...anthropicModel,
	id: "kimi-for-coding",
	name: "Kimi For Coding",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};

describe("Anthropic auth token env", () => {
	it("sends ANTHROPIC_AUTH_TOKEN as a bearer alongside the key, as Claude Code does", async () => {
		const provider = anthropicProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) =>
					({
						ANTHROPIC_AUTH_TOKEN: "auth-token",
						ANTHROPIC_OAUTH_TOKEN: "oauth-token",
						ANTHROPIC_API_KEY: "api-key",
					})[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({
			auth: { apiKey: "oauth-token", headers: { Authorization: "Bearer auth-token" } },
			source: ANTHROPIC_AUTH_TOKEN_ENV,
			sourceKind: "environment",
		});
	});

	it("sends ANTHROPIC_AUTH_TOKEN alone as a bearer when no key variable is set", async () => {
		const provider = anthropicProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => ({ ANTHROPIC_AUTH_TOKEN: "auth-token" })[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: ANTHROPIC_AUTH_TOKEN_ENV,
			sourceKind: "environment",
		});
	});

	it("preserves ANTHROPIC_OAUTH_TOKEN as OAuth-shaped API auth", async () => {
		const provider = anthropicProvider();
		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) =>
					({
						ANTHROPIC_OAUTH_TOKEN: "oauth-token",
						ANTHROPIC_API_KEY: "api-key",
					})[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});

		expect(auth).toEqual({
			auth: { apiKey: "oauth-token" },
			source: ANTHROPIC_OAUTH_TOKEN_ENV,
			sourceKind: "environment",
		});
	});

	it("uses Authorization headers without OAuth-mode request shaping", async () => {
		const stream = streamAnthropic(anthropicModel, context, {
			headers: { Authorization: "Bearer gateway-token" },
			fetch,
		});
		await stream.result();

		const [request] = requests;
		expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
		expect(request.headers.get("x-api-key")).toBeNull();
		expect(request.headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
		expect(request.body.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it("threads authContext ANTHROPIC_AUTH_TOKEN through request headers", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, context, { fetch }).result();

		const [request] = requests;
		expect(request.headers.get("authorization")).toBe("Bearer ctx-token");
		expect(request.headers.get("x-api-key")).toBeNull();
		expect(request.headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
		expect(request.body.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it("preserves OAuth request shaping for ANTHROPIC_OAUTH_TOKEN", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? "sk-ant-oat-test" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, context, { fetch }).result();

		const [request] = requests;
		expect(request.headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
		expect(request.headers.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
	});

	it("lets explicit request headers override ANTHROPIC_AUTH_TOKEN", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models
			.streamSimple(anthropicModel, context, {
				headers: { Authorization: "Bearer explicit-token" },
				fetch,
			})
			.result();

		expect(requests[0].headers.get("authorization")).toBe("Bearer explicit-token");
	});
});

describe("Anthropic-compatible user agents", () => {
	it("uses pi's User-Agent by default for Anthropic Messages requests", async () => {
		await streamAnthropic(anthropicModel, context, { apiKey: "anthropic-key", fetch }).result();

		expect(requests[0].headers.get("user-agent")).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default Anthropic Messages User-Agent", async () => {
		await streamAnthropic(kimiCodingModel, context, {
			apiKey: "kimi-key",
			headers: { "User-Agent": "custom-client" },
			fetch,
		}).result();

		expect(requests[0].headers.get("user-agent")).toBe("custom-client");
	});

	it("preserves explicit Anthropic beta header replacement", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "anthropic-key",
			headers: { "anthropic-beta": "custom-beta" },
			fetch,
		}).result();

		expect(requests[0].headers.get("anthropic-beta")).toBe("custom-beta");
	});

	it("preserves explicit Anthropic beta header suppression", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "anthropic-key",
			headers: { "anthropic-beta": null },
			fetch,
		}).result();

		expect(requests[0].headers.get("anthropic-beta")).toBeNull();
	});
});
