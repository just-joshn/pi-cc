import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	baseEnv,
	createRoots,
	expandPlaceholders,
	findPresentPaths,
	hashTree,
	renderProfile,
	scanWorkspace,
	seedFiles,
} from "../conformance/isolate.ts";

const darwin = process.platform === "darwin";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SandboxedRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runInProfile(program: string, argv: string[], stdin: string): SandboxedRun {
	const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-isolate-")), "profile", "claude");
	tempDirs.push(roots.root);
	const profilePath = join(roots.out, "profile.sb");
	writeFileSync(profilePath, renderProfile({ roots, executableRoots: ["/bin/ls"], port: null }));
	const result = spawnSync(SANDBOX_EXEC, ["-f", profilePath, program, ...argv], {
		cwd: roots.workspace,
		env: baseEnv(roots, null),
		input: stdin,
		encoding: "utf8",
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Regression: the profile allowed every mach service, so the host's pasteboard and Shortcuts
// database were reachable from inside a case.
describe.skipIf(!darwin)("the case profile and host services", () => {
	test("denies pbcopy", () => {
		const run = runInProfile("/usr/bin/pbcopy", [], "pi-cc conformance clipboard probe");

		expect(run.status).not.toBe(0);
	});

	test("denies pbpaste and reads nothing", () => {
		const run = runInProfile("/usr/bin/pbpaste", [], "");

		expect(run.status).not.toBe(0);
		expect(run.stdout.length).toBe(0);
	});

	test("denies shortcuts list", () => {
		const run = runInProfile("/usr/bin/shortcuts", ["list"], "");

		expect(run.status).not.toBe(0);
		expect(run.stdout.length).toBe(0);
	});
});

function scratchRoot(): string {
	const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-scan-")), "scan", "claude");
	tempDirs.push(roots.root);
	return roots.workspace;
}

function outsideFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-outside-"));
	tempDirs.push(dir);
	const path = join(dir, "secret.txt");
	writeFileSync(path, "SECRET\n");
	return path;
}

// The side owns every path under its own root, so the scan and the reader treat what it leaves there as
// hostile: a link is never followed, a fifo is never opened, and nothing below ever throws or leaks.
describe("scanning a side's tree", () => {
	test("records a dangling link as a violation instead of throwing", () => {
		const workspace = scratchRoot();
		symlinkSync(join(workspace, "absent-target"), join(workspace, "dangling.log"));

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "dangling-symlink", path: "dangling.log" }]);
		expect(scan.entries.get("dangling.log")).toContain("symlink:dangling-symlink:");
		expect(hashTree(workspace, ["dangling.log"]).text.size).toBe(0);
	});

	test("records a link that lands outside the workspace as an escape", () => {
		const workspace = scratchRoot();
		symlinkSync(outsideFile(), join(workspace, "secret.log"));

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "escaping-symlink", path: "secret.log" }]);
		expect(hashTree(workspace, ["secret.log"]).text.size).toBe(0);
	});

	test("records a link inside the workspace without resolving it", () => {
		const workspace = scratchRoot();
		writeFileSync(join(workspace, "real.txt"), "inside\n");
		symlinkSync("real.txt", join(workspace, "alias.txt"));

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "symlink", path: "alias.txt" }]);
		expect(scan.entries.get("alias.txt")).toBe("symlink:symlink:real.txt");
		const wanted = hashTree(workspace, ["alias.txt", "real.txt"]).text;
		expect(wanted.has("alias.txt")).toBe(false);
		expect(wanted.get("real.txt")).toBe("inside\n");
	});

	test("records a fifo as a violation and never opens it", () => {
		const workspace = scratchRoot();
		execFileSync("mkfifo", [join(workspace, "fifo.log")]);

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "not-regular-file", path: "fifo.log" }]);
		expect(scan.entries.get("fifo.log")).toBe("special:fifo");
		expect(hashTree(workspace, ["fifo.log"]).text.size).toBe(0);
	});

	test("records a file it cannot read as a violation", () => {
		const workspace = scratchRoot();
		const path = join(workspace, "locked.log");
		writeFileSync(path, "locked\n");
		chmodSync(path, 0o000);

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "unreadable", path: "locked.log" }]);
		expect(scan.entries.get("locked.log")).toBe("unreadable:EACCES");
		chmodSync(path, 0o600);
	});

	test("refuses a workspace anchor that became a link", () => {
		const workspace = scratchRoot();
		const elsewhere = outsideFile();
		renameSync(workspace, `${workspace}.bak`);
		symlinkSync(dirname(elsewhere), workspace);

		const scan = hashTree(workspace);

		expect(scan.violations).toEqual([{ kind: "symlink", path: null }]);
		expect(scan.entries.size).toBe(0);
		expect(hashTree(workspace, ["secret.txt"]).text.size).toBe(0);
	});

	test("counts a planted dangling link at an absent path as present", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-absent-"));
		tempDirs.push(dir);
		const path = join(dir, "escape-marker.txt");
		symlinkSync(join(dir, "nowhere"), path);

		expect(findPresentPaths([path])).toEqual([path]);
		expect(findPresentPaths([join(dir, "missing.txt")])).toEqual([]);
	});
});

