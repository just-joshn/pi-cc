import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BREAKERS, type Breaker, holdsUnderBypass, isBypassImmune } from "../src/core/permissions/breakers.ts";
import { severity, strictest, type Verdict } from "../src/core/permissions/command-safety.ts";
import { type PermissionContext, type PermissionInit, PermissionState } from "../src/core/permissions/context.ts";
import { applyDontAsk, evaluatePermission } from "../src/core/permissions/evaluate.ts";
import type { PermissionMode } from "../src/core/permissions/mode.ts";
import { dangerousRemoval } from "../src/core/permissions/removal.ts";
import type { PermissionCall } from "../src/core/permissions/tool-checks.ts";

let cwd: string;
let home: string;

beforeEach(() => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-breakers-")));
	cwd = join(root, "work");
	home = join(root, "home");
	mkdirSync(join(cwd, "sub", "deep"), { recursive: true });
	mkdirSync(home);
});
afterEach(() => rmSync(join(cwd, ".."), { recursive: true, force: true }));

function context(mode: PermissionMode, init: Partial<PermissionInit> = {}): PermissionContext {
	return new PermissionState({ cwd, home, cliMode: mode, ...init }).current();
}

function evaluate(call: PermissionCall, mode: PermissionMode, init: Partial<PermissionInit> = {}) {
	const ctx = context(mode, init);
	const evaluation = evaluatePermission(call, ctx);
	return { ...evaluation, final: applyDontAsk(evaluation.decision, call, ctx) };
}

const bash = (command: string): PermissionCall => ({ name: "Bash", input: { command } });
const scope = () => ({ cwd, home, directories: [cwd], env: {} as Record<string, string | undefined> });
const removal = (command: string, env: Record<string, string | undefined> = {}) =>
	dangerousRemoval(command, { ...scope(), env });

describe("the breaker table", () => {
	it("is Claude Code's: five bypass-immune breakers and one that the operator may waive", () => {
		const immune = (Object.keys(BREAKERS) as Breaker[]).filter((name) => isBypassImmune(name)).sort();
		expect(immune).toEqual(
			["dangerousRemoval", "isolatePeerMachines", "outsideReadsBlocked", "restrictedMode", "unfinishedCheck"].sort(),
		);
		const waivable = (Object.keys(BREAKERS) as Breaker[]).filter((name) => BREAKERS[name].waivableInBypass);
		expect(waivable).toEqual(["dangerousRemoval"]);
	});

	it("holds an immune breaker under bypass, lets the waiver release only a removal, and never holds an ordinary one", () => {
		expect(holdsUnderBypass("dangerousRemoval", false)).toBe(true);
		expect(holdsUnderBypass("dangerousRemoval", true)).toBe(false);
		expect(holdsUnderBypass("outsideReadsBlocked", true)).toBe(true);
		expect(holdsUnderBypass("unfinishedCheck", true)).toBe(true);
		expect(holdsUnderBypass("backgroundOperator", false)).toBe(false);
		expect(holdsUnderBypass(undefined, false)).toBe(false);
	});
});

describe("verdict severity", () => {
	const verdicts: Verdict[] = [
		{ kind: "none" },
		{ kind: "allowed" },
		{ kind: "ask", tier: "approval" },
		{ kind: "ask", tier: "construct" },
		{ kind: "ask", tier: "path" },
		{ kind: "ask", tier: "safety", breaker: "backgroundOperator" },
		{ kind: "ask", tier: "safety", breaker: "dangerousRemoval" },
	];

	it("ranks each tier above the one before it, with a bypass-immune breaker on top", () => {
		const ranks = verdicts.map(severity);
		expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
		expect(new Set(ranks).size).toBe(ranks.length);
	});

	it("picks the same verdict whatever order the checks ran in", () => {
		const worst = verdicts.at(-1);
		for (let rotation = 0; rotation < verdicts.length; rotation++) {
			const rotated = [...verdicts.slice(rotation), ...verdicts.slice(0, rotation)];
			expect(strictest(rotated)).toBe(worst);
			expect(strictest([...rotated].reverse())).toBe(worst);
		}
	});
});

