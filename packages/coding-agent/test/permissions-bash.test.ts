import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BashCheck, checkBash, matchRule, parseCommand, shellWords } from "../src/core/permissions/bash.ts";
import { rulesFromTexts } from "../src/core/permissions/rules.ts";

let cwd: string;
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-bash-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function check(
	command: string,
	rules: { allow?: string[]; ask?: string[]; deny?: string[] } = {},
	acceptEdits = false,
): BashCheck {
	return checkBash({
		command,
		allow: rulesFromTexts(rules.allow ?? [], "allow", "session"),
		ask: rulesFromTexts(rules.ask ?? [], "ask", "session"),
		deny: rulesFromTexts(rules.deny ?? [], "deny", "session"),
		acceptEdits,
		directories: [cwd],
		cwd,
	});
}

describe("splitting a command line", () => {
	it("splits at &&, ||, ;, | and newlines outside quotes", () => {
		expect(parseCommand("a && b || c; d | e\nf").parts).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(parseCommand("echo 'a && b' \"c; d\"").parts).toEqual(["echo 'a && b' \"c; d\""]);
	});

	it("flags substitution, grouping and backgrounding, and ignores them inside single quotes", () => {
		expect(parseCommand("echo $(pwd)").nested).toBe(true);
		expect(parseCommand("echo `pwd`").nested).toBe(true);
		expect(parseCommand("echo '$(pwd)'").nested).toBe(false);
		expect(parseCommand("(ls)").grouped).toBe(true);
		expect(parseCommand("sleep 1 &").background).toBe(true);
		expect(parseCommand("a && b").background).toBe(false);
	});

	it("collects the files a redirection writes and skips /dev/null, descriptors and input", () => {
		expect(parseCommand("echo a > f.txt").writeTargets).toEqual(["f.txt"]);
		expect(parseCommand("echo a >> f.txt").writeTargets).toEqual(["f.txt"]);
		expect(parseCommand("ls > /dev/null 2>&1").writeTargets).toEqual([]);
		expect(parseCommand("cat < in.txt").writeTargets).toEqual([]);
	});

	it("finds a redirection glued to its word, to a descriptor or to an ampersand", () => {
		expect(parseCommand("echo hi>/tmp/x").writeTargets).toEqual(["/tmp/x"]);
		expect(parseCommand("echo hi>>/tmp/x").writeTargets).toEqual(["/tmp/x"]);
		expect(parseCommand("echo hi 2>/tmp/err").writeTargets).toEqual(["/tmp/err"]);
		expect(parseCommand("echo hi &>/tmp/x").writeTargets).toEqual(["/tmp/x"]);
		expect(parseCommand("echo hi >|/tmp/x").writeTargets).toEqual(["/tmp/x"]);
		expect(parseCommand("echo hi 2>&1").writeTargets).toEqual([]);
		expect(parseCommand("echo hi >&2").writeTargets).toEqual([]);
		expect(parseCommand("echo hi>/tmp/x").parts).toEqual(["echo hi"]);
		expect(parseCommand("cat <<EOF>/tmp/x").heredoc).toBe(true);
	});

	it("lists the commands hiding inside substitutions, groups and blocks", () => {
		expect(parseCommand("echo $(rm a)").looseParts).toContain("rm a");
		expect(parseCommand("echo `rm a`").looseParts).toContain("rm a");
		expect(parseCommand("(rm a)").looseParts).toContain("rm a");
		expect(parseCommand("{ rm a; }").looseParts).toContain("rm a");
		expect(parseCommand("echo '$(rm a)'").looseParts).toEqual(["echo '$(rm a)'"]);
	});

	it("reads shell words with quotes and escapes removed", () => {
		expect(shellWords("git commit -m 'a b' \"c d\" e\\ f")).toEqual(["git", "commit", "-m", "a b", "c d", "e f"]);
	});
});

describe("matching a rule against a command as written", () => {
	const allow = rulesFromTexts(["Bash(echo:*)"], "allow", "session");
	const deny = rulesFromTexts(["Bash(rm:*)"], "deny", "session");

	it("matches a prefix rule on the bare command and on it followed by arguments", () => {
		expect(matchRule(allow, "echo")).toBeDefined();
		expect(matchRule(allow, "echo hi")).toBeDefined();
		expect(matchRule(allow, "echoes")).toBeUndefined();
	});

	it("does not let an allow rule cover an absolute path, an env prefix, a wrapper or a backslash spelling", () => {
		for (const spelling of ["/bin/echo hi", "FOO=1 echo hi", "time echo hi", "\\echo hi", "env echo hi"]) {
			expect(matchRule(allow, spelling), spelling).toBeUndefined();
		}
	});

	it("lets a deny rule see through quotes, env assignments and wrappers", () => {
		for (const spelling of [
			"rm a",
			"FOO=1 rm a",
			"time rm a",
			"env rm a",
			"nice -n 5 rm a",
			"timeout 5 rm a",
			"'rm' a",
			'"rm" a',
			"\\rm a",
			"sudo rm a",
			"doas rm a",
		]) {
			expect(matchRule(deny, spelling), spelling).toBeDefined();
		}
	});

	it("separates exact, prefix and wildcard rules", () => {
		const rules = (text: string) => rulesFromTexts([text], "allow", "session");
		expect(matchRule(rules("Bash(git status)"), "git status")).toBeDefined();
		expect(matchRule(rules("Bash(git status)"), "git status -s")).toBeUndefined();
		expect(matchRule(rules("Bash(git *)"), "git push origin")).toBeDefined();
		expect(matchRule(rules("Bash(git *)"), "gitk")).toBeUndefined();
		expect(matchRule(rules("Bash(npm run test:*)"), "npm run test -- -t x")).toBeDefined();
		expect(matchRule(rules("Bash(npm run test:*)"), "npm run build")).toBeUndefined();
	});
});

