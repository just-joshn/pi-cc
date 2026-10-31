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
		expect(parseCommand("echo hi >&-").writeTargets).toEqual([]);
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
		expect(check("ls &")).toMatchObject({
			behavior: "ask",
			safety: true,
			message: expect.stringContaining("background operator"),
		});
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
			behavior: "ask",
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

describe("redirections that name a file", () => {
	it("writes the word after >& unless it is a descriptor", () => {
		expect(parseCommand("echo hi >& pwn.txt").writeTargets).toEqual(["pwn.txt"]);
		expect(parseCommand("echo hi>&pwn.txt").writeTargets).toEqual(["pwn.txt"]);
		expect(parseCommand("echo hi &> pwn.txt").writeTargets).toEqual(["pwn.txt"]);
		expect(parseCommand("echo hi 2>&1 >&2").writeTargets).toEqual([]);
		expect(check("echo hi >& pwn.txt")).toMatchObject({
			behavior: "ask",
			message: expect.stringContaining("Output redirection to"),
		});
	});

	it("reads the word after <", () => {
		expect(parseCommand("cat < in.txt").readTargets).toEqual(["in.txt"]);
		expect(parseCommand("cat </dev/null").readTargets).toEqual([]);
		expect(parseCommand("cat <<< word").readTargets).toEqual([]);
		expect(check("cat < in.txt").behavior).toBe("allow");
		expect(check("cat < /etc/hosts")).toMatchObject({
			behavior: "ask",
			message: expect.stringMatching(/^Input redirection from '(\/private)?\/etc\/hosts' was blocked\./),
		});
	});
});

describe("options on a read-only command", () => {
	it("accepts only the options Claude Code lists", () => {
		expect(check("sort -r b.txt").behavior).toBe("allow");
		expect(check("sort -k 2,3 -t , b.txt").behavior).toBe("allow");
		expect(check("sort --compress-program=/usr/bin/true b.txt").behavior).toBe("ask");
		expect(check("sort -T /tmp b.txt").behavior).toBe("ask");
		expect(check("grep -rn --include=x a .").behavior).toBe("allow");
		expect(check("grep -A5 a b.txt").behavior).toBe("allow");
		expect(check("grep --no-such-option a b.txt").behavior).toBe("ask");
		expect(check("date +%s").behavior).toBe("allow");
		expect(check("date -s tomorrow").behavior).toBe("ask");
		expect(check("test -f b.txt").behavior).toBe("allow");
		expect(check("test -v HOME").behavior).toBe("ask");
	});

	it("keeps the value of a pattern option out of the path operands", () => {
		for (const command of ["grep --regexp=a /etc/hosts", "grep -e a /etc/hosts", "grep -f /etc/hosts b.txt"]) {
			expect(check(command), command).toMatchObject({
				behavior: "ask",
				message: expect.stringMatching(/^grep in '(\/private)?\/etc\/hosts' was blocked/),
			});
		}
		expect(check("grep --regexp=a b.txt").behavior).toBe("allow");
		expect(check("grep a b.txt").behavior).toBe("allow");
		expect(check("grep a /etc/hosts").behavior).toBe("ask");
	});

	it("reads only the paths before the first find expression", () => {
		expect(check("find . -name b.txt").behavior).toBe("allow");
		expect(check("find /etc -name b.txt").behavior).toBe("ask");
	});
});

describe("a path the file tools treat as sensitive", () => {
	it("asks before a shell command writes it, even under acceptEdits", () => {
		const sensitive = /sensitive file\.$/;
		for (const command of [
			"echo x > .git/config",
			"touch .vscode/settings.json",
			"rm .git/HEAD",
			"sed -i s/a/b/ .envrc",
		]) {
			expect(check(command, {}, true), command).toMatchObject({
				behavior: "ask",
				safety: true,
				message: expect.stringMatching(sensitive),
			});
		}
		expect(check("cp b.txt .claude/settings.json", {}, true)).toMatchObject({
			behavior: "ask",
			safety: true,
			message: expect.stringContaining("requested permissions to write to"),
		});
		expect(check("cp .git/config b.txt", {}, true).behavior).toBe("allow");
		expect(check("touch ok.txt", {}, true).behavior).toBe("allow");
	});
});

