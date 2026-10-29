/**
 * The prior-read record for one agent session.
 *
 * `Read` records what it returned and the file's modification time; `Edit` and `Write` consult it
 * to refuse a stale write. The store is in memory and lives as long as the session.
 */

import { stat as fsStat } from "node:fs/promises";

export interface ReadRecord {
	readonly content: string;
	readonly mtimeMs: number;
}

export interface ReadState {
	record(absolutePath: string, content: string): Promise<void>;
	get(absolutePath: string): ReadRecord | undefined;
}

export function createReadState(): ReadState {
	const records = new Map<string, ReadRecord>();
	return {
		async record(absolutePath, content) {
			const { mtimeMs } = await fsStat(absolutePath);
			records.set(absolutePath, { content, mtimeMs });
		},
		get(absolutePath) {
			return records.get(absolutePath);
		},
	};
}
