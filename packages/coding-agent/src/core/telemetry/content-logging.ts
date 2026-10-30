/** The four opt-in content classes of the OpenTelemetry export, each off until its variable is set. */

type Env = Readonly<Record<string, string | undefined>>;

export interface ContentLogging {
	/** `OTEL_LOG_USER_PROMPTS`: the prompt text on `user_prompt`, and the reply text on `assistant_response` too (measured on 2.1.312). */
	readonly userPrompts: boolean;
	/** `OTEL_LOG_ASSISTANT_RESPONSES`: the reply text on `assistant_response`. */
	readonly assistantResponses: boolean;
	/** `OTEL_LOG_TOOL_CONTENT`: tool input and output on trace spans, which pi-cc does not export. It changes no metric or event. */
	readonly toolContent: boolean;
	/** `OTEL_LOG_TOOL_DETAILS`: `tool_parameters`, `tool_input` and the error text on tool events. */
	readonly toolDetails: boolean;
}

export const REDACTED = "<REDACTED>";

const isOn = (value: string | undefined): boolean =>
	["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

export function contentLogging(env: Env): ContentLogging {
	return {
		userPrompts: isOn(env.OTEL_LOG_USER_PROMPTS),
		assistantResponses: isOn(env.OTEL_LOG_ASSISTANT_RESPONSES),
		toolContent: isOn(env.OTEL_LOG_TOOL_CONTENT),
		toolDetails: isOn(env.OTEL_LOG_TOOL_DETAILS),
	};
}

/** The value for a content-bearing attribute: the text when its class is on, otherwise the placeholder. */
export const gated = (on: boolean, text: string): string => (on ? text : REDACTED);
