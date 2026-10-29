import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const leadingEvents =
	sse("message_start", {
		type: "message_start",
		message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
	}) +
	sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
	sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });

/** A body that stops after one delta and errors only when the request aborts, as fetch does. */
function stalledFetch(): FetchFunction {
	return async (_input, init) => {
		const signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(leadingEvents));
				signal?.addEventListener(
					"abort",
					() => controller.error(new DOMException("This operation was aborted", "AbortError")),
					{ once: true },
				);
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

const context = normalizeContext({
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
});

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

describe("Anthropic request abort during a stream", () => {
	it("ends a read that is pending when the caller aborts", async () => {
		const controller = new AbortController();
		const events = streamAnthropic(model, context, {
			apiKey: "anthropic-key",
			fetch: stalledFetch(),
			signal: controller.signal,
		});

		let abortedAt = 0;
		let endedAt = 0;
		const drained = (async () => {
			for await (const event of events) {
				if (event.type === "text_delta") {
					abortedAt = Date.now();
					controller.abort();
				}
			}
			endedAt = Date.now();
			return await events.result();
		})();
		const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));

		const outcome = await Promise.race([drained, timedOut]);
		expect(outcome, "the caller abort must reach the live request").not.toBe("timeout");

		const message = outcome as AssistantMessage;
		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("This operation was aborted");
		expect(endedAt - abortedAt).toBeLessThan(100);
	});
});
