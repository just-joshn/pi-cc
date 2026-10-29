import { describe, expect, test } from "vitest";
import { ccAdmitRepoEnv, ccEffectiveEnv, ccProtectedEnvKey } from "../src/core/settings/cc/env.ts";
import { mergeCcSettings } from "../src/core/settings/cc/merge.ts";
import { EMPTY_CC_POLICY } from "../src/core/settings/cc/policy.ts";
import type { CcSettings } from "../src/core/settings/cc/types.ts";

function settingsWithEnv(env: Record<string, string>): CcSettings {
	return mergeCcSettings([{ source: "user", path: "/settings/user.json", values: { env } }], EMPTY_CC_POLICY);
}

describe("effective environment", () => {
	test("a settings value replaces the inherited value for that key", () => {
		const env = ccEffectiveEnv(
			{ ANTHROPIC_API_KEY: "sk-ant-inherited", KEEP: "kept" },
			settingsWithEnv({ ANTHROPIC_API_KEY: "sk-ant-poison-project" }),
		);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-poison-project");
		expect(env.KEEP).toBe("kept");
	});

	test("adds keys the inherited environment does not have", () => {
		expect(ccEffectiveEnv({}, settingsWithEnv({ ANTHROPIC_MODEL: "claude-sonnet-4-5" }))).toEqual({
			ANTHROPIC_MODEL: "claude-sonnet-4-5",
		});
	});

	test("drops inherited keys with no value", () => {
		const env = ccEffectiveEnv({ ABSENT: undefined }, settingsWithEnv({}));
		expect(Object.keys(env)).toEqual([]);
	});
});

describe("repository-controlled env", () => {
	test("project and local tiers lose pi's bootstrap keys", () => {
		const admitted = ccAdmitRepoEnv("project", {
			PI_CODING_AGENT_DIR: "/elsewhere",
			NODE_OPTIONS: "--inspect",
			LD_PRELOAD: "x",
			DYLD_INSERT_LIBRARIES: "y",
			PATH: "/evil",
			BASH_ENV: "/evil",
			ENV: "/evil",
			ZDOTDIR: "/evil",
			ANTHROPIC_MODEL: "claude-sonnet-4-5",
		});
		expect(admitted).toEqual({ ANTHROPIC_MODEL: "claude-sonnet-4-5" });
	});

	test("user, flag and policy tiers keep every key", () => {
		for (const source of ["user", "flag", "policy"] as const) {
			expect(ccAdmitRepoEnv(source, { PI_CODING_AGENT_DIR: "/mine" })).toEqual({ PI_CODING_AGENT_DIR: "/mine" });
		}
	});

	test("names the protected keys", () => {
		for (const key of ["PI_OFFLINE", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_X", "PATH", "BASH_ENV", "ENV", "ZDOTDIR"]) {
			expect(ccProtectedEnvKey(key)).toBe(true);
		}
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "HOME"]) {
			expect(ccProtectedEnvKey(key)).toBe(false);
		}
	});
});
