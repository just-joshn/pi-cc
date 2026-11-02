import { describe, expect, it } from "vitest";
import { callMatchesRule } from "../src/core/hooks/filter.ts";
import { allowedTerminalSequence, stopHookCap } from "../src/core/hooks/messages.ts";
import { answerFromDecision, permissionHooksFor } from "../src/core/hooks/permission.ts";
import { PermissionState } from "../src/core/permissions/context.ts";
import { PermissionGate, type PermissionHooks } from "../src/core/permissions/gate.ts";
import type { PermissionPrompter } from "../src/core/permissions/prompt.ts";

const cwd = "/work";
const bash = (command: string) => ({ name: "Bash", input: { command } });

function gate(
	hooks: PermissionHooks | undefined,
	options: { prompter?: PermissionPrompter; mode?: "default" | "dontAsk" } = {},
) {
	const state = new PermissionState({ cwd, home: "/nonexistent", ...(options.mode ? { cliMode: options.mode } : {}) });
	return new PermissionGate({
		state,
		...(hooks ? { hooks } : {}),
		...(options.prompter ? { prompter: () => options.prompter } : {}),
	});
}

describe("a PreToolUse hook's say on permission", () => {
	it("allow answers an ask nothing holds in place", async () => {
		const outcome = await gate(undefined).decide(bash("npm test"), "1", { permission: "allow" });
		expect(outcome).toEqual({ action: "run" });
	});

	it("allow does not lift a deny rule", async () => {
		const state = new PermissionState({ cwd, home: "/x", disallowedTools: ["Bash(npm test)"] });
		const outcome = await new PermissionGate({ state }).decide(bash("npm test"), "1", { permission: "allow" });
		expect(outcome.action).toBe("refuse");
	});

	it("allow does not lift an ask rule", async () => {
		const state = new PermissionState({ cwd, home: "/x", settings: { ask: ["Bash(ls:*)"] } });
		const outcome = await new PermissionGate({ state }).decide(bash("ls"), "1", { permission: "allow" });
		expect(outcome.action).toBe("refuse");
	});

	it("ask turns an allowed call into a refusal with the hook's reason when nobody can ask", async () => {
		let consulted = false;
		const request = async () => {
			consulted = true;
			return undefined;
		};
		const outcome = await gate({ request }).decide(bash("ls"), "1", { permission: "ask", reason: "WHY" });
		expect(outcome).toEqual({ action: "refuse", message: "WHY" });
		expect(consulted).toBe(false);
	});

	it("ask puts the question to whoever can answer, with the hook's reason", async () => {
		const seen: string[] = [];
		const prompter: PermissionPrompter = async (request) => {
			seen.push(request.message);
			return { behavior: "allow" };
		};
		const outcome = await gate(undefined, { prompter }).decide(bash("ls"), "1", { permission: "ask", reason: "WHY" });
		expect(outcome).toEqual({ action: "run" });
		expect(seen).toEqual(["WHY"]);
	});
});

describe("PermissionRequest hooks", () => {
	const hooks = (answer: Awaited<ReturnType<NonNullable<PermissionHooks["request"]>>>): PermissionHooks => ({
		request: async () => answer,
	});

	it("an allow answer runs the call and carries the rewritten input", async () => {
		const outcome = await gate(hooks({ behavior: "allow", updatedInput: { command: "echo" } })).decide(
			bash("npm test"),
			"1",
		);
		expect(outcome).toEqual({ action: "run", updatedInput: { command: "echo" } });
	});

	it("a deny answer refuses with its message, and interrupt carries through", async () => {
		const outcome = await gate(hooks({ behavior: "deny", message: "NO", interrupt: true })).decide(
			bash("npm test"),
			"1",
		);
		expect(outcome).toEqual({ action: "refuse", message: "NO", interrupt: true });
	});

	it("no answer falls through to the prompt", async () => {
		const prompter: PermissionPrompter = async () => ({ behavior: "allow" });
		expect(await gate(hooks(undefined), { prompter }).decide(bash("npm test"), "1")).toEqual({ action: "run" });
	});

	it("is not consulted for a call that needs no asking", async () => {
		let consulted = false;
		const request = async () => {
			consulted = true;
			return undefined;
		};
		const outcome = await gate({ request }).decide(bash("ls"), "1");
		expect(outcome).toEqual({ action: "run" });
		expect(consulted).toBe(false);
	});

	it("dontAsk refuses before any hook can answer", async () => {
		const outcome = await gate(hooks({ behavior: "allow" }), { mode: "dontAsk" }).decide(bash("npm test"), "1");
		expect(outcome.action).toBe("refuse");
	});

	it("updatedPermissions become grants for the session", async () => {
		const answer = answerFromDecision({
			behavior: "allow",
			updatedPermissions: [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "npm test" }],
					behavior: "allow",
					destination: "session",
				},
			],
		});
		expect(answer).toMatchObject({
			behavior: "allow",
			updates: [{ type: "addRules", rules: ["Bash(npm test)"], destination: "session" }],
		});
	});

	it("the dispatcher-facing adapter skips a hookless session", async () => {
		const adapter = permissionHooksFor(
			{
				active: () => false,
				run: async () => {
					throw new Error("no");
				},
			} as never,
			() => undefined,
		);
		expect(await adapter.request?.(bash("ls"), "1", [], false)).toBeUndefined();
	});
});

describe("the removal waiver", () => {
	const base = { cwd, home: "/x", removalWaiverRequested: true };
	it("holds with no PermissionRequest hook", () => {
		expect(new PermissionState(base).current().removalWaived).toBe(true);
	});
	it("is voided by a configured PermissionRequest hook", () => {
		expect(new PermissionState({ ...base, permissionRequestHooks: true }).current().removalWaived).toBe(false);
	});
});

describe("hook helpers", () => {
	it("a terminal sequence passes only as title and notification OSC or bell", () => {
		expect(allowedTerminalSequence("\u001b]0;title\u0007")).toBe("\u001b]0;title\u0007");
		expect(allowedTerminalSequence("\u0007")).toBe("\u0007");
		expect(allowedTerminalSequence("\u001b]777;notify;t;b\u001b\\")).toBeDefined();
		expect(allowedTerminalSequence("\u001b[2J")).toBeUndefined();
		expect(allowedTerminalSequence("\u001b]0;ok\u0007\u001b[2J")).toBeUndefined();
		expect(allowedTerminalSequence("\u001b]52;c;Zm9v\u0007")).toBeUndefined();
	});
	it("the Stop block cap is eight unless the environment says otherwise", () => {
		expect(stopHookCap({})).toBe(8);
		expect(stopHookCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "2" })).toBe(2);
		expect(stopHookCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "0" })).toBe(0);
		expect(stopHookCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "x" })).toBe(8);
	});
	it("an if rule matches the tool and its content", () => {
		const call = { tool_name: "Bash", tool_input: { command: "git status" } };
		expect(callMatchesRule("Bash(git *)", call, cwd)).toBe(true);
		expect(callMatchesRule("Bash(npm *)", call, cwd)).toBe(false);
		expect(callMatchesRule("Bash", call, cwd)).toBe(true);
		expect(callMatchesRule("Read", call, cwd)).toBe(false);
		expect(callMatchesRule("Read(./src/**)", { tool_name: "Read", tool_input: { file_path: "src/a.ts" } }, cwd)).toBe(
			true,
		);
	});
});