describe("dangerous removal targets", () => {
	it.each([
		"rm -rf .",
		"rm -rf ./",
		"rm -rf *",
		"rm -rf ./*",
		"rm -rf ..",
		"rm -rf ~",
		"rm -rf $HOME",
		"rm -rf /",
		"rm -rf /*",
		"rm -rf /etc",
		"rm -rf /usr",
		"rm -rf /tmp",
		"rm -rf sub/..",
		"rmdir .",
		"rm -r -f -- *",
		"sudo rm -rf /",
	])("refuses %s", (command) => {
		const found = removal(command);
		expect(found?.message, command).toMatch(/^Dangerous (?:rm|rmdir) operation detected/);
	});

	it("names a workspace directory or a critical system directory, as Claude Code does", () => {
		expect(removal("rm -rf .")?.message).toContain("would remove a workspace directory");
		expect(removal("rm -rf ..")?.message).toContain("would remove a workspace directory");
		expect(removal("rm -rf /etc")?.message).toContain("would remove a critical system directory");
		expect(removal("rm -rf ~")?.message).toContain("would remove a critical system directory");
		expect(removal("rm -rf /")?.message).toContain(`'/'\n\nThis command would remove a critical system directory.`);
	});

	it.each([
		"rm -rf sub/deep",
		"rm -rf sub/*",
		"rm -rf ~/x",
		"rm -rf $HOME/x",
		"rm -rf ../x",
		"rm -rf /usr/local",
		'rm -rf "$X"',
		"rm file.txt",
		"echo 'rm -rf .'",
		'echo "a; rm -rf ."',
		"xargs rm -rf .",
		"find . -delete",
		"cat <<EOF\nrm -rf .\nEOF",
	])("lets %s through", (command) => {
		expect(removal(command), command).toBeUndefined();
	});

	it.each([
		["{ rm -rf .; }", "group"],
		["(rm -rf *)", "subshell"],
		["echo $(rm -rf .)", "substitution"],
		["echo `rm -rf ..`", "backticks"],
		["for i in 1; do rm -rf *; done", "loop body"],
		["if true; then rm -rf .; fi", "conditional"],
		["bash -c 'rm -rf .'", "inline script"],
		["eval 'rm -rf .'", "eval"],
		["echo hi && (rm -rf *)", "later in a list"],
		["rm -rf . &", "background"],
	])("finds %s (%s)", (command) => {
		expect(removal(command)?.message, command).toContain("Dangerous rm operation detected");
	});

	it("refuses a glob after a directory change, a variable that may be empty, and a substitution as the target", () => {
		expect(removal("cd sub && rm -rf *")?.message).toContain("changes directories before the removal");
		expect(removal("rm -rf $X/")?.message).toContain("is a shell variable expansion");
		expect(removal("rm -rf $X/")?.message).toContain(['rewrite it as `"$', '{X:?}"/`'].join(""));
		expect(removal("rm -rf $X/usr")?.message).toContain("becomes `/usr`");
		expect(removal("rm -rf $(echo /)")?.message).toContain("output of a command substitution");
		expect(removal("rm -rf $X/", { X: "/some/dir" })).toBeUndefined();
	});
});

const brace = (inner: string) => ["$", "{", inner, "}"].join("");

