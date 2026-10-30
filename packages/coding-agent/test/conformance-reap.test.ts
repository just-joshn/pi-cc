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

function startChain(hookCommand: string): { root: string; pgid: number; startedAt: number } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-reap-")));
	roots.push(root);
	writeFileSync(join(root, "hop.sh"), HOP);
	const startedAt = Date.now();
	const side = spawn(process.execPath, ["-e", SIDE_SIMULATOR, hookCommand], {
		cwd: root,
		detached: true,
		stdio: "ignore",
	});
	side.unref();
	return { root, pgid: side.pid ?? 0, startedAt };
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

			const reaped = await reap(chain.pgid, chain.root, chain.startedAt);
			const afterReap = generations(chain.root);
			await delay(400);

			expect(cwdHolders(chain.root)).toEqual([]);
			expect(generations(chain.root)).toBe(afterReap);
			expect(reaped).toEqual({ survived: true, converged: true });
		},
		30_000,
	);
});
