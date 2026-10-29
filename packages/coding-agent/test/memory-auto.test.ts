import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	isAutoMemoryEnabled,
	projectSlug,
	resolveAutoMemoryDir,
	truncateMemoryIndex,
} from "../src/core/memory/auto-memory.ts";
import { discoverMemory, resolveMemoryLocation } from "../src/core/memory/discover.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-auto-memory-")));
	tempDirs.push(root);
	return root;
}

describe("enablement", () => {
	test("CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy turns it off, falsy forces it on", () => {
		for (const value of ["1", "true", "YES", "on"]) {
			expect(isAutoMemoryEnabled({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: value }, { autoMemoryEnabled: true })).toBe(
				false,
			);
		}
		for (const value of ["0", "false", "no", "OFF"]) {
			expect(isAutoMemoryEnabled({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: value }, { autoMemoryEnabled: false })).toBe(
				true,
			);
		}
	});

	test("otherwise follows autoMemoryEnabled, on by default", () => {
		expect(isAutoMemoryEnabled({}, {})).toBe(true);
		expect(isAutoMemoryEnabled({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "maybe" }, {})).toBe(true);
		expect(isAutoMemoryEnabled({}, { autoMemoryEnabled: false })).toBe(false);
	});
});

describe("directory", () => {
	test("defaults to <configDir>/projects/<slug>/memory/ keyed by cwd outside a repository", () => {
		const root = tempRoot();
		const cwd = join(root, "x", "workspace");
		mkdirSync(cwd, { recursive: true });
		expect(resolveAutoMemoryDir("/cfg", cwd, "/home", {})).toBe(
			`/cfg/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/memory/`,
		);
	});

	test("is keyed by the repository's main checkout, shared by its worktrees and subdirectories", () => {
		const root = tempRoot();
		const main = join(root, "main");
		const worktree = join(root, "feature");
		const worktreeGitDir = join(main, ".git", "worktrees", "feature");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(join(main, "src"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(worktreeGitDir, "commondir"), "../..");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		const expected = `/cfg/projects/${projectSlug(main)}/memory/`;
		expect(resolveAutoMemoryDir("/cfg", join(main, "src"), "/home", {})).toBe(expected);
		expect(resolveAutoMemoryDir("/cfg", worktree, "/home", {})).toBe(expected);
	});

	test("autoMemoryDirectory wins when it is a usable absolute path", () => {
		expect(resolveAutoMemoryDir("/cfg", "/w", "/home/u", { autoMemoryDirectory: "~/notes" })).toBe("/home/u/notes/");
		expect(resolveAutoMemoryDir("/cfg", "/w", "/home/u", { autoMemoryDirectory: "/mem//" })).toBe("/mem/");
		for (const bad of ["relative/dir", "/", "/a\0b", 42]) {
			expect(resolveAutoMemoryDir("/cfg", "/w", "/home/u", { autoMemoryDirectory: bad })).toBe(
				"/cfg/projects/-w/memory/",
			);
		}
	});

	test("a slug over 200 characters keeps its first 200 and a Java string hash in base 36", () => {
		const key = `/${"segment/".repeat(40)}end`;
		const slug = projectSlug(key);
		expect(slug).toBe(`${key.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-${javaHashBase36(key)}`);
		expect(projectSlug("/short/path")).toBe("-short-path");
	});
});

describe("MEMORY.md", () => {
	test("keeps the first 200 lines and says what was cut", () => {
		const lines = Array.from({ length: 259 }, (_, index) => `AM_LINE_${index + 1}`);
		const result = truncateMemoryIndex(lines.join("\n"));
		const [kept, note] = result.split("\n\n> ");
		expect(kept).toBe(lines.slice(0, 200).join("\n"));
		expect(note).toMatch(/259 lines/);
		expect(note).toMatch(/200 lines/);
		expect(note).toMatch(/59 lines from line 201/);
		expect(note).not.toContain("\n");
		expect(result).not.toContain("AM_LINE_201");
	});

	test("cuts at the last line break before 25000 characters", () => {
		const lines = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(296)}`);
		const result = truncateMemoryIndex(lines.join("\n"));
		const [kept, note] = result.split("\n\n> ");
		expect(kept).toBe(lines.slice(0, 83).join("\n"));
		expect(note).toMatch(/17 lines from line 84/);
	});

	test("short content is only trimmed", () => {
		expect(truncateMemoryIndex("\n- one\n- two\n\n")).toBe("- one\n- two");
	});

	test("loads last, with frontmatter stripped and no imports followed", () => {
		const root = tempRoot();
		const config = join(root, "config");
		const cwd = join(root, "workspace");
		const memoryDir = join(root, "mem");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(cwd, "CLAUDE.md"), "project");
		writeFileSync(join(memoryDir, "MEMORY.md"), "---\nname: index\n---\n- [fact](fact.md) @fact.md");
		writeFileSync(join(memoryDir, "fact.md"), "fact");

		const location = resolveMemoryLocation({
			cwd,
			home: join(root, "home"),
			env: { CLAUDE_CONFIG_DIR: config },
			platform: "freebsd",
			values: { autoMemoryDirectory: memoryDir },
			settingSources: undefined,
			projectTrusted: true,
			disabled: false,
		});
		const snapshot = discoverMemory(location);

		expect(snapshot.autoMemoryDir).toBe(`${memoryDir}/`);
		expect(snapshot.files.map((file) => [file.path, file.type, file.content])).toEqual([
			[join(cwd, "CLAUDE.md"), "project", "project"],
			[join(memoryDir, "MEMORY.md"), "auto", "- [fact](fact.md) @fact.md"],
		]);
		const off = discoverMemory({ ...location, autoMemory: undefined });
		expect(off.autoMemoryDir).toBeUndefined();
		expect(off.files.map((file) => file.type)).toEqual(["project"]);
	});
});

function javaHashBase36(value: string): string {
	let hash = 0n;
	for (const unit of Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))) {
		hash = BigInt.asIntN(32, hash * 31n + BigInt(unit));
	}
	return (hash < 0n ? -hash : hash).toString(36);
}
