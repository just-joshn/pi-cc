import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	findUnaccounted,
	identity,
	type ProcessRow,
	parseProcessTable,
	takeBaseline,
	unaccounted,
} from "../conformance/processes.ts";

const darwin = process.platform === "darwin";
const HARNESS = { pid: 100, uid: 501 };

function row(overrides: Partial<ProcessRow> & { pid: number }): ProcessRow {
	return {
		ppid: 1,
		uid: 501,
		zombie: false,
		unresolved: false,
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
			row({ pid: 413, ppid: 412, zombie: true, unresolved: true, command: "(sh)" }),
		]);
	});
});

describe("which new processes are left behind", () => {
	const before = row({ pid: 200, ppid: 1, command: "/usr/bin/ssh-agent" });
	const baseline = new Set([identity(before), identity(row({ pid: HARNESS.pid, command: "node" }))]);
	const left = (...rows: ProcessRow[]) => unaccounted([before, ...rows], baseline, HARNESS).map((found) => found.pid);

	test("a new orphan running a program a side could choose is left behind", () => {
		expect(left(row({ pid: 300 }))).toEqual([300]);
	});

	test("a new descendant of such an orphan is left behind too", () => {
		expect(left(row({ pid: 300 }), row({ pid: 301, ppid: 300, command: "/bin/sleep" }))).toEqual([300, 301]);
	});

	test("a process already running before the side is not new, and a recycled pid is", () => {
		expect(left(before, row({ pid: 200, start: "Thu Oct 29 23:30:00 2026" }))).toEqual([200]);
	});

	test.each([
		["a child of the harness, like the ps it runs", row({ pid: 301, ppid: HARNESS.pid })],
		["a grandchild of the harness", row({ pid: 302, ppid: 301 })],
		["a child of a process that predates the side", row({ pid: 303, ppid: 200 })],
		["a service launchd started from a system directory", row({ pid: 304, command: "/usr/libexec/cfprefsd" })],
		["a process of another user", row({ pid: 305, uid: 0 })],
		["a zombie", row({ pid: 306, zombie: true, unresolved: true, command: "(sh)" })],
	])("%s is not left behind", (_name, other) => {
		expect(left(row({ pid: 301, ppid: HARNESS.pid }), other)).not.toContain(other.pid);
	});
});

describe.skipIf(!darwin)("the process table of this machine", () => {
	const dirs: string[] = [];
	const pids: number[] = [];

	afterEach(() => {
		for (const pid of pids.splice(0)) spawnSync("/bin/kill", ["-9", String(pid)]);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Starts a sleep whose parent exits at once, so it is an orphan with a program path, as a side's survivor is. */
	function startOrphan(): void {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-orphan-"));
		dirs.push(dir);
		spawnSync("/bin/sh", ["-c", `/bin/sleep 45 >/dev/null 2>&1 & echo $! > ${join(dir, "pid")}`]);
		pids.push(Number.parseInt(readFileSync(join(dir, "pid"), "utf8"), 10));
	}

	test("an orphan started after the baseline is found, and one started before it is not", async () => {
		startOrphan();
		const baseline = await takeBaseline();
		startOrphan();
		const [older, newer] = pids;

		const found = await findUnaccounted(baseline);

		expect(found.complete).toBe(true);
		expect(found.processes.map((process) => process.pid)).toEqual([newer]);
		expect(found.processes.map((process) => process.pid)).not.toContain(older);
	});

	test("a child of this process, which is the harness, is not found", async () => {
		const baseline = await takeBaseline();
		const child = spawn("/bin/sleep", ["45"], { stdio: "ignore" });
		pids.push(child.pid ?? 0);

		const found = await findUnaccounted(baseline);

		expect(found).toEqual({ complete: true, processes: [] });
	});

	test("a listing that cannot be read is incomplete, not empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-fake-ps-"));
		dirs.push(dir);
		const ps = join(dir, "ps");
		writeFileSync(ps, "#!/bin/sh\nexit 2\n", { mode: 0o755 });

		expect(await takeBaseline(ps)).toBeNull();
		expect(await findUnaccounted(await takeBaseline(), ps)).toEqual({ complete: false, processes: [] });
		expect(await findUnaccounted(null)).toEqual({ complete: false, processes: [] });
	});
});
