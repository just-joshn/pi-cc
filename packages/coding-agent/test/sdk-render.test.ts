import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AssistantFrame, SdkFrame } from "../src/modes/sdk/frames.ts";
import { FrameRenderer } from "../src/modes/sdk/render.ts";
import { SessionLedger, TurnTally } from "../src/modes/sdk/result.ts";

function renderer(includePartial = false) {
	const frames: SdkFrame[] = [];
	const instance = new FrameRenderer({
		sessionId: () => "session",
		includePartial,
		emit: (frame) => frames.push(frame),
		now: () => 1_000,
		limitsOf: () => ({ contextWindow: 0, maxOutputTokens: 0 }),
	});
	const tally = new TurnTally(0, () => ({ usd: 0, basis: "list" }));
	instance.beginTurn(tally);
	return { instance, frames, tally };
}

function toolCall(name: string, args: Record<string, unknown>, modelCall?: ToolCall["modelCall"]): ToolCall {
	return {
		type: "toolCall",
		id: "toolu_1",
		name,
		arguments: args as ToolCall["arguments"],
		...(modelCall ? { modelCall } : {}),
	};
}

function partialOf(call: ToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [call],
		usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as AssistantMessage;
}

/** The two events that bracket a streamed call: the render opens the message on the first. */
function callEvents(call: ToolCall): AgentSessionEvent[] {
	const partial = partialOf(call);
	return [
		{
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
		} as AgentSessionEvent,
		endOf(call),
	];
}

function endOf(call: ToolCall): AgentSessionEvent {
	const partial = partialOf(call);
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial },
	} as AgentSessionEvent;
}

function resultOf(text: string, isError = false): AgentSessionEvent {
	return {
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "x",
			content: [{ type: "text", text }],
			isError,
			timestamp: 0,
		},
	} as AgentSessionEvent;
}

function resultWith(content: unknown[]): AgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "toolResult", toolCallId: "toolu_1", toolName: "x", content, isError: false, timestamp: 0 },
	} as AgentSessionEvent;
}

describe("compaction frames", () => {
	test("reports compacting, a success status and a boundary in oracle order", () => {
		const { instance, frames } = renderer();
		instance.onEvent({ type: "compaction_start", reason: "manual" });
		instance.onEvent({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			result: { summary: "checkpoint", firstKeptEntryId: "", tokensBefore: 170_000, estimatedTokensAfter: 100 },
		});
		expect(frames).toMatchObject([
			{ type: "system", subtype: "status", status: "compacting" },
			{ type: "system", subtype: "status", status: null, compact_result: "success" },
			{
				type: "system",
				subtype: "compact_boundary",
				compact_metadata: {
					trigger: "manual",
					pre_tokens: 170_000,
					post_tokens: 100,
					duration_ms: 0,
				},
			},
		]);
	});
	test("successful overflow recovery returns a successful result without clearing a budget stop", () => {
		const { instance, tally } = renderer();
		const ledger = new SessionLedger();
		tally.outcome = { kind: "api_error", status: 400, text: "prompt is too long" };
		const recovered: AgentSessionEvent = {
			type: "compaction_end",
			reason: "overflow",
			aborted: false,
			willRetry: true,
			result: { summary: "checkpoint", firstKeptEntryId: "", tokensBefore: 200_000 },
		};
		instance.onEvent(recovered);
		expect(ledger.result(tally, "session", 1000).is_error).toBe(false);
		tally.outcome = { kind: "budget", limit: 1 };
		instance.onEvent(recovered);
		expect(ledger.result(tally, "session", 1000).is_error).toBe(true);
	});
	test("reports a failed summary without a successful boundary", () => {
		const { instance, frames } = renderer();
		instance.onEvent({ type: "compaction_start", reason: "threshold" });
		instance.onEvent({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "checkpoint unavailable",
		});
		expect(frames).toMatchObject([
			{ status: "compacting" },
			{ status: null, compact_result: "failed", compact_error: "checkpoint unavailable" },
		]);
	});
});

