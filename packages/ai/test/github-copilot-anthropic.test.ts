import { beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { type RecordedAnthropicRequest, recordFetch } from "./anthropic-utils.ts";

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 5 },
		})}\n`,
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

describe("Copilot Claude via Anthropic Messages", () => {
	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});

	it("applies Copilot-specific adaptive thinking effort overrides", () => {
		const opus5 = getModel("github-copilot", "claude-opus-5");
		expect(opus5.api).toBe("anthropic-messages");
		expect(opus5.contextWindow).toBe(1000000);
		expect(opus5.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });
		expect(getSupportedThinkingLevels(opus5)).toContain("xhigh");
		expect(getSupportedThinkingLevels(opus5)).toContain("max");

		const opus55 = getModel("github-copilot", "claude-opus-5.5");
		expect(opus55.api).toBe("anthropic-messages");
		expect(opus55.contextWindow).toBe(1000000);
		expect(getSupportedThinkingLevels(opus55)).toEqual(["low", "medium", "high", "xhigh", "max"]);

		const sonnet46 = getModel("github-copilot", "claude-sonnet-4.6");
		expect(sonnet46.thinkingLevelMap).toMatchObject({ minimal: "low", max: "max" });
		expect(getSupportedThinkingLevels(sonnet46)).toContain("max");
		expect(getSupportedThinkingLevels(sonnet46)).not.toContain("xhigh");
	});

	it("uses Bearer auth, Copilot headers, and valid Anthropic Messages payload", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.6");
		expect(model.api).toBe("anthropic-messages");

		const s = streamAnthropic(model, context, {
			apiKey: "tid_copilot_session_test_token",
			fetch,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const [request] = requests;
		expect(request.url.toString()).toBe(`${model.baseUrl}/v1/messages?beta=true`);

		expect(request.headers.get("authorization")).toBe("Bearer tid_copilot_session_test_token");
		expect(request.headers.get("x-api-key")).toBeNull();

		// Copilot static headers from model.headers
		expect(request.headers.get("user-agent")).toContain("GitHubCopilotChat");
		expect(request.headers.get("copilot-integration-id")).toBe("vscode-chat");

		// Dynamic headers
		expect(request.headers.get("x-initiator")).toBe("user");
		expect(request.headers.get("openai-intent")).toBe("conversation-edits");

		// Payload is valid Anthropic Messages format
		expect(request.headers.get("anthropic-beta") ?? "").not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(request.body.model).toBe("claude-sonnet-4.6");
		expect(request.body.stream).toBe(true);
		expect(request.body.max_tokens).toBe(model.maxTokens);
		expect(Array.isArray(request.body.messages)).toBe(true);
	});

	it("omits interleaved-thinking beta for adaptive-thinking models", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.6");
		const s = streamAnthropic(model, context, {
			apiKey: "tid_copilot_session_test_token",
			interleavedThinking: true,
			fetch,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("interleaved-thinking-2025-05-14");
	});
});