describe("a removal target an earlier assignment in the line makes dangerous", () => {
	it.each([
		"X=/; rm -rf $X",
		"X=/usr; rm -rf $X",
		"X=/usr; rmdir $X",
		'X=/usr; rm -rf "$X"',
		"X=/usr; rm -rf $X/",
		"X=/usr && rm -rf $X",
		"X=/usr;\nrm -rf $X",
		"X=/usr; true; rm -rf $X",
		"export X=/usr; rm -rf $X",
		"local X=/usr; rm -rf $X",
		"readonly X=/usr; rm -rf $X",
		"declare X=/usr; rm -rf $X",
		"export X=/usr; export Y=1; rm -rf $X",
		"X=/; Y=$X; rm -rf $Y",
		"X=/; Y=$X/usr; rm -rf $Y",
		"X=/usr; X=/usr; rm -rf $X",
		"X=/usr; if true; then rm -rf $X; fi",
		"X=/usr; for i in 1; do rm -rf $X; done",
		"X=/usr; while false; do :; done; rm -rf $X",
		"X=/usr; echo x | rm -rf $X",
		"X=/usr; rm -rf $X | cat",
		"(X=/usr; rm -rf $X)",
		"X=/usr; echo $((1 + 1)); rm -rf $X",
		"X=/usr; echo $HOME; rm -rf $X",
		`X=/usr; echo 'a${brace("Y")}'; rm -rf $X`,
		"X=/usr; true || rm -rf $X",
		"X=/usr; bash -c 'rm -rf $X'",
		"X=/usr; echo hi && sudo rm -rf $X",
		"X=/usr; rm -rf $X; X=/lib",
	])("refuses %s", (command) => {
		const found = removal(command);
		expect(found?.message, command).toContain("would remove a critical system directory");
	});

	it("still reports a braced variable followed by a slash, which Claude Code does not follow", () => {
		for (const value of ["/", "/usr", "/tmp/scratch"]) {
			const found = removal(`X=${value}; rm -rf ${brace("X")}/`);
			expect(found?.message, value).toContain("is a shell variable expansion");
		}
	});

	it("names the expanded target, as Claude Code does", () => {
		expect(removal("X=/usr; rmdir $X")?.message).toContain("Dangerous rmdir operation detected: '/usr'");
		expect(removal("X=/; rm -rf $X")?.message).toContain(
			"Dangerous rm operation detected: '/'\n\nThis command would",
		);
	});

	it.each([
		"(X=/usr); rm -rf $X",
		"X=/usr; (rm -rf $X)",
		"X=/usr; (true); rm -rf $X",
		"(X=/usr; (rm -rf $X))",
		"X=/usr; echo a & rm -rf $X",
		"X=/usr; echo a{b,c}; rm -rf $X",
		"X=/usr || true; rm -rf $X",
		"true || X=/usr; rm -rf $X",
		"X=/usr | cat; rm -rf $X",
		"cat | X=/usr; rm -rf $X",
		"X=/usr & rm -rf $X",
		"X=/usr rm -rf $X",
		"echo hi; X=/usr; rm -rf $X",
		"export A=1; export X=/usr; rm -rf $X",
		"X=/usr; X=/tmp/scratch; rm -rf $X",
		"X=/tmp/scratch; X=/usr; rm -rf $X",
		"X=/usr; unset X; rm -rf $X",
		"X=/usr; read X; rm -rf $X",
		"X=/usr; for X in a; do rm -rf $X; done",
		"X=/usr; if true; then X=/lib; rm -rf $X; fi",
		"X=/usr; true || true; rm -rf $X",
		"X=/usr; { rm -rf $X; }",
		`X=/usr; echo ${brace("Y")}; rm -rf $X`,
		`X=/usr; rm -rf ${brace("X")}`,
		"X=/usr; echo $(date); rm -rf $X",
		'X=/usr; echo "$(date)"; rm -rf $X',
		"X=/usr; echo `date`; rm -rf $X",
		"X=/usr; cat <(:); rm -rf $X",
		"X=/usr; echo $FOO; rm -rf $X",
		'X=/usr; echo "$FOO"; rm -rf $X',
		"X=/usr; echo $?; rm -rf $X",
		"X=/usr; echo $PWD; rm -rf $X",
		"X=/usr; echo $'a'; rm -rf $X",
		"X=/usr; case a in a) rm -rf $X;; esac",
		"X=/usr; f() { :; }; rm -rf $X",
		'X="/ usr"; rm -rf $X',
		"X=/tmp/scratch; rm -rf $X",
		"X=/tmp/scratch; rm -rf $X/",
	])("lets %s through, because Claude Code cannot follow the variable there", (command) => {
		expect(removal(command), command).toBeUndefined();
	});
});

