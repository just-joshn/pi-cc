/**
 * Renders pi's session events as Claude Code frames. One assistant message that holds several content
 * blocks becomes one `assistant` frame per block, all sharing the message id, written when the block
 * ends. The partial `stream_event` frames are written only when the host asked for them.
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { declaredToolName, modelCallOf } from "../../core/tools/cc-surface.ts";
import type {
	AssistantFrame,
	ContentBlock,
	Json,
	MessageUsage,
	SdkFrame,
	StreamEventFrame,
	UserInterruptFrame,
	UserToolResultFrame,
} from "./frames.ts";
import { anthropicStopReason, apiErrorText, type ModelLimits, type TurnTally } from "./result.ts";
import { syntheticApiErrorFrame } from "./synthetic.ts";

export interface RenderContext {
	sessionId(): string;
	includePartial: boolean;
	emit(frame: SdkFrame): void;
	now(): number;
	/** The context window and output cap of the model that produced `message`, read when its usage is counted. */
	limitsOf(message: AssistantMessage): ModelLimits;
}

/** The streaming message under way: what the first block reported, which every row of it repeats. */
interface OpenMessage {
	id: string;
	model: string;
	usage: MessageUsage;
	/** Content block indexes that started, and those that finished. A block still open when an interrupt lands is abandoned. */
	started: Set<number>;
	ended: Set<number>;
	/** The latest partial message the stream reported, which holds the text of a block cut off mid-way. */
	partial: AssistantMessage | undefined;
}

interface SeenCall {
	piName: string;
	modelName: string;
	modelInput: Json;
}

export class FrameRenderer {
	private readonly context: RenderContext;
	private tally: TurnTally | undefined;
	private open: OpenMessage | undefined;
	private requests = 0;
	private requestStartedAt = 0;
	private firstBlockSeen = false;
	private interrupted = false;
	private readonly calls = new Map<string, SeenCall>();

	constructor(context: RenderContext) {
		this.context = context;
	}

	/** Starts accounting a user message. The host writes that message's first `requesting` status itself. */
	beginTurn(tally: TurnTally): void {
		this.tally = tally;
		this.open = undefined;
		this.requests = 0;
		this.interrupted = false;
	}

	/** An interrupt control request arrived: the tool results and aborted request that follow are its doing. */
	markInterrupted(): void {
		this.interrupted = true;
	}

	onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				this.requestStartedAt = this.context.now();
				this.firstBlockSeen = false;
				this.requests += 1;
				if (this.requests > 1 && this.context.includePartial && !this.interrupted) this.status();
				return;
			case "message_update":
				this.onStream(event.assistantMessageEvent);
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					this.assistantEnd(event.message as AssistantMessage);
				} else if (event.message.role === "toolResult" && this.tally?.outcome.kind !== "budget") {
					this.context.emit(this.toolResultFrame(event.message as ToolResultMessage));
				}
				return;
			case "turn_end":
				if (event.toolResults.length > 0 && this.tally !== undefined && this.tally.outcome.kind !== "budget") {
					this.tally.toolBatches += 1;
				}
				return;
			default:
				return;
		}
	}

	/** The `requesting` status that precedes each model request when partial messages are on. */
	status(): void {
		this.context.emit({
			type: "system",
			subtype: "status",
			status: "requesting",
			session_id: this.context.sessionId(),
			uuid: randomUUID(),
		});
	}

	private onStream(event: AssistantMessageEvent): void {
		if (this.open !== undefined && "partial" in event) this.open.partial = event.partial;
		switch (event.type) {
			case "text_start":
				this.blockStart(event.partial, event.contentIndex, { type: "text", text: "" });
				return;
			case "thinking_start":
				this.blockStart(event.partial, event.contentIndex, { type: "thinking", thinking: "", signature: "" });
				return;
			case "toolcall_start": {
				const call = event.partial.content[event.contentIndex] as ToolCall;
				this.blockStart(event.partial, event.contentIndex, {
					type: "tool_use",
					id: call.id,
					name: declaredToolName(call.name),
					input: {},
				});
				return;
			}
			case "text_delta":
				this.delta(event.contentIndex, { type: "text_delta", text: event.delta });
				return;
			case "thinking_delta":
				this.delta(event.contentIndex, { type: "thinking_delta", thinking: event.delta });
				return;
			case "toolcall_delta":
				this.delta(event.contentIndex, { type: "input_json_delta", partial_json: event.delta });
				return;
			case "text_end":
				this.blockEnd(event.contentIndex, { type: "text", text: event.content });
				return;
			case "thinking_end": {
				const block = event.partial.content[event.contentIndex];
				const signature = block?.type === "thinking" ? (block.thinkingSignature ?? "") : "";
				this.blockEnd(event.contentIndex, { type: "thinking", thinking: event.content, signature });
				return;
			}
			case "toolcall_end": {
				const model = modelCallOf(event.toolCall);
				this.calls.set(event.toolCall.id, {
					piName: event.toolCall.name,
					modelName: model.name,
					modelInput: model.arguments,
				});
				this.blockEnd(event.contentIndex, {
					type: "tool_use",
					id: event.toolCall.id,
					name: model.name,
					input: model.arguments,
				});
				return;
			}
			default:
				return;
		}
	}

	private ensureOpen(partial: AssistantMessage): OpenMessage {
		if (this.open !== undefined) return this.open;
		const usage: MessageUsage = { input_tokens: partial.usage.input, output_tokens: partial.usage.output };
		if (partial.usage.cacheWrite > 0) {
			usage.cache_creation_input_tokens = partial.usage.cacheWrite;
			if (partial.usage.cacheWrite1h !== undefined || partial.usage.cacheWrite5m !== undefined) {
				usage.cache_creation = {
					ephemeral_5m_input_tokens: partial.usage.cacheWrite5m ?? 0,
					ephemeral_1h_input_tokens: partial.usage.cacheWrite1h ?? 0,
				};
			}
		}
		if (partial.usage.cacheRead > 0) usage.cache_read_input_tokens = partial.usage.cacheRead;
		this.open = {
			id: partial.responseId ?? `msg_${randomUUID().replaceAll("-", "")}`,
			model: partial.responseModel ?? partial.model,
			usage,
			started: new Set(),
			ended: new Set(),
			partial,
		};
		return this.open;
	}

	private blockStart(partial: AssistantMessage, index: number, block: ContentBlock): void {
		const fresh = this.open === undefined;
		const message = this.ensureOpen(partial);
		message.started.add(index);
		if (!this.firstBlockSeen && this.tally !== undefined) {
			this.firstBlockSeen = true;
			this.tally.ttftMs = this.context.now() - this.requestStartedAt;
		}
		if (!this.context.includePartial) return;
		if (fresh) {
			this.stream(
				message,
				{
					type: "message_start",
					message: {
						id: message.id,
						type: "message",
						role: "assistant",
						model: message.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: message.usage,
					},
				},
				{ ttft_ms: this.tally?.ttftMs ?? 0, thinking_display: "updates" },
			);
		}
		this.stream(message, { type: "content_block_start", index, content_block: block });
	}

	private delta(index: number, delta: Json): void {
		if (this.open === undefined || !this.context.includePartial) return;
		this.stream(this.open, { type: "content_block_delta", index, delta });
	}

	private blockEnd(index: number, block: ContentBlock): void {
		if (this.open === undefined) return;
		this.open.ended.add(index);
		this.context.emit(this.assistantFrame(this.open, block));
		if (this.context.includePartial) this.stream(this.open, { type: "content_block_stop", index });
	}

	private assistantEnd(message: AssistantMessage): void {
		// A request started after an interrupt fails as a transport error, which is still the interrupt's doing.
		const cutOff = message.stopReason === "aborted" || (this.interrupted && message.stopReason === "error");
		if (cutOff) {
			this.abortedEnd();
		} else {
			if (message.stopReason !== "error") this.messageEnd(message);
			this.tally?.addAssistant(message, this.context.now() - this.requestStartedAt, this.context.limitsOf(message));
			if (message.stopReason === "error") this.errorEnd();
		}
		this.open = undefined;
	}

	private messageEnd(message: AssistantMessage): void {
		if (this.open !== undefined && this.context.includePartial) {
			this.stream(this.open, {
				type: "message_delta",
				delta: { stop_reason: anthropicStopReason(message.stopReason), stop_sequence: null },
				usage: { output_tokens: message.usage.output },
			});
			this.stream(this.open, { type: "message_stop" });
		}
	}

	/** A failed request becomes the synthetic API-error row, where Claude Code writes its own. */
	private errorEnd(): void {
		const outcome = this.tally?.outcome;
		if (outcome?.kind !== "api_error") return;
		this.context.emit(
			syntheticApiErrorFrame({
				sessionId: this.context.sessionId(),
				text: apiErrorText(outcome),
				error: outcome.status === 401 ? "authentication_failed" : "unknown",
				status: outcome.status,
			}),
		);
	}

	/**
	 * A request cut off by an interrupt. Text the model had begun is written as an aborted row, the
	 * interrupt notice follows, and an open stream is closed with the blocks it abandoned. A thinking or
	 * tool block that had not finished is dropped (measured).
	 */
	private abortedEnd(): void {
		const open = this.open;
		const unfinished =
			open === undefined ? [] : [...open.started].filter((index) => !open.ended.has(index)).sort((a, b) => a - b);
		let abandonedFrom = open === undefined ? 0 : Math.max(-1, ...open.started) + 1;
		for (const index of unfinished) {
			const block = open?.partial?.content[index];
			if (open !== undefined && block?.type === "text" && block.text !== "") {
				this.context.emit({ ...this.assistantFrame(open, { type: "text", text: block.text }), aborted: true });
			} else {
				abandonedFrom = Math.min(abandonedFrom, index);
			}
		}
		const afterTools = this.tally?.outcome.kind === "aborted_tools";
		this.context.emit(this.interruptFrame(afterTools));
		if (this.tally !== undefined && !afterTools) this.tally.outcome = { kind: "aborted_streaming" };
		if (open === undefined || !this.context.includePartial) return;
		for (const index of unfinished) this.stream(open, { type: "content_block_stop", index });
		this.stream(open, abortedMessageDelta(open.usage));
		this.stream(
			open,
			{ type: "message_stop" },
			{ abandoned_blocks: { api_message_id: open.id, from_block_index: abandonedFrom } },
		);
	}

	private interruptFrame(afterTools: boolean): UserInterruptFrame {
		return {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: afterTools ? "[Request interrupted by user for tool use]" : "[Request interrupted by user]",
					},
				],
			},
			parent_tool_use_id: null,
			session_id: this.context.sessionId(),
			uuid: randomUUID(),
			timestamp: new Date(this.context.now()).toISOString(),
		};
	}

	private assistantFrame(message: OpenMessage, block: ContentBlock): AssistantFrame {
		return {
			type: "assistant",
			message: {
				id: message.id,
				type: "message",
				role: "assistant",
				model: message.model,
				content: [block],
				stop_reason: null,
				stop_sequence: null,
				usage: message.usage,
				context_management: null,
			},
			parent_tool_use_id: null,
			session_id: this.context.sessionId(),
			uuid: randomUUID(),
			timestamp: new Date(this.context.now()).toISOString(),
		};
	}

	private stream(message: OpenMessage, event: Json, extra: Partial<StreamEventFrame> = {}): void {
		this.context.emit({
			type: "stream_event",
			event,
			session_id: this.context.sessionId(),
			parent_tool_use_id: null,
			uuid: randomUUID(),
			api_message_id: message.id,
			...extra,
		});
	}

	private toolResultFrame(message: ToolResultMessage): UserToolResultFrame {
		const frame = {
			type: "user" as const,
			parent_tool_use_id: null,
			session_id: this.context.sessionId(),
			uuid: randomUUID(),
			timestamp: new Date(this.context.now()).toISOString(),
		};
		if (this.interrupted) {
			if (this.tally !== undefined) this.tally.outcome = { kind: "aborted_tools" };
			return {
				...frame,
				message: {
					role: "user",
					content: [
						{ type: "tool_result", content: REJECTED_TOOL_TEXT, is_error: true, tool_use_id: message.toolCallId },
					],
				},
				tool_use_result: "User rejected tool use",
				tool_result_meta: [{ id: message.toolCallId, non_execution_kind: "user-rejected" }],
			};
		}
		const call = this.calls.get(message.toolCallId);
		const isBash = call?.modelName === "Bash" && !message.isError;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const shown = isBash ? text.trimEnd() : text;
		const block: Json = {
			tool_use_id: message.toolCallId,
			type: "tool_result",
			content: toolResultContent(message, shown),
		};
		if (message.isError) block.is_error = true;
		else if (isBash) block.is_error = false;
		return {
			...frame,
			message: { role: "user", content: [block] },
			tool_use_result: toolUseResult(call, shown, message.isError),
		};
	}
}

