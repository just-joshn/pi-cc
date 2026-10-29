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
			expect(ccAdmitRepoEnv(source, { PI_CODING_AGENT_DIR: "/mine", HOME: "/mine" })).toEqual({
				PI_CODING_AGENT_DIR: "/mine",
				HOME: "/mine",
			});
		}
	});

	test("protects the key set Claude Code protects", () => {
		for (const key of [
			"HOME",
			"TMPDIR",
			"XDG_CONFIG_HOME",
			"XDG_CACHE_HOME",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"PWD",
			"CDPATH",
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_CODE_MANAGED_SETTINGS_PATH",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
			"ANTHROPIC_CONFIG_DIR",
		]) {
			expect(ccProtectedEnvKey(key)).toBe(true);
		}
	});

	test("protects pi's own bootstrap keys", () => {
		for (const key of ["PI_OFFLINE", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_X", "PATH", "BASH_ENV", "ENV", "ZDOTDIR"]) {
			expect(ccProtectedEnvKey(key)).toBe(true);
		}
	});

	test("compares names case-insensitively and protects the CLAUDE_AX_ prefix", () => {
		expect(ccProtectedEnvKey("home")).toBe(true);
		expect(ccProtectedEnvKey("Claude_Config_Dir")).toBe(true);
		expect(ccProtectedEnvKey("CLAUDE_AX_SCREEN_READER")).toBe(true);
		expect(ccProtectedEnvKey("claude_ax_screen_reader")).toBe(true);
		expect(ccProtectedEnvKey("pi_coding_agent_dir")).toBe(true);
	});

	test("a project or local block keeps the anthropic keys Claude Code admits", () => {
		for (const source of ["project", "local"] as const) {
			expect(
				ccAdmitRepoEnv(source, {
					ANTHROPIC_MODEL: "claude-sonnet-4-5",
					ANTHROPIC_API_KEY: "sk-ant-project",
					ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
					ANTHROPIC_CUSTOM_HEADERS: "x: y",
					CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
				}),
			).toEqual({
				ANTHROPIC_MODEL: "claude-sonnet-4-5",
				ANTHROPIC_API_KEY: "sk-ant-project",
				ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
				ANTHROPIC_CUSTOM_HEADERS: "x: y",
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
			});
		}
	});

	test("a project env block cannot move pi's home or config roots", () => {
		const inherited = {
			HOME: "/side/home",
			CLAUDE_CONFIG_DIR: "/side/config",
			XDG_CONFIG_HOME: "/side/home/.config",
			XDG_CACHE_HOME: "/side/home/.cache",
			XDG_DATA_HOME: "/side/home/.local/share",
			XDG_STATE_HOME: "/side/home/.local/state",
		};
		const settings = mergeCcSettings(
			[
				{
					source: "project",
					path: "/side/workspace/.claude/settings.json",
					values: {
						env: {
							HOME: "/side/workspace",
							CLAUDE_CONFIG_DIR: "/side/workspace/.claude",
							XDG_CONFIG_HOME: "/side/workspace/.config",
							XDG_CACHE_HOME: "/side/workspace/.cache",
							XDG_DATA_HOME: "/side/workspace/.data",
							XDG_STATE_HOME: "/side/workspace/.state",
						},
					},
				},
			],
			EMPTY_CC_POLICY,
		);
		expect(ccEffectiveEnv(inherited, settings)).toEqual(inherited);
	});
});