describe("a line with too many command substitutions", () => {
	const repeated = (piece: string, count: number, lead = "echo") => `${lead} ${Array(count).fill(piece).join(" ")}`;
	const message = (count: number) =>
		`This command contains ${count} command substitutions \u2014 too many to analyze for catastrophic removals. This requires explicit approval.`;

	it("asks once there are more than 64, with or without a removal", () => {
		expect(removal(repeated("$(:)", 65))?.message).toBe(message(65));
		expect(removal(repeated("$(:)", 65, "echo rmdir"))?.message).toBe(message(65));
		expect(removal(repeated("$(:)", 64))).toBeUndefined();
	});

	it("counts backticks, process substitutions, quoted and nested ones and function substitutions", () => {
		expect(removal(repeated("`:`", 65))?.message).toBe(message(65));
		expect(removal(repeated("<(:)", 65, "cat"))?.message).toBe(message(65));
		expect(removal(repeated(">(:)", 65, "tee"))?.message).toBe(message(65));
		expect(removal(repeated('"$(:)"', 65))?.message).toBe(message(65));
		expect(removal(repeated(brace(" :; "), 65))?.message).toBe(message(65));
		expect(removal(repeated("$(echo $(:))", 33))?.message).toBe(message(66));
		expect(removal(repeated("$(echo $(:))", 32))).toBeUndefined();
		expect(removal(`${repeated("`:`", 32)} ${repeated("$(:)", 32)} <(:) <(:)`)?.message).toBe(message(66));
	});

	it("does not count arithmetic, single-quoted text or a quoted here-document", () => {
		expect(removal(repeated("$((1 + 1))", 65))).toBeUndefined();
		expect(removal(`echo '${Array(65).fill("$(:)").join(" ")}'`)).toBeUndefined();
		expect(removal(`cat <<'EOF'\n${Array(65).fill("$(:)").join("\n")}\nEOF`)).toBeUndefined();
	});

	it("counts the substitutions in an unquoted here-document", () => {
		expect(removal(`cat <<EOF\n${Array(65).fill("$(:)").join("\n")}\nEOF`)?.message).toBe(message(65));
	});

	it("gives way to a variable that may be empty, which Claude Code checks first", () => {
		expect(removal(`${repeated("$(:)", 65)}; rm -rf $X/`)?.message).toContain("is a shell variable expansion");
	});

	it("is a bypass-immune dangerous-removal ask, and the waiver releases it", () => {
		const command = repeated("$(:)", 65);
		const held = evaluate(bash(command), "bypassPermissions", { allowedTools: ["Bash"] });
		expect(held.decision.behavior).toBe("ask");
		expect(held.decision.behavior === "ask" && held.decision.reason).toMatchObject({
			type: "safetyCheck",
			breaker: "dangerousRemoval",
		});
		expect(evaluate(bash(command), "bypassPermissions", { removalWaiverRequested: true }).decision.behavior).toBe(
			"allow",
		);
	});
});

