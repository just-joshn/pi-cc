import { describe, expect, it } from "vitest";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { recordFetch } from "./anthropic-utils.ts";

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

const model: Model<"anthropic-messages"> = {
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

async function requestUrl(env: Record<string, string>): Promise<string> {
	const recorder = recordFetch(() => sseResponse());
	const models = createModels({
		authContext: { env: async (name) => env[name], fileExists: async () => false },
	});
	models.setProvider(anthropicProvider());

	await models.streamSimple(model, transcript, { fetch: recorder.fetch }).result();

	expect(recorder.requests).toHaveLength(1);
	return recorder.requests[0].url.href;
}

describe("ANTHROPIC_BASE_URL", () => {
	it("sends the messages request to the endpoint the environment names", async () => {
		await expect(
			requestUrl({ ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://gateway.example" }),
		).resolves.toBe("https://gateway.example/v1/messages?beta=true");
	});

	it("keeps a path prefix and drops trailing slashes", async () => {
		await expect(
			requestUrl({ ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://gateway.example/anthropic/" }),
		).resolves.toBe("https://gateway.example/anthropic/v1/messages?beta=true");
	});

	it("falls back to api.anthropic.com when the environment is unset", async () => {
		await expect(requestUrl({ ANTHROPIC_API_KEY: "key" })).resolves.toBe(
			"https://api.anthropic.com/v1/messages?beta=true",
		);
	});
});
