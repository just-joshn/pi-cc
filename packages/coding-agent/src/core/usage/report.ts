import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type CostBasis, canonicalName, chargeFor, hasNativeRates, type PricingPolicy } from "./cost.ts";

/** One model's totals, merged over every spelling of its name. */
export interface ModelSpend {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	webSearchRequests: number;
	costUSD: number;
}

export interface UsageReportInput {
	models: ReadonlyMap<string, ModelSpend>;
	totalCostUSD: number;
	apiMs: number;
	wallMs: number;
	linesAdded: number;
	linesRemoved: number;
	/** A model with no price was charged at the default rates. */
	hasUnknownModelCost: boolean;
	/** An operator's pricing policy is in force. */
	managedPricing: boolean;
	/** Finished model requests, and how many input tokens they read from cache. */
	requests: number;
	cacheHitRatio: number | undefined;
	/** Whether any request read or wrote the prompt cache. */
	cachingObserved: boolean;
}

export interface SessionMessage {
	role: string;
}

/** Looks up whether pi's own catalog prices a model, so a model outside Claude Code's list keeps pi's cost. */
export type NativePricedLookup = (provider: string, model: string) => boolean;

/** Folds a session's messages into the report's input. Failed and aborted requests cost nothing. */
export function collectUsage(
	messages: readonly SessionMessage[],
	wallMs: number,
	policy: PricingPolicy | undefined,
	nativePriced: NativePricedLookup,
): UsageReportInput {
	const models = new Map<string, ModelSpend>();
	let total = 0;
	let apiMs = 0;
	let unknown = false;
	let requests = 0;
	let cacheReads = 0;
	let promptTokens = 0;
	let cacheWrites = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") continue;
		const charge = chargeFor(
			assistant.model,
			assistant.usage,
			nativePriced(assistant.provider, assistant.model),
			policy,
		);
		unknown ||= charge.basis === ("unknown" satisfies CostBasis);
		total += charge.usd;
		requests += 1;
		cacheReads += assistant.usage.cacheRead;
		cacheWrites += assistant.usage.cacheWrite;
		promptTokens += assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
		apiMs += assistant.durationMs ?? 0;
		const key = canonicalName(assistant.model);
		const current = models.get(key) ?? emptySpend();
		models.set(key, {
			inputTokens: current.inputTokens + assistant.usage.input,
			outputTokens: current.outputTokens + assistant.usage.output,
			cacheReadInputTokens: current.cacheReadInputTokens + assistant.usage.cacheRead,
			cacheCreationInputTokens: current.cacheCreationInputTokens + assistant.usage.cacheWrite,
			webSearchRequests: current.webSearchRequests + (assistant.usage.webSearchRequests ?? 0),
			costUSD: current.costUSD + charge.usd,
		});
	}
	const lines = codeChanges(messages);
	return {
		models,
		totalCostUSD: total,
		apiMs,
		wallMs,
		linesAdded: lines.added,
		linesRemoved: lines.removed,
		hasUnknownModelCost: unknown,
		managedPricing: policy !== undefined,
		requests,
		cacheHitRatio: promptTokens > 0 ? cacheReads / promptTokens : undefined,
		cachingObserved: cacheReads > 0 || cacheWrites > 0,
	};
}

function emptySpend(): ModelSpend {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		webSearchRequests: 0,
		costUSD: 0,
	};
}

interface PatchedDetails {
	patch?: unknown;
}

function codeChanges(messages: readonly SessionMessage[]): { added: number; removed: number } {
	const writes = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type === "toolCall" && block.name === "write" && typeof block.arguments.content === "string") {
				writes.set(block.id, block.arguments.content);
			}
		}
	}
	let added = 0;
	let removed = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (result.isError) continue;
		const patch = (result.details as PatchedDetails | undefined)?.patch;
		if (result.toolName === "edit" && typeof patch === "string") {
			for (const line of patch.split("\n")) {
				if (line.startsWith("+++") || line.startsWith("---")) continue;
				if (line.startsWith("+")) added += 1;
				else if (line.startsWith("-")) removed += 1;
			}
		} else if (result.toolName === "write") {
			const content = writes.get(result.toolCallId);
			if (content !== undefined && content !== "") added += content.replace(/\n$/, "").split("\n").length;
		}
	}
	return { added, removed };
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const COMPACT_THOUSANDS = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
});

