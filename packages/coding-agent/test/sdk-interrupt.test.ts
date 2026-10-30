import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SdkFrame } from "../src/modes/sdk/frames.ts";
import { FrameRenderer } from "../src/modes/sdk/render.ts";
import { TurnTally } from "../src/modes/sdk/result.ts";

type Frame = Record<string, any>;

function renderer(includePartial: boolean) {
	const frames: Frame[] = [];
	const tally = new TurnTally(0);
	const instance = new FrameRenderer({
		sessionId: () => "session",
		includePartial,
		emit: (frame: SdkFrame) => frames.push(frame as Frame),
		now: () => 1_000,
		limitsOf: () => ({ contextWindow: 0, maxOutputTokens: 0 }),
	});
	instance.beginTurn(tally);
	return { instance, frames, tally };
}

const usage = { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };

function partialWith(content: unknown[]): AssistantMessage {
	return { role: "assistant", content, usage, responseId: "msg_1", model: "m" } as unknown as AssistantMessage;
}

function update(partial: AssistantMessage, assistantMessageEvent: Record<string, unknown>): AgentSessionEvent {
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { ...assistantMessageEvent, partial },
	} as AgentSessionEvent;
}

function assistantEnd(stopReason: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return {
		type: "message_end",
		message: { ...partialWith([]), stopReason, ...extra },
	} as unknown as AgentSessionEvent;
}

const labels = (frames: Frame[]) =>
	frames.map((frame) =>
		frame.type === "stream_event"
			? `event/${frame.event.type}`
			: frame.subtype
				? `${frame.type}/${frame.subtype}`
				: frame.type,
	);

describe("an interrupt that cuts off a streaming request", () => {
	test("writes the text so far as an aborted row, the notice, and closes the stream with the abandoned block", () => {
		const { instance, frames, tally } = renderer(true);
		const started = partialWith([{ type: "text", text: "" }]);
		const typed = partialWith([{ type: "text", text: "PARTIAL" }]);
		instance.onEvent(update(started, { type: "text_start", contentIndex: 0 }));
		instance.onEvent(update(typed, { type: "text_delta", contentIndex: 0, delta: "PARTIAL" }));
		instance.markInterrupted();
		instance.onEvent(assistantEnd("aborted"));

		expect(labels(frames)).toEqual([
			"event/message_start",
			"event/content_block_start",
			"event/content_block_delta",
			"assistant",
			"user",
			"event/content_block_stop",
			"event/message_delta",
			"event/message_stop",
		]);
		expect(frames[3]).toMatchObject({
			aborted: true,
			message: { id: "msg_1", content: [{ type: "text", text: "PARTIAL" }], stop_reason: null },
		});
		expect(frames[4].message.content).toEqual([{ type: "text", text: "[Request interrupted by user]" }]);
		expect(frames[6].event).toMatchObject({
			delta: { stop_reason: null, stop_sequence: null, container: null, stop_details: null },
			context_management: null,
			usage: { input_tokens: 12, output_tokens: 0, iterations: [], fallback_credit: null },
		});
		expect(frames[7].abandoned_blocks).toEqual({ api_message_id: "msg_1", from_block_index: 1 });
		expect(tally.outcome).toEqual({ kind: "aborted_streaming" });
		expect(tally.turns).toBe(0);
		expect(tally.models).toEqual({});
	});

	test("drops a thinking block that had not finished and abandons from its index", () => {
		const { instance, frames } = renderer(true);
		const started = partialWith([{ type: "thinking", thinking: "hm" }]);
		instance.onEvent(update(started, { type: "thinking_start", contentIndex: 0 }));
		instance.onEvent(assistantEnd("aborted"));

		expect(labels(frames)).toEqual([
			"event/message_start",
			"event/content_block_start",
			"user",
			"event/content_block_stop",
			"event/message_delta",
			"event/message_stop",
		]);
		expect(frames[5].abandoned_blocks).toEqual({ api_message_id: "msg_1", from_block_index: 0 });
	});

	test("writes only the notice when no partial messages are asked for", () => {
		const { instance, frames } = renderer(false);
		instance.onEvent(update(partialWith([{ type: "text", text: "x" }]), { type: "text_start", contentIndex: 0 }));
		instance.onEvent(assistantEnd("aborted"));
		expect(labels(frames)).toEqual(["assistant", "user"]);
	});

	test("a request that failed after the interrupt is the interrupt's doing, not an API error", () => {
		const { instance, frames, tally } = renderer(false);
		instance.markInterrupted();
		instance.onEvent(assistantEnd("error", { errorMessage: "This operation was aborted" }));
		expect(labels(frames)).toEqual(["user"]);
		expect(tally.outcome).toEqual({ kind: "aborted_streaming" });
	});
});

