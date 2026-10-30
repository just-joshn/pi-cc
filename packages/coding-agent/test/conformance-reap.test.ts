import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { reap } from "../conformance/reap.ts";

const darwin = process.platform === "darwin";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		// The stop file ends the chain even when an assertion failed before the reaper did.
		writeFileSync(join(root, "stop"), "");
		spawnSync("/usr/bin/pkill", ["-9", "-f", join(root, "hop.sh")]);
		rmSync(root, { recursive: true, force: true });
	}
});

const HOP = "[ -e ./stop ] && exit 0\necho x >> gen.log\n/bin/sh ./hop.sh &\nexit 0\n";

// What Claude Code does with a SessionStart hook: the hook shell is spawned detached, so it leaves the
// side's process group, and the hook's own command then starts the chain.
const SIDE_SIMULATOR = `
const { spawn } = require("node:child_process");
spawn("/bin/sh", ["-c", process.argv[1]], { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
`;

function startChain(hookCommand: string): { root: string; pgid: number } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
	roots.push(root);
	writeFileSync(join(root, "hop.sh"), HOP);
	const side = spawn(process.execPath, ["-e", SIDE_SIMULATOR, hookCommand], {
		cwd: root,
		detached: true,
		stdio: "ignore",
	});
	side.unref();
	return { root, pgid: side.pid ?? 0 };
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

// Regression: a hook that re-forks itself (`/bin/sh ./hop.sh & exit 0`) moves faster than a ps and lsof
// sweep, so the sweep killed pids that had already exited and the next generation kept running.
describe.skipIf(!darwin)("reaping a process chain that re-forks itself", () => {
	test.each([
		["a bare re-forking script", "/bin/sh ./hop.sh & exit 0"],
		["the same script started through nohup", "nohup /bin/sh ./hop.sh >/dev/null 2>&1 & exit 0"],
	])(
		"%s is gone after the reap and stays gone",
		async (_name, hookCommand) => {
			const chain = startChain(hookCommand);
			await delay(150);
			expect(generations(chain.root)).toBeGreaterThan(1);

			const reaped = await reap(chain.pgid, chain.root);
			const afterReap = generations(chain.root);
			await delay(400);

			expect(cwdHolders(chain.root)).toEqual([]);
			expect(generations(chain.root)).toBe(afterReap);
			expect(reaped).toEqual({ survived: true, converged: true });
		},
		30_000,
	);
});

// A scan that cannot run says nothing about the tree, so the reap must not call it clean.
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

		const reaped = await reap(2 ** 22, root, lsof);

		expect(reaped).toEqual({ survived: false, converged: false });
	});

	test.each([
		["missing", "/nonexistent/lsof"],
		["silent", "#!/bin/sh\nexit 1\n"],
	])("an lsof that is %s reports no convergence", async (kind, tool) => {
		const lsof = kind === "missing" ? tool : fakeLsof(tool);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);

		const reaped = await reap(2 ** 22, root, lsof);

		expect(reaped).toEqual({ survived: false, converged: false });
	});
});

describe.skipIf(!darwin)("a reap and the harness's own process group", () => {
	test("never signals a process in the harness's group, even inside the root", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
		roots.push(root);
		const bystander = spawn("/bin/sleep", ["30"], { cwd: root, stdio: "ignore" });

		const reaped = await reap(2 ** 22, root);

		const alive = bystander.exitCode === null && bystander.signalCode === null;
		bystander.kill("SIGKILL");
		expect(alive).toBe(true);
		expect(reaped).toEqual({ survived: false, converged: true });
	});
});