describe("round 5 parser regressions", () => {
	it("counts substitutions through eight nested wrappers", () => {
		let command = `: ${Array(65).fill("$(:)").join(" ")}`;
		for (let depth = 1; depth <= 8; depth++) {
			command = `: $(${command})`;
			expect(removal(command)?.message).toContain(`contains ${65 + depth} command substitutions`);
		}
	});

	it("follows HOME in assignment values", () => {
		expect(removal("X=$HOME; rmdir $X")?.message).toContain(`'${home}'`);
	});

	it("checks commands substituted into an unquoted heredoc, not literal body text", () => {
		expect(removal("true <<EOF\n$(rmdir /usr)\nEOF")?.message).toContain("'/usr'");
		expect(removal("true <<'EOF'\n$(rmdir /usr)\nEOF")).toBeUndefined();
		expect(removal("true <<EOF\nrmdir /usr\nEOF")).toBeUndefined();
	});

	it.each(["X=/usr; rmdir '$X'", "X=/usr; rmdir \\$X"])("preserves literal dollars in %s", (command) => {
		expect(removal(command)).toBeUndefined();
	});

	it("keeps an absolute dot-dot spelling and checks it as a workspace ancestor", () => {
		const target = `${cwd}/missing/..`;
		expect(removal(`rmdir ${target}`)?.message).toBe(
			`Dangerous rmdir operation detected: '${target}'\n\nThis command would remove a workspace directory (the working directory, an additional working directory, or one of their parent directories). This requires explicit approval and cannot be auto-allowed by permission rules.`,
		);
	});

	it("does not treat assignment tilde as a known literal", () => {
		expect(removal("X=~; rmdir $X")).toBeUndefined();
	});
});

describe("what Claude Code does not read inside function bodies, case items and compound bodies", () => {
	it.each([
		"f() { rmdir /usr; }; true",
		"case one in one) rmdir /usr;; esac",
		"if true; then X=. & rmdir /usr; fi",
		"for Y in one; do X=. & rmdir *; done",
		"true <(X=. || rmdir $X/usr)",
		'(export X=/usr || rmdir "$X")',
		'local X=\\$HOME\nrmdir "$X"',
		`(typeset X=${brace("HOME")}; rmdir /usr)`,
	])("lets %s through", (command) => {
		expect(removal(command), command).toBeUndefined();
	});

	it.each([
		[`f() { X=.; rmdir ${brace("X")}/; }; true`, "is a shell variable expansion"],
		["{ X=.\nrmdir $X; }", "workspace directory"],
		["true $(export X=1 || rmdir $X/usr)", "(inside a command substitution)"],
		["readonly X=\\$HOME | rmdir $X/usr", "is a shell variable expansion"],
		[`true ${brace(" declare X=.; rmdir sub; ")}`, "could not be checked for dangerous rm operations"],
	])("still refuses %s", (command, text) => {
		expect(removal(command)?.message, command).toContain(text);
	});

	it("does not follow a variable set outside a group into it", () => {
		expect(removal("X=/usr; { rm -rf $X; }")).toBeUndefined();
	});
});

describe("a removal target in quotes", () => {
	it.each(['rm -rf "*"', "rm -rf '*'", "rmdir \\*", 'rm -rf "./*"', 'rm -rf "/*"'])("refuses %s", (command) => {
		expect(removal(command)?.message, command).toMatch(/^Dangerous (?:rm|rmdir) operation detected/);
	});

	it("explains a quoted trailing glob the way an unquoted one is explained", () => {
		expect(removal('rmdir "*/"')?.message).toContain("cannot be statically resolved");
		expect(removal("rmdir */")?.message).toContain("cannot be statically resolved");
	});

	it.each(['rm -rf "sub/*"', 'rm -f "*.txt"', "rm -f '*.txt'"])("lets %s through", (command) => {
		expect(removal(command), command).toBeUndefined();
	});

	it.each(['ls "*.txt"', 'cat "*.txt"', 'find . -name "*.txt"', "find . -name '*.txt'"])(
		"allows the quoted glob %s in default mode, as Claude Code does",
		(command) => {
			expect(evaluate(bash(command), "default").decision.behavior, command).toBe("allow");
		},
	);
});

