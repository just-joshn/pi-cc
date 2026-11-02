/** The synthetic assistant rows Claude Code writes in place of a model reply: API errors and local-command output. */

import { randomUUID } from "node:crypto";
import type { LocalCommandFrame, SyntheticApiErrorFrame } from "./frames.ts";

/** The message body every synthetic assistant row shares; only the stop reason and text differ. */
function syntheticMessage(text: string, stopReason: "end_turn" | "stop_sequence"): Record<string, unknown> {
	return {
		diagnostics: null,
		id: randomUUID(),
		container: null,
		model: "<synthetic>",
		role: "assistant",
		stop_details: null,
		stop_reason: stopReason,
		stop_sequence: stopReason === "end_turn" ? null : "",
		type: "message",
		usage: {
			output_tokens_details: null,
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
			service_tier: null,
			cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
			inference_geo: null,
			iterations: null,
			speed: null,
			fallback_credit: null,
		},
		content: [{ type: "text", text }],
		context_management: null,
	};
}

export interface SyntheticApiError {
	sessionId: string;
	text: string;
	/** Claude Code's error class: `authentication_failed` for a missing credential, `unknown` for an HTTP failure. */
	error: string;
	/** The HTTP status, when the failure was a response. A failure inside a stream has none. */
	status?: number;
}

export function syntheticApiErrorFrame(failure: SyntheticApiError): SyntheticApiErrorFrame {
	return {
		type: "assistant",
		message: syntheticMessage(failure.text, "stop_sequence"),
		parent_tool_use_id: null,
		session_id: failure.sessionId,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		error: failure.error,
		is_api_error_message: true,
		...(failure.status === undefined ? {} : { api_error_status: failure.status }),
	};
}

export interface LocalCommandText {
	sessionId: string;
	/** The command's text output, delivered as the frame's only content block. */
	text: string;
	/** The alias typed, normalized the way the result frame reports it. */
	command: string;
	args: string;
}

export function localCommandFrame(output: LocalCommandText): LocalCommandFrame {
	return {
		type: "assistant",
		message: syntheticMessage(output.text, "end_turn"),
		parent_tool_use_id: null,
		session_id: output.sessionId,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		local_command_source: "local",
		local_command_run: { command: output.command, args: output.args },
		local_command_outcome: { kind: "success" },
	};
}
