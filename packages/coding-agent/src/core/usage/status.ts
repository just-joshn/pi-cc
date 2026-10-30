/** The latest request's usage in Anthropic's wire names. */
export interface CurrentUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

export interface StatusCostFields {
	total_cost_usd: number;
	total_duration_ms: number;
	total_api_duration_ms: number;
	total_lines_added: number;
	total_lines_removed: number;
}

export interface StatusContextWindow {
	total_input_tokens: number;
	total_output_tokens: number;
	context_window_size: number;
	current_usage: CurrentUsage | null;
	used_percentage: number | null;
	remaining_percentage: number | null;
}

/** The `cost` object of the status line input. */
export function statusCostFields(fields: {
	costUsd: number;
	durationMs: number;
	apiMs: number;
	linesAdded: number;
	linesRemoved: number;
}): StatusCostFields {
	return {
		total_cost_usd: fields.costUsd,
		total_duration_ms: fields.durationMs,
		total_api_duration_ms: fields.apiMs,
		total_lines_added: fields.linesAdded,
		total_lines_removed: fields.linesRemoved,
	};
}

/** The `context_window` object: the latest request's prompt and output tokens and how much of the window the prompt fills. */
export function statusContextWindow(latest: CurrentUsage | null, windowSize: number): StatusContextWindow {
	if (latest === null) {
		return {
			total_input_tokens: 0,
			total_output_tokens: 0,
			context_window_size: windowSize,
			current_usage: null,
			used_percentage: null,
			remaining_percentage: null,
		};
	}
	const prompt = latest.input_tokens + latest.cache_creation_input_tokens + latest.cache_read_input_tokens;
	const used = Math.min(100, Math.max(0, Math.round((prompt / windowSize) * 100)));
	return {
		total_input_tokens: prompt,
		total_output_tokens: latest.output_tokens,
		context_window_size: windowSize,
		current_usage: latest,
		used_percentage: used,
		remaining_percentage: 100 - used,
	};
}
