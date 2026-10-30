import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { baseEnv, createRoots } from "../conformance/isolate.ts";
import { runSandboxed } from "../conformance/sandboxed.ts";
import {
	acquireProcessTable,
	PROCESS_TABLE_LOCK_TIMEOUT_MS,
	releaseProcessTable,
} from "./conformance-process-table.ts";

const darwin = process.platform === "darwin";
beforeAll(acquireProcessTable, PROCESS_TABLE_LOCK_TIMEOUT_MS);
afterAll(releaseProcessTable);

/** Forks without exec, leaves the root for `/`, holds no file but the inherited output pipes, and outlives its parent. */
const FORK_ONLY = `
import os, sys, time
child = os.fork()
if child == 0:
    os.chdir("/")
    time.sleep(45)
    os._exit(0)
with open(sys.argv[1], "w") as f:
    f.write(str(child))
os._exit(0)
`;

describe.skipIf(!darwin)("running a side whose only child outlives it", () => {
	test("a fork-only child holding the output pipes is killed when the side exits, not at the timeout", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-sandboxed-")));
		const roots = createRoots(base, "sandboxed", "claude");
		const profile = join(base, "profile.sb");
		const pidFile = join(base, "pid");
		writeFileSync(profile, "(version 1)(allow default)");
		try {
			const started = Date.now();
			const result = await runSandboxed(
				profile,
				["/usr/bin/python3", "-c", FORK_ONLY, pidFile],
				roots.workspace,
				roots,
				baseEnv(roots, null),
				null,
				6_000,
			);
			const elapsed = Date.now() - started;
			const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);

			expect(result.timedOut).toBe(false);
			expect(elapsed).toBeLessThan(4_000);
			expect(isAlive(pid)).toBe(false);
		} finally {
			if (existsSync(pidFile)) spawnSync("/bin/kill", ["-9", readFileSync(pidFile, "utf8").trim()]);
			rmSync(base, { recursive: true, force: true });
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
