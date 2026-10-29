import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	ccSettingsPath,
	localSettingsPath,
	managedSettingsPath,
	projectSettingsPath,
	userSettingsPath,
} from "../src/core/settings/cc/paths.ts";

describe("user settings path", () => {
	test("reads CLAUDE_CONFIG_DIR when it is set", () => {
		expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "/side/config" }, "/side/home")).toBe(
			join("/side/config", "settings.json"),
		);
	});

	test("falls back to ~/.claude", () => {
		expect(userSettingsPath({}, "/side/home")).toBe(join("/side/home", ".claude", "settings.json"));
	});

	test("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
		expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "" }, "/side/home")).toBe(
			join("/side/home", ".claude", "settings.json"),
		);
	});
});

describe("project and local paths", () => {
	test("sit beside each other under .claude", () => {
		expect(projectSettingsPath("/side/workspace")).toBe(join("/side/workspace", ".claude", "settings.json"));
		expect(localSettingsPath("/side/workspace")).toBe(join("/side/workspace", ".claude", "settings.local.json"));
	});
});

describe("managed settings path", () => {
	test("uses the per-platform managed directory", () => {
		expect(managedSettingsPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
		expect(managedSettingsPath("linux")).toBe("/etc/claude-code/managed-settings.json");
		expect(managedSettingsPath("win32")).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");
	});

	test("is absent on a platform Claude Code has no managed directory for", () => {
		expect(managedSettingsPath("freebsd")).toBeUndefined();
	});
});

describe("tier lookup", () => {
	const location = {
		cwd: "/side/workspace",
		home: "/side/home",
		env: { CLAUDE_CONFIG_DIR: "/side/config" },
		platform: "darwin",
	};

	test("maps every file tier", () => {
		expect(ccSettingsPath("user", location)).toBe(join("/side/config", "settings.json"));
		expect(ccSettingsPath("project", location)).toBe(join("/side/workspace", ".claude", "settings.json"));
		expect(ccSettingsPath("local", location)).toBe(join("/side/workspace", ".claude", "settings.local.json"));
		expect(ccSettingsPath("policy", location)).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
	});

	test("has no file for the flag tier", () => {
		expect(ccSettingsPath("flag", location)).toBeUndefined();
	});
});
