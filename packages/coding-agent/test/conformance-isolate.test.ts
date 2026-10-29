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
import { baseEnv, createRoots, expandPlaceholders, findPresentPaths, hashTree, renderProfile, seedFiles } from "../conformance/isolate.ts";

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

		expect([...scan.entries.keys()]).toEqual([Array.from({ length: 400 }, () => "d").join("/") + "/leaf.txt"]);
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
		expect(() => seedFiles(roots, { "$HOME/../../escape.json": "{}" })).toThrow(/escapes the case root/);
	});

	test("the real home is refused", () => {
		const { roots } = seedRoot();
		expect(() => seedFiles(roots, { "$REAL_HOME/escape.json": "{}" })).toThrow(/escapes the case root/);
	});

	test("a workspace path that escapes the workspace is refused", () => {
		const { roots } = seedRoot();
		expect(() => seedFiles(roots, { "../escape.json": "{}" })).toThrow(/escapes workspace/);
	});

	test("expands the config placeholder in argv as well", () => {
		const { roots } = seedRoot();
		expect(expandPlaceholders("$CONFIG/settings.json", roots)).toBe(join(roots.config, "settings.json"));
	});
});
