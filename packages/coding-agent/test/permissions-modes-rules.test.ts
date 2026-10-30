import { describe, expect, it } from "vitest";
import { PermissionState } from "../src/core/permissions/context.ts";
import { PERMISSION_MODES, parsePermissionMode, stricterMode } from "../src/core/permissions/mode.ts";
import { coversTool, formatRule, parseRuleText, RuleSet, rulesFromTexts } from "../src/core/permissions/rules.ts";

describe("the mode ladder", () => {
	it("orders plan below default and dontAsk, then acceptEdits, auto and bypassPermissions", () => {
		expect(stricterMode("bypassPermissions", "acceptEdits")).toBe("acceptEdits");
		expect(stricterMode("acceptEdits", "plan")).toBe("plan");
		expect(stricterMode("auto", "default")).toBe("default");
		expect(stricterMode("plan", "bypassPermissions")).toBe("plan");
	});

	it("keeps the first mode on a tie, so default and dontAsk never swap", () => {
		expect(stricterMode("dontAsk", "default")).toBe("dontAsk");
		expect(stricterMode("default", "dontAsk")).toBe("default");
	});

	it("accepts manual as another name for default and refuses unknown names", () => {
		expect(parsePermissionMode("manual")).toBe("default");
		for (const mode of PERMISSION_MODES) expect(parsePermissionMode(mode)).toBe(mode);
		expect(parsePermissionMode("yolo")).toBeUndefined();
	});
});

describe("rule text", () => {
	it("parses a tool, content, and the whole-tool spellings", () => {
		expect(parseRuleText("Bash(npm run test:*)")).toEqual({ toolName: "Bash", content: "npm run test:*" });
		expect(parseRuleText("Read")).toEqual({ toolName: "Read" });
		expect(parseRuleText("Bash()")).toEqual({ toolName: "Bash" });
		expect(parseRuleText("Bash(*)")).toEqual({ toolName: "Bash" });
		expect(parseRuleText("mcp__server__tool")).toEqual({ toolName: "mcp__server__tool" });
		expect(parseRuleText("")).toBeUndefined();
		expect(parseRuleText("(x)")).toBeUndefined();
	});

	it("round-trips parentheses inside content through a backslash", () => {
		const parsed = parseRuleText("Bash(echo \\(hi\\))");
		expect(parsed).toEqual({ toolName: "Bash", content: "echo (hi)" });
		expect(formatRule(parsed!)).toBe("Bash(echo \\(hi\\))");
	});

	it("covers every tool of an MCP server with the server name, and only exact names otherwise", () => {
		expect(coversTool("mcp__github", "mcp__github__create_issue")).toBe(true);
		expect(coversTool("mcp__github__*", "mcp__github__create_issue")).toBe(true);
		expect(coversTool("mcp__github", "mcp__gitlab__create_issue")).toBe(false);
		expect(coversTool("mcp__github__create_issue", "mcp__github__list")).toBe(false);
		expect(coversTool("Bash", "Bash")).toBe(true);
		expect(coversTool("Bash", "PowerShell")).toBe(false);
	});
});

describe("rule sources", () => {
	it("walks sources in the order settings, cliArg, command, session, whatever order they were added in", () => {
		const set = new RuleSet([
			...rulesFromTexts(["Write(b)"], "deny", "session"),
			...rulesFromTexts(["Write(a)"], "deny", "cliArg"),
			...rulesFromTexts(["Write(c)"], "deny", "settings"),
			...rulesFromTexts(["Write(d)"], "allow", "settings"),
		]);
		expect(set.of("deny").map((rule) => rule.content)).toEqual(["c", "a", "b"]);
		expect(set.of("allow").map((rule) => rule.content)).toEqual(["d"]);
	});

	it("returns the first whole-tool rule, which is the earliest source", () => {
		const set = new RuleSet([
			...rulesFromTexts(["Bash"], "deny", "session"),
			...rulesFromTexts(["Bash"], "deny", "settings"),
		]);
		expect(set.wholeTool("deny", "Bash")?.source).toBe("settings");
		expect(set.wholeTool("allow", "Bash")).toBeUndefined();
	});
});

describe("the session's permission state", () => {
	const cwd = "/tmp";

	it("starts in default and lets defaultMode set it", () => {
		expect(new PermissionState({ cwd }).current().mode).toBe("default");
		expect(new PermissionState({ cwd, settings: { defaultMode: "dontAsk" } }).current().mode).toBe("dontAsk");
	});

	it("lets the command line beat defaultMode", () => {
		const state = new PermissionState({ cwd, cliMode: "acceptEdits", settings: { defaultMode: "dontAsk" } });
		expect(state.current().mode).toBe("acceptEdits");
	});

	it("turns a bypass request into default when settings disable bypass, and refuses a later switch to it", () => {
		const state = new PermissionState({
			cwd,
			cliMode: "bypassPermissions",
			settings: { disableBypassPermissionsMode: "disable" },
		});
		expect(state.current().mode).toBe("default");
		expect(state.setMode("bypassPermissions")).toBe(false);
		expect(state.current().mode).toBe("default");
		expect(state.setMode("plan")).toBe(true);
	});

	it("hands out a context that later grants do not change", () => {
		const state = new PermissionState({ cwd });
		const before = state.current();
		state.addRules(["Bash(ls:*)"], "allow", "session");
		expect(before.rules.of("allow")).toHaveLength(0);
		expect(state.current().rules.of("allow")).toHaveLength(1);
	});
});
