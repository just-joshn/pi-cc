import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import {
	billingHeader,
	buildCcPolicy,
	CC_AUTO_BETAS,
	ccWireProfile,
	compactionWindow,
	parseAutocompact,
	parseFallbackModels,
	resolveEffort,
	unknownModelMaxTokens,
} from "../src/core/cc-policy.ts";

const model = (id: string) => getModel("anthropic", id as never) as Model<"anthropic-messages">;

const noFlags = { entrypoint: "sdk-cli" as const, customPrompt: false, flags: {} };

describe("effort resolution", () => {
	test.each([
		["claude-opus-5-5", "medium"],
		["claude-sonnet-5-5", "medium"],
		["claude-haiku-5-5", "medium"],
		["claude-opus-4-8", "high"],
		["claude-opus-4-7", "xhigh"],
	] as const)("%s defaults to %s", (id, expected) => {
		expect(resolveEffort(undefined, model(id), true)).toBe(expected);
	});

	test("--effort beats the catalog default", () => {
		expect(resolveEffort("max", model("claude-opus-5-5"), true)).toBe("max");
	});

	test("an id outside the catalog defaults to high", () => {
		expect(resolveEffort(undefined, { ...model("claude-opus-5-5"), id: "claude-probe-alias-x" }, false)).toBe("high");
	});

	test("a catalog model without effort control sends none, even with --effort", () => {
		const plain = { ...model("claude-opus-5-5"), compat: {} };

		expect(resolveEffort("high", plain, true)).toBeUndefined();
	});

	test("a dated id resolves through its undated entry", () => {
		expect(resolveEffort(undefined, { ...model("claude-opus-5-5"), id: "claude-opus-5-5-20260801" }, true)).toBe(
			"medium",
		);
	});
});

describe("maximum output tokens", () => {
	test("an unknown id caps at 32000", () => {
		expect(unknownModelMaxTokens(model("claude-opus-5-5"))).toBe(32_000);
	});

	test("a base model with a lower cap keeps it", () => {
		expect(unknownModelMaxTokens({ ...model("claude-opus-5-5"), maxTokens: 8192 })).toBe(8192);
	});
});

describe("flag parsing", () => {
	test("autocompact accepts auto and tokens in range only", () => {
		expect(parseAutocompact("auto")).toBeUndefined();
		expect(parseAutocompact("500000")).toBe(500_000);
		expect(parseAutocompact("100000")).toBe(100_000);
		expect(parseAutocompact("1000000")).toBe(1_000_000);
		expect(parseAutocompact("50")).toBeUndefined();
		expect(parseAutocompact("2000000")).toBeUndefined();
		expect(parseAutocompact("12abc")).toBeUndefined();
	});

	test("the fallback chain keeps order and drops blanks", () => {
		expect(parseFallbackModels(" a, b ,,c")).toEqual(["a", "b", "c"]);
		expect(parseFallbackModels(undefined)).toEqual([]);
	});

	test("snapshots default on and off under --bare, and an explicit value wins", () => {
		expect(buildCcPolicy(noFlags).snapshot).toBe(true);
		expect(buildCcPolicy({ ...noFlags, flags: { bare: true } }).snapshot).toBe(false);
		expect(buildCcPolicy({ ...noFlags, flags: { bare: true, systemPromptSnapshot: "on" } }).snapshot).toBe(true);
		expect(buildCcPolicy({ ...noFlags, flags: { systemPromptSnapshot: "off" } }).snapshot).toBe(false);
	});

	test("exclude-dynamic is ignored when a custom prompt replaced the default", () => {
		const flags = { excludeDynamicSystemPromptSections: true };

		expect(buildCcPolicy({ ...noFlags, flags }).excludeDynamic).toBe(true);
		expect(buildCcPolicy({ ...noFlags, flags, customPrompt: true }).excludeDynamic).toBe(false);
	});

	test("an unknown --effort value never reaches the policy", () => {
		expect(buildCcPolicy({ ...noFlags, flags: { effort: "bogus" } }).effort).toBeUndefined();
		expect(buildCcPolicy({ ...noFlags, flags: { effort: "xhigh" } }).effort).toBe("xhigh");
	});
});

describe("wire profile", () => {
	test("derives the billing header from the entrypoint", () => {
		expect(billingHeader("sdk-cli")).toMatch(
			/^x-anthropic-billing-header: cc_version=2\.1\.312\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/,
		);
		expect(billingHeader("cli")).toContain("cc_entrypoint=cli;");
		expect(billingHeader("sdk-cli")).toHaveLength(74);
	});

	test("carries the automatic betas first and --betas after them", () => {
		const policy = buildCcPolicy({ ...noFlags, flags: { betas: ["probe-beta"] } });
		const profile = ccWireProfile(policy, model("claude-opus-5-5"), true);

		expect(profile?.extraBetas).toEqual([...CC_AUTO_BETAS, "probe-beta"]);
		expect(profile?.effort).toBe("medium");
	});

	test("is absent for a model off the Anthropic transport", () => {
		const other = getModel("openai", "gpt-4.1")!;

		expect(ccWireProfile(buildCcPolicy(noFlags), other, true)).toBeUndefined();
	});
});

describe("compaction window", () => {
	test("--autocompact lowers the window and never raises it past the model's", () => {
		const policy = buildCcPolicy({ ...noFlags, flags: { autocompact: "300000" } });

		expect(compactionWindow(policy, 1_000_000)).toBe(300_000);
		expect(compactionWindow(policy, 200_000)).toBe(200_000);
		expect(compactionWindow(undefined, 200_000)).toBe(200_000);
	});
});
