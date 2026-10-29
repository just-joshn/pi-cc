import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	discoverMemory,
	type MemoryFile,
	type MemoryLocation,
	memoryForFileAccess,
	resolveMemoryLocation,
} from "../src/core/memory/discover.ts";
import { renderMemoryReminder, renderNestedReminder } from "../src/core/memory/wrapper.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Side {
	root: string;
	home: string;
	config: string;
	managed: string;
	parent: string;
	workspace: string;
}

function side(): Side {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-")));
	tempDirs.push(root);
	const parent = join(root, "parent");
	const parts = {
		root,
		home: join(root, "home"),
		config: join(root, "config"),
		managed: join(root, "managed"),
		parent,
		workspace: join(parent, "workspace"),
	};
	for (const dir of [parts.home, parts.config, parts.managed, parts.workspace]) mkdirSync(dir, { recursive: true });
	return parts;
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function location(parts: Side, overrides: Partial<MemoryLocation> = {}): MemoryLocation {
	return {
		cwd: parts.workspace,
		home: parts.home,
		configDir: parts.config,
		managedDir: undefined,
		sources: { user: true, project: true, local: true },
		excludes: [],
		autoMemory: undefined,
		disabled: false,
		...overrides,
	};
}

function paths(files: readonly MemoryFile[]): string[] {
	return files.map((file) => file.path);
}

describe("startup order", () => {
	test("managed, user, each directory from the top down to cwd, then auto memory", () => {
		const parts = side();
		const ws = parts.workspace;
		write(join(parts.managed, "CLAUDE.md"), "managed");
		write(join(parts.managed, ".claude", "rules", "policy.md"), "managed rule");
		write(join(parts.config, "CLAUDE.md"), "user @extra.md");
		write(join(parts.config, "extra.md"), "user import");
		write(join(parts.config, "rules", "style.md"), "user rule");
		write(join(parts.parent, "CLAUDE.md"), "parent");
		write(join(ws, "CLAUDE.md"), "project");
		write(join(ws, ".claude", "CLAUDE.md"), "dot claude");
		write(join(ws, ".claude", "rules", "unit.md"), "project rule");
		write(join(ws, "CLAUDE.local.md"), "local");
		write(join(parts.root, "mem", "MEMORY.md"), "- [fact](fact.md)");

		const snapshot = discoverMemory(
			location(parts, { managedDir: parts.managed, autoMemory: { dir: `${join(parts.root, "mem")}/` } }),
		);

		expect(snapshot.files.map((file) => [file.path, file.type])).toEqual([
			[join(parts.managed, "CLAUDE.md"), "managed"],
			[join(parts.managed, ".claude", "rules", "policy.md"), "managed"],
			[join(parts.config, "CLAUDE.md"), "user"],
			[join(parts.config, "extra.md"), "user"],
			[join(parts.config, "rules", "style.md"), "user"],
			[join(parts.parent, "CLAUDE.md"), "project"],
			[join(ws, "CLAUDE.md"), "project"],
			[join(ws, ".claude", "CLAUDE.md"), "project"],
			[join(ws, ".claude", "rules", "unit.md"), "project"],
			[join(ws, "CLAUDE.local.md"), "local"],
			[join(parts.root, "mem", "MEMORY.md"), "auto"],
		]);
		expect(snapshot.autoMemoryDir).toBe(`${join(parts.root, "mem")}/`);
	});

	test("the reminder wraps one labelled section per file after a preamble", () => {
		const parts = side();
		write(join(parts.workspace, "CLAUDE.md"), "\n  project rule  \n");
		write(join(parts.workspace, "CLAUDE.local.md"), "local rule");

		const reminder = renderMemoryReminder(discoverMemory(location(parts)).files);

		const project = join(parts.workspace, "CLAUDE.md");
		const local = join(parts.workspace, "CLAUDE.local.md");
		expect(reminder.startsWith("<system-reminder>\n")).toBe(true);
		expect(reminder.endsWith("\n</system-reminder>")).toBe(true);
		expect(reminder).toMatch(
			new RegExp(
				`\\n\\nContents of ${escapeRegExp(project)} \\([^()\\n]+\\):\\n\\nproject rule\\n\\nContents of ${escapeRegExp(local)} \\([^()\\n]+\\):\\n\\nlocal rule\\n</system-reminder>$`,
			),
		);
		expect(renderMemoryReminder([])).toBe("");
	});

	test("every type has its own label", () => {
		const labels = (["managed", "user", "project", "local", "auto"] as const).map(
			(type) =>
				renderMemoryReminder([{ path: "/x", type, content: "c" }]).match(/Contents of \/x \(([^)]+)\):/)?.[1],
		);
		expect(new Set(labels).size).toBe(5);
		expect(labels.every((label) => label !== undefined)).toBe(true);
	});

	test("frontmatter and comment-only blocks are stripped; a file left empty is dropped with its imports", () => {
		const parts = side();
		write(join(parts.workspace, "CLAUDE.md"), "---\ndescription: x\n---\n<!-- hidden -->\n\nbody <!-- inline -->\n");
		write(join(parts.workspace, "CLAUDE.local.md"), "<!-- only a comment @a.md -->\n");
		write(join(parts.workspace, "a.md"), "never");

		const files = discoverMemory(location(parts)).files;

		expect(files.map((file) => [file.path, file.content.trim()])).toEqual([
			[join(parts.workspace, "CLAUDE.md"), "body <!-- inline -->"],
		]);
	});

	test("AGENTS.md is not memory", () => {
		const parts = side();
		write(join(parts.workspace, "AGENTS.md"), "agents");
		expect(discoverMemory(location(parts)).files).toEqual([]);
	});
});