describe("seedFiles", () => {
	test("lands a placeholder inside the side root and refuses one that leaves it", () => {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-seed-")), "seed", "pi-cc");
		tempDirs.push(roots.root);

		seedFiles(roots, { "$AGENT/auth.json": '{"ok":true}', "note.txt": "workspace" });

		expect(readFileSync(join(roots.agent, "auth.json"), "utf8")).toBe('{"ok":true}');
		expect(readFileSync(join(roots.workspace, "note.txt"), "utf8")).toBe("workspace");
		expect(() => seedFiles(roots, { "$REAL_HOME/secret": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "$AGENT/../../outside": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "../zz": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "$WORKSPACE/../out/requests.jsonl": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "$FIXTURES/zz": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "/tmp/zz-abs": "no" })).toThrow(/escapes the side root/);

		seedFiles(roots, {
			"$CONFIG/.credentials.json": "config",
			"$HOME/.profile": "home",
			"$WORKSPACE/kept.txt": "workspace",
		});
		expect(readFileSync(join(roots.config, ".credentials.json"), "utf8")).toBe("config");
		expect(readFileSync(join(roots.home, ".profile"), "utf8")).toBe("home");
		expect(readFileSync(join(roots.workspace, "kept.txt"), "utf8")).toBe("workspace");
		expect(() => readFileSync(join(roots.root, "zz"), "utf8")).toThrow();
		expect(() => readFileSync(join(roots.out, "requests.jsonl"), "utf8")).toThrow();
	});

	test("refuses a seeded path whose parent or leaf is a symlink outside an allowed subtree", () => {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-seed-")), "links", "pi-cc");
		tempDirs.push(roots.root);
		const outside = mkdtempSync(join(tmpdir(), "pi-cc-seed-outside-"));
		tempDirs.push(outside);
		symlinkSync(outside, join(roots.workspace, "escape"));
		symlinkSync(roots.agent, join(roots.workspace, "other-subtree"));
		symlinkSync(join(outside, "leaf.txt"), join(roots.workspace, "leaf.txt"));

		expect(() => seedFiles(roots, { "escape/parent.txt": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "other-subtree/parent.txt": "no" })).toThrow(/escapes the side root/);
		expect(() => seedFiles(roots, { "leaf.txt": "no" })).toThrow(/escapes the side root/);
		expect(() => readFileSync(join(outside, "parent.txt"))).toThrow();
		expect(() => readFileSync(join(outside, "leaf.txt"))).toThrow();
	});

	test("creates no directory through a link it refuses", () => {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-seed-")), "mkdir", "pi-cc");
		tempDirs.push(roots.root);
		const outside = mkdtempSync(join(tmpdir(), "pi-cc-seed-outside-"));
		tempDirs.push(outside);
		symlinkSync(outside, join(roots.workspace, "escape"));

		expect(() => seedFiles(roots, { "escape/deep/file.txt": "no" })).toThrow(/escapes the side root/);
		expect(existsSync(join(outside, "deep"))).toBe(false);
	});
});

