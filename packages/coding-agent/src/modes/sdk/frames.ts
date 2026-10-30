/**
 * The Claude Code stream-json wire model: every frame pi-cc writes, and every line it reads, as a
 * discriminated union. The shapes follow the frames measured on 2.1.312 (see
 * `conformance/shapes/`), so a field here is one the pinned binary also writes.
 */

import type { ImageContent } from "@earendil-works/pi-ai";

export type Json = Record<string, unknown>;

/** The tool-use content block one assistant row carries. */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "tool_use"; id: string; name: string; input: Json };

/** Token counts as an Anthropic message reports them. The cache keys appear only when they are non-zero. */
export interface MessageUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	/** Present when the request wrote cache entries, split by lifetime. */
	cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
}

export interface SystemInitFrame {
	type: "system";
	subtype: "init";
	cwd: string;
	session_id: string;
	tools: string[];
	mcp_servers: { name: string; status: string }[];
	model: string;
	permissionMode: string;
	slash_commands: string[];
	terminal_slash_commands: string[];
	apiKeySource: string;
	claude_code_version: string;
	output_style: string;
	agents: string[];
	skills: string[];
	plugins: { name: string; path: string; source: string }[];
	capabilities: string[];
	analytics_disabled: boolean;
	product_feedback_disabled: boolean;
	uuid: string;
	memory_paths: { auto?: string };
	original_cwd: string;
	additional_directories: string[];
	fast_mode_state: string;
	fast_mode_disabled_reason: string;
	per_turn_effort_active: boolean;
	view_mode: string;
}

/** `status: "requesting"` precedes each model request; `status: null` reports a permission-mode change. */
export type SystemStatusFrame =
	| { type: "system"; subtype: "status"; status: "requesting"; session_id: string; uuid: string }
	| { type: "system"; subtype: "status"; status: null; permissionMode: string; uuid: string; session_id: string };

export interface AssistantFrame {
	type: "assistant";
	message: {
		id: string;
		type: "message";
		role: "assistant";
		model: string;
		content: ContentBlock[];
		stop_reason: null;
		stop_sequence: null;
		usage: MessageUsage;
		context_management: null;
	};
	parent_tool_use_id: null;
	session_id: string;
	uuid: string;
	timestamp: string;
	/** Set on the row written for a block cut off by an interrupt. */
	aborted?: true;
}

/** The synthetic assistant row Claude Code writes in place of a model reply when the request fails. */
export interface SyntheticApiErrorFrame {
	type: "assistant";
	message: Json;
	parent_tool_use_id: null;
	session_id: string;
	uuid: string;
	timestamp: string;
	error: string;
	is_api_error_message: true;
	api_error_status?: number;
}

export interface UserToolResultFrame {
	type: "user";
	message: { role: "user"; content: Json[] };
	parent_tool_use_id: null;
	session_id: string;
	uuid: string;
	timestamp: string;
	tool_use_result: unknown;
	/** Set when the tool never ran, with why. */
	tool_result_meta?: Json[];
}

/** The text row Claude Code writes after it interrupted a request or a tool batch. */
export interface UserInterruptFrame {
	type: "user";
	message: { role: "user"; content: Json[] };
	parent_tool_use_id: null;
	session_id: string;
	uuid: string;
	timestamp: string;
}

/** A stdin user message echoed back under `--replay-user-messages`. */
export interface UserReplayFrame {
	type: "user";
	message: { role: "user"; content: string | Json[] };
	session_id: string;
	parent_tool_use_id: null;
	uuid: string;
	timestamp: string;
	isReplay: true;
}

export interface StreamEventFrame {
	type: "stream_event";
	event: Json;
	session_id: string;
	parent_tool_use_id: null;
	uuid: string;
	api_message_id: string;
	ttft_ms?: number;
	thinking_display?: string;
	/** On the `message_stop` of a request an interrupt cut off: the first block index that never finished. */
	abandoned_blocks?: { api_message_id: string; from_block_index: number };
}

export type ResultFrame = Json & { type: "result"; subtype: string; is_error: boolean };

export type ControlResponseFrame =
	| { type: "control_response"; response: { subtype: "success"; request_id?: string; response?: Json } }
	| {
			type: "control_response";
			response: { subtype: "error"; request_id?: string; error: string; error_code?: string };
	  }
	| (Json & { type: "control_response" });

export type SdkFrame =
	| SystemInitFrame
	| SystemStatusFrame
	| AssistantFrame
	| SyntheticApiErrorFrame
	| UserToolResultFrame
	| UserInterruptFrame
	| UserReplayFrame
	| StreamEventFrame
	| ResultFrame
	| ControlResponseFrame;

/** A control request body. The handler table dispatches on `subtype`, and a subtype with no handler is answered with an error. */
export interface ControlRequestBody {
	subtype?: unknown;
	[key: string]: unknown;
}

/** One parsed stdin line, discriminated by what the host does with it. */
export type SdkInput =
	| { kind: "user"; content: string | Json[]; text: string; images: ImageContent[] }
	| { kind: "control"; requestId: string | undefined; request: ControlRequestBody }
	| { kind: "ignored" }
	| { kind: "invalid"; message: string };
