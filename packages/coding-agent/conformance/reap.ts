/** Kills what a side left running, so nothing it started can change what the harness reads after it. */

import { spawnSync } from "node:child_process";

/**
 * Kills the side's process group and every process this run started that is still working inside the
 * side's root, then reports whether anything outlived the side. The group covers a child that stayed
 * in it. The sweep covers a SessionStart hook, which Claude Code spawns detached: the hook shell lands
 * in its own session, so `nohup ... &` inside it survives the group and has to be found in the process
 * table. Both run to completion before the caller hashes the workspace, so a delayed writer cannot
 * change what the case compared.
 */
export async function reap(pgid: number, root: string, startedAt: number): Promise<boolean> {
	killGroup(pgid);
	let survived = false;
	const deadline = Date.now() + 2_000;
	for (;;) {
		const stragglers = stragglersIn(root, startedAt);
		if (stragglers.length === 0) break;
		survived = true;
		for (const pid of stragglers) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		if (Date.now() >= deadline) break;
		await delay(25);
	}
	return survived;
}

export function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {}
}

/**
 * Processes that started after the run began and are still working inside the side's root. `ps` narrows
 * the table by start time first, because confirming every process's directory costs 20x more, and
 * `lsof` confirms the directory before anything is killed, so a process that merely started at the same
 * moment is never touched.
 */
function stragglersIn(root: string, startedAt: number): number[] {
	const listed = spawnSync("/bin/ps", ["-axo", "pid=,lstart="], { encoding: "utf8", timeout: 5_000 });
	if (listed.stdout === null || listed.error !== undefined) {
		warnOnce("survivor sweep unavailable: /bin/ps could not list processes");
		return [];
	}
	const candidates: number[] = [];
	let parsed = 0;
	for (const line of listed.stdout.split("\n")) {
		const fields = /^\s*(\d+)\s+(\S+ \S+ \S+ \S+ \S+)\s*$/.exec(line);
		if (fields === null) continue;
		parsed += 1;
		const pid = Number.parseInt(fields[1], 10);
		const started = Date.parse(fields[2]);
		// `lstart` has one-second resolution, so a process that started just before the run still counts.
		if (pid === process.pid || (!Number.isNaN(started) && started + 1_000 < startedAt)) continue;
		candidates.push(pid);
	}
	if (parsed === 0) {
		warnOnce("survivor sweep unavailable: /bin/ps no longer prints a start time this harness reads");
		return [];
	}
	if (candidates.length === 0) return [];
	const cwd = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", candidates.join(","), "-w", "-n", "-P", "-Fpn"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (cwd.stdout === null || cwd.error !== undefined) {
		warnOnce("survivor sweep unavailable: /usr/sbin/lsof could not report working directories");
		return [];
	}
	const pids: number[] = [];
	let pid: number | null = null;
	for (const line of cwd.stdout.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number.parseInt(line.slice(1), 10);
			continue;
		}
		if (line.startsWith("n") && pid !== null) {
			const path = line.slice(1);
			if (path === root || path.startsWith(`${root}/`)) pids.push(pid);
		}
	}
	return pids;
}

export const WARNINGS: string[] = [];

/** One line on the console and in the report, so a sweep that cannot run is not mistaken for a clean one. */
function warnOnce(message: string): void {
	if (WARNINGS.includes(message)) return;
	WARNINGS.push(message);
	console.warn(message);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
