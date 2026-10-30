import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { permissionCallFor } from "../src/core/permissions/call.ts";
import { permissionSetup, splitToolList } from "../src/core/permissions/cli.ts";
import { PermissionState } from "../src/core/permissions/context.ts";
import { PermissionGate } from "../src/core/permissions/gate.ts";
import {
	grantScope,
	NO,
	type PermissionAnswer,
	type PermissionPrompter,
	type PermissionRequest,
	YES,
} from "../src/core/permissions/prompt.ts";
import { createUiPrompter } from "../src/core/permissions/ui-prompter.ts";

let cwd: string;
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-gate-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const bash = (command: string) => ({ name: "Bash", input: { command } });
const write = { name: "Write", input: { file_path: "a.txt", content: "x" } };

function gateWith(
	answer: (request: PermissionRequest) => PermissionAnswer | undefined,
	options: { prompts?: "host" | "none"; mode?: "default" | "dontAsk" } = {},
) {
	const state = new PermissionState({ cwd, home: "/nonexistent", ...(options.mode ? { cliMode: options.mode } : {}) });
	const asked: PermissionRequest[] = [];
	const prompter: PermissionPrompter = async (request) => {
		asked.push(request);
		return answer(request);
	};
	return { state, asked, gate: new PermissionGate({ state, prompter: () => prompter, prompts: options.prompts }) };
}

describe("asking", () => {
	it("refuses with the ask's own text when nobody can answer", async () => {
		const gate = new PermissionGate({ state: new PermissionState({ cwd }) });
		expect(await gate.decide(bash("npm test"), "1")).toEqual({
			action: "refuse",
			message: "This command requires approval",
		});
	});

	it("does not prompt for an allowed or denied call", async () => {
		const { gate, asked } = gateWith(() => ({ behavior: "allow" }));
		expect(await gate.decide(bash("ls"), "1")).toEqual({ action: "run" });
		expect(await gate.decide({ name: "Write", input: { file_path: join(cwd, "a.txt") } }, "2")).toMatchObject({
			action: "run",
		});
		expect(asked).toHaveLength(1);
	});

	it("runs the call after an allow answer and refuses with the answer's text after a deny", async () => {
		expect(await gateWith(() => ({ behavior: "allow" })).gate.decide(bash("npm test"), "1")).toEqual({
			action: "run",
		});
		const denied = await gateWith(() => ({ behavior: "deny", message: "no thanks", interrupt: true })).gate.decide(
			bash("npm test"),
			"1",
		);
		expect(denied).toEqual({ action: "refuse", message: "no thanks", interrupt: true });
	});

	it("refuses an unanswered prompt with the ask's text", async () => {
		expect(await gateWith(() => undefined).gate.decide(bash("npm test"), "1")).toEqual({
			action: "refuse",
			message: "This command requires approval",
		});
	});

	it("never prompts under --permission-prompts none", async () => {
		const { gate, asked } = gateWith(() => ({ behavior: "allow" }), { prompts: "none" });
		expect(await gate.decide(bash("npm test"), "1")).toMatchObject({ action: "refuse" });
		expect(asked).toHaveLength(0);
	});

	it("never prompts in dontAsk mode and answers with the don't-ask denial", async () => {
		const { gate, asked } = gateWith(() => ({ behavior: "allow" }), { mode: "dontAsk" });
		const outcome = await gate.decide(bash("npm test"), "1");
		expect(outcome).toMatchObject({ action: "refuse", message: expect.stringContaining("don't ask mode") });
		expect(asked).toHaveLength(0);
	});

	it("asks one question at a time and re-checks a waiting call against the grant given to the one before", async () => {
		const { gate, asked, state } = gateWith(() => ({
			behavior: "allow",
			updates: [{ type: "addRules", rules: ["Bash(npm test)"], behavior: "allow", destination: "session" }],
		}));
		const [first, second] = await Promise.all([
			gate.decide(bash("npm test"), "1"),
			gate.decide(bash("npm test"), "2"),
		]);
		expect(first).toEqual({ action: "run" });
		expect(second).toEqual({ action: "run" });
		expect(asked).toHaveLength(1);
		expect(state.current().rules.of("allow")).toHaveLength(1);
	});
});

