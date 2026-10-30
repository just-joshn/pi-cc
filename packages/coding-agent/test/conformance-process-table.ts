/**
 * Serializes the test files whose assertions depend on which processes exist. Vitest runs files in parallel,
 * and a re-forking chain one file starts shows up as a new process in another file's listing, so a file that
 * starts such processes or asserts that none are left must hold this lock while it runs.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "pi-cc-conformance-process-table.lock");
const WAIT_MS = 50;
const GIVE_UP_MS = 120_000;
/** A holder that crashed leaves the lock behind, so one older than any test file takes is taken over. */
const STALE_MS = 90_000;

export const PROCESS_TABLE_LOCK_TIMEOUT_MS = GIVE_UP_MS + 5_000;

/** Waits until no other test file holds the lock, then holds it. */
export async function acquireProcessTable(): Promise<void> {
	const deadline = Date.now() + GIVE_UP_MS;
	for (;;) {
		try {
			mkdirSync(LOCK);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`process table lock still held after ${GIVE_UP_MS}ms: ${LOCK}`);
			if (isStale()) rmSync(LOCK, { recursive: true, force: true });
			await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
		}
	}
}

export function releaseProcessTable(): void {
	rmSync(LOCK, { recursive: true, force: true });
}

function isStale(): boolean {
	try {
		return Date.now() - statSync(LOCK).mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}