describe("tool_result content", () => {
	const image = { type: "image", data: "QUJD", mimeType: "image/png" };
	const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };

	test("text only stays one string", () => {
		const { instance, frames } = renderer();
		instance.onEvent(
			resultWith([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		);
		expect((frames[0] as { message: { content: unknown[] } }).message.content[0]).toMatchObject({ content: "a\nb" });
	});

	test("an image-only result keeps the image block", () => {
		const { instance, frames } = renderer();
		instance.onEvent(resultWith([image]));
		expect((frames[0] as { message: { content: unknown[] } }).message.content[0]).toMatchObject({
			content: [imageBlock],
		});
	});

	test("a mixed result keeps text and image blocks in order", () => {
		const { instance, frames } = renderer();
		instance.onEvent(resultWith([{ type: "text", text: "shot" }, image]));
		expect((frames[0] as { message: { content: unknown[] } }).message.content[0]).toMatchObject({
			content: [{ type: "text", text: "shot" }, imageBlock],
		});
	});
});

describe("tool_use_result", () => {
	test("Read reports the file the way Claude Code does", () => {
		const { instance, frames } = renderer();
		for (const event of callEvents(
			toolCall("read", { path: "a.txt" }, { name: "Read", arguments: { file_path: "a.txt" } }),
		))
			instance.onEvent(event);
		instance.onEvent(resultOf("1\tLINE_A\n2\tLINE_B\n3\t"));

		expect(frames[0]).toMatchObject({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.txt" } }] },
		});
		expect(frames[1]).toMatchObject({
			type: "user",
			tool_use_result: {
				type: "text",
				file: { filePath: "a.txt", content: "LINE_A\nLINE_B\n", numLines: 3, startLine: 1, totalLines: 3 },
			},
		});
	});

	test("Bash reports its streams, and an error reports Error: text with is_error on the block", () => {
		const { instance, frames } = renderer();
		for (const event of callEvents(toolCall("bash", { command: "echo hi" }))) instance.onEvent(event);
		instance.onEvent(resultOf("hi"));
		expect(frames[1]).toMatchObject({
			tool_use_result: { stdout: "hi", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
		});

		const failed = renderer();
		for (const event of callEvents(toolCall("bash", { command: "false" }))) failed.instance.onEvent(event);
		failed.instance.onEvent(resultOf("exit 1", true));
		expect(failed.frames[1]).toMatchObject({
			message: { content: [{ type: "tool_result", content: "exit 1", is_error: true }] },
			tool_use_result: "Error: exit 1",
		});
	});

	test("a tool the surface does not cover reports its text", () => {
		const { instance, frames } = renderer();
		for (const event of callEvents(toolCall("echo", { value: "a" }))) instance.onEvent(event);
		instance.onEvent(resultOf("echo:a"));
		expect(frames[1]).toMatchObject({ tool_use_result: "echo:a" });
	});
});

describe("assistant usage metadata", () => {
	function textEvents(usage: Record<string, number>): AgentSessionEvent[] {
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
		} as unknown as AssistantMessage;
		return [
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
			} as AgentSessionEvent,
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_end", contentIndex: 0, partial, content: "hi" },
			} as AgentSessionEvent,
		];
	}

	test("assistant frames report server tool use when the request used it", () => {
		const { instance, frames } = renderer();
		for (const event of textEvents({ webSearchRequests: 2 })) instance.onEvent(event);
		expect(frames[0]).toMatchObject({
			message: { usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } },
		});
	});

	test("frames without server tools leave the key out", () => {
		const { instance, frames } = renderer();
		for (const event of textEvents({})) instance.onEvent(event);
		const frame = frames[0] as AssistantFrame;
		expect(frame.message.usage.server_tool_use).toBeUndefined();
	});
});