describe("a prefix rule", () => {
	it("does not allow the options that run programs or write files", () => {
		const allow = ["Bash(find:*)", "Bash(jq:*)", "Bash(awk:*)", "Bash(sort:*)"];
		expect(check("find . -name b.txt", { allow }).behavior).toBe("allow");
		for (const command of [
			"find . -name b.txt -delete",
			"find . -exec rm {} ;",
			"find . -fprint out.txt",
			"find . -name *.txt",
			"jq -f prog.jq b.txt",
			"jq 'system(\"id\")' b.txt",
			"awk 'BEGIN{system(\"id\")}'",
		]) {
			expect(check(command, { allow }), command).toMatchObject({ behavior: "ask" });
		}
		expect(check("find . -delete", { allow })).toMatchObject({
			message:
				"find with '-delete' executes commands or modifies files \u2014 cannot be auto-allowed by a Bash(find:*) prefix rule",
		});
		expect(check("sort -o out.txt b.txt", { allow }).behavior).toBe("allow");
	});

	it("still allows an exact rule for the same command", () => {
		expect(check("find . -delete", { allow: ["Bash(find . -delete)"] }).behavior).toBe("allow");
	});
});

describe("a command's safety verdict and what can clear it", () => {
	const unsafe = (command: string) => check(command, { allow: [`Bash(${command.split(" ")[0]}:*)`] });

	it("is computed with no rule and with a prefix rule alike", () => {
		for (const command of [
			"jq -n 'system(\"id\")'",
			"jq -f x.jq b.txt",
			"find . -name *.txt",
			"cat /etc/hosts",
			"cp b.txt ../out.txt",
			"touch ~/.zshrc",
			"cat $FOO",
			"rm *.zz",
			"grep --regexp=a /etc/hosts",
		]) {
			expect(check(command).behavior, command).toBe("ask");
			expect(unsafe(command).behavior, `${command} under a prefix rule`).toBe("ask");
		}
	});

	it("lets only an exact rule clear a dangerous option, never a path or a sensitive file", () => {
		expect(check("find . -delete", { allow: ["Bash(find . -delete)"] }).behavior).toBe("allow");
		expect(check("find . -delete", { allow: ["Bash(find . *)"] }).behavior).toBe("ask");
		expect(check("cat /etc/hosts", { allow: ["Bash(cat /etc/hosts)"] }).behavior).toBe("ask");
		expect(check("echo x > .git/config", { allow: ["Bash(echo x > .git/config)"] })).toMatchObject({
			behavior: "ask",
			safety: true,
		});
	});

	it("reads a redirection target and a word with the same unescaping", () => {
		expect(parseCommand("echo a > .gi\\t/config").writeTargets).toEqual([".git/config"]);
		expect(shellWords("echo a .gi\\t/config")[2]).toBe(".git/config");
		expect(parseCommand('echo a > ".gi\\t/config"').writeTargets).toEqual([".gi\\t/config"]);
		expect(check("echo a > .gi\\t/config", {}, true)).toMatchObject({ behavior: "ask", safety: true });
	});

	it("expands a leading tilde to the home directory for operands and redirection targets", () => {
		const home = "/nonexistent-home";
		const at = (command: string) =>
			checkBash({
				command,
				allow: [],
				ask: [],
				deny: [],
				acceptEdits: true,
				directories: [cwd],
				cwd,
				home,
			});
		expect(at("echo a > ~/.claude/settings.json")).toMatchObject({ behavior: "ask", safety: true });
		expect(at("echo a > ~/note.txt")).toMatchObject({
			behavior: "ask",
			safety: false,
			message: "Shell expansion syntax in paths requires manual approval",
		});
		expect(at("cat ~/note.txt")).toMatchObject({ behavior: "ask", message: expect.stringContaining("was blocked") });
	});

	it("keeps a glob read inside the working directories and refuses a glob write", () => {
		expect(check("ls *.txt").behavior).toBe("allow");
		expect(check("ls /etc/*.conf").behavior).toBe("ask");
		expect(check("rm *.zz", {}, true)).toMatchObject({
			behavior: "ask",
			message: "Glob patterns are not allowed in write operations. Please specify an exact file path.",
		});
	});
});

describe("whether an allowed command is read-only", () => {
	it("says so for the plan-mode floor", () => {
		expect(check("cat b.txt")).toMatchObject({ behavior: "allow", readOnly: true });
		expect(check("touch a", { allow: ["Bash(touch:*)"] })).toMatchObject({ behavior: "allow", readOnly: false });
		expect(check("echo a > f.txt", {}, true)).toMatchObject({ behavior: "allow", readOnly: false });
	});
});
