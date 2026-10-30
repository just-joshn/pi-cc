import { describe, expect, test } from "vitest";
import { catalogLimits } from "../src/core/usage/cost.ts";

describe("catalogLimits", () => {
	test("reports Claude Code's output cap for the 4.x generations", () => {
		expect(catalogLimits("claude-sonnet-4-5")).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 });
		expect(catalogLimits("claude-haiku-4-5")).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 });
		expect(catalogLimits("claude-opus-4-1")).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 });
	});

	test("reports the larger window and cap of the 5.x generations", () => {
		expect(catalogLimits("claude-opus-5-5")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
	});

	test("has no limits for a model Claude Code does not list", () => {
		expect(catalogLimits("gpt-6.1")).toBeUndefined();
	});
});