/** The `message_delta` Claude Code writes for a request an interrupt cut off: no stop reason, and the usage the stream began with. */
function abortedMessageDelta(usage: MessageUsage): Json {
	return {
		type: "message_delta",
		context_management: null,
		delta: { container: null, stop_details: null, stop_reason: null, stop_sequence: null },
		usage: {
			output_tokens_details: { thinking_tokens: 0 },
			cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
			cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
			input_tokens: usage.input_tokens,
			iterations: [],
			output_tokens: usage.output_tokens,
			server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
			fallback_credit: null,
		},
	};
}

const REJECTED_TOOL_TEXT =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** Text-only results are one string. A result holding images is an array of blocks in the order the tool produced them. */
function toolResultContent(message: ToolResultMessage, text: string): string | Json[] {
	if (!message.content.some((block) => block.type === "image")) return text;
	return message.content.map(
		(block): Json =>
			block.type === "image"
				? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
				: { type: "text", text: block.text },
	);
}

const NUMBERED_LINE = /^\d+\t/;

/**
 * Claude Code's structured `tool_use_result`. Read and Bash have the measured structure. Every other
 * tool reports its result text, and an error reports `Error: <text>`.
 */
function toolUseResult(call: SeenCall | undefined, text: string, isError: boolean): unknown {
	if (isError) return `Error: ${text}`;
	if (call?.modelName === "Bash") {
		return { stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
	}
	const lines = text.split("\n");
	if (call?.modelName === "Read" && lines.every((line) => NUMBERED_LINE.test(line))) {
		const offset = typeof call.modelInput.offset === "number" ? call.modelInput.offset : 1;
		return {
			type: "text",
			file: {
				filePath: String(call.modelInput.file_path ?? ""),
				content: lines.map((line) => line.replace(NUMBERED_LINE, "")).join("\n"),
				numLines: lines.length,
				startLine: offset,
				totalLines: lines.length,
			},
		};
	}
	return text;
}
