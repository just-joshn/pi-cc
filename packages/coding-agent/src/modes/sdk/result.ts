/** Accumulates a run's usage and builds Claude Code's `result` frame (measured on 2.1.312, `conformance/shapes/cc-result.json`). */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { budgetErrorText, budgetExhausted } from "../../core/usage/budget.ts";
import { breakdownOf, type Charge, type CostBasis, canonicalName } from "../../core/usage/cost.ts";
import type { Json, ResultFrame } from "./frames.ts";

export interface ModelTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cacheCreation1h: number;
	/** The 5m figure the responses reported, which is zero for a response with no TTL split. */
	cacheCreation5m: number;
	webSearchRequests: number;
	thinkingTokens: number;
	costUSD: number;
	costBasis: CostBasis;
	limits: ModelLimits;
}

/** Prices a finished request. The host supplies it, with the model catalog and the operator's pricing policy behind it. */
export type RequestPricer = (message: AssistantMessage) => Charge;

export interface ModelLimits {
	contextWindow: number;
	maxOutputTokens: number;
}

export interface Denial {
	tool_name: string;
	tool_use_id: string;
	tool_input: Json;
}

const ZERO: ModelTotals = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	cacheCreation1h: 0,
	cacheCreation5m: 0,
	webSearchRequests: 0,
	thinkingTokens: 0,
	costUSD: 0,
	costBasis: "list",
	limits: { contextWindow: 0, maxOutputTokens: 0 },
};

const STOP_REASONS: Readonly<Record<string, string>> = {
	stop: "end_turn",
	toolUse: "tool_use",
	length: "max_tokens",
	error: "end_turn",
	aborted: "end_turn",
};

/** Maps pi's stop reason to the Anthropic one an assistant stream reports. */
export function anthropicStopReason(reason: string): string {
	return STOP_REASONS[reason] ?? "end_turn";
}

/** How one user message ended. Each non-completed kind selects a different `result` frame. */
export type ApiErrorOutcome = { kind: "api_error"; status: number | undefined; text: string };

export type TurnOutcome =
	| { kind: "completed" }
	| ApiErrorOutcome
	| { kind: "aborted_streaming" }
	| { kind: "aborted_tools" }
	| { kind: "max_turns"; limit: number; terminalReason: "max_turns" | "aborted_tools" }
	| { kind: "budget"; limit: number }
	| { kind: "local_command_error"; text: string }
	/** A hook ended the run: a PostToolUse hook after its tool, or a Stop hook for good. */
	| { kind: "hook_stopped"; terminalReason: "hook_stopped" | "stop_hook_prevented" };

/** What one user message cost: model calls, tokens per model, and the last assistant text. */
export class TurnTally {
	readonly startedAt: number;
	/** Model requests that finished, which `--max-turns` counts. */
	turns = 0;
	/** Tool-result batches, each one a user message in Claude Code's transcript. */
	toolBatches = 0;
	apiMs = 0;
	models: Record<string, ModelTotals> = {};
	/** Tokens of a failed request: counted in `usage`, but never in cost or `modelUsage`. */
	failedUsage: ModelTotals = ZERO;
	lastText = "";
	/** The last finished request's stop reason, or null while none has finished. */
	stopReason: string | null = null;
	outcome: TurnOutcome = { kind: "completed" };
	ttftMs = 0;
	denials: Denial[] = [];
	private readonly price: RequestPricer;
	private readonly priorCostUSD: number;
	private readonly budgetUsd: number | undefined;

	constructor(startedAt: number, price: RequestPricer, priorCostUSD = 0, budgetUsd?: number) {
		this.startedAt = startedAt;
		this.price = price;
		this.priorCostUSD = priorCostUSD;
		this.budgetUsd = budgetUsd;
	}

	/** What the session has spent so far, this user message included. */
	spentUSD(): number {
		return Object.values(this.models).reduce((total, model) => total + model.costUSD, this.priorCostUSD);
	}

	/** Whether the run is past `--max-budget-usd`. */
	overBudget(): boolean {
		return budgetExhausted(this.spentUSD(), this.budgetUsd);
	}

