import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SdkFrame } from "../src/modes/sdk/frames.ts";
import { FrameRenderer } from "../src/modes/sdk/render.ts";
import { TurnTally } from "../src/modes/sdk/result.ts";

function renderer(includePartial = false) {
	const frames: SdkFrame[] = [];
	const instance = new FrameRenderer({
		sessionId: () => "session",
		includePartial,
		emit: (frame) => frames.push(frame),
		now: () => 1_000,
	});
	instance.beginTurn(new TurnTally(0));
	return { instance, frames };
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
