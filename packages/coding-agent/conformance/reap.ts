/** Kills what a side left running, so nothing it started can change what the harness reads after it. */

import { spawnSync } from "node:child_process";

export interface ReapResult {
	/** Something this run started was still working inside the side's root after the side exited. */
	survived: boolean;
	/** Repeated scans found nothing, so the tree is gone. False means the scan failed or the deadline ran out. */
	converged: boolean;
}

type Sweep = { kind: "clean" } | { kind: "killed"; groups: number[] } | { kind: "unavailable" };

/** A scan that must come back empty this many times in a row before the tree counts as gone. */
const CLEAN_SWEEPS = 3;
const REAP_DEADLINE_MS = 10_000;
const LSOF = "/usr/sbin/lsof";

/**
 * Kills the side's process group and every process group still working inside the side's root, and
 * returns once repeated scans find nothing. The side's group covers a child that stayed in it. The scan
 * covers a SessionStart hook, which Claude Code spawns detached: the hook shell lands in its own process
 * group, so whatever it starts survives the side's group. A hook can re-fork faster than a scan runs
 * (`/bin/sh ./hop.sh & exit 0`: each generation starts the next and exits), so killing the pids a scan
 * saw would only kill ones that had already gone. Descendants keep their group, and `lsof` reports a
 * process's group together with its working directory, so the scan kills whole groups instead. A group
 * that was killed must also be gone from the kernel before the reap returns. A scan that cannot run is
 * not a clean scan: the reap reports that it did not converge. It returns before the caller hashes the
 * workspace, so a delayed writer cannot change what the case compared.
 */
export async function reap(pgid: number, root: string, lsof: string = LSOF): Promise<ReapResult> {
	killGroup(pgid);
	let survived = false;
	let clean = 0;
	const killed = new Set<number>();
	const deadline = Date.now() + REAP_DEADLINE_MS;
	while (clean < CLEAN_SWEEPS || [...killed].some(groupExists)) {
		if (Date.now() >= deadline) return { survived, converged: false };
		const sweep = sweepGroups(root, lsof);
		if (sweep.kind === "unavailable") return { survived, converged: false };
		if (sweep.kind === "killed") {
			survived = true;
			clean = 0;
			for (const group of sweep.groups) killed.add(group);
		} else {
			clean += 1;
		}
		for (const group of killed) killGroup(group);
		await delay(25);
	}
	return { survived, converged: true };
}

export function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {}
}

function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		// EPERM means the group exists and belongs to someone else, which still is not gone.
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

/**
 * One scan. `lsof` lists every process's group and working directory, and the groups with a member
 * inside the root are killed. The harness's own group and the system groups are never signalled.
 * Nothing narrows the scan by start time: the root is unique to this case and side, so a process working
 * inside it is this run's.
 */
function sweepGroups(root: string, lsof: string): Sweep {
	const cwd = spawnSync(lsof, ["-a", "-d", "cwd", "-w", "-n", "-P", "-Fpgn"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (cwd.stdout === null || cwd.error !== undefined || cwd.stdout.length === 0) {
		warnOnce("survivor sweep unavailable: /usr/sbin/lsof could not report working directories");
		return { kind: "unavailable" };
	}
	const own = ownGroup();
	if (own === null) {
		warnOnce("survivor sweep unavailable: /bin/ps could not report the harness's own process group");
		return { kind: "unavailable" };
	}
	const groups = new Set<number>();
	let group: number | null = null;
	for (const line of cwd.stdout.split("\n")) {
		if (line.startsWith("g")) {
			group = Number.parseInt(line.slice(1), 10);
			continue;
		}
		if (line.startsWith("n") && group !== null && group > 1 && group !== own) {
			const path = line.slice(1);
			if (path === root || path.startsWith(`${root}/`)) groups.add(group);
		}
	}
	for (const found of groups) killGroup(found);
	return groups.size === 0 ? { kind: "clean" } : { kind: "killed", groups: [...groups] };
}

function ownGroup(): number | null {
	const listed = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], {
		encoding: "utf8",
		timeout: 5_000,
	});
	const parsed = Number.parseInt(listed.stdout ?? "", 10);
	return listed.error !== undefined || Number.isNaN(parsed) ? null : parsed;
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
