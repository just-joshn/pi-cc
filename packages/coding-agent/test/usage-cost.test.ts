import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { budgetErrorText, budgetExhausted } from "../src/core/usage/budget.ts";
import { breakdownOf, canonicalName, chargeFor, costOf, parsePricingPolicy, priceOf } from "../src/core/usage/cost.ts";
import { CATALOG, findCatalogModel } from "../src/core/usage/pricing.ts";
import { formatDuration, formatUsageReport, formatUsd } from "../src/core/usage/report.ts";
import { statusContextWindow } from "../src/core/usage/status.ts";

function usage(over: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
		...over,
	};
}

const NOT_PRICED = { priced: false };
const price = (model: string, speed?: string) => priceOf(model, speed, NOT_PRICED, undefined);
const cost = (model: string, over: Partial<Usage>) => costOf(breakdownOf(usage(over)), price(model), 0);

describe("cost per token category", () => {
	test("prices input, output and cache read per million tokens", () => {
		expect(cost("claude-opus-4-8", { input: 1e6 })).toBeCloseTo(5);
		expect(cost("claude-opus-4-8", { output: 1e6 })).toBeCloseTo(25);
		expect(cost("claude-opus-4-8", { cacheRead: 1e6 })).toBeCloseTo(0.5);
	});

	test("prices web searches per request", () => {
		expect(cost("claude-opus-4-8", { webSearchRequests: 3 })).toBeCloseTo(0.03);
	});

	test("prices every catalog model from its own tier", () => {
		expect(cost("claude-opus-5-5", { input: 1e6, output: 1e6 })).toBeCloseTo(24);
		expect(cost("claude-sonnet-4-5", { input: 1e6, output: 1e6 })).toBeCloseTo(18);
		expect(cost("claude-fable-5-1", { cacheRead: 1e6 })).toBeCloseTo(0.25);
		expect(cost("claude-3-5-haiku", { input: 1e6 })).toBeCloseTo(0.8);
		for (const model of CATALOG) expect(cost(model.id, { input: 1e6 })).toBeGreaterThan(0);
	});
});

describe("cache write TTL", () => {
	test("charges 1h writes at the 1h price and the rest at 5m", () => {
		const total = cost("claude-opus-4-8", { cacheWrite: 2e6, cacheWrite1h: 1e6, cacheWrite5m: 1e6 });
		expect(total).toBeCloseTo(10 + 6.25);
	});

	test("charges writes with no TTL split at the 5m price", () => {
		expect(cost("claude-opus-4-8", { cacheWrite: 1e6 })).toBeCloseTo(6.25);
	});

	test("reports the 5m figure as the response gave it, clamped to what the 1h figure leaves", () => {
		expect(breakdownOf(usage({ cacheWrite: 2000, cacheWrite1h: 500 })).cacheWrite5m).toBe(0);
		expect(breakdownOf(usage({ cacheWrite: 2000, cacheWrite5m: 1500 })).cacheWrite5m).toBe(1500);
		expect(breakdownOf(usage({ cacheWrite: 2000, cacheWrite1h: 900, cacheWrite5m: 5000 })).cacheWrite5m).toBe(1100);
		expect(breakdownOf(usage({ cacheWrite: 100, cacheWrite1h: 900 })).cacheWrite1h).toBe(100);
	});
});

describe("long prompt pricing", () => {
	test("switches a request to the long rates once its whole prompt passes the threshold", () => {
		expect(cost("claude-haiku-5-5", { input: 100_000 })).toBeCloseTo(0.01);
		expect(cost("claude-haiku-5-5", { input: 100_001 })).toBeCloseTo(0.0500005);
	});

	test("counts cache reads and writes toward the threshold", () => {
		expect(cost("claude-haiku-5-5", { input: 1e5, cacheRead: 1 })).toBeCloseTo(0.01 + 0.05 / 1e6 + 0.4 * 0.1);
	});
});

