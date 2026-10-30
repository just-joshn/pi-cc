import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { chargeFor } from "../src/core/usage/cost.ts";
import { SessionLedger, TurnTally } from "../src/modes/sdk/result.ts";

const LIMITS = { contextWindow: 200_000, maxOutputTokens: 32_000 };

function message(model: string, usage: Partial<AssistantMessage["usage"]>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
			...usage,
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const pricer = (m: AssistantMessage) => chargeFor(m.model, m.usage, false, undefined);

describe("result ledger", () => {
	test("totals cost from the Claude Code price list, not from pi's catalog cost", () => {
		const tally = new TurnTally(0, pricer);
		tally.addAssistant(message("claude-sonnet-4-5", { input: 1e6, output: 1e6 }), 10, LIMITS);
		const result = new SessionLedger().result(tally, "s", 100);
		expect(result.total_cost_usd).toBeCloseTo(18);
		const usage = (result.modelUsage as Record<string, Record<string, unknown>>)["claude-sonnet-4-5"];
		expect(usage).toMatchObject({
			costUSD: expect.closeTo(18),
			costBasis: "list",
			canonicalModel: "claude-sonnet-4-5",
		});
	});

	test("reports the TTL split as responses gave it and sums web searches", () => {
		const tally = new TurnTally(0, pricer);
		tally.addAssistant(
			message("claude-sonnet-4-5", { cacheWrite: 2000, cacheWrite1h: 500, webSearchRequests: 2 }),
			10,
			LIMITS,
		);
		const result = new SessionLedger().result(tally, "s", 100);
		expect(result.usage).toMatchObject({
			cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
			server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
		});
	});

	test("marks a model nobody prices unknown", () => {
		const tally = new TurnTally(0, pricer);
		tally.addAssistant(message("mystery-1", { input: 1e6 }), 10, LIMITS);
		const result = new SessionLedger().result(tally, "s", 100);
		expect(result.total_cost_usd).toBeCloseTo(5);
		expect(result.modelUsage).toMatchObject({ "mystery-1": { costBasis: "unknown" } });
	});

	test("a request that reaches the budget ends the user message with error_max_budget_usd", () => {
		const tally = new TurnTally(0, pricer, 0, 0.5);
		tally.addAssistant(message("claude-sonnet-4-5", { input: 1e6 }), 10, LIMITS);
		expect(tally.overBudget()).toBe(true);
		const result = new SessionLedger().result(tally, "s", 100);
		expect(result).toMatchObject({
			subtype: "error_max_budget_usd",
			is_error: true,
			terminal_reason: "budget_exhausted",
			errors: ["Reached maximum budget ($0.5)"],
		});
	});

	test("counts what earlier user messages spent toward the budget", () => {
		const tally = new TurnTally(0, pricer, 0.4, 0.5);
		tally.addAssistant(message("claude-sonnet-4-5", { input: 10_000 }), 10, LIMITS);
		expect(tally.spentUSD()).toBeCloseTo(0.43);
		expect(tally.overBudget()).toBe(false);
		tally.addAssistant(message("claude-sonnet-4-5", { input: 40_000 }), 10, LIMITS);
		expect(tally.overBudget()).toBe(true);
	});
});
