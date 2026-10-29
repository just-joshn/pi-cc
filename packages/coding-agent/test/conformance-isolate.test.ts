import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { baseEnv, createRoots, renderProfile } from "../conformance/isolate.ts";

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