	/** Folds one finished assistant message in; `apiMs` is how long its request took. */
	addAssistant(message: AssistantMessage, apiMs: number, limits: ModelLimits): void {
		if (message.stopReason === "aborted") return;
		if (message.stopReason === "error") {
			const failure = apiErrorOutcome(message.errorMessage);
			this.failedUsage = addUsage(this.failedUsage, message.usage, limits, { usd: 0, basis: "list" });
			this.outcome = failure;
			this.stopReason = "stop_sequence";
			this.lastText = apiErrorText(failure);
			return;
		}
		this.turns += 1;
		this.apiMs += apiMs;
		this.models[message.model] = addUsage(
			this.models[message.model] ?? ZERO,
			message.usage,
			limits,
			this.price(message),
		);
		this.lastText = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		this.stopReason = anthropicStopReason(message.stopReason);
		if (this.budgetUsd !== undefined && this.overBudget()) this.outcome = { kind: "budget", limit: this.budgetUsd };
	}
}

const STATUS_PREFIX = /^(\d{3}) ([\s\S]*)$/;

/** Splits pi's `<status> <body>` error text, and reads the message out of an Anthropic error body. */
function apiErrorOutcome(errorMessage: string | undefined): ApiErrorOutcome {
	const raw = errorMessage ?? "unknown error";
	const prefixed = STATUS_PREFIX.exec(raw);
	const status = prefixed === null ? undefined : Number(prefixed[1]);
	const body = prefixed === null ? raw : prefixed[2];
	let text = body;
	try {
		const parsed: unknown = JSON.parse(body);
		const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
		if (typeof message === "string") text = message;
	} catch {
		// not a JSON body: the text stands as it came
	}
	return { kind: "api_error", status, text };
}

/** The text Claude Code gives an API failure: `API Error: <status> <message>`. */
export function apiErrorText(outcome: ApiErrorOutcome): string {
	return outcome.status === undefined ? `API Error: ${outcome.text}` : `API Error: ${outcome.status} ${outcome.text}`;
}

function addUsage(totals: ModelTotals, usage: Usage, limits: ModelLimits, charge: Charge): ModelTotals {
	const tokens = breakdownOf(usage);
	return {
		inputTokens: totals.inputTokens + tokens.input,
		outputTokens: totals.outputTokens + tokens.output,
		cacheReadInputTokens: totals.cacheReadInputTokens + tokens.cacheRead,
		cacheCreationInputTokens: totals.cacheCreationInputTokens + tokens.cacheWrite,
		cacheCreation1h: totals.cacheCreation1h + tokens.cacheWrite1h,
		cacheCreation5m: totals.cacheCreation5m + tokens.cacheWrite5m,
		webSearchRequests: totals.webSearchRequests + tokens.webSearchRequests,
		thinkingTokens: totals.thinkingTokens + (usage.reasoning ?? 0),
		costUSD: totals.costUSD + charge.usd,
		costBasis: charge.basis,
		limits,
	};
}

function merge(base: Record<string, ModelTotals>, extra: Record<string, ModelTotals>): Record<string, ModelTotals> {
	const out = { ...base };
	for (const [model, totals] of Object.entries(extra)) {
		const current = out[model] ?? ZERO;
		out[model] = {
			inputTokens: current.inputTokens + totals.inputTokens,
			outputTokens: current.outputTokens + totals.outputTokens,
			cacheReadInputTokens: current.cacheReadInputTokens + totals.cacheReadInputTokens,
			cacheCreationInputTokens: current.cacheCreationInputTokens + totals.cacheCreationInputTokens,
			cacheCreation1h: current.cacheCreation1h + totals.cacheCreation1h,
			cacheCreation5m: current.cacheCreation5m + totals.cacheCreation5m,
			webSearchRequests: current.webSearchRequests + totals.webSearchRequests,
			thinkingTokens: current.thinkingTokens + totals.thinkingTokens,
			costUSD: current.costUSD + totals.costUSD,
			costBasis: totals.costBasis,
			limits: totals.limits,
		};
	}
	return out;
}

type CountKey = Exclude<keyof ModelTotals, "limits" | "costBasis">;

