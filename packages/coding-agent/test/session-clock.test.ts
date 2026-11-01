import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { type CostStateEntry, SessionManager } from "../src/core/session-manager.ts";
import { costStateOf, restoredCostState } from "../src/core/usage/cost-state.ts";
import type { ModelSpend, UsageReportInput } from "../src/core/usage/report.ts";
import { SessionClock } from "../src/core/usage/session-clock.ts";
import { SessionLedger, TurnTally } from "../src/modes/sdk/result.ts";

describe("session clock", () => {
	test("starts at construction and counts idle time", () => {
		const start = 1_000_000;
		const clock = new SessionClock(start);
		expect(clock.elapsed(start)).toBe(0);
		expect(clock.elapsed(start + 5_000)).toBe(5_000);
		expect(clock.sessionStartTime()).toBe(start);
	});

	test("never reports a negative duration", () => {
		const clock = new SessionClock(0);
		clock.restore(500, undefined, 1_000);
		expect(clock.snapshot()).toEqual({ startMs: 500, sessionStartMs: undefined });
		expect(clock.elapsed(400)).toBe(0);
	});

	test("restartClock re-anchors and drops the logical start", () => {
		const clock = new SessionClock(0);
		clock.restore(10_000, 5_000, 20_000);
		clock.restartClock(30_000);
		expect(clock.snapshot()).toEqual({ startMs: 30_000, sessionStartMs: undefined });
		expect(clock.elapsed(30_500)).toBe(500);
	});

	test("reset re-anchors like a new session", () => {
		const clock = new SessionClock(0);
		clock.restore(10_000, 5_000, 20_000);
		clock.reset(30_000);
		expect(clock.snapshot()).toEqual({ startMs: 30_000, sessionStartMs: undefined });
	});

	test("restore continues at the persisted duration and clamps the logical start to the anchor", () => {
		const clock = new SessionClock(0);
		clock.restore(60_000, 5_000, 100_000);
		expect(clock.snapshot()).toEqual({ startMs: 40_000, sessionStartMs: 5_000 });
		expect(clock.elapsed(100_000)).toBe(60_000);
		clock.restore(10_000, 200_000, 100_000);
		expect(clock.snapshot()).toEqual({ startMs: 90_000, sessionStartMs: 90_000 });
	});
});

function costStateEntry(over: Partial<CostStateEntry> = {}): CostStateEntry {
	return {
		type: "cost_state",
		id: `id-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		totalDuration: 1_000,
		startTime: 500,
		totalCostUSD: 1,
		totalAPIDuration: 100,
		totalLinesAdded: 3,
		totalLinesRemoved: 2,
		modelUsage: {},
		hasUnknownModelCost: false,
		...over,
	};
}

describe("cost-state persistence", () => {
	test("restoredCostState takes the newest entry, last-wins", () => {
		const first = costStateEntry({ totalCostUSD: 1, id: "a" });
		const second = costStateEntry({ totalCostUSD: 2, id: "b" });
		expect(restoredCostState([first, second])).toBe(second);
		expect(restoredCostState([second, first])).toBe(first);
		expect(restoredCostState([])).toBeUndefined();
	});

	test("appendCostState persists through the session entries", () => {
		const session = SessionManager.inMemory();
		session.appendCostState({
			totalDuration: 1_000,
			startTime: 500,
			totalCostUSD: 1,
			totalAPIDuration: 100,
			totalLinesAdded: 3,
			totalLinesRemoved: 2,
			modelUsage: { "claude-opus-4-8": spend(1) },
			hasUnknownModelCost: false,
		});
		const restored = restoredCostState(session.getEntries());
		expect(restored?.totalCostUSD).toBe(1);
		expect(restored?.modelUsage?.["claude-opus-4-8"]).toEqual(spend(1));
	});

	test("costStateOf maps a report input onto the record shape", () => {
		const clock = new SessionClock(1_000);
		clock.restore(60_000, 5_000, 100_000);
		const state = costStateOf(reportInput(), clock, 100_000);
		expect(state).toEqual({
			totalDuration: 60_000,
			startTime: 5_000,
			totalCostUSD: 0.0002,
			totalAPIDuration: 0,
			totalLinesAdded: 0,
			totalLinesRemoved: 0,
			modelUsage: { "claude-opus-4-8": spend(0.0002) },
			hasUnknownModelCost: false,
		});
	});
});

describe("ledger restored-cost split", () => {
	const LIMITS = { contextWindow: 200_000, maxOutputTokens: 32_000 };

	function assistant(model: string, input: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model,
			usage: {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
	}

	test("result totals include restored cost while the budget counts fresh spend only", () => {
		const ledger = new SessionLedger();
		ledger.seed(1.5);
		const tally = new TurnTally(0, () => ({ usd: 0.5, basis: "list" }), ledger.freshSpentUSD(), 1.6);
		tally.addAssistant(assistant("claude-opus-4-8", 10), 10, LIMITS);
		expect(ledger.freshSpentUSD()).toBe(0);
		const result = ledger.result(tally, "s", 100);
		expect(result.total_cost_usd).toBeCloseTo(2);
		expect(tally.overBudget()).toBe(false);

		const over = new TurnTally(0, () => ({ usd: 0.5, basis: "list" }), ledger.freshSpentUSD(), 0.4);
		over.addAssistant(assistant("claude-opus-4-8", 10), 10, LIMITS);
		expect(over.overBudget()).toBe(true);
	});
});

function spend(costUSD: number): ModelSpend {
	return {
		inputTokens: 12,
		outputTokens: 8,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		webSearchRequests: 0,
		costUSD,
	};
}

function reportInput(): UsageReportInput {
	return {
		models: new Map([["claude-opus-4-8", spend(0.0002)]]),
		totalCostUSD: 0.0002,
		apiMs: 0,
		wallMs: 0,
		linesAdded: 0,
		linesRemoved: 0,
		hasUnknownModelCost: false,
		managedPricing: false,
		requests: 1,
		cacheHitRatio: 0,
		cachingObserved: false,
	};
}
