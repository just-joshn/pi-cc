import { describe, expect, test } from "vitest";
import { activeGroups, type HookConfig, hookConfigFrom } from "../src/core/hooks/config.ts";
import { interpolateHeader, urlMatchesPattern } from "../src/core/hooks/http.ts";
import { matcherAccepts, selectHandlers } from "../src/core/hooks/matcher.ts";
import { interpret, mergeOutcomes } from "../src/core/hooks/outcome.ts";
import type { CcSettings } from "../src/core/settings/cc/types.ts";

function settings(hooks: Record<string, unknown>, extra: Record<string, unknown> = {}, source = "user"): CcSettings {
	return {
		values: extra,
		hooksBySource: { [source]: hooks },
		policy: { allowManagedHooksOnly: extra.allowManagedHooksOnly === true },
	} as unknown as CcSettings;
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe("matchers", () => {
	test("a plain name list matches names exactly", () => {
		expect(matcherAccepts("Read|Write", "Read", true)).toBe(true);
		expect(matcherAccepts("Rea", "Read", true)).toBe(false);
	});
	test("anything else is an unanchored regular expression", () => {
		expect(matcherAccepts("ea.", "Read", true)).toBe(true);
		expect(matcherAccepts("^mcp__.*", "mcp__a__b", true)).toBe(true);
	});
	test("an empty or star matcher matches everything", () => {
		expect(matcherAccepts(undefined, "x", true)).toBe(true);
		expect(matcherAccepts("*", "x", true)).toBe(true);
	});
	test("identical handlers in two groups run once", () => {
		const config = hookConfigFrom({
			settings: settings({
				PreToolUse: [
					{ hooks: [{ type: "command", command: "a" }] },
					{ matcher: "Bash", hooks: [{ type: "command", command: "a" }] },
				],
			}),
		});
		expect(selectHandlers(activeGroups(config, "PreToolUse"), "PreToolUse", "Bash")).toHaveLength(1);
	});
	test("an event without a matcher field ignores the matcher", () => {
		const config = hookConfigFrom({
			settings: settings({ Stop: [{ matcher: "Nope", hooks: [{ type: "command", command: "a" }] }] }),
		});
		expect(selectHandlers(activeGroups(config, "Stop"), "Stop", undefined)).toHaveLength(1);
	});
});

describe("outcomes", () => {
	const here = { source: "cmd" };
	test("exit 2 blocks with the command and its stderr, and is a user error where nothing can be blocked", () => {
		expect(interpret("PreToolUse", { code: 2, stdout: "", stderr: "no\n" }, here)).toEqual({
			block: { text: "[cmd]: no\n", reason: "no", viaExit: true },
		});
		expect(interpret("SessionStart", { code: 2, stdout: "", stderr: "no" }, here)).toEqual({ error: "no" });
	});
	test("other exit codes are errors that do not block", () => {
		expect(interpret("PreToolUse", { code: 1, stdout: "", stderr: "bad" }, here)).toEqual({ error: "bad" });
	});
	test("onFailure block turns a failure into a block", () => {
		const out = interpret("PreToolUse", { code: 1, stdout: "", stderr: "bad" }, { ...here, onFailure: "block" });
		expect(out.block?.reason).toBe("bad");
	});
	test("an http answer is read by its status, and a 2xx body must be JSON", () => {
		expect(interpret("PreToolUse", { code: null, status: 500, stdout: "", stderr: "HTTP 500 from u" }, here)).toEqual(
			{
				error: "HTTP 500 from u",
			},
		);
		const plain = interpret("PreToolUse", { code: null, status: 200, stdout: "hi", stderr: "" }, here);
		expect(plain.error).toContain("must return JSON");
		const json = JSON.stringify({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" },
		});
		expect(interpret("PreToolUse", { code: null, status: 200, stdout: json, stderr: "" }, here).permission).toBe(
			"deny",
		);
	});
	test("a PreToolUse decision carries permission, reason and rewrite", () => {
		const out = interpret(
			"PreToolUse",
			ok(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "why",
						updatedInput: { command: "x" },
					},
				}),
			),
			here,
		);
		expect(out).toMatchObject({ permission: "deny", block: { reason: "why" }, updatedInput: { command: "x" } });
	});
	test("plain stdout is context only for the events that take it", () => {
		expect(interpret("UserPromptSubmit", ok("hello\n"), here)).toEqual({ output: "hello" });
		expect(interpret("PreToolUse", ok("hello\n"), here)).toEqual({});
	});
	test("continue false stops with the reason", () => {
		expect(interpret("Stop", ok('{"continue":false,"stopReason":"enough"}'), here)).toEqual({ stop: "enough" });
	});
	test("the strongest permission wins, the later of two equals wins, and the last rewrite wins", () => {
		const block = (reason: string) => ({ text: reason, reason, viaExit: false });
		const verdict = mergeOutcomes([
			{ permission: "allow", updatedInput: { a: 1 } },
			{ permission: "deny", permissionReason: "first", block: block("first") },
			{ permission: "deny", permissionReason: "second", block: block("second") },
			{ permission: "ask", updatedInput: { a: 2 } },
		]);
		expect(verdict.permission).toBe("deny");
		expect(verdict.permissionReason).toBe("second");
		expect(verdict.updatedInput).toEqual({ a: 2 });
		expect(verdict.blocks.map((entry) => entry.reason)).toEqual(["first", "second"]);
	});
});

