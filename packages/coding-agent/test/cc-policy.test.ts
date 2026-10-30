import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import {
	buildCcPolicy,
	CC_AUTO_BETAS,
	ccWireProfile,
	compactionWindow,
	parseFallbackModels,
} from "../src/core/cc-policy.ts";

const model = (id: string) => getModel("anthropic", id as never) as Model<"anthropic-messages">;

const noFlags = { entrypoint: "sdk-cli" as const, customPrompt: false, flags: {} };

describe("effort of a request", () => {
	const profile = (
		flag: string | undefined,
		target: Model<"anthropic-messages">,
		known: boolean,
		levelChosen = false,
	) => ccWireProfile(buildCcPolicy({ ...noFlags, flags: { effort: flag } }), target, known, false, levelChosen);

	test.each([
		["claude-opus-5-5", "medium"],
		["claude-sonnet-5-5", "medium"],
		["claude-haiku-5-5", "medium"],
		["claude-opus-4-8", "high"],
		["claude-opus-4-7", "xhigh"],
	] as const)("%s defaults to %s", (id, expected) => {
		expect(profile(undefined, model(id), true)?.defaultEffort).toBe(expected);
	});

	test("--effort travels separately so it beats the default and a chosen level", () => {
		const result = profile("max", model("claude-opus-5-5"), true, true);

		expect(result?.effort).toBe("max");
		expect(result?.defaultEffort).toBe("medium");
		expect(result?.levelChosen).toBe(true);
	});

	test("an id outside the catalog defaults to high", () => {
		expect(
			profile(undefined, { ...model("claude-opus-5-5"), id: "claude-probe-alias-x" }, false)?.defaultEffort,
		).toBe("high");
	});

	test("a catalog model without effort control sends none, even with --effort", () => {
		const plain = { ...model("claude-opus-5-5"), compat: {} };
		const result = profile("high", plain, true);

		expect(result?.effort).toBeUndefined();
		expect(result?.defaultEffort).toBeUndefined();
	});

	test("a dated id resolves through its undated entry", () => {
		const dated = { ...model("claude-opus-5-5"), id: "claude-opus-5-5-20260801" };

		expect(profile(undefined, dated, true)?.defaultEffort).toBe("medium");
	});
});

describe("maximum output tokens", () => {
	const profile = (id: string, known: boolean, capOverridden = false) =>
		ccWireProfile(buildCcPolicy(noFlags), { ...model("claude-opus-5-5"), id }, known, capOverridden, false)
			?.maxTokens;

	test("an unknown id caps at 32000", () => {
		expect(profile("claude-probe-alias-x", false)).toBe(32_000);
	});

	test("a listed model sends Claude Code's own cap", () => {
		expect(profile("claude-opus-5-5", true)).toBe(128_000);
		expect(profile("claude-fable-5-1", true)).toBe(64_000);
		expect(profile("claude-haiku-4-5", true)).toBe(32_000);
		expect(profile("claude-sonnet-4-5", true)).toBe(32_000);
		expect(profile("claude-opus-4-8", true)).toBe(64_000);
	});

	test("an unlisted catalog model keeps its catalog cap", () => {
		expect(profile("claude-sonnet-5-5", true)).toBeUndefined();
	});

	test("CLAUDE_CODE_MAX_OUTPUT_TOKENS leaves the cap alone", () => {
		expect(profile("claude-probe-alias-x", false, true)).toBeUndefined();
	});
});

describe("flag parsing", () => {
	test("autocompact takes the window from --autocompact and none for auto", () => {
		const window = (value: string) => buildCcPolicy({ ...noFlags, flags: { autocompact: value } }).autocompactWindow;

		expect(window("auto")).toBeUndefined();
		expect(window("500000")).toBe(500_000);
		expect(window("200k")).toBe(200_000);
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
	test("omits client attribution and client betas", () => {
		const policy = buildCcPolicy({ ...noFlags, flags: { betas: ["claude-code-20250219"] } });
		const profile = ccWireProfile(policy, model("claude-opus-5-5"), true, false, false);
		expect.soft(profile).not.toHaveProperty("billingHeader");
		expect.soft(profile?.extraBetas).not.toContain("claude-code-20250219");
	});

	test("carries the automatic betas first and the recognized --betas values after them, dropping the rest", () => {
		const policy = buildCcPolicy({ ...noFlags, flags: { betas: ["probe-beta", "context-1m-2025-08-07"] } });
		const profile = ccWireProfile(policy, model("claude-opus-5-5"), true, false, false);

		expect(profile?.extraBetas).toEqual([...CC_AUTO_BETAS, "context-1m-2025-08-07"]);
		expect(profile?.defaultEffort).toBe("medium");
	});

	test("is absent for a model off the Anthropic transport", () => {
		const other = getModel("openai", "gpt-4.1")!;

		expect(ccWireProfile(buildCcPolicy(noFlags), other, true, false, false)).toBeUndefined();
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
