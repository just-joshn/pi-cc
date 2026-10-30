/** The assistant row Claude Code writes in place of a model reply when the request could not be made or failed. */

import { randomUUID } from "node:crypto";
import type { SyntheticApiErrorFrame } from "./frames.ts";

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
		message: {
			diagnostics: null,
			id: randomUUID(),
			container: null,
			model: "<synthetic>",
			role: "assistant",
			stop_details: null,
			stop_reason: "stop_sequence",
			stop_sequence: "",
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
			content: [{ type: "text", text: failure.text }],
			context_management: null,
		},
		parent_tool_use_id: null,
		session_id: failure.sessionId,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		error: failure.error,
		is_api_error_message: true,
		...(failure.status === undefined ? {} : { api_error_status: failure.status }),
	};
}
