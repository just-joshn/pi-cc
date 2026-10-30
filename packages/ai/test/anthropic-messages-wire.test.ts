import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { recordFetch } from "./anthropic-utils.ts";

// Characterization pin for the Anthropic Messages request shape and stream
// handling. Intercepts the injected `fetch`, so it pins what every provider
// sees on the wire rather than how the request is assembled internally.

function fixture(name: string): string {
	return readFileSync(new URL(`./data/anthropic-messages/${name}`, import.meta.url), "utf8");
}

const thinkingTextToolUse = fixture("thinking-text-tool-use.sse");
const overloadedError = fixture("overloaded-error.sse");

function sseResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 4096,
};

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Anthropic Messages request", () => {
	it("posts the built payload to the beta messages endpoint with API key auth", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		await streamAnthropic(model, context, { apiKey: "anthropic-key", fetch }).result();

		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.url.toString()).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("x-api-key")).toBe("anthropic-key");
		expect(request.headers.get("authorization")).toBeNull();
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("accept")).toBe("application/json");
		expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(request.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
		expect(request.headers.get("user-agent")).toMatch(/^pi\//);
		expect(request.body).toEqual({
			model: "claude-test",
			max_tokens: 4096,
			stream: true,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
				},
			],
			system: [{ type: "text", text: "System prompt.", cache_control: { type: "ephemeral" } }],
		});
	});

	it("moves the request betas onto the anthropic-beta header", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		await streamAnthropic(model, context, {
			apiKey: "anthropic-key",
			fetch,
			headers: { "anthropic-beta": "custom-beta, other-beta" },
		}).result();

		expect(requests[0].body).not.toHaveProperty("betas");
		expect(requests[0].headers.get("anthropic-beta")).toBe("custom-beta,other-beta");
	});

	it("uses header-owned auth without an API key", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		await streamAnthropic(model, context, { fetch, headers: { Authorization: "Bearer gateway-token" } }).result();

		expect(requests[0].headers.get("authorization")).toBe("Bearer gateway-token");
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
	});

	it("keeps pi identity and OAuth auth without client impersonation", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		await streamAnthropic(model, context, { apiKey: "sk-ant-oat-test", fetch }).result();

		expect(requests[0].headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("user-agent")).toMatch(/^pi\//);
		expect(requests[0].headers.get("x-app")).toBeNull();
		expect(requests[0].headers.get("anthropic-beta")?.split(",")).not.toContain("claude-code-20250219");
		expect(requests[0].headers.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
		expect(requests[0].body.system).toEqual([
			{ type: "text", text: "System prompt.", cache_control: { type: "ephemeral" } },
		]);
	});

	it("uses Copilot bearer auth with the endpoint's own base URL", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		const copilot: Model<"anthropic-messages"> = {
			...model,
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
		};
		await streamAnthropic(copilot, context, { apiKey: "copilot-token", fetch }).result();

		expect(requests[0].url.toString()).toBe("https://api.githubcopilot.com/v1/messages?beta=true");
		expect(requests[0].headers.get("authorization")).toBe("Bearer copilot-token");
		expect(requests[0].headers.get("x-api-key")).toBeNull();
	});

	it("fails without any request auth instead of falling back to stored credentials", async () => {
		const { requests, fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		const message = await streamAnthropic(model, context, { fetch, env: {} }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("No API key for provider: anthropic");
		expect(requests).toHaveLength(0);
	});
});

describe("Anthropic Messages stream", () => {
	it("turns a recorded thinking, text, and tool_use stream into pi events", async () => {
		const { fetch } = recordFetch(() => sseResponse(thinkingTextToolUse));
		const stream = streamAnthropic(model, context, { apiKey: "anthropic-key", fetch });
		const events = await collect(stream);
		const result = (await stream.result()) as AssistantMessage;

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);

		const thinkingDelta = events[2];
		expect(thinkingDelta).toMatchObject({
			delta: "The user asks about the weather. I should look it up.",
		});
		expect(events[3]).toMatchObject({
			content: "The user asks about the weather. I should look it up.",
		});

		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "The user asks about the weather. I should look it up.",
				thinkingSignature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds",
			},
			{ type: "text", text: "I'll check the weather for that location." },
			{
				type: "toolCall",
				id: "toolu_01A09q90qw90lq917835lq9",
				name: "get_weather",
				arguments: { location: "San Francisco, CA" },
			},
		]);
		expect(result.responseId).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
		expect(result.stopReason).toBe("toolUse");
		expect(result.rawStopReason).toBe("tool_use");
		expect(result.usage).toMatchObject({
			input: 472,
			output: 89,
			cacheRead: 2048,
			cacheWrite: 128,
			totalTokens: 472 + 89 + 2048 + 128,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.0038454, 9);
	});

	it("reports a stream error event as the request error", async () => {
		const { fetch } = recordFetch(() => sseResponse(overloadedError));
		const message = await streamAnthropic(model, context, { apiKey: "anthropic-key", fetch }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
	});

	it("reports an HTTP error status as the request error", async () => {
		const { requests, fetch } = recordFetch(() =>
			Response.json(
				{
					type: "error",
					error: { type: "invalid_request_error", message: "messages: at least one message is required" },
				},
				{ status: 400 },
			),
		);
		const message = await streamAnthropic(model, context, { apiKey: "anthropic-key", fetch }).result();

		expect(requests).toHaveLength(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
		);
	});
});
