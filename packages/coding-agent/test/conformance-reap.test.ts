import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { baseEnv, createRoots, type Roots } from "../conformance/isolate.ts";
import { reap } from "../conformance/reap.ts";
import {
	acquireProcessTable,
	PROCESS_TABLE_LOCK_TIMEOUT_MS,
	releaseProcessTable,
} from "./conformance-process-table.ts";

const darwin = process.platform === "darwin";
beforeAll(acquireProcessTable, PROCESS_TABLE_LOCK_TIMEOUT_MS);
afterAll(releaseProcessTable);

const roots: string[] = [];
const bases: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		writeFileSync(join(root, "stop"), "");
		for (const pidFile of [join(root, "pid"), join(root, "workspace", "pid")]) {
			if (existsSync(pidFile)) spawnSync("/bin/kill", ["-9", readFileSync(pidFile, "utf8").trim()]);
		}
		for (let attempt = 0; attempt < 30; attempt++) {
			spawnSync("/usr/bin/pkill", ["-9", "-f", root]);
			if (spawnSync("/usr/bin/pgrep", ["-f", root]).status !== 0) break;
			await delay(100);
		}
		rmSync(root, { recursive: true, force: true });
	}
	for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const HOP = "[ -e ./stop ] && exit 0\necho x >> gen.log\n/bin/sh ./hop.sh &\nexit 0\n";

const SIDE_SIMULATOR = `
const { spawn } = require("node:child_process");
spawn("/bin/sh", ["-c", process.argv[1]], { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
`;

function startChain(hookCommand: string): { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
	roots.push(root);
	writeFileSync(join(root, "hop.sh"), HOP);
	const side = spawn(process.execPath, ["-e", SIDE_SIMULATOR, hookCommand], {
		cwd: root,
		detached: true,
		stdio: "ignore",
	});
	side.unref();
	return { root };
}

function cwdHolders(root: string): string[] {
	const listed = spawnSync("/usr/sbin/lsof", ["-w", "-n", "-P", "-d", "cwd", "-Fn"], { encoding: "utf8" });
	return listed.stdout.split("\n").filter((line) => line === `n${root}` || line.startsWith(`n${root}/`));
}

function generations(root: string): number {
	const log = join(root, "gen.log");
	return existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!darwin)("reaping a process chain that re-forks itself", () => {
	test.each([
		["a bare re-forking script", "/bin/sh ./hop.sh & exit 0"],
		["the same script started through nohup", "nohup /bin/sh ./hop.sh >/dev/null 2>&1 & exit 0"],
		[
			"the same script moved into its own process group by set -m",
			"set -m; /bin/sh ./hop.sh & echo x >>gen.log; exit 0",
		],
	])(
		"%s is gone after the reap and stays gone",
		async (_name, hookCommand) => {
			const chain = startChain(hookCommand);
			await delay(150);
			expect(generations(chain.root)).toBeGreaterThan(1);

			const reaped = await reap(chain.root);
			const afterReap = generations(chain.root);
			await delay(400);

			expect(cwdHolders(chain.root)).toEqual([]);
			expect(generations(chain.root)).toBe(afterReap);
			expect(reaped).toEqual({ survived: true, converged: true });
		},
		30_000,
	);
});

describe.skipIf(!darwin)("a reap whose scan cannot run", () => {
	function fakeLsof(script: string): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-fake-lsof-")));
		roots.push(dir);
		const path = join(dir, "lsof");
		writeFileSync(path, script, { mode: 0o755 });
		return path;
	}

	test("an lsof that prints a record and then fails reports no convergence", async () => {
		const lsof = fakeLsof("#!/bin/sh\nprintf 'p1\\ng1\\nfcwd\\nn/elsewhere\\n'\nexit 2\n");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);

		const reaped = await reap(root, { lsof });

		expect(reaped).toEqual({ survived: false, converged: false });
	});

	test.each([
		["missing", "/nonexistent/lsof"],
		["silent", "#!/bin/sh\nexit 1\n"],
	])("an lsof that is %s reports no convergence", async (kind, tool) => {
		const lsof = kind === "missing" ? tool : fakeLsof(tool);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);

		const reaped = await reap(root, { lsof });

		expect(reaped).toEqual({ survived: false, converged: false });
	});
});