describe("imports", () => {
	test("follow Markdown structure and the path grammar", () => {
		const parts = side();
		const ws = parts.workspace;
		const body = [
			"foo@bar.md (@q.md) [link](@g.md) \\@e.md @dir @missing.md",
			"> quote @d.md",
			"- list @l.md",
			"# head @f.md",
			"",
			"*@h.md* @p.md. @i.md, @t.txt @j.json @k.png @sub/../s.md @frag.md#part",
			"",
			"```",
			"@code.md",
			"```",
			"",
			"    @indented.md",
			"",
			"`@span.md`",
			"",
			"<div>",
			"@html.md",
			"</div>",
			"",
		].join("\n");
		write(join(ws, "CLAUDE.md"), body);
		for (const name of [
			"bar.md",
			"q.md",
			"g.md",
			"e.md",
			"d.md",
			"l.md",
			"f.md",
			"h.md",
			"p.md",
			"i.md",
			"t.txt",
			"j.json",
			"k.png",
			"s.md",
			"frag.md",
			"code.md",
			"indented.md",
			"span.md",
			"html.md",
		]) {
			write(join(ws, name), name);
		}
		mkdirSync(join(ws, "dir"));

		const files = discoverMemory(location(parts)).files;

		expect(paths(files)).toEqual(
			["CLAUDE.md", "d.md", "l.md", "f.md", "h.md", "t.txt", "j.json", "s.md", "frag.md"].map((name) =>
				join(ws, name),
			),
		);
		expect(files.slice(1).every((file) => file.parent === join(ws, "CLAUDE.md") && file.type === "project")).toBe(
			true,
		);
	});

	test("land right after their importer, depth first, up to four hops, each file once", () => {
		const parts = side();
		const ws = parts.workspace;
		write(join(ws, "CLAUDE.md"), "@h1.md @b.md");
		write(join(ws, "h1.md"), "@h2.md");
		write(join(ws, "h2.md"), "@h3.md");
		write(join(ws, "h3.md"), "@h4.md");
		write(join(ws, "h4.md"), "@h5.md @CLAUDE.md");
		write(join(ws, "h5.md"), "too deep");
		write(join(ws, "b.md"), "@h1.md");
		write(join(ws, "CLAUDE.local.md"), "@b.md");

		expect(paths(discoverMemory(location(parts)).files)).toEqual(
			["CLAUDE.md", "h1.md", "h2.md", "h3.md", "h4.md", "b.md", "CLAUDE.local.md"].map((name) => join(ws, name)),
		);
	});

	test("project memory never imports outside cwd; user memory may", () => {
		const parts = side();
		const ws = parts.workspace;
		write(join(parts.root, "outside.md"), "outside");
		write(join(parts.home, "homefile.md"), "home");
		write(join(parts.parent, "sibling.md"), "sibling");
		write(join(ws, "in.md"), "inside");
		write(join(ws, "CLAUDE.md"), "@../../outside.md @~/homefile.md");
		write(join(parts.parent, "CLAUDE.md"), "@sibling.md @workspace/in.md");
		write(join(parts.config, "CLAUDE.md"), `@${join(parts.root, "outside.md")}`);
		symlinkSync(join(parts.root, "outside.md"), join(ws, "link.md"));
		write(join(ws, "CLAUDE.local.md"), "@link.md");

		expect(discoverMemory(location(parts)).files.map((file) => [file.path, file.type])).toEqual([
			[join(parts.config, "CLAUDE.md"), "user"],
			[join(parts.root, "outside.md"), "user"],
			[join(parts.parent, "CLAUDE.md"), "project"],
			[join(ws, "in.md"), "project"],
			[join(ws, "CLAUDE.md"), "project"],
			[join(ws, "CLAUDE.local.md"), "local"],
		]);
	});
});