describe("a dangerous removal against rules, modes and bypass", () => {
	const targets = ["rm -rf .", "rm -rf *", "rm -rf ~", "rm -rf /", "rm -rf /*", "rm -rf ..", "rm -rf /etc"];

	it.each(["default", "acceptEdits", "bypassPermissions", "plan"] as const)(
		"holds under %s even with a whole-tool allow",
		(mode) => {
			for (const command of targets) {
				const result = evaluate(bash(command), mode, { allowedTools: ["Bash"] });
				expect(result.decision.behavior, `${mode} ${command}`).toBe("ask");
				expect(result.stage, `${mode} ${command}`).toBe("modeHold");
				const decision = result.decision;
				if (mode !== "plan") {
					expect(decision.behavior === "ask" && decision.reason).toMatchObject({
						type: "safetyCheck",
						breaker: "dangerousRemoval",
					});
				}
			}
		},
	);

	it("holds against a prefix rule that names rm", () => {
		const result = evaluate(bash("rm -rf *"), "default", { allowedTools: ["Bash(rm:*)"] });
		expect(result.decision.behavior).toBe("ask");
	});

	it("becomes a dontAsk denial with the don't ask text", () => {
		const result = evaluate(bash("rm -rf ~"), "dontAsk", { allowedTools: ["Bash"] });
		expect(result.final.behavior).toBe("deny");
		expect(result.final.behavior === "deny" && result.final.message).toContain("don't ask mode");
	});

	it("still allows an ordinary removal under bypass and under acceptEdits", () => {
		for (const mode of ["bypassPermissions", "acceptEdits"] as const) {
			expect(evaluate(bash("rm -rf sub/deep"), mode).decision.behavior, mode).toBe("allow");
		}
	});

	it("is released under bypass by the operator's waiver, and by nothing narrower", () => {
		const waived = evaluate(bash("rm -rf ~"), "bypassPermissions", { removalWaiverRequested: true });
		expect(waived.decision.behavior).toBe("allow");
		expect(
			evaluate(bash("rm -rf ~"), "default", { removalWaiverRequested: true, allowedTools: ["Bash"] }).decision
				.behavior,
		).toBe("ask");
	});

	it.each([
		["a deny rule with content", { disallowedTools: ["Bash(curl:*)"] }],
		["an ask rule on Read", { settings: { ask: ["Read(/nope/*)"] } }],
		["the read block", { settings: { blockReadsOutsideWorkingDirectories: true } }],
	])("is not released when %s is in force", (_label, extra) => {
		const result = evaluate(bash("rm -rf ~"), "bypassPermissions", { removalWaiverRequested: true, ...extra });
		expect(result.decision.behavior).toBe("ask");
	});
});

describe("the read block", () => {
	const blocked = { settings: { blockReadsOutsideWorkingDirectories: true } } as const;

	it("refuses a Read outside the working directories with the path and directories in the text", () => {
		const result = evaluate({ name: "Read", input: { file_path: "/etc/hosts" } }, "bypassPermissions", blocked);
		expect(result.decision.behavior).toBe("deny");
		expect(result.decision.behavior === "deny" && result.decision.message).toBe(
			`/etc/hosts is outside ${cwd}; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`,
		);
	});

	it("reads inside the working directories as before", () => {
		const result = evaluate({ name: "Read", input: { file_path: join(cwd, "a.txt") } }, "default", blocked);
		expect(result.decision.behavior).toBe("allow");
	});

	it.each(["cat /etc/hosts", "ls /tmp", "grep -r foo /etc", "head -1 ~/x", "echo hi | cat /etc/hosts"])(
		"holds %s against bypass and a whole-tool allow",
		(command) => {
			const result = evaluate(bash(command), "bypassPermissions", { ...blocked, allowedTools: ["Bash"] });
			expect(result.decision.behavior, command).toBe("ask");
			expect(result.stage, command).toBe("modeHold");
			const decision = result.decision;
			expect(decision.behavior === "ask" && decision.reason).toMatchObject({
				type: "safetyCheck",
				breaker: "outsideReadsBlocked",
			});
		},
	);

	it("words a command it cannot analyze as Claude Code does", () => {
		for (const [command, text] of [
			["cat $X", "A variable in this command can't be checked before it runs"],
			["echo $(cat /etc/hosts)", "A nested command in this command can't be checked before it runs"],
		] as const) {
			const result = evaluate(bash(command), "bypassPermissions", blocked);
			const decision = result.decision;
			expect(decision.behavior, command).toBe("ask");
			expect(decision.behavior === "ask" && decision.message).toBe(
				`${text}; under the read block (permissions.blockReadsOutsideWorkingDirectories) a command the shell parser cannot analyze asks the person`,
			);
		}
	});

	it("names the part of a pipeline that needs approval", () => {
		const result = evaluate(bash("echo hi | cat /etc/hosts"), "bypassPermissions", blocked);
		const decision = result.decision;
		expect(decision.behavior === "ask" && decision.message).toBe(
			"This Bash command contains multiple operations. The following part requires approval: cat /etc/hosts",
		);
	});

	it("leaves a read inside the working directories alone", () => {
		expect(evaluate(bash("cat seed.txt"), "bypassPermissions", blocked).decision.behavior).toBe("allow");
	});

	it("does nothing when the setting is off", () => {
		expect(evaluate(bash("cat /etc/hosts"), "bypassPermissions").decision.behavior).toBe("allow");
	});
});