describe.skipIf(!darwin)("a reap and the harness's own process group", () => {
	test("never signals a process in the harness's group, even inside the root", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);
		const bystander = spawn("/bin/sleep", ["30"], { cwd: root, stdio: "ignore" });

		const reaped = await reap(root);

		const alive = bystander.exitCode === null && bystander.signalCode === null;
		bystander.kill("SIGKILL");
		expect(alive).toBe(true);
		expect(reaped).toEqual({ survived: false, converged: true });
	});
});

interface SideChain {
	roots: Roots;
}

/** Starts a side the way the runner does (harness env, cwd in the workspace) whose only child is `command`. */
function startSideChain(command: (roots: Roots) => string, files: (roots: Roots) => Record<string, string>): SideChain {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
	const sideRoots = createRoots(base, "reap", "claude");
	bases.push(base);
	roots.push(sideRoots.root);
	for (const [name, content] of Object.entries(files(sideRoots)))
		writeFileSync(join(sideRoots.workspace, name), content);
	const side = spawn(process.execPath, ["-e", SIDE_SIMULATOR, command(sideRoots)], {
		cwd: sideRoots.workspace,
		env: baseEnv(sideRoots, null),
		detached: true,
		stdio: "ignore",
	});
	side.unref();
	return { roots: sideRoots };
}

describe.skipIf(!darwin)("reaping beyond the working-directory scan", () => {
	test("a process that only holds a file open inside the root, with its environment cleared, is gone after the reap", async () => {
		const chain = startSideChain(
			(side) =>
				`/usr/bin/env -i /bin/sh -c 'echo $$ > "$0/pid"; cd /; exec 3>>"$0/held.log"; exec /bin/sleep 60' ${side.workspace} & exit 0`,
			() => ({}),
		);
		await delay(300);
		const pid = Number.parseInt(readFileSync(join(chain.roots.workspace, "pid"), "utf8"), 10);
		expect(isAlive(pid)).toBe(true);

		const reaped = await reap(chain.roots.root);

		expect(isAlive(pid)).toBe(false);
		expect(reaped).toEqual({ survived: true, converged: true });
	}, 30_000);

	test("a chain that moves into a new group every generation is reported unconverged", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-fake-lsof-")));
		roots.push(dir);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);
		const lsof = join(dir, "lsof");
		const counter = join(dir, "count");
		writeFileSync(
			lsof,
			`#!/bin/sh\nn=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))\necho $n > ${counter}\nprintf 'p1\\ng%s\\nfcwd\\nn${root}\\n' $((4242000 + n))\n`,
			{ mode: 0o755 },
		);
		const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === 0) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			return true;
		});

		try {
			const reaped = await reap(root, { lsof, deadlineMs: 1500 });
			expect(reaped).toEqual({ survived: true, converged: false });
		} finally {
			kill.mockRestore();
		}
	}, 30_000);
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!darwin)("the signals a reap sends", () => {
	test("only the group a sweep saw working inside the root, and only while it was seen", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-fake-lsof-")));
		roots.push(dir);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);
		const lsof = join(dir, "lsof");
		const seen = join(dir, "seen");
		writeFileSync(
			lsof,
			`#!/bin/sh\nif [ -e ${seen} ]; then printf 'p1\\ng1\\nfcwd\\nn/elsewhere\\n'; else : > ${seen}; printf 'p4242423\\ng4242424\\nfcwd\\nn${root}\\n'; fi\n`,
			{ mode: 0o755 },
		);
		const signalled: unknown[][] = [];
		const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (signal === 0) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			signalled.push([pid, signal]);
			return true;
		});

		try {
			const reaped = await reap(root, { lsof });
			expect(reaped).toEqual({ survived: true, converged: true });
		} finally {
			kill.mockRestore();
		}

		expect(signalled).toEqual([[-4242424, "SIGKILL"]]);
	});
});