describe("the profile keeps the harness artifacts out of the side's reach", () => {
	test("denies writes to out after granting the run root", () => {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-profile-")), "profile", "claude");
		tempDirs.push(roots.root);

		const lines = renderProfile({ roots, executableRoots: ["/bin/ls"], port: null }).split("\n");
		const allowRoot = lines.indexOf(`(allow file-write* (subpath "${roots.root}"))`);
		const denyOut = lines.indexOf(`(deny file-write* (subpath "${roots.out}"))`);

		expect(allowRoot).toBeGreaterThan(-1);
		expect(denyOut).toBeGreaterThan(allowRoot);
	});
});

describe("what a side can plant without crashing the scan", () => {
	test("walks a deep tree with its own stack", () => {
		const workspace = scratchRoot();
		let deepest = workspace;
		// PATH_MAX caps a macOS path at 1024 bytes, so this is as deep as a side can make the walk go.
		for (let depth = 0; depth < 400; depth += 1) {
			deepest = join(deepest, "d");
			mkdirSync(deepest);
		}
		writeFileSync(join(deepest, "leaf.txt"), "leaf\n");

		const scan = hashTree(workspace);

		expect([...scan.entries.keys()]).toEqual([`${Array.from({ length: 400 }, () => "d").join("/")}/leaf.txt`]);
		expect(scan.violations).toEqual([]);
	});

	test("refuses a file past the read cap instead of reading it", () => {
		const workspace = scratchRoot();
		const path = join(workspace, "huge.bin");
		const fd = openSync(path, "w");
		ftruncateSync(fd, 9 * 1024 * 1024);
		closeSync(fd);

		const scan = hashTree(workspace, ["huge.bin"]);

		expect(scan.entries.get("huge.bin")).toBe("unreadable:too-large");
		expect(scan.violations).toEqual([{ kind: "unreadable", path: "huge.bin" }]);
		expect(scan.text.size).toBe(0);
	});
});

// A case writes the user settings file and a home-directory file, so `files` keys may name a root
// instead of the workspace. Either way the target stays inside the side's own root.
describe("seeding a case's files", () => {
	const seedRoot = (): { tmpRoot: string; roots: ReturnType<typeof createRoots> } => {
		const tmpRoot = mkdtempSync(join(tmpdir(), "pi-cc-seed-"));
		tempDirs.push(tmpRoot);
		return { tmpRoot, roots: createRoots(tmpRoot, "seed", "claude") };
	};

	test("a bare path seeds the workspace", () => {
		const { roots } = seedRoot();
		seedFiles(roots, { ".claude/settings.json": "{}\n" });
		expect(readFileSync(join(roots.workspace, ".claude", "settings.json"), "utf8")).toBe("{}\n");
	});

	test("$CONFIG seeds the side's config directory", () => {
		const { roots } = seedRoot();
		seedFiles(roots, { "$CONFIG/settings.json": '{"model":"claude-haiku-4-5"}\n' });
		expect(readFileSync(join(roots.config, "settings.json"), "utf8")).toContain("claude-haiku-4-5");
	});

	test("$WORKSPACE, $TMP and $HOME name their own roots", () => {
		const { roots } = seedRoot();
		seedFiles(roots, {
			"$WORKSPACE/workspace.txt": "w",
			"$TMP/tmp.txt": "t",
			"$HOME/home.txt": "h",
		});
		expect(existsSync(join(roots.workspace, "workspace.txt"))).toBe(true);
		expect(existsSync(join(roots.tmp, "tmp.txt"))).toBe(true);
		expect(existsSync(join(roots.home, "home.txt"))).toBe(true);
	});

	test("a root path that escapes the side root is refused", () => {
		const { roots } = seedRoot();
		expect(() => seedFiles(roots, { "$HOME/../../escape.json": "{}" })).toThrow(/escapes the side root/);
	});

	test("the real home is refused", () => {
		const { roots } = seedRoot();
		expect(() => seedFiles(roots, { "$REAL_HOME/escape.json": "{}" })).toThrow(/escapes the side root/);
	});

	test("a workspace path that escapes the workspace is refused", () => {
		const { roots } = seedRoot();
		expect(() => seedFiles(roots, { "../escape.json": "{}" })).toThrow(/escapes the side root/);
	});

	test("expands the config placeholder in argv as well", () => {
		const { roots } = seedRoot();
		expect(expandPlaceholders("$CONFIG/settings.json", roots)).toBe(join(roots.config, "settings.json"));
	});

	test("$AGENT seeds the side's agent directory, and the content expands too", () => {
		const { roots } = seedRoot();
		seedFiles(roots, { "$AGENT/trust.json": '{"$WORKSPACE": true}\n' });
		expect(readFileSync(join(roots.agent, "trust.json"), "utf8")).toBe(`{"${roots.workspace}": true}\n`);
	});
});