const sum = (models: Record<string, ModelTotals>, key: CountKey): number =>
	Object.values(models).reduce((total, model) => total + model[key], 0);

/** The `usage` block counts every request, failed ones included. */
function usageBlock(models: Record<string, ModelTotals>, failed: ModelTotals = ZERO): Json {
	const write = sum(models, "cacheCreationInputTokens") + failed.cacheCreationInputTokens;
	const write1h = sum(models, "cacheCreation1h") + failed.cacheCreation1h;
	const write5m = sum(models, "cacheCreation5m") + failed.cacheCreation5m;
	return {
		input_tokens: sum(models, "inputTokens") + failed.inputTokens,
		cache_creation_input_tokens: write,
		cache_read_input_tokens: sum(models, "cacheReadInputTokens") + failed.cacheReadInputTokens,
		output_tokens: sum(models, "outputTokens") + failed.outputTokens,
		output_tokens_details: { thinking_tokens: sum(models, "thinkingTokens") + failed.thinkingTokens },
		server_tool_use: {
			web_search_requests: sum(models, "webSearchRequests") + failed.webSearchRequests,
			web_fetch_requests: 0,
		},
		service_tier: "standard",
		cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m },
		inference_geo: "",
		iterations: [],
		speed: "standard",
		fallback_credit: null,
	};
}

function modelUsageBlock(models: Record<string, ModelTotals>): Json {
	return Object.fromEntries(
		Object.entries(models).map(([model, totals]) => [
			model,
			{
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheReadInputTokens: totals.cacheReadInputTokens,
				cacheCreationInputTokens: totals.cacheCreationInputTokens,
				webSearchRequests: totals.webSearchRequests,
				costUSD: totals.costUSD,
				...totals.limits,
				thinkingTokens: totals.thinkingTokens,
				cacheCreationEphemeral5mInputTokens: totals.cacheCreation5m,
				cacheCreationEphemeral1hInputTokens: totals.cacheCreation1h,
				canonicalModel: canonicalName(model),
				provider: "firstParty",
				costBasis: totals.costBasis,
			},
		]),
	);
}

function terminalReason(outcome: TurnOutcome): string {
	switch (outcome.kind) {
		case "completed":
			return "completed";
		case "api_error":
			return "api_error";
		case "aborted_streaming":
			return "aborted_streaming";
		case "aborted_tools":
			return "aborted_tools";
		case "max_turns":
			return outcome.terminalReason;
		case "budget":
			return "budget_exhausted";
		case "local_command_error":
			return "turn_setup_failed";
		case "hook_stopped":
			return outcome.terminalReason;
	}
}

const SUBAGENT_STATS = {
	spawned: 0,
	requested: { background: 0, foreground: 0, unset: 0 },
	started_in_background: 0,
	max_depth: 0,
	spawned_by_subagents: 0,
	completed: 0,
	failed: 0,
	killed: { parent: 0, user: 0, system: 0 },
	refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
	by_type: {},
};

/** The totals that outlive one user message: cost, API time and per-model usage grow across turns. */
export class SessionLedger {
	private models: Record<string, ModelTotals> = {};

	/** What the session has spent over every user message folded in. */
	spentUSD(): number {
		return sum(this.models, "costUSD");
	}
	private apiMs = 0;
	private resultIndex = 0;

