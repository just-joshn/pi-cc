import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

export interface ReapResult {
	/** Something this run started was still working inside the side's root after the side exited. */
	survived: boolean;
	/** Repeated scans found nothing, so the tree is gone. False means the scan failed or the deadline ran out. */
	converged: boolean;
}

export interface ReapOptions {
	/** Where the workspace moved to after the side exited, which a process can still reach through a working directory or an open file. */
	moved?: string;
	/** The side's own process group, signalled once up front: a child that stayed in it holds nothing a scan sees. */
	group?: number;
	lsof?: string;
	deadlineMs?: number;
	/** Consecutive scans that must find nothing. The default is for the first reap; a check that already follows one can use fewer. */
	cleanSweeps?: number;
}

const CLEAN_SWEEPS = 3;
const REAP_DEADLINE_MS = 10_000;
const LSOF = "/usr/sbin/lsof";
const PS = "/bin/ps";
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const SAMPLES_PER_SWEEP = 4;
const SAMPLE_STAGGER_MS = 30;

const execFileAsync = promisify(execFile);

/**
 * Kills the side's own group when `group` is given, and every process group with a member working inside the side's root, or inside `moved` once the
 * workspace has moved, and returns once repeated scans find nothing. A member is a process whose working
 * directory or any open file is under one of those paths. A SessionStart hook is spawned detached, so
 * its shell lands in its own process group and whatever it starts survives the side's group.
 *
 * A hook can re-fork faster than a scan runs (`/bin/sh ./hop.sh & exit 0`: each generation starts the
 * next and exits), so the reap signals whole groups, which the kernel kills atomically, instead of the
 * pids a scan saw. A group is signalled only in a sweep that saw one of its members, never from an
 * earlier sweep's memory, because a group id can be recycled by an unrelated process once its members
 * are gone.
 *
 * Moving into another group (`set -m`) does not escape this: the process keeps its working directory,
 * so the next scan sees it and kills its new group. What does escape is a chain that moves into a new
 * group in every generation, which no signal outruns, and a process that is not working inside the
 * paths at all (`cd /` first, no file held), which no scan of what a process holds sees. The reap cannot
 * claim those are gone, so `scanWorkspace` follows it with a comparison of the process table against a
 * baseline taken before the side started (`processes.ts`). A scan that cannot run is not a clean scan, so
 * the reap then reports that it did not converge. It returns before the caller hashes the workspace, so
 * a delayed writer cannot change what the case compared.
 */
export async function reap(root: string, options: ReapOptions = {}): Promise<ReapResult> {
	const lsof = options.lsof ?? LSOF;
	const held = options.moved === undefined ? [root] : [root, options.moved];
	let survived = false;
	let clean = 0;
	const killed = new Set<number>();
	if (options.group !== undefined) killGroup(options.group);
	const deadline = Date.now() + (options.deadlineMs ?? REAP_DEADLINE_MS);
	const cleanSweeps = options.cleanSweeps ?? CLEAN_SWEEPS;
	while (clean < cleanSweeps || [...killed].some(groupExists)) {
		if (Date.now() >= deadline) return { survived, converged: false };
		const found = await observedGroups(held, lsof);
		if (found === null) return { survived, converged: false };
		if (found.size === 0) {
			clean += 1;
		} else {
			survived = true;
			clean = 0;
			for (const group of found) {
				killGroup(group);
				killed.add(group);
			}
		}
		await delay(25);
	}
	return { survived, converged: true };
}

export function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {}
}

/** Signal 0 only asks whether the group exists; it delivers nothing. */
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
 * The groups with a member working inside `held` in any of several overlapping scans, or null when a
 * scan could not run. One `lsof` run takes longer than a fast re-forking generation lives, and it sees
 * only the generations alive when it starts, so a single run often sees none. Runs started a few
 * milliseconds apart see different generations, and a sweep counts as clean only if all of them are.
 */
async function observedGroups(held: string[], lsof: string): Promise<Set<number> | null> {
	const own = ownGroup();
	if (own === null) {
		warnOnce("survivor sweep unavailable: /bin/ps could not report the harness's own process group");
		return null;
	}
	const listings = await Promise.all(
		Array.from({ length: SAMPLES_PER_SWEEP }, async (_, index) => {
			await delay(index * SAMPLE_STAGGER_MS);
			return listOpenFiles(lsof);
		}),
	);
	const groups = new Set<number>();
	for (const listing of listings) {
		if (listing === null) return null;
		let group: number | null = null;
		for (const line of listing.split("\n")) {
			if (line.startsWith("g")) {
				group = Number.parseInt(line.slice(1), 10);
			} else if (line.startsWith("n") && group !== null && held.some((path) => isInside(path, line.slice(1)))) {
				groups.add(group);
			}
		}
	}
	// Group 0 and 1 are the kernel and launchd, and the harness's own group is never the side's.
	for (const found of groups) if (found <= 1 || found === own) groups.delete(found);
	return groups;
}

async function listOpenFiles(lsof: string): Promise<string | null> {
	try {
		const listed = await execFileAsync(lsof, ["-w", "-n", "-P", "-Fpgfn"], {
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: MAX_LISTING_BYTES,
		});
		if (listed.stdout.length > 0) return listed.stdout;
	} catch {}
	warnOnce("survivor sweep unavailable: /usr/sbin/lsof could not report working directories and open files");
	return null;
}

function ownGroup(): number | null {
	const listed = spawnSync(PS, ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5_000 });
	const parsed = Number.parseInt(listed.stdout ?? "", 10);
	return listed.error !== undefined || Number.isNaN(parsed) ? null : parsed;
}

function isInside(directory: string, path: string): boolean {
	return path === directory || path.startsWith(`${directory}/`);
}

export const WARNINGS: string[] = [];

function warnOnce(message: string): void {
	if (WARNINGS.includes(message)) return;
	WARNINGS.push(message);
	console.warn(message);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