describe("rules", () => {
	test("recurse into subdirectories, keep only unconditional .md rules, and survive a symlink loop", () => {
		const parts = side();
		const rules = join(parts.workspace, ".claude", "rules");
		write(join(rules, "a.md"), "a");
		write(join(rules, "nested", "deep", "b.md"), "b");
		write(join(rules, "notes.txt"), "not a rule");
		write(join(rules, "upper.MD"), "not a rule");
		write(join(rules, "scoped.md"), "---\npaths: src/**/*.ts\n---\nscoped");
		write(join(rules, "everywhere.md"), "---\npaths: ['**']\n---\neverywhere");
		symlinkSync(rules, join(rules, "nested", "loop"));

		const files = discoverMemory(location(parts)).files;

		expect(new Set(paths(files))).toEqual(
			new Set([join(rules, "a.md"), join(rules, "nested", "deep", "b.md"), join(rules, "everywhere.md")]),
		);
		expect(files.find((file) => file.path.endsWith("everywhere.md"))?.content).toBe("everywhere");
	});
});

describe("claudeMdExcludes", () => {
	test("drops user, project, local files and imports, never managed", () => {
		const parts = side();
		const ws = parts.workspace;
		write(join(parts.managed, "CLAUDE.md"), "managed");
		write(join(parts.config, "CLAUDE.md"), "user");
		write(join(ws, "CLAUDE.md"), "@imp.md @kept.md");
		write(join(ws, "imp.md"), "imp");
		write(join(ws, "kept.md"), "kept");
		write(join(ws, ".claude", "rules", "r.md"), "rule");
		write(join(ws, "CLAUDE.local.md"), "local");

		const files = discoverMemory(
			location(parts, {
				managedDir: parts.managed,
				excludes: [
					`${parts.config}/CLAUDE.md`,
					"**/imp.md",
					`${ws}/.claude/rules/**`,
					"**/CLAUDE.local.md",
					`${parts.managed}/**`,
				],
			}),
		).files;

		expect(paths(files)).toEqual([join(parts.managed, "CLAUDE.md"), join(ws, "CLAUDE.md"), join(ws, "kept.md")]);
	});

	test("an absolute pattern also matches through the real path of its directory", () => {
		const parts = side();
		const link = join(parts.root, "link");
		symlinkSync(parts.parent, link);
		write(join(parts.workspace, "CLAUDE.md"), "project");
		write(join(parts.workspace, "CLAUDE.local.md"), "local");

		const files = discoverMemory(location(parts, { excludes: [`${link}/workspace/CLAUDE.local.md`] })).files;

		expect(paths(files)).toEqual([join(parts.workspace, "CLAUDE.md")]);
	});
});

