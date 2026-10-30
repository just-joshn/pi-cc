import { describe, expect, test } from "vitest";
import { reportedOutputCap } from "../src/modes/sdk/result.ts";

describe("reportedOutputCap", () => {
	test("caps the 4.x generations at 32000 whatever the catalog allows", () => {
		expect(reportedOutputCap("claude-sonnet-4-5", 64_000)).toBe(32_000);
		expect(reportedOutputCap("claude-haiku-4-5", 64_000)).toBe(32_000);
		expect(reportedOutputCap("claude-opus-4-1", 32_000)).toBe(32_000);
	});

	test("never raises a cap the catalog already holds below 32000", () => {
		expect(reportedOutputCap("claude-sonnet-4-5", 8_192)).toBe(8_192);
	});

	test("leaves later generations and other providers' models at the catalog value", () => {
		expect(reportedOutputCap("claude-opus-5-5", 128_000)).toBe(128_000);
		expect(reportedOutputCap("gpt-6.1", 100_000)).toBe(100_000);
	});
});
