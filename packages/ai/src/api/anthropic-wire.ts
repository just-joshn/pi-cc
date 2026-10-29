/**
 * Request and stream shapes of `POST /v1/messages` for every provider that
 * speaks the Anthropic Messages format, not just Anthropic. Only the fields pi
 * sends or reads are typed; the API accepts more.
 */

export interface AnthropicCacheControl {
	type: "ephemeral";
	ttl?: "1h";
}

export interface AnthropicImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
		data: string;
	};
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicTextBlock {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}

export interface AnthropicRedactedThinkingBlock {
	type: "redacted_thinking";
	data: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

export interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | AnthropicContentBlock[];
	is_error: boolean;
	cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolAdditionBlock {
	type: "tool_addition";
	tool: { type: "tool_definition"; definition: AnthropicTool };
	cache_control?: AnthropicCacheControl;
}

/** Withdraws a tool for later turns of a conversation that changes its tool list. */
export interface AnthropicToolRemovalBlock {
	type: "tool_removal";
	tool: { type: "tool_reference"; name: string };
	cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicToolAdditionBlock
	| AnthropicToolRemovalBlock;

export interface AnthropicMessageParam {
	role: "user" | "assistant" | "system";
	content: string | AnthropicContentBlock[];
	/** Effort marker of a managed-effort model: sets the level for the reply that follows it. */
	output_config?: { effort: AnthropicEffort };
}

/** Tool input schema. pi sends an object schema; other JSON Schema keys pass through. */
export interface AnthropicToolInputSchema {
	type?: string;
	properties?: unknown;
	required?: string[];
	[key: string]: unknown;
}

export interface AnthropicTool {
	name: string;
	description: string;
	input_schema: AnthropicToolInputSchema;
	eager_input_streaming?: boolean;
	strict?: boolean;
	cache_control?: AnthropicCacheControl;
	defer_loading?: boolean;
}

export type AnthropicThinkingConfig =
	| { type: "disabled" }
	| { type: "adaptive"; display: AnthropicThinkingDisplay; block_binding?: { prefix_mismatch_behavior: "drop_block" } }
	| { type: "enabled"; budget_tokens: number; display: AnthropicThinkingDisplay };

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicMessageRequest {
	model: string;
	messages: AnthropicMessageParam[];
	max_tokens: number;
	stream: true;
	/** Beta features. Sent as the `anthropic-beta` header, never in the body. */
	betas?: string[];
	system?: AnthropicTextBlock[];
	temperature?: number;
	tools?: AnthropicTool[];
	thinking?: AnthropicThinkingConfig;
	output_config?: { effort: AnthropicEffort };
	metadata?: { user_id: string };
	tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
	fallbacks?: Array<{ model: string }>;
}

export interface AnthropicUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
}

/** A server-side rewrite Anthropic applied to the request before answering it. */
export interface AnthropicInputTransformation {
	type: string;
	path: string;
	reason: string;
}

export interface AnthropicRefusalStopDetails {
	explanation?: string | null;
}

export type AnthropicResponseBlock =
	| { type: "text"; text?: string | null }
	| { type: "thinking"; thinking?: string | null; signature?: string | null }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	/** The model switched to another model mid-output; pi refuses it rather than mixing two replies. */
	| { type: "fallback" };

export type AnthropicBlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "input_json_delta"; partial_json: string }
	| { type: "signature_delta"; signature: string };

export type AnthropicStreamEvent =
	| {
			type: "message_start";
			message: {
				id: string;
				model: string;
				usage: AnthropicUsage;
				input_transformations?: AnthropicInputTransformation[];
			};
	  }
	| { type: "content_block_start"; index: number; content_block: AnthropicResponseBlock }
	| { type: "content_block_delta"; index: number; delta: AnthropicBlockDelta }
	| { type: "content_block_stop"; index: number }
	| {
			type: "message_delta";
			delta: { stop_reason?: string | null; stop_details?: AnthropicRefusalStopDetails | null };
			usage?: AnthropicUsage | null;
			input_transformations?: AnthropicInputTransformation[];
	  }
	| { type: "message_stop" };