describe("scanning the workspace after the side exits", () => {
	function sideRoots() {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-take-")), "take", "claude");
		tempDirs.push(roots.root);
		writeFileSync(join(roots.workspace, "result.txt"), "result\n");
		return roots;
	}

	test("a workspace that moves is scanned where it landed", () => {
		const roots = sideRoots();

		const scan = scanWorkspace(roots, ["result.txt"]);

		expect(scan.violations).toEqual([]);
		expect(scan.text.get("result.txt")).toBe("result\n");
		expect(existsSync(roots.workspace)).toBe(false);
	});

	test("a workspace that cannot move reports the move, not an unreadable tree", () => {
		const roots = sideRoots();
		const taken = join(dirname(roots.root), "snapshot-claude");
		mkdirSync(join(taken, "occupied"), { recursive: true });
		tempDirs.push(taken);

		const scan = scanWorkspace(roots, ["result.txt"]);

		expect(scan.violations).toEqual([{ kind: "workspace-unmovable", path: null }]);
		expect(scan.entries.size).toBe(0);
		expect(existsSync(join(roots.workspace, "result.txt"))).toBe(true);
	});

	test("a workspace behind an inaccessible parent is a failed move, not an unreadable tree", () => {
		const roots = sideRoots();
		chmodSync(roots.root, 0o000);
		try {
			const scan = scanWorkspace(roots, []);

			expect(scan.violations).toEqual([{ kind: "workspace-unmovable", path: null }]);
		} finally {
			chmodSync(roots.root, 0o700);
		}
	});

	test("a workspace the side removed is still unreadable", () => {
		const roots = sideRoots();
		rmSync(roots.workspace, { recursive: true });

		const scan = scanWorkspace(roots, []);

		expect(scan.violations).toEqual([{ kind: "unreadable", path: null }]);
	});
});

// /etc/claude-code does not exist here, so the rule form is proven on /private/etc/hosts, which does.
describe.skipIf(!darwin)("the managed policy denial", () => {
	function profileWith(rule: string, replacement: string): { roots: ReturnType<typeof createRoots>; profile: string } {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-policy-")), "policy", "claude");
		tempDirs.push(roots.root);
		const rendered = renderProfile({ roots, executableRoots: ["/bin/cat"], port: null });
		expect(rendered).toContain(rule);
		return { roots, profile: rendered.split(rule).join(replacement) };
	}

	function cat(target: string, rule: string, replacement: string): SandboxedRun {
		const { roots, profile } = profileWith(rule, replacement);
		const profilePath = join(roots.out, "profile.sb");
		writeFileSync(profilePath, profile);
		const result = spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/cat", target], {
			cwd: roots.workspace,
			env: baseEnv(roots, null),
			encoding: "utf8",
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	test("the profile names the canonical path and keeps the application support path", () => {
		const roots = createRoots(mkdtempSync(join(tmpdir(), "pi-cc-policy-")), "policy", "claude");
		tempDirs.push(roots.root);

		const profile = renderProfile({ roots, executableRoots: ["/bin/cat"], port: null });

		expect(profile).toContain('(deny file-read* (subpath "/private/etc/claude-code"))');
		expect(profile).toContain('(deny file-read* (subpath "/Library/Application Support/ClaudeCode"))');
	});

	test("a rule on the canonical path denies the read through both spellings", () => {
		for (const target of ["/private/etc/hosts", "/etc/hosts"]) {
			const run = cat(target, "/private/etc/claude-code", "/private/etc/hosts");

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("Operation not permitted");
			expect(run.stdout).toBe("");
		}
	});

	test("a rule spelled through the /etc link denies nothing", () => {
		const run = cat("/etc/hosts", '"/private/etc/claude-code"', '"/etc/hosts"');

		expect(run.status).toBe(0);
		expect(run.stdout.length).toBeGreaterThan(0);
	});
});
