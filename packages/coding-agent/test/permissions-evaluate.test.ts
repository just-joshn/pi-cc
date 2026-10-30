import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionState, type SettingsPermissions } from "../src/core/permissions/context.ts";
import { applyDontAsk, evaluatePermission, STAGE_NAMES, type StageName } from "../src/core/permissions/evaluate.ts";
import type { PermissionMode } from "../src/core/permissions/mode.ts";
import type { PermissionCall } from "../src/core/permissions/tool-checks.ts";

let cwd: string;

beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-perm-")));
	mkdirSync(join(cwd, ".git"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function run(
	call: PermissionCall,
	options: {
		mode?: PermissionMode;
		settings?: SettingsPermissions;
		allowedTools?: string[];
		disallowedTools?: string[];
		useAutoModeDuringPlan?: boolean;
	} = {},
) {
	const state = new PermissionState({
		cwd,
		home: "/nonexistent-home",
		settings: options.settings,
		...(options.mode === undefined ? {} : { cliMode: options.mode }),
		allowedTools: options.allowedTools,
		disallowedTools: options.disallowedTools,
		...(options.useAutoModeDuringPlan === undefined ? {} : { useAutoModeDuringPlan: options.useAutoModeDuringPlan }),
	});
	const ctx = state.current();
	const evaluation = evaluatePermission(call, ctx);
	return { ...evaluation, final: applyDontAsk(evaluation.decision, call, ctx) };
}

const write = (file: string): PermissionCall => ({
	name: "Write",
	input: { file_path: join(cwd, file), content: "x" },
});
const bash = (command: string): PermissionCall => ({ name: "Bash", input: { command } });

function stageOf(result: { stage: StageName }): StageName {
	return result.stage;
}

describe("the pipeline's named stages", () => {
	it("lists the stages in the fixed order", () => {
		expect(STAGE_NAMES).toEqual([
			"denyRule",
			"askRule",
			"toolCheck",
			"modeHold",
			"bypassMode",
			"allowRule",
			"toolResult",
		]);
	});

	it("denyRule: a whole-tool deny rule beats an allow rule and bypassPermissions", () => {
		const result = run(write("a.txt"), {
			mode: "bypassPermissions",
			settings: { deny: ["Write"], allow: ["Write"] },
		});
		expect(stageOf(result)).toBe("denyRule");
		expect(result.decision.behavior).toBe("deny");
	});

	it("askRule: a whole-tool ask rule beats an allow rule and acceptEdits, with the tool's own message when it asks", () => {
		const result = run(write("a.txt"), { mode: "acceptEdits", settings: { ask: ["Write"], allow: ["Write"] } });
		expect(stageOf(result)).toBe("askRule");
		expect(result.decision).toMatchObject({
			behavior: "ask",
			message: "Claude requested permissions to use Write, but you haven't granted it yet.",
		});
	});

	it("askRule: the tool's own deny still wins over the ask rule", () => {
		const result = run(write("a.txt"), { settings: { ask: ["Write"], deny: ["Edit(./a.txt)"] } });
		expect(result.decision.behavior).toBe("deny");
	});

	it("toolCheck: a content deny rule inside the tool's check ends the pipeline before a whole-tool allow", () => {
		const result = run(bash("touch x"), { allowedTools: ["Bash"], settings: { deny: ["Bash(touch:*)"] } });
		expect(stageOf(result)).toBe("toolCheck");
		expect(result.decision).toMatchObject({
			behavior: "deny",
			message: "Permission to use Bash with command touch x has been denied.",
		});
	});

	it("modeHold: plan mode holds the tool's ask against a whole-tool allow rule", () => {
		const result = run(write("a.txt"), { mode: "plan", allowedTools: ["Write"] });
		expect(stageOf(result)).toBe("modeHold");
		expect(result.decision).toMatchObject({
			behavior: "ask",
			message: `Cannot write to ${join(cwd, "a.txt")} while in plan mode.`,
		});
	});

	it("modeHold: a content ask rule holds against bypassPermissions", () => {
		const result = run(bash("touch x"), { mode: "bypassPermissions", settings: { ask: ["Bash(touch:*)"] } });
		expect(stageOf(result)).toBe("modeHold");
		expect(result.decision.behavior).toBe("ask");
	});

	it("modeHold: a safety-check ask holds against an allow rule, but not against bypassPermissions", () => {
		expect(stageOf(run(write(".git/config"), { allowedTools: ["Write"] }))).toBe("modeHold");
		expect(run(write(".git/config"), { mode: "bypassPermissions" }).decision.behavior).toBe("allow");
	});

	it("bypassMode: allows what the tool left undecided, outside the working directory too", () => {
		const result = run(
			{ name: "Write", input: { file_path: "/tmp/pi-cc-outside.txt", content: "x" } },
			{ mode: "bypassPermissions" },
		);
		expect(stageOf(result)).toBe("bypassMode");
		expect(result.decision.behavior).toBe("allow");
	});

	it("allowRule: a whole-tool allow rule allows an ask nothing holds in place", () => {
		const result = run(write("a.txt"), { allowedTools: ["Write"] });
		expect(stageOf(result)).toBe("allowRule");
		expect(result.decision.behavior).toBe("allow");
	});

	it("toolResult: the tool's own allow stands, and no opinion asks", () => {
		expect(stageOf(run(write("a.txt"), { mode: "acceptEdits" }))).toBe("toolResult");
		expect(run(write("a.txt"), { mode: "acceptEdits" }).decision.behavior).toBe("allow");
		const other = run({ name: "mcp__s__t", input: {} });
		expect(other.decision).toMatchObject({
			behavior: "ask",
			message: "Claude requested permissions to use mcp__s__t, but you haven't granted it yet.",
		});
	});

	it("an MCP server rule covers every tool of the server in the deny and allow stages", () => {
		expect(run({ name: "mcp__s__t", input: {} }, { settings: { deny: ["mcp__s"] } }).decision.behavior).toBe("deny");
		expect(run({ name: "mcp__s__t", input: {} }, { allowedTools: ["mcp__s"] }).decision.behavior).toBe("allow");
	});
});

describe("modes", () => {
	it("default asks for a write inside the working directory", () => {
		expect(run(write("a.txt")).decision.behavior).toBe("ask");
	});

	it("acceptEdits allows edits inside the working directory but asks outside it and for sensitive files", () => {
		expect(run(write("a.txt"), { mode: "acceptEdits" }).decision.behavior).toBe("allow");
		expect(run(write("../outside.txt"), { mode: "acceptEdits" }).decision.behavior).toBe("ask");
		expect(run(write(".git/config"), { mode: "acceptEdits" }).decision).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining("which is a sensitive file"),
		});
	});

	it("dontAsk turns every ask into a denial and keeps allows", () => {
		const denied = run(write("a.txt"), { mode: "dontAsk" });
		expect(denied.final).toMatchObject({
			behavior: "deny",
			message: expect.stringContaining("running in don't ask mode"),
		});
		expect(run(write("a.txt"), { mode: "dontAsk", allowedTools: ["Write"] }).final.behavior).toBe("allow");
		writeFileSync(join(cwd, "r.txt"), "x");
		expect(run({ name: "Read", input: { file_path: join(cwd, "r.txt") } }, { mode: "dontAsk" }).final.behavior).toBe(
			"allow",
		);
	});
});