describe("an interrupt that cuts off a tool", () => {
	function toolResult(isError: boolean): AgentSessionEvent {
		return {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "bash",
				content: [{ type: "text", text: "Command aborted" }],
				isError,
				timestamp: 0,
			},
		} as AgentSessionEvent;
	}

	test.each([true, false])("writes the rejected tool result even when isError is %s", (isError) => {
		const { instance, frames, tally } = renderer(false);
		instance.markInterrupted();
		instance.onEvent(toolResult(isError));
		instance.onEvent(assistantEnd("aborted"));

		expect(labels(frames)).toEqual(["user", "user"]);
		expect(frames[0]).toMatchObject({
			tool_use_result: "User rejected tool use",
			tool_result_meta: [{ id: "toolu_1", non_execution_kind: "user-rejected" }],
			message: { content: [{ type: "tool_result", is_error: true, tool_use_id: "toolu_1" }] },
		});
		expect(frames[0].message.content[0].content).toContain("The user doesn't want to proceed with this tool use.");
		expect(frames[1].message.content).toEqual([{ type: "text", text: "[Request interrupted by user for tool use]" }]);
		expect(tally.outcome).toEqual({ kind: "aborted_tools" });
	});

	test("a tool that failed without an interrupt keeps its own error text", () => {
		const { instance, frames, tally } = renderer(false);
		instance.onEvent(toolResult(true));
		expect(frames[0].message.content[0]).toMatchObject({ content: "Command aborted", is_error: true });
		expect(frames[0].tool_use_result).toBe("Error: Command aborted");
		expect(tally.outcome).toEqual({ kind: "completed" });
	});

	test("counts one tool batch per turn that ran tools", () => {
		const { instance, tally } = renderer(false);
		instance.onEvent({
			type: "turn_end",
			message: partialWith([]),
			toolResults: [{}],
		} as unknown as AgentSessionEvent);
		instance.onEvent({ type: "turn_end", message: partialWith([]), toolResults: [] } as unknown as AgentSessionEvent);
		expect(tally.toolBatches).toBe(1);
	});
});

describe("a failed request", () => {
	test("becomes the synthetic API error row with the HTTP status and Claude Code's text", () => {
		const { instance, frames, tally } = renderer(false);
		instance.onEvent(
			assistantEnd("error", {
				errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad request probe"}}',
			}),
		);

		expect(labels(frames)).toEqual(["assistant"]);
		expect(frames[0]).toMatchObject({
			error: "unknown",
			is_api_error_message: true,
			api_error_status: 400,
			message: {
				model: "<synthetic>",
				stop_reason: "stop_sequence",
				content: [{ type: "text", text: "API Error: 400 bad request probe" }],
			},
		});
		expect(tally.outcome).toEqual({ kind: "api_error", status: 400, text: "bad request probe" });
		expect(tally.models).toEqual({});
		expect(tally.failedUsage.inputTokens).toBe(12);
	});

	test("omits the status for a failure inside a stream and maps 401 to authentication_failed", () => {
		const stream = renderer(false);
		stream.instance.onEvent(
			assistantEnd("error", { errorMessage: '{"type":"error","error":{"message":"stream error probe"}}' }),
		);
		expect(stream.frames[0]).not.toHaveProperty("api_error_status");
		expect(stream.frames[0].message.content[0].text).toBe("API Error: stream error probe");

		const unauthorized = renderer(false);
		unauthorized.instance.onEvent(assistantEnd("error", { errorMessage: "401 invalid x-api-key" }));
		expect(unauthorized.frames[0]).toMatchObject({ error: "authentication_failed", api_error_status: 401 });
	});
});

describe("assistant usage", () => {
	test("reports the cache write split once the request wrote cache entries", () => {
		const { instance, frames } = renderer(false);
		const written = {
			...partialWith([{ type: "text", text: "t" }]),
			usage: { ...usage, cacheWrite: 2000, cacheRead: 3000, cacheWrite1h: 500 },
		} as AssistantMessage;
		instance.onEvent(update(written, { type: "text_start", contentIndex: 0 }));
		instance.onEvent(update(written, { type: "text_end", contentIndex: 0, content: "t" }));
		expect(frames[0].message.usage).toEqual({
			input_tokens: 12,
			output_tokens: 0,
			cache_creation_input_tokens: 2000,
			cache_read_input_tokens: 3000,
			cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
		});
	});

	test("leaves cache_creation out when nothing was written", () => {
		const { instance, frames } = renderer(false);
		const plain = {
			...partialWith([{ type: "text", text: "t" }]),
			usage: { ...usage, cacheWrite1h: 0 },
		} as AssistantMessage;
		instance.onEvent(update(plain, { type: "text_start", contentIndex: 0 }));
		instance.onEvent(update(plain, { type: "text_end", contentIndex: 0, content: "t" }));
		expect(frames[0].message.usage).toEqual({ input_tokens: 12, output_tokens: 0 });
	});
});

describe("Bash results", () => {
	function bashRun(text: string, isError = false) {
		const { instance, frames } = renderer(false);
		const call: ToolCall = {
			type: "toolCall",
			id: "toolu_1",
			name: "bash",
			arguments: {},
			modelCall: { name: "Bash", arguments: { command: "echo" } },
		};
		const partial = partialWith([call]);
		instance.onEvent(update(partial, { type: "toolcall_start", contentIndex: 0 }));
		instance.onEvent(update(partial, { type: "toolcall_end", contentIndex: 0, toolCall: call }));
		instance.onEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "bash",
				content: [{ type: "text", text }],
				isError,
				timestamp: 0,
			},
		} as AgentSessionEvent);
		return frames.at(-1) as Frame;
	}

	test("trims the trailing newline and marks success with is_error false", () => {
		const frame = bashRun("hi\nerr\n");
		expect(frame.message.content).toEqual([
			{ tool_use_id: "toolu_1", type: "tool_result", content: "hi\nerr", is_error: false },
		]);
		expect(frame.tool_use_result).toMatchObject({ stdout: "hi\nerr" });
	});

	test("keeps an error result as it came", () => {
		const frame = bashRun("boom\n", true);
		expect(frame.message.content[0]).toMatchObject({ content: "boom\n", is_error: true });
	});
});
