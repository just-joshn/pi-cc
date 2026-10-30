/**
 * Which processes exist after a side exits that did not exist before it started. This is the harness's
 * answer to a process the working-directory and open-file scans cannot see: one that changed to `/`, holds
 * no file, and is replaced by a fresh pid every few milliseconds. A scan that looks for what a process holds
 * misses it however often it runs, but the process table still lists it, because every generation is new.
 *
 * A process is identified by its pid and its start time, so a recycled pid is a different process. The
 * baseline is every identity listed before the side started. Afterwards every new live process of the
 * harness's user counts as left behind, except the ones that provably belong to someone else:
 * a descendant of the harness itself (the `ps` and `lsof` it runs), a descendant of a process that was
 * already running before the side (another terminal, another conformance run), and a service launchd
 * starts from a system directory. What remains is a process that was started during the run, whose
 * parent is gone, and that runs a program a side could have chosen. It is reported and never signalled,
 * because the harness cannot prove it is the side's.
 *
 * Several listings are taken and their findings are united, not intersected: a chain that changes pid
 * between listings has no pid that appears in two of them, and one new process in any listing is enough.
 * A listing that cannot be read is not an empty one, so it is reported as incomplete.
 *
 * What this cannot see: a process that runs a program under a system service directory, a process that
 * exits before the listings (it holds nothing and writes nothing afterwards by definition), and a
 * descendant of a process that predates the side. A concurrent conformance run whose own side leaves an
 * orphan during this window is reported here too, as a process nobody can tell apart.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Baseline = ReadonlySet<string>;

export interface ProcessRow {
	pid: number;
	ppid: number;
	uid: number;
	zombie: boolean;
	/** `ps` could not resolve the program because the process exited between the table and the lookup, and prints its name in parentheses. */
	unresolved: boolean;
	/** The `lstart` text, which has one-second resolution and together with the pid identifies a process. */
	start: string;
	/** The executable path, not argv, so a process cannot disguise what it runs. */
	command: string;
}

export interface Unaccounted {
	/** False when the baseline is missing or a listing could not be read, so an empty `processes` proves nothing. */
	complete: boolean;
	processes: ProcessRow[];
}

const PS = "/bin/ps";
const LISTINGS = 4;
const LISTING_GAP_MS = 25;
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** Where launchd starts services from. A side's own program is never installed here. */
const SYSTEM_SERVICE_ROOTS = [
	"/System/",
	"/usr/libexec/",
	"/usr/sbin/",
	"/sbin/",
	"/usr/lib/",
	"/Library/",
	"/Applications/",
];

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/;

const execFileAsync = promisify(execFile);

/** The identities of every process running now, or null when the listing cannot be read. */
export async function takeBaseline(ps: string = PS): Promise<Baseline | null> {
	const rows = await listProcesses(ps);
	return rows === null ? null : new Set(rows.map(identity));
}

/** The new processes any of several listings shows, or an incomplete result when one cannot be read. */
export async function findUnaccounted(baseline: Baseline | null, ps: string = PS): Promise<Unaccounted> {
	if (baseline === null) return { complete: false, processes: [] };
	const resolved = new Map<string, ProcessRow>();
	const unresolved = new Map<string, ProcessRow>();
	const harness = { pid: process.pid, uid: userId() };
	const result = (complete: boolean): Unaccounted => ({
		complete,
		// One unresolved row cannot be told from a process that exited while the listing ran. A fast
		// chain shows a different one in every listing, so two are taken as a chain.
		processes: [...resolved.values(), ...(unresolved.size >= 2 ? unresolved.values() : [])],
	});
	for (let listing = 0; listing < LISTINGS; listing++) {
		if (listing > 0) await delay(LISTING_GAP_MS);
		const rows = await listProcesses(ps);
		if (rows === null) return result(false);
		for (const row of unaccounted(rows, baseline, harness))
			(row.unresolved ? unresolved : resolved).set(identity(row), row);
	}
	return result(true);
}

/** The rows of one listing that are new, the harness user's, alive, and not provably someone else's. */
export function unaccounted(
	rows: readonly ProcessRow[],
	baseline: Baseline,
	harness: { pid: number; uid: number },
): ProcessRow[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const isNew = (row: ProcessRow) => !baseline.has(identity(row));
	// Walks up through new parents to the first process that is not new. A parent that is gone or is
	// launchd makes the walk's last new process an orphan, which is what a side's survivor becomes.
	const belongsToSomeoneElse = (row: ProcessRow): boolean => {
		let current = row;
		for (;;) {
			if (current.ppid === harness.pid) return true;
			const parent = byPid.get(current.ppid);
			if (current.ppid <= 1 || parent === undefined) {
				return SYSTEM_SERVICE_ROOTS.some((root) => current.command.startsWith(root));
			}
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
			unresolved: fields[6].startsWith("("),
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