describe("inference geo and speed", () => {
	test("multiplies the token subtotal by 1.1 for us, never the web search charge", () => {
		const base = costOf(breakdownOf(usage({ input: 1e6, webSearchRequests: 1 })), price("claude-opus-4-8"), 0);
		const us = costOf(
			breakdownOf(usage({ input: 1e6, webSearchRequests: 1, inferenceGeo: "us" })),
			price("claude-opus-4-8"),
			0,
		);
		expect(base).toBeCloseTo(5.01);
		expect(us).toBeCloseTo(5 * 1.1 + 0.01);
	});

	test("charges fast-mode responses at the fast rates of models that have them", () => {
		const fast = costOf(breakdownOf(usage({ input: 1e6, speed: "fast" })), price("claude-opus-4-8", "fast"), 0);
		expect(fast).toBeCloseTo(10);
		const slow = costOf(breakdownOf(usage({ input: 1e6, speed: "fast" })), price("claude-sonnet-4-5", "fast"), 0);
		expect(slow).toBeCloseTo(3);
	});
});

describe("model names", () => {
	test("resolves dated, Bedrock, Vertex and [1m] spellings to the catalog id", () => {
		for (const name of [
			"claude-sonnet-4-5-20250929",
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"claude-sonnet-4-5@20250929",
			"claude-sonnet-4-5[1m]",
		]) {
			expect(findCatalogModel(name)?.id).toBe("claude-sonnet-4-5");
		}
		expect(findCatalogModel("claude-sonnet-4-20250514")?.id).toBe("claude-sonnet-4-0");
		expect(findCatalogModel("claude-opus-5-5")?.id).toBe("claude-opus-5-5");
		expect(findCatalogModel("claude-opus-5")?.id).toBe("claude-opus-5");
	});

	test("reports a canonical name, stripping a date from a model it does not list", () => {
		expect(canonicalName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(canonicalName("mystery-model-20250101")).toBe("mystery-model");
	});
});

describe("unknown models", () => {
	test("a model nobody prices pays the default rates and is marked unknown", () => {
		const unknown = priceOf("mock-1", undefined, NOT_PRICED, undefined);
		expect(unknown.basis).toBe("unknown");
		expect(costOf(breakdownOf(usage({ input: 1e6 })), unknown, 0)).toBeCloseTo(5);
	});

	test("a model only pi's catalog prices keeps pi's cost and is marked unknown", () => {
		const charge = chargeFor("gpt-6.1", usage(), true, undefined);
		expect(charge).toEqual({ usd: 0.123, basis: "unknown" });
	});

	test("a Claude Code model ignores pi's cost", () => {
		expect(chargeFor("claude-opus-4-8", usage({ input: 1e6 }), true, undefined)).toEqual({ usd: 5, basis: "list" });
	});
});

describe("managed pricing policy", () => {
	const policy = parsePricingPolicy({
		multiplier: 2,
		overrides: { "claude-opus-4-8": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } },
	});

	test("prices an overridden model at the override, ignoring geo, and applies the multiplier", () => {
		const charge = chargeFor(
			"us.anthropic.claude-opus-4-8",
			usage({ input: 1e6, inferenceGeo: "us" }),
			false,
			policy,
		);
		expect(charge).toEqual({ usd: 2, basis: "managed" });
	});

	test("an override has no 1h price, so 1h writes pay the 5m price", () => {
		const charge = chargeFor("claude-opus-4-8", usage({ cacheWrite: 1e6, cacheWrite1h: 1e6 }), false, policy);
		expect(charge.usd).toBeCloseTo(3);
	});

	test("the multiplier alone moves a list price and marks it managed", () => {
		const charge = chargeFor("claude-sonnet-4-5", usage({ input: 1e6 }), false, policy);
		expect(charge).toEqual({ usd: 6, basis: "managed" });
	});

	test("a policy with nothing valid in it prices at list", () => {
		expect(parsePricingPolicy("x")).toBeUndefined();
		expect(parsePricingPolicy({ multiplier: -1 })).toBeUndefined();
		expect(parsePricingPolicy({ overrides: { m: { input: "1" } } })).toBeUndefined();
	});

	test("a bad override row is skipped and valid rows keep their rates and geo handling", () => {
		const mixed = parsePricingPolicy({
			overrides: {
				"claude-opus-4-8": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
				broken: { input: "1" },
				"claude-haiku-4-5": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: -1 },
			},
		});
		expect([...(mixed?.exact.keys() ?? [])]).toEqual(["claude-opus-4-8"]);
		expect(chargeFor("claude-opus-4-8", usage({ input: 1e6, inferenceGeo: "us" }), false, mixed)).toEqual({
			usd: 1,
			basis: "managed",
		});
		expect(chargeFor("claude-sonnet-4-5", usage({ input: 1e6, inferenceGeo: "us" }), false, mixed).usd).toBeCloseTo(
			3.3,
		);
	});

	test("an out-of-range multiplier is ignored while valid rows stay", () => {
		const rows = { "claude-opus-4-8": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } };
		for (const multiplier of [0, -1, 10.5, "2", Number.NaN]) {
			const parsed = parsePricingPolicy({ multiplier, overrides: rows });
			expect(parsed?.multiplier).toBe(1);
			expect(chargeFor("claude-opus-4-8", usage({ input: 1e6 }), false, parsed).usd).toBe(1);
		}
		expect(parsePricingPolicy({ multiplier: 10, overrides: rows })?.multiplier).toBe(10);
		expect(parsePricingPolicy({ multiplier: 99 })).toBeUndefined();
	});

	test("a built-in override reaches every spelling but not a model whose name merely contains the id", () => {
		const parsed = parsePricingPolicy({
			overrides: { "claude-sonnet-4-5": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } },
		});
		for (const name of ["claude-sonnet-4-5-20250929", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]) {
			expect(chargeFor(name, usage({ input: 1e6 }), false, parsed)).toEqual({ usd: 1, basis: "managed" });
		}
		const custom = parsePricingPolicy({
			overrides: { "claude-sonnet-4-5-custom": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } },
		});
		expect(custom?.builtin.size).toBe(0);
		expect(chargeFor("claude-sonnet-4-5", usage({ input: 1e6 }), false, custom)).toEqual({ usd: 3, basis: "list" });
		expect(chargeFor("claude-sonnet-4-5-custom", usage({ input: 1e6 }), false, custom).usd).toBe(1);
	});
});