describe("grant scopes", () => {
	it("classifies an answer as once, session or always from where its rules go", () => {
		expect(grantScope({ behavior: "allow" })).toBe("once");
		expect(grantScope({ behavior: "deny", message: "x" })).toBe("once");
		expect(grantScope({ behavior: "allow", updates: [{ type: "setMode", mode: "acceptEdits" }] })).toBe("session");
		expect(
			grantScope({
				behavior: "allow",
				updates: [{ type: "addRules", rules: ["Bash(ls)"], behavior: "allow", destination: "session" }],
			}),
		).toBe("session");
		expect(
			grantScope({
				behavior: "allow",
				updates: [{ type: "addRules", rules: ["Bash(ls)"], behavior: "allow", destination: "localSettings" }],
			}),
		).toBe("always");
	});

	it("once leaves the next identical call asking", async () => {
		const { gate, asked } = gateWith(() => ({ behavior: "allow" }));
		await gate.decide(bash("npm test"), "1");
		await gate.decide(bash("npm test"), "2");
		expect(asked).toHaveLength(2);
	});

	it("session covers the next identical call without a file", async () => {
		const { gate, asked } = gateWith(() => ({
			behavior: "allow",
			updates: [{ type: "addRules", rules: ["Bash(npm test)"], behavior: "allow", destination: "session" }],
		}));
		await gate.decide(bash("npm test"), "1");
		expect(await gate.decide(bash("npm test"), "2")).toEqual({ action: "run" });
		expect(asked).toHaveLength(1);
		expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(false);
	});

	it("always also writes the rule into the project's local settings, once", async () => {
		const { gate } = gateWith(() => ({
			behavior: "allow",
			updates: [{ type: "addRules", rules: ["Bash(npm test)"], behavior: "allow", destination: "localSettings" }],
		}));
		await gate.decide(bash("npm test"), "1");
		const file = join(cwd, ".claude", "settings.local.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ permissions: { allow: ["Bash(npm test)"] } });
		const again = gateWith(() => ({
			behavior: "allow",
			updates: [{ type: "addRules", rules: ["Bash(npm test)"], behavior: "allow", destination: "localSettings" }],
		}));
		await again.gate.decide(bash("npm test"), "2");
		expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toEqual(["Bash(npm test)"]);
	});

	it("a setMode update switches the mode for the next call", async () => {
		const { gate, state } = gateWith(() => ({
			behavior: "allow",
			updates: [{ type: "setMode", mode: "acceptEdits" }],
		}));
		await gate.decide(write, "1");
		expect(state.current().mode).toBe("acceptEdits");
		expect(await gate.decide({ name: "Write", input: { file_path: "b.txt" } }, "2")).toEqual({ action: "run" });
	});

	it("refuses a deny or ask rule an answer adds with a ! exception, and keeps the rest", async () => {
		const { gate, state } = gateWith(() => ({
			behavior: "allow",
			updates: [
				{
					type: "addRules",
					rules: ["Read(!./ok.txt)", "Read(./secret.txt)"],
					behavior: "deny",
					destination: "session",
				},
				{ type: "addRules", rules: ["Read(!./ok.txt)"], behavior: "allow", destination: "session" },
			],
		}));
		await gate.decide(bash("npm test"), "1");
		const rules = state.current().rules;
		expect(rules.of("deny").map((rule) => rule.content)).toEqual(["./secret.txt"]);
		expect(rules.of("allow").map((rule) => rule.content)).toEqual(["!./ok.txt"]);
	});
});

describe("the terminal prompt", () => {
	function uiAnswering(
		choice: string | undefined,
		seen: { title?: string; options?: string[] } = {},
	): ExtensionUIContext {
		return {
			select: async (title: string, options: string[]) => {
				seen.title = title;
				seen.options = options;
				return choice === "FIRST_SUGGESTION" ? options[1] : choice;
			},
		} as unknown as ExtensionUIContext;
	}
	const request = (call = bash("npm test")): PermissionRequest => ({
		call,
		toolCallId: "1",
		message: "This command requires approval",
		suggestions: [
			{
				label: "Yes, and don't ask again for npm test in /p",
				update: { type: "addRules", rules: ["Bash(npm test)"], behavior: "allow", destination: "localSettings" },
			},
		],
	});

	it("offers Yes, the don't-ask-again choices, then No, in Claude Code's words", async () => {
		const seen: { title?: string; options?: string[] } = {};
		await createUiPrompter(uiAnswering(YES, seen))(request());
		expect(seen.options).toEqual([
			YES,
			"Yes, and don't ask again for npm test in /p",
			"No, and tell Claude what to do differently (esc)",
		]);
		expect(seen.title).toContain("npm test");
	});

	it("maps each choice to an answer", async () => {
		expect(await createUiPrompter(uiAnswering(YES))(request())).toEqual({ behavior: "allow" });
		const suggested = await createUiPrompter(uiAnswering("FIRST_SUGGESTION"))(request());
		expect(suggested).toMatchObject({ behavior: "allow", updates: [{ type: "addRules" }] });
		for (const choice of [NO, undefined]) {
			expect(await createUiPrompter(uiAnswering(choice))(request())).toMatchObject({
				behavior: "deny",
				message: expect.stringContaining("Permission for this tool use was denied"),
			});
		}
	});
});

describe("projecting pi's call onto rule names", () => {
	it("uses the model's tool names and file_path for the tools the surface covers", () => {
		expect(permissionCallFor("bash", { command: "ls" })).toEqual({ name: "Bash", input: { command: "ls" } });
		expect(permissionCallFor("edit", { path: "a.txt", edits: [] })).toEqual({
			name: "Edit",
			input: { file_path: "a.txt", edits: [] },
		});
		expect(permissionCallFor("write", { path: "a.txt", content: "" })).toEqual({
			name: "Write",
			input: { file_path: "a.txt", content: "" },
		});
		expect(permissionCallFor("read", { path: "a.txt" })).toEqual({ name: "Read", input: { file_path: "a.txt" } });
		expect(permissionCallFor("grep", { path: "src", pattern: "x" })).toEqual({
			name: "grep",
			input: { path: "src", pattern: "x" },
		});
		expect(permissionCallFor("mcp__s__t", { a: 1 })).toEqual({ name: "mcp__s__t", input: { a: 1 } });
	});
});

describe("flags", () => {
	it("splits --allowedTools entries on commas and spaces outside parentheses", () => {
		expect(splitToolList(["Bash(git commit -m x),Read Write", "Edit(/src/**)"])).toEqual([
			"Bash(git commit -m x)",
			"Read",
			"Write",
			"Edit(/src/**)",
		]);
	});

	it("builds the mode from --permission-mode, --dangerously-skip-permissions and settings, and the rules from flags and settings", () => {
		const setup = permissionSetup(
			{ allowedTools: ["Bash(ls:*)"], disallowedTools: ["Write", "Bash(rm:*)"] },
			{ permissions: { defaultMode: "plan", deny: ["mcp__s", "Read(./.env)"], additionalDirectories: ["/x"] } },
			["/y"],
			cwd,
		);
		expect(setup.init).toMatchObject({
			cwd,
			additionalDirectories: ["/x", "/y"],
			allowedTools: ["Bash(ls:*)"],
			disallowedTools: ["Write", "Bash(rm:*)"],
		});
		expect(setup.init.cliMode).toBeUndefined();
		expect(setup.deniedToolPatterns).toEqual(["mcp__s__*", "Write"]);
		expect(permissionSetup({ dangerouslySkipPermissions: true }, {}, [], cwd).init.cliMode).toBe("bypassPermissions");
		expect(permissionSetup({ permissionMode: "manual", permissionPrompts: "none" }, {}, [], cwd)).toMatchObject({
			init: { cliMode: "default" },
			prompts: "none",
		});
	});

	it("warns that auto mode has no classifier", () => {
		expect(permissionSetup({ permissionMode: "auto" }, {}, [], cwd).warnings).toHaveLength(1);
		expect(permissionSetup({}, { permissions: { defaultMode: "auto" } }, [], cwd).warnings).toHaveLength(1);
		expect(permissionSetup({ permissionMode: "plan" }, {}, [], cwd).warnings).toHaveLength(0);
	});
});