describe("a check that did not finish", () => {
	function brokenContext(mode: PermissionMode): PermissionContext {
		const ctx = context(mode, { allowedTools: ["Bash"] });
		const rules = {
			...ctx.rules,
			of: ctx.rules.of.bind(ctx.rules),
			wholeTool: ctx.rules.wholeTool.bind(ctx.rules),
			withContent: () => {
				throw new Error("rule store unavailable");
			},
		};
		return { ...ctx, rules: rules as unknown as PermissionContext["rules"] };
	}

	it("asks with Claude Code's text and is held against bypass", () => {
		for (const mode of ["default", "bypassPermissions"] as const) {
			const result = evaluatePermission(bash("echo hi"), brokenContext(mode));
			expect(result.decision.behavior, mode).toBe("ask");
			expect(result.decision.behavior === "ask" && result.decision.message).toBe(
				"The permission check for this command did not finish, so its safety checks did not run.",
			);
			expect(result.stage).toBe("modeHold");
		}
	});
});

describe("the background operator against grouped commands", () => {
	it("asks for a simple command that ends in & and holds against a whole-tool allow", () => {
		const result = evaluate(bash("echo hi & echo b"), "default", { allowedTools: ["Bash"] });
		expect(result.decision.behavior).toBe("ask");
		expect(result.stage).toBe("modeHold");
	});

	it("does not ask where Claude Code runs it: with a group, a substitution or a function body in the line", () => {
		for (const command of ["echo a & (echo b)", "(echo a &)", "{ echo a; } &", "f(){ echo F|cat& }; echo defined"]) {
			const result = evaluate(bash(command), "default", { allowedTools: ["Bash"] });
			expect(result.decision.behavior, command).toBe("allow");
		}
	});

	it("lets a bypass-held removal win over a group and over the operator, whichever the line puts first", () => {
		for (const command of ["{ rm -rf .; } &", "echo a & rm -rf .", "(echo a) & rm -rf *", "rm -rf . & (echo a)"]) {
			const result = evaluate(bash(command), "bypassPermissions", { allowedTools: ["Bash"] });
			const decision = result.decision;
			expect(decision.behavior, command).toBe("ask");
			expect(decision.behavior === "ask" && decision.message, command).toContain("Dangerous rm operation detected");
		}
	});

	it("lets a whole-tool allow run a settings-file write inside a group, as Claude Code does (measured)", () => {
		for (const command of ["{ echo x > ~/.claude/settings.json; }", "echo $(id) > .git/config"]) {
			expect(evaluate(bash(command), "default", { allowedTools: ["Bash"] }).decision.behavior, command).toBe(
				"allow",
			);
		}
	});
});
