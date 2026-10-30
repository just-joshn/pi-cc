/** Kills what a side left running, so nothing it started can change what the harness reads after it. */

import { spawnSync } from "node:child_process";

export interface ReapResult {
	/** Something this run started was still working inside the side's root after the side exited. */
	survived: boolean;
	/** Consecutive sweeps found nothing, so the tree is gone. False means the deadline ran out first. */
	converged: boolean;
}

/** A sweep that must come back empty this many times in a row before the tree counts as gone. */
const CLEAN_SWEEPS = 3;
const REAP_DEADLINE_MS = 10_000;

/**
 * Kills the side's process group and every process group this run started that still works inside the
 * side's root, and returns once repeated sweeps find nothing. The side's group covers a child that
 * stayed in it. The sweep covers a SessionStart hook, which Claude Code spawns detached: the hook shell
 * lands in its own process group, so whatever it starts survives the side's group and has to be found
 * in the process table. A hook can re-fork faster than a sweep runs (`/bin/sh ./hop.sh & exit 0`: each
 * generation starts the next and exits), so a sweep that killed pids would only ever kill the one that
 * had already gone. Descendants keep their group, so the sweep freezes and kills whole groups instead.
 * It returns before the caller hashes the workspace, so a delayed writer cannot change what the case
 * compared.
 */
export async function reap(pgid: number, root: string, startedAt: number): Promise<ReapResult> {
	killGroup(pgid);
	let survived = false;
	let clean = 0;
	const deadline = Date.now() + REAP_DEADLINE_MS;
	while (clean < CLEAN_SWEEPS) {
		if (Date.now() >= deadline) return { survived, converged: false };
		if (sweepGroups(root, startedAt)) {
			survived = true;
			clean = 0;
		} else {
			clean += 1;
		}
		await delay(25);
	}
	return { survived, converged: true };
}

export function killGroup(pgid: number): void {
	signalGroup(pgid, "SIGKILL");
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {}
}

interface ProcessRow {
	pid: number;
	pgid: number;
	started: number;
}

/**
 * One sweep. `ps` lists every process with its group and start time. A group whose members all started
 * after the run began is a candidate, and it is frozen before anything else: a stopped process cannot
 * fork, so the chain stops where it is. `lsof` then confirms which frozen processes work inside the
 * side's root, the confirmed groups are killed, and every other candidate is resumed after at most one
 * `lsof` call. Returns whether any group was killed.
 */
function sweepGroups(root: string, startedAt: number): boolean {
	const rows = listProcesses();
	if (rows === null) return false;
	const own = rows.find((row) => row.pid === process.pid)?.pgid;
	const older = new Set<number>();
	const members = new Map<number, number[]>();
	for (const row of rows) {
		// `lstart` has one-second resolution, so a process that started just before the run still counts.
		if (row.started + 1_000 < startedAt || row.pid === process.pid) older.add(row.pgid);
		members.set(row.pgid, [...(members.get(row.pgid) ?? []), row.pid]);
	}
	const candidates = [...members.keys()].filter((group) => group > 1 && group !== own && !older.has(group));
	if (candidates.length === 0) return false;
	// Stop twice: a child forked while the first signal was delivered joins the group after it.
	for (const group of candidates) signalGroup(group, "SIGSTOP");
	for (const group of candidates) signalGroup(group, "SIGSTOP");
	const confirmed = groupsWorkingIn(root, candidates);
	for (const group of candidates) signalGroup(group, confirmed.has(group) ? "SIGKILL" : "SIGCONT");
	return confirmed.size > 0;
}

function listProcesses(): ProcessRow[] | null {
	const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8", timeout: 5_000 });
	if (listed.stdout === null || listed.error !== undefined) {
		warnOnce("survivor sweep unavailable: /bin/ps could not list processes");
		return null;
	}
	const rows: ProcessRow[] = [];
	for (const line of listed.stdout.split("\n")) {
		const fields = /^\s*(\d+)\s+(\d+)\s+(\S+ \S+ \S+ \S+ \S+)\s*$/.exec(line);
		if (fields === null) continue;
		const started = Date.parse(fields[3]);
		rows.push({
			pid: Number.parseInt(fields[1], 10),
			pgid: Number.parseInt(fields[2], 10),
			started: Number.isNaN(started) ? 0 : started,
		});
	}
	if (rows.length === 0) {
		warnOnce("survivor sweep unavailable: /bin/ps no longer prints a start time this harness reads");
		return null;
	}
	return rows;
}

/**
 * The candidate groups with a member whose working directory is inside the root. `lsof` selects by
 * group rather than by the pids `ps` listed, because the members have changed since: the pids in a
 * re-forking chain are dead by the time `lsof` runs, and its frozen members are new ones.
 */
function groupsWorkingIn(root: string, candidates: number[]): Set<number> {
	const confirmed = new Set<number>();
	const cwd = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-g", candidates.join(","), "-w", "-n", "-P", "-Fgn"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (cwd.stdout === null || cwd.error !== undefined) {
		warnOnce("survivor sweep unavailable: /usr/sbin/lsof could not report working directories");
		return confirmed;
	}
	let group: number | null = null;
	for (const line of cwd.stdout.split("\n")) {
		if (line.startsWith("g")) {
			group = Number.parseInt(line.slice(1), 10);
			continue;
		}
		if (line.startsWith("n") && group !== null) {
			const path = line.slice(1);
			if (path === root || path.startsWith(`${root}/`)) confirmed.add(group);
		}
	}
	return confirmed;
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