describe("path rules", () => {
	it("anchors /x at the working directory, //x at the root and ./x and bare names at the working directory", () => {
		const allow = (rule: string) =>
			run(write("src/a.txt"), { settings: { allow: [], ask: [] }, allowedTools: [rule] }).decision.behavior;
		expect(allow("Edit(/src/**)")).toBe("allow");
		expect(allow("Edit(./src/**)")).toBe("allow");
		expect(allow(`Edit(/${cwd}/src/**)`)).toBe("allow");
		expect(allow("Edit(/other/**)")).toBe("ask");
	});

	it("applies Read rules to reads and Read deny rules to edits of the same file", () => {
		writeFileSync(join(cwd, ".env"), "s");
		const read = run(
			{ name: "Read", input: { file_path: join(cwd, ".env") } },
			{ settings: { deny: ["Read(./.env)"] } },
		);
		expect(read.decision).toMatchObject({
			behavior: "deny",
			message: expect.stringContaining("denied by your permission settings"),
		});
		const edit = run(
			{ name: "Edit", input: { file_path: join(cwd, ".env"), old_string: "s", new_string: "t" } },
			{ settings: { deny: ["Read(./.env)"] } },
		);
		expect(edit.decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("Read deny rule") });
	});

	it("allows reads outside the working directory only with a Read allow rule", () => {
		const outside = { name: "Read", input: { file_path: "/etc/hosts" } };
		expect(run(outside).decision.behavior).toBe("ask");
		expect(run(outside, { allowedTools: ["Read(//etc/hosts)"] }).decision.behavior).toBe("allow");
	});
});