describe("resolveMemoryLocation", () => {
	const input = (parts: Side) => ({
		cwd: parts.workspace,
		home: parts.home,
		env: { CLAUDE_CONFIG_DIR: parts.config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
		platform: "darwin",
		values: {},
		settingSources: undefined,
		projectTrusted: true,
		disabled: false,
	});

	function seed(parts: Side): void {
		write(join(parts.config, "CLAUDE.md"), "user");
		write(join(parts.workspace, "CLAUDE.md"), "project");
		write(join(parts.workspace, "CLAUDE.local.md"), "local");
	}

	test("--setting-sources narrows memory to the admitted tiers", () => {
		const parts = side();
		seed(parts);
		const load = (settingSources: string[]) =>
			paths(
				discoverMemory({ ...resolveMemoryLocation({ ...input(parts), settingSources }), managedDir: undefined })
					.files,
			);

		expect(load(["user"])).toEqual([join(parts.config, "CLAUDE.md")]);
		expect(load(["project"])).toEqual([join(parts.workspace, "CLAUDE.md")]);
		expect(load(["user", "local"])).toEqual([
			join(parts.config, "CLAUDE.md"),
			join(parts.workspace, "CLAUDE.local.md"),
		]);
	});

	test("an untrusted project keeps only user memory", () => {
		const parts = side();
		seed(parts);
		const resolved = { ...resolveMemoryLocation({ ...input(parts), projectTrusted: false }), managedDir: undefined };
		expect(paths(discoverMemory(resolved).files)).toEqual([join(parts.config, "CLAUDE.md")]);
	});

	test("CLAUDE_CONFIG_DIR replaces ~/.claude", () => {
		const parts = side();
		write(join(parts.home, ".claude", "CLAUDE.md"), "home user");
		expect(resolveMemoryLocation(input(parts)).configDir).toBe(parts.config);
		const env = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
		expect(resolveMemoryLocation({ ...input(parts), env }).configDir).toBe(join(parts.home, ".claude"));
	});

	test("the flag and CLAUDE_CODE_DISABLE_CLAUDE_MDS (even 0) turn all memory off", () => {
		const parts = side();
		seed(parts);
		const off = [
			resolveMemoryLocation({ ...input(parts), disabled: true }),
			resolveMemoryLocation({ ...input(parts), env: { ...input(parts).env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0" } }),
		];
		for (const resolved of off) {
			expect(resolved.autoMemory).toBeUndefined();
			expect(discoverMemory(resolved)).toMatchObject({ files: [], autoMemoryDir: undefined });
			expect(memoryForFileAccess(join(parts.workspace, "x.ts"), resolved, new Set())).toEqual([]);
		}
	});

	test("the managed directory follows the platform", () => {
		const parts = side();
		expect(resolveMemoryLocation(input(parts)).managedDir).toBe("/Library/Application Support/ClaudeCode");
		expect(resolveMemoryLocation({ ...input(parts), platform: "linux" }).managedDir).toBe("/etc/claude-code");
	});
});

describe("memory on file access", () => {
	test("brings in rules and nested memory in Claude Code's order", () => {
		const parts = side();
		const ws = parts.workspace;
		const sub = join(ws, "sub");
		const deep = join(sub, "deep");
		write(join(parts.managed, ".claude", "rules", "m.md"), "---\npaths: sub/**\n---\nmanaged scoped");
		write(join(parts.config, "rules", "u.md"), "---\npaths: '**/*.ts'\n---\nuser scoped");
		write(join(parts.config, "rules", "u-miss.md"), "---\npaths: '*.py'\n---\nuser miss");
		write(join(sub, "CLAUDE.md"), "sub @sub-imp.md");
		write(join(sub, "sub-imp.md"), "sub import");
		write(join(sub, ".claude", "CLAUDE.md"), "sub dot");
		write(join(sub, "CLAUDE.local.md"), "sub local");
		write(join(sub, ".claude", "rules", "always.md"), "sub always");
		write(join(sub, ".claude", "rules", "scoped.md"), "---\npaths: deep/{a,b}.ts\n---\nsub scoped");
		write(join(deep, "CLAUDE.md"), "deep");
		write(join(ws, ".claude", "rules", "ws.md"), "---\npaths: sub/deep/*.ts, other/**\n---\nws scoped");
		write(join(parts.parent, ".claude", "rules", "up.md"), "---\npaths: workspace/sub/**\n---\nparent scoped");
		write(join(ws, ".claude", "rules", "ws-miss.md"), "---\npaths: lib/**\n---\nws miss");
		write(join(deep, "a.ts"), "");

		const files = memoryForFileAccess("sub/deep/a.ts", location(parts, { managedDir: parts.managed }), new Set());

		expect(files.map((file) => [file.path, file.type])).toEqual([
			[join(parts.managed, ".claude", "rules", "m.md"), "managed"],
			[join(parts.config, "rules", "u.md"), "user"],
			[join(sub, "CLAUDE.md"), "project"],
			[join(sub, "sub-imp.md"), "project"],
			[join(sub, ".claude", "CLAUDE.md"), "project"],
			[join(sub, "CLAUDE.local.md"), "local"],
			[join(sub, ".claude", "rules", "always.md"), "project"],
			[join(sub, ".claude", "rules", "scoped.md"), "project"],
			[join(deep, "CLAUDE.md"), "project"],
			[join(parts.parent, ".claude", "rules", "up.md"), "project"],
			[join(ws, ".claude", "rules", "ws.md"), "project"],
		]);
		expect(renderNestedReminder(files[2])).toBe(
			`<system-reminder>\nContents of ${join(sub, "CLAUDE.md")}:\n\nsub @sub-imp.md\n</system-reminder>`,
		);
	});

	test("skips loaded paths, files outside cwd, and untrusted project memory", () => {
		const parts = side();
		const sub = join(parts.workspace, "sub");
		write(join(sub, "CLAUDE.md"), "sub");
		write(join(sub, "CLAUDE.local.md"), "local");
		write(join(parts.parent, "other", "CLAUDE.md"), "outside");

		const loaded = new Set([join(sub, "CLAUDE.md")]);
		expect(paths(memoryForFileAccess(join(sub, "x.ts"), location(parts), loaded))).toEqual([
			join(sub, "CLAUDE.local.md"),
		]);
		expect(memoryForFileAccess(join(parts.parent, "other", "x.ts"), location(parts), new Set())).toEqual([]);
		const untrusted = location(parts, { sources: { user: true, project: false, local: false } });
		expect(memoryForFileAccess(join(sub, "x.ts"), untrusted, new Set())).toEqual([]);
	});

	test("the accessed file itself is not injected", () => {
		const parts = side();
		write(join(parts.workspace, "sub", "CLAUDE.md"), "sub");
		expect(memoryForFileAccess("sub/CLAUDE.md", location(parts), new Set())).toEqual([]);
	});
});

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
