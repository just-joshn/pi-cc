import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type ExecLog, startExecLog } from "../conformance/execlog.ts";
import {
	beginWatch,
	findLeftBehind,
	identity,
	type ProcessRow,
	parseProcessTable,
	unaccounted,
} from "../conformance/processes.ts";
import {
	acquireProcessTable,
	PROCESS_TABLE_LOCK_TIMEOUT_MS,
	releaseProcessTable,
} from "./conformance-process-table.ts";

const darwin = process.platform === "darwin";
const HARNESS = { pid: 100, uid: 501 };

let execLog: ExecLog | null = null;

beforeAll(acquireProcessTable, PROCESS_TABLE_LOCK_TIMEOUT_MS);
beforeAll(async () => {
	execLog = await startExecLog();
}, 30_000);
afterAll(() => {
	execLog?.close();
	releaseProcessTable();
});

function row(overrides: Partial<ProcessRow> & { pid: number }): ProcessRow {
	return {
		ppid: 1,
		uid: 501,
		zombie: false,
		start: "Thu Oct 29 23:00:00 2026",
		command: "/bin/sh",
		...overrides,
	};
}

describe("reading a process table", () => {
	test("parses a start time with a padded day and a program path with spaces", () => {
		const rows = parseProcessTable(
			[
				"    1     0     0 Ss   Sat Oct 24 14:11:31 2026     /sbin/launchd",
				"  412   101   501 S    Fri Oct  2 09:00:01 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"  413   412   501 Z    Thu Oct 29 23:00:00 2026     (sh)",
				"garbage",
			].join("\n"),
		);

		expect(rows).toEqual([
			row({ pid: 1, ppid: 0, uid: 0, start: "Sat Oct 24 14:11:31 2026", command: "/sbin/launchd" }),
			row({
				pid: 412,
				ppid: 101,
				start: "Fri Oct 2 09:00:01 2026",
				command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			}),
			row({ pid: 413, ppid: 412, zombie: true, command: "(sh)" }),
		]);
	});
});

describe("which new processes the table offers as candidates", () => {
	const before = row({ pid: 200, ppid: 1, command: "/usr/bin/ssh-agent" });
	const baseline = new Set([identity(before), identity(row({ pid: HARNESS.pid, command: "node" }))]);
	const left = (...rows: ProcessRow[]) => unaccounted([before, ...rows], baseline, HARNESS).map((found) => found.pid);

	test("a new orphan is a candidate", () => {
		expect(left(row({ pid: 300 }))).toEqual([300]);
	});

	test("a new descendant of such an orphan is a candidate too", () => {
		expect(left(row({ pid: 300 }), row({ pid: 301, ppid: 300, command: "/bin/sleep" }))).toEqual([300, 301]);
	});

	test("a process already running before the side is not new, and a recycled pid is", () => {
		expect(left(before, row({ pid: 200, start: "Thu Oct 29 23:30:00 2026" }))).toEqual([200]);
	});

	test.each([
		["a child of the harness, like the ps it runs", row({ pid: 301, ppid: HARNESS.pid })],
		["a grandchild of the harness", row({ pid: 302, ppid: 301 })],
		["a child of a process that predates the side", row({ pid: 303, ppid: 200 })],
		["a process of another user", row({ pid: 305, uid: 0 })],
		["a zombie", row({ pid: 306, zombie: true, command: "(sh)" })],
	])("%s is not a candidate", (_name, other) => {
		expect(left(row({ pid: 301, ppid: HARNESS.pid }), other)).not.toContain(other.pid);
	});
});

describe.skipIf(!darwin)("the process table and the exec log of this machine", () => {
	const dirs: string[] = [];
	const pids: number[] = [];
	const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
	const REPORTING =
		"(version 1)(deny default)(allow process-exec* (with report))(allow process-fork)(allow sysctl-read)(allow file-read*)";

	afterEach(() => {
		for (const pid of pids.splice(0)) spawnSync("/bin/kill", ["-9", String(pid)]);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** An orphan with a program path: its parent exits at once, as a side's survivor's does. */
	function startOrphan(options: { sandboxed: boolean }): number {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-orphan-"));
		dirs.push(dir);
		const sleep = options.sandboxed ? `${SANDBOX_EXEC} -p '${REPORTING}' /bin/sleep 45` : "/bin/sleep 45";
		spawnSync("/bin/sh", ["-c", `${sleep} >/dev/null 2>&1 & echo $! > ${join(dir, "pid")}`]);
		const pid = Number.parseInt(readFileSync(join(dir, "pid"), "utf8"), 10);
		pids.push(pid);
		return pid;
	}

	test("a sandboxed orphan started after the watch is found, and one started before it is not", async () => {
		const older = startOrphan({ sandboxed: true });
		const watch = await beginWatch(execLog);
		const newer = startOrphan({ sandboxed: true });

		const found = await findLeftBehind(watch);

		expect(found.complete).toBe(true);
		const foundPids = found.processes.map((process) => process.pid);
		expect(foundPids).toContain(newer);
		expect(foundPids).not.toContain(older);
	});

	test("a new orphan that never ran under a sandbox profile is not found", async () => {
		const watch = await beginWatch(execLog);
		const foreign = startOrphan({ sandboxed: false });

		const found = await findLeftBehind(watch);

		expect(found.complete).toBe(true);
		expect(found.processes.map((process) => process.pid)).not.toContain(foreign);
	});

	test("a sandboxed child of this process, which is the harness, is not found", async () => {
		const watch = await beginWatch(execLog);
		const child = spawn(SANDBOX_EXEC, ["-p", REPORTING, "/bin/sleep", "45"], { stdio: "ignore" });
		pids.push(child.pid ?? 0);

		const found = await findLeftBehind(watch);

		expect(found.complete).toBe(true);
		expect(found.processes.map((process) => process.pid)).not.toContain(child.pid);
	});

	test("a listing that cannot be read, or a missing watch, is incomplete and not empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-fake-ps-"));
		dirs.push(dir);
		const ps = join(dir, "ps");
		writeFileSync(ps, "#!/bin/sh\nexit 2\n", { mode: 0o755 });

		expect(await beginWatch(execLog, ps)).toBeNull();
		expect(await findLeftBehind(await beginWatch(execLog), ps)).toEqual({ complete: false, processes: [] });
		expect(await findLeftBehind(null)).toEqual({ complete: false, processes: [] });
		expect(await beginWatch(null)).toBeNull();
	});
});