describe("plan mode and Bash", () => {
	const plan = { mode: "plan" as const, allowedTools: ["Bash"] };

	it("holds a command that is not read-only against a whole-tool allow rule", () => {
		for (const command of ["echo hi > f.txt", "touch t.txt", "npm test"]) {
			const result = run(bash(command), plan);
			expect(stageOf(result), command).toBe("modeHold");
			expect(result.decision, command).toMatchObject({
				behavior: "ask",
				message: "Cannot call Bash while in plan mode.",
			});
		}
	});

	it("holds it against a prefix allow rule and against bypassPermissions' allow", () => {
		expect(run(bash("touch t.txt"), { mode: "plan", allowedTools: ["Bash(touch:*)"] }).decision.behavior).toBe("ask");
	});

	it("runs a read-only command", () => {
		expect(run(bash("cat b.txt"), plan).decision.behavior).toBe("allow");
		expect(run(bash("ls | wc -l"), { mode: "plan" }).decision.behavior).toBe("allow");
	});

	it("still refuses a denied command", () => {
		expect(run(bash("rm a"), { ...plan, settings: { deny: ["Bash(rm:*)"] } }).decision.behavior).toBe("deny");
	});

	it("runs the allow rule when settings turn off auto mode during plan", () => {
		expect(run(bash("echo hi > f.txt"), { ...plan, useAutoModeDuringPlan: false }).decision.behavior).toBe("allow");
	});
});

describe("a shell write to a sensitive path", () => {
	it("holds against a whole-tool allow rule and acceptEdits, and yields to bypassPermissions", () => {
		const held = run(bash("echo x > .git/config"), { mode: "acceptEdits", allowedTools: ["Bash"] });
		expect(stageOf(held)).toBe("modeHold");
		expect(held.decision).toMatchObject({ behavior: "ask", message: expect.stringContaining("sensitive file") });
		expect(run(bash("echo x > .git/config"), { mode: "bypassPermissions" }).decision.behavior).toBe("allow");
	});
});

describe("a write through a symbolic link", () => {
	it("refuses a dangling link and names where it leads", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-outside-")));
		try {
			symlinkSync(join(outside, "target.txt"), join(cwd, "link"));
			const result = run(write("link"), { mode: "acceptEdits" });
			expect(result.decision).toMatchObject({
				behavior: "deny",
				message: `Refusing to write ${join(cwd, "link")}: it is a symbolic link. Write to the link's target path instead: ${join(outside, "target.txt")}.`,
			});
			expect(
				run(
					{ name: "Write", input: { file_path: join(outside, "target.txt"), content: "x" } },
					{ mode: "acceptEdits" },
				).decision.behavior,
			).toBe("ask");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("follows a chain of dangling links out of the working directory", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-outside-")));
		try {
			symlinkSync(join(outside, "gone"), join(cwd, "hop"));
			symlinkSync("hop", join(cwd, "link"));
			const result = run(
				{ name: "Write", input: { file_path: join(cwd, "link", "x.txt"), content: "x" } },
				{ mode: "acceptEdits" },
			);
			expect(result.decision.behavior).toBe("ask");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