	/** Folds a finished turn in and returns its `result` frame. */
	result(turn: TurnTally, sessionId: string, now: number): ResultFrame {
		this.models = merge(this.models, turn.models);
		this.apiMs += turn.apiMs;
		const outcome = turn.outcome;
		const interrupted = outcome.kind === "aborted_streaming" || outcome.kind === "aborted_tools";
		const common = {
			duration_api_ms: this.apiMs,
			stop_reason: turn.stopReason,
			session_id: sessionId,
			total_cost_usd: sum(this.models, "costUSD"),
			usage: usageBlock(turn.models, turn.failedUsage),
			modelUsage: modelUsageBlock(this.models),
			permission_denials: turn.denials,
			terminal_reason: terminalReason(outcome),
			fast_mode_state: "off",
			fast_mode_disabled_reason: "sdk_opt_in_required",
			subagent_stats: SUBAGENT_STATS,
			safety_stops: 0,
			is_error: outcome.kind !== "completed" && outcome.kind !== "hook_stopped",
			num_turns: 1 + turn.toolBatches + (interrupted ? 1 : 0),
		};
		const tail = {
			type: "result" as const,
			duration_ms: now - turn.startedAt,
			uuid: randomUUID(),
			queued_turn_count: 0,
			result_index: this.nextResultIndex(),
			model_usage_since_last_result: modelUsageBlock(turn.models),
		};
		switch (outcome.kind) {
			case "hook_stopped":
				return {
					...common,
					subtype: "success",
					api_error_status: null,
					result: outcome.terminalReason === "hook_stopped" ? "" : turn.lastText,
					ttft_ms: turn.ttftMs,
					ttft_stream_ms: turn.ttftMs,
					time_to_request_ms: 0,
					first_content_frame_ms: turn.ttftMs,
					...tail,
				};
			case "completed":
				return {
					...common,
					subtype: "success",
					api_error_status: null,
					result: turn.lastText,
					ttft_ms: turn.ttftMs,
					ttft_stream_ms: turn.ttftMs,
					time_to_request_ms: 0,
					first_content_frame_ms: turn.ttftMs,
					...tail,
				};
			case "api_error":
				return {
					...common,
					subtype: "success",
					api_error_status: outcome.status ?? null,
					result: apiErrorText(outcome),
					...tail,
				};
			case "aborted_streaming":
			case "aborted_tools":
				return {
					...common,
					subtype: "error_during_execution",
					errors: [
						`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${turn.stopReason ?? "null"}`,
					],
					...tail,
				};
			case "max_turns":
				return {
					...common,
					subtype: "error_max_turns",
					errors: [`Reached maximum number of turns (${outcome.limit})`],
					...tail,
				};
			case "budget":
				return {
					...common,
					subtype: "error_max_budget_usd",
					errors: [budgetErrorText(sum(this.models, "costUSD"), outcome.limit)],
					...tail,
				};
			case "local_command_error":
				return { ...common, subtype: "error_during_execution", errors: [outcome.text], ...tail };
		}
	}

	/** The result for a prompt a UserPromptSubmit hook dropped: no request went out, and the reason is the answer. */
	blockedPromptResult(text: string, sessionId: string, now: number, startedAt: number): ResultFrame {
		return {
			is_error: false,
			duration_api_ms: this.apiMs,
			num_turns: 0,
			stop_reason: null,
			session_id: sessionId,
			total_cost_usd: sum(this.models, "costUSD"),
			usage: usageBlock({}),
			modelUsage: modelUsageBlock(this.models),
			permission_denials: [],
			fast_mode_state: "off",
			fast_mode_disabled_reason: "sdk_opt_in_required",
			subagent_stats: SUBAGENT_STATS,
			safety_stops: 0,
			subtype: "success",
			result: text,
			type: "result",
			duration_ms: now - startedAt,
			uuid: randomUUID(),
			queued_turn_count: 0,
			result_index: this.nextResultIndex(),
			model_usage_since_last_result: {},
		};
	}

	/** The result Claude Code writes when no credentials exist: no model call happened, so nothing is timed. */
	notLoggedInResult(sessionId: string, now: number, startedAt: number, text: string): ResultFrame {
		return {
			duration_api_ms: 0,
			stop_reason: "stop_sequence",
			session_id: sessionId,
			total_cost_usd: 0,
			usage: usageBlock({}),
			modelUsage: {},
			permission_denials: [],
			terminal_reason: "api_error",
			fast_mode_state: "off",
			fast_mode_disabled_reason: "sdk_opt_in_required",
			subagent_stats: SUBAGENT_STATS,
			safety_stops: 0,
			is_error: true,
			num_turns: 1,
			subtype: "success",
			api_error_status: null,
			result: text,
			type: "result",
			duration_ms: now - startedAt,
			uuid: randomUUID(),
			queued_turn_count: 0,
			result_index: this.nextResultIndex(),
			model_usage_since_last_result: {},
		};
	}

	private nextResultIndex(): number {
		const index = this.resultIndex;
		this.resultIndex += 1;
		return index;
	}
}
