import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
};

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new Error("payload captured");
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture before request");
	return captured;
}

describe("Anthropic user message after tool results", () => {
	it("joins the tool result message, so the turn is one user message", async () => {
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "go", timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [{ type: "text", text: "extra" }], timestamp: 3 },
			],
		});
		expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(payload.messages[2]?.content).toMatchObject([{ type: "tool_result" }, { type: "text", text: "extra" }]);
	});

	it("keeps a user message after an assistant message separate", async () => {
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "go", timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file" }],
					isError: false,
					timestamp: 2,
				},
				{ ...assistant, content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 },
				{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 4 },
			],
		});
		expect(payload.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
	});
});