function tokens(count: number): string {
	return (count >= 1000 ? COMPACT_THOUSANDS : COMPACT).format(count).toLowerCase();
}

/** Claude Code's dollar format: four decimals up to fifty cents, then cents. */
export function formatUsd(usd: number): string {
	return `$${usd > 0.5 ? (Math.round(usd * 100) / 100).toFixed(2) : usd.toFixed(4)}`;
}

/** Claude Code's duration format: seconds under a minute, then minutes and seconds, hours, days. */
export function formatDuration(ms: number): string {
	if (ms < 60000) {
		if (ms === 0) return "0s";
		if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 1000)}s`;
	}
	let days = Math.floor(ms / 86400000);
	let hours = Math.floor((ms % 86400000) / 3600000);
	let minutes = Math.floor((ms % 3600000) / 60000);
	let seconds = Math.round((ms % 60000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes += 1;
	}
	if (minutes === 60) {
		minutes = 0;
		hours += 1;
	}
	if (hours === 24) {
		hours = 0;
		days += 1;
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

const UNKNOWN_COST_NOTE = "costs may be inaccurate due to usage of unknown models";
const MANAGED_PRICING_NOTE = "at your organization's configured rates";

function spendLine(spend: ModelSpend): string {
	const search = spend.webSearchRequests > 0 ? `, ${tokens(spend.webSearchRequests)} web search` : "";
	return `${tokens(spend.inputTokens)} input, ${tokens(spend.outputTokens)} output, ${tokens(spend.cacheReadInputTokens)} cache read, ${tokens(spend.cacheCreationInputTokens)} cache write${search}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Claude Code's `/usage` text for an API-key session. */
export function formatUsageReport(input: UsageReportInput): string {
	const notes = [
		input.hasUnknownModelCost ? UNKNOWN_COST_NOTE : undefined,
		input.managedPricing ? MANAGED_PRICING_NOTE : undefined,
	]
		.filter((note) => note !== undefined)
		.join("; ");
	const total = formatUsd(input.totalCostUSD) + (notes === "" ? "" : ` (${notes})`);
	const perModel =
		input.models.size === 0
			? "Usage:                 0 input, 0 output, 0 cache read, 0 cache write"
			: [
					"Usage by model:",
					...[...input.models].map(
						([model, spend]) => `${`${model}:`.padStart(21)}  ${spendLine(spend)} (${formatUsd(spend.costUSD)})`,
					),
				].join("\n");
	const cache = cacheLine(input);
	return [
		`Total cost:            ${total}`,
		`Total duration (API):  ${formatDuration(input.apiMs)}`,
		`Total duration (wall): ${formatDuration(input.wallMs)}`,
		`Total code changes:    ${plural(input.linesAdded, "line")} added, ${plural(input.linesRemoved, "line")} removed`,
		perModel,
		...(cache === undefined ? [] : [cache]),
	].join("\n");
}

function cacheLine(input: UsageReportInput): string | undefined {
	if (input.requests === 0 || input.cachingObserved) return undefined;
	const percent = Math.round((input.cacheHitRatio ?? 0) * 100);
	return `Prompt cache (main):   ${plural(input.requests, "request")} · ${percent}% of input tokens from cache · no misses · no prompt caching reported by the API`;
}

/** Whether pi's catalog prices the model a message names, for `collectUsage`. */
export function nativePricedBy(
	lookup: (provider: string, model: string) => { cost: { input: number; output: number } } | undefined,
): NativePricedLookup {
	return (provider, model) => hasNativeRates(lookup(provider, model)?.cost);
}
