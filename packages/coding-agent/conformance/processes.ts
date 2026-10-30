/**
 * Which processes exist after a side exits that did not exist before it started, and that the side's
 * sandbox ran. This is the harness's answer to a process the working-directory and open-file scans cannot
 * see: one that changed to `/`, holds no file, and is replaced by a fresh pid every few milliseconds. A
 * scan of what a process holds misses it however often it runs, but the process table still lists it,
 * because every generation is new, and the exec log (`execlog.ts`) says whose it is.
 *
 * A process is identified by its pid and its start time, so a recycled pid is a different process. The
 * baseline is every identity listed before the side started. Afterwards a process counts as left behind
 * when it is new, alive, the harness user's, ran a program under a harness sandbox profile since the
 * baseline, and does not descend from the harness or from a process that predates the side. The last
 * rule keeps another conformance run's live side out. Unrelated processes that merely started during the
 * run (indexers, other agents, a terminal) never ran under the profile, so busy machines do not fail cases.
 * A left-behind process is reported and never signalled, because a concurrent conformance run's orphan
 * cannot be told from the side's.
 *
 * Several listings are taken and their findings are united, not intersected: a chain that changes pid
 * between listings has no pid that appears in two of them, and one process in any listing is enough.
 * A missing baseline, an unreadable listing, or an exec log that cannot be confirmed current is not an
 * empty result, so each is reported as incomplete.
 *
 * What this cannot see: a process that exits before the listings, and a descendant of a process that
 * predates the side.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecLog } from "./execlog.ts";

export interface RunWatch {
	/** Every process running before the side started, by `identity`. */
	readonly identities: ReadonlySet<string>;
	/** When the side was about to start, in milliseconds. */
	readonly startedAt: number;
	readonly log: ExecLog;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	uid: number;
	zombie: boolean;
	/** The `lstart` text, which has one-second resolution and together with the pid identifies a process. */
	start: string;
	/** The executable path, or the name in parentheses when the process exited before `ps` resolved it. */
	command: string;
}

export interface LeftBehind {
	/** False when the watch is missing or a listing or the log could not be read, so an empty `processes` proves nothing. */
	complete: boolean;
	processes: ProcessRow[];
}

const PS = "/bin/ps";
const LISTINGS = 4;
const LISTING_GAP_MS = 25;
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
/** The log stamps a line when the kernel handles the exec, which can precede the harness's own clock reading. */
const CLOCK_SKEW_MS = 1_000;

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/;

const execFileAsync = promisify(execFile);

/** Notes what is running now and when, or returns null when the listing or the exec log is unavailable. */
export async function beginWatch(log: ExecLog | null, ps: string = PS): Promise<RunWatch | null> {
	if (log === null) return null;
	const startedAt = Date.now();
	const rows = await listProcesses(ps);
	return rows === null ? null : { identities: new Set(rows.map(identity)), startedAt, log };
}

/** The new processes of the side's sandbox that any of several listings shows, or an incomplete result. */
export async function findLeftBehind(watch: RunWatch | null, ps: string = PS): Promise<LeftBehind> {
	if (watch === null) return { complete: false, processes: [] };
	const found = new Map<string, ProcessRow>();
	const harness = { pid: process.pid, uid: userId() };
	for (let listing = 0; listing < LISTINGS; listing++) {
		if (listing > 0) await delay(LISTING_GAP_MS);
		const rows = await listProcesses(ps);
		if (rows === null) return { complete: false, processes: [...found.values()] };
		for (const row of unaccounted(rows, watch.identities, harness)) found.set(identity(row), row);
	}
	// The listings come first so that every pid they showed exec'd before the catch-up's own exec.
	if (!(await watch.log.catchUp())) return { complete: false, processes: [...found.values()] };
	const sandboxed = watch.log.executedSince(watch.startedAt - CLOCK_SKEW_MS);
	return { complete: true, processes: [...found.values()].filter((row) => sandboxed.has(row.pid)) };
}

/** The rows of one listing that are new, the harness user's, alive, and not descended from someone else. */
export function unaccounted(
	rows: readonly ProcessRow[],
	baseline: ReadonlySet<string>,
	harness: { pid: number; uid: number },
): ProcessRow[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const isNew = (row: ProcessRow) => !baseline.has(identity(row));
	// Walks up through new parents to the first process that is not new. A parent that is gone or is
	// launchd ends the walk at an orphan, which is what a side's survivor becomes.
	const belongsToSomeoneElse = (row: ProcessRow): boolean => {
		let current = row;
		for (;;) {
			if (current.ppid === harness.pid) return true;
			const parent = byPid.get(current.ppid);
			if (current.ppid <= 1 || parent === undefined) return false;
			if (!isNew(parent)) return true;
			current = parent;
		}
	};
	return rows.filter((row) => row.uid === harness.uid && !row.zombie && isNew(row) && !belongsToSomeoneElse(row));
}

export function identity(row: ProcessRow): string {
	return `${row.pid}@${row.start}`;
}

/** Parses `ps` output into rows, dropping lines that are not rows. */
export function parseProcessTable(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const fields = ROW.exec(line);
		if (fields === null) continue;
		rows.push({
			pid: Number.parseInt(fields[1], 10),
			ppid: Number.parseInt(fields[2], 10),
			uid: Number.parseInt(fields[3], 10),
			zombie: fields[4].startsWith("Z"),
			start: fields[5].replace(/\s+/g, " "),
			command: fields[6],
		});
	}
	return rows;
}

async function listProcesses(ps: string): Promise<ProcessRow[] | null> {
	try {
		const listed = await execFileAsync(ps, ["-axo", "pid=,ppid=,uid=,state=,lstart=,comm="], {
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: MAX_LISTING_BYTES,
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
		});
		const rows = parseProcessTable(listed.stdout);
		// A table without the harness in it is not this machine's table, however many rows it has.
		return rows.some((row) => row.pid === process.pid) ? rows : null;
	} catch {
		return null;
	}
}

function userId(): number {
	return process.getuid?.() ?? -1;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