describe("checking a command", () => {
	it("allows an allow-ruled command and every part of a compound only when each part is covered", () => {
		expect(check("touch a", { allow: ["Bash(touch:*)"] }).behavior).toBe("allow");
		expect(check("touch a && touch b", { allow: ["Bash(touch:*)"] }).behavior).toBe("allow");
		const partial = check("touch a && npm test", { allow: ["Bash(touch:*)"] });
		expect(partial).toMatchObject({
			behavior: "ask",
			message: "This Bash command contains multiple operations. The following part requires approval: npm test",
		});
	});

	it("allows read-only commands and asks for the rest with Claude Code's text", () => {
		expect(check("ls").behavior).toBe("allow");
		expect(check("cat b.txt | wc -l").behavior).toBe("allow");
		expect(check("git status").behavior).toBe("allow");
		expect(check("git branch -D x")).toMatchObject({ behavior: "ask", message: "This command requires approval" });
		expect(check("find . -delete")).toMatchObject({ behavior: "ask" });
		expect(check("npm test")).toMatchObject({ behavior: "ask", message: "This command requires approval" });
	});

	it("does not treat a wrapped or absolute read-only command as read-only", () => {
		for (const command of ["/bin/ls", "FOO=1 ls", "time ls", "timeout 5 ls", "env ls"]) {
			expect(check(command).behavior, command).toBe("ask");
		}
	});

	it("asks about commands it cannot see into", () => {
		expect(check("echo $(pwd)")).toMatchObject({
			behavior: "ask",
			message: "A nested command in this command can't be checked before it runs",
		});
		expect(check("(ls)")).toMatchObject({
			behavior: "ask",
			message: "This command uses shell operators that require approval for safety",
		});
		expect(check("ls &")).toMatchObject({ behavior: "ask", message: expect.stringContaining("background operator") });
	});

	it("denies a deny-ruled part of a compound and names the whole command", () => {
		expect(check("ls && rm a", { deny: ["Bash(rm:*)"] })).toMatchObject({
			behavior: "deny",
			message: "Permission to use Bash with command ls && rm a has been denied.",
		});
	});

	it("lets an ask rule ask without a message of its own", () => {
		expect(check("touch a", { ask: ["Bash(touch:*)"], allow: ["Bash(touch:*)"] })).toMatchObject({
			behavior: "ask",
			message: undefined,
		});
	});

	it("denies a denied command that hides in a substitution, a group or a block", () => {
		for (const command of ["echo $(rm a)", "echo `rm a`", "(rm a)", "{ rm a; }", "ls && (sudo rm a)"]) {
			expect(check(command, { deny: ["Bash(rm:*)"] }).behavior, command).toBe("deny");
		}
	});

	it("asks, rather than allows, for a glued redirection and a here-document", () => {
		expect(check("echo hi>/tmp/x")).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining("Output redirection to"),
		});
		expect(check("cat <<EOF>/tmp/x")).toMatchObject({ behavior: "ask" });
	});

	it("does not call a command read-only when an option makes it write", () => {
		for (const command of [
			"sed -n 'w /tmp/x' b.txt",
			"sed -n -e 'w /tmp/x'",
			"sort -o/tmp/x b.txt",
			"sort --output=/tmp/x b.txt",
			"git diff --output=/tmp/x",
			"git branch -Dfoo",
			"tree -o /tmp/x",
		]) {
			expect(check(command).behavior, command).toBe("ask");
		}
		expect(check("sed -n 1,3p b.txt").behavior).toBe("allow");
		expect(check("git branch -a").behavior).toBe("allow");
	});

	it("blocks a read-only command on a path outside the working directories", () => {
		expect(check("cat /etc/hosts")).toMatchObject({
			behavior: "deny",
			message: expect.stringMatching(
				/^cat in '(\/private)?\/etc\/hosts' was blocked\. For security, Claude Code may only concatenate files from the allowed working directories/,
			),
		});
	});

	it("asks before a file command and allows it inside the working directory under acceptEdits", () => {
		expect(check("touch x.txt")).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining(`touch in '${join(cwd, "x.txt")}' needs approval`),
		});
		expect(check("touch x.txt", {}, true).behavior).toBe("allow");
		expect(check("mkdir d && rm -rf d", {}, true).behavior).toBe("allow");
		expect(check("touch ../x.txt", {}, true)).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining("outside the working directories"),
		});
		expect(check("echo a > f.txt", {}, true).behavior).toBe("allow");
		expect(check("echo a > f.txt")).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining("Output redirection to"),
		});
	});

	it("does not auto-allow sed that edits in place outside acceptEdits, but allows sed -n as read-only", () => {
		expect(check("sed -n 1p b.txt").behavior).toBe("allow");
		expect(check("sed -i s/a/b/ b.txt").behavior).toBe("ask");
	});
});