describe("http hooks", () => {
	const env = { A: "1", B: "2" };
	test("only allowed variables interpolate, the rest become empty", () => {
		const header = ["$A-$", "{B}-$C"].join("");
		expect(interpolateHeader(header, new Set(["A"]), env)).toBe("1--");
	});
	test("a credential variable never interpolates", () => {
		expect(interpolateHeader("$ANTHROPIC_API_KEY", new Set(["ANTHROPIC_API_KEY"]), { ANTHROPIC_API_KEY: "k" })).toBe(
			"",
		);
	});
	test("line breaks are stripped from a header", () => {
		expect(interpolateHeader("a\r\nb", new Set(), {})).toBe("ab");
	});
	test("url patterns use star as a wildcard over the whole url", () => {
		expect(urlMatchesPattern("https://a.example/x", "https://*.example/*")).toBe(true);
		expect(urlMatchesPattern("https://a.example.evil/x", "https://a.example")).toBe(false);
	});
});

describe("configuration", () => {
	const hooks = { PreToolUse: [{ hooks: [{ type: "command", command: "a", timeout: 3 }] }] };
	test("timeouts are in seconds and default to ten minutes", () => {
		const config = hookConfigFrom({
			settings: settings({ Stop: [{ hooks: [{ type: "command", command: "x" }] }], ...hooks }),
		});
		expect(config.groups.PreToolUse?.[0]?.handlers[0]?.timeoutMs).toBe(3000);
		expect(config.groups.Stop?.[0]?.handlers[0]?.timeoutMs).toBe(600_000);
	});
	test("disableAllHooks and --bare switch everything off", () => {
		const off = hookConfigFrom({ settings: settings(hooks, { disableAllHooks: true }) });
		expect(activeGroups(off, "PreToolUse")).toEqual([]);
		expect(activeGroups(hookConfigFrom({ settings: settings(hooks), bare: true }), "PreToolUse")).toEqual([]);
	});
	test("allowManagedHooksOnly keeps only policy hooks", () => {
		const user = hookConfigFrom({ settings: settings(hooks, { allowManagedHooksOnly: true }) });
		expect(activeGroups(user, "PreToolUse")).toEqual([]);
		const policy = hookConfigFrom({ settings: settings(hooks, { allowManagedHooksOnly: true }, "policy") });
		expect(activeGroups(policy, "PreToolUse")).toHaveLength(1);
	});
	test("an unknown event or hook type is reported and skipped", () => {
		const config: HookConfig = hookConfigFrom({
			settings: settings({ Nope: [], Stop: [{ hooks: [{ type: "wat" }] }] }),
		});
		expect(config.warnings).toHaveLength(2);
		expect(config.groups).toEqual({});
	});
});