describe("budget", () => {
	test("is exhausted when spend reaches the limit, or is not a number", () => {
		expect(budgetExhausted(0.99, 1)).toBe(false);
		expect(budgetExhausted(1, 1)).toBe(true);
		expect(budgetExhausted(Number.NaN, 1)).toBe(true);
		expect(budgetExhausted(5, undefined)).toBe(false);
	});

	test("names the limit in the error", () => {
		expect(budgetErrorText(2, 1.5)).toBe("Reached maximum budget ($1.5)");
		expect(budgetErrorText(Number.NaN, 1)).toContain("refusing to continue under --max-budget-usd 1");
	});
});

describe("usage text", () => {
	test("formats dollars with four decimals up to fifty cents, then cents", () => {
		expect(formatUsd(0)).toBe("$0.0000");
		expect(formatUsd(0.00021)).toBe("$0.0002");
		expect(formatUsd(1.234)).toBe("$1.23");
	});

	test("formats durations", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(2400)).toBe("2s");
		expect(formatDuration(75_000)).toBe("1m 15s");
		expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
	});
});

describe("status line context window", () => {
	test("counts the latest prompt and reports how much of the window it fills", () => {
		const fields = statusContextWindow(
			{ input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 },
			200_000,
		);
		expect(fields.total_input_tokens).toBe(4000);
		expect(fields.total_output_tokens).toBe(50);
		expect(fields.used_percentage).toBe(2);
		expect(fields.remaining_percentage).toBe(98);
	});
});

describe("usage report cache row", () => {
	const report = (requests: number, cachingObserved: boolean) =>
		formatUsageReport({
			models: new Map([
				[
					"claude-opus-5-5",
					{
						inputTokens: 12,
						outputTokens: 8,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						webSearchRequests: 0,
						costUSD: 0.0002,
					},
				],
			]),
			totalCostUSD: 0.0002,
			apiMs: 0,
			wallMs: 6000,
			linesAdded: 0,
			linesRemoved: 0,
			hasUnknownModelCost: false,
			managedPricing: false,
			requests,
			cacheHitRatio: 0,
			cachingObserved,
		});

	test("matches Claude Code's text after one request that never cached", () => {
		expect(report(1, false)).toBe(
			[
				"Total cost:            $0.0002",
				"Total duration (API):  0s",
				"Total duration (wall): 6s",
				"Total code changes:    0 lines added, 0 lines removed",
				"Usage by model:",
				"     claude-opus-5-5:  12 input, 8 output, 0 cache read, 0 cache write ($0.0002)",
				"Prompt cache (main):   1 request · 0% of input tokens from cache · no misses · no prompt caching reported by the API",
			].join("\n"),
		);
	});

	test("leaves the cache row out when the session cached", () => {
		expect(report(2, true)).not.toContain("Prompt cache");
	});
});
