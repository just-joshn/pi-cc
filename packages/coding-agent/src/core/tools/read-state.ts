/**
 * What the model has read, so a later Edit or Write can tell whether the file it means to change
 * is the file the model saw. One record store per session.
 */

/** One file as a Read returned it. */
export interface ReadRecord {
	/** The whole file, without a byte-order mark, with line endings normalized to `\n`. */
	readonly content: string;
	/** True unless the Read returned the whole file: Claude Code's full-read test (`PR`) failed. */
	readonly partial: boolean;
	/** The file's modification time in whole milliseconds when the model read or last wrote it, when known. */
	readonly timestamp?: number;
	/** True when the Read was cut at the token cap: Claude Code's `isPartialView`, an unfinished view that never counts as a read. */
	readonly unfinished?: boolean;
	/** True when an Edit changed the file without the model having read it, so the content is not in its context. */
	readonly unseen?: boolean;
}

export interface ReadState {
	record(absolutePath: string, record: ReadRecord): void;
	get(absolutePath: string): ReadRecord | undefined;
}

export function createReadState(): ReadState {
	const records = new Map<string, ReadRecord>();
	return {
		record(absolutePath, record) {
			records.set(absolutePath, record);
		},
		get(absolutePath) {
			return records.get(absolutePath);
		},
	};
}

/** The form two copies of a file are compared in: no byte-order mark, `\n` line endings. */
export function normalizeForComparison(text: string): string {
	return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
}

/** The modification time in whole milliseconds from the operations' own lookup, or undefined when they have none. */
export async function readMtimeMs(
	mtimeMs: ((absolutePath: string) => Promise<number>) | undefined,
	absolutePath: string,
): Promise<number | undefined> {
	if (mtimeMs === undefined) return undefined;
	try {
		return Math.floor(await mtimeMs(absolutePath));
	} catch {
		return undefined;
	}
}

/**
 * Claude Code's stale-read test (`chunk-r5cyd28m.js:124266-124269`, `:44880-44887`): the file is
 * stale when its modification time is newer than the read's, unless the read was a full read and
 * the content is unchanged. Without a modification time on either side the content decides.
 */
export function isStaleSinceRead(record: ReadRecord, mtimeMs: number | undefined, current: string): boolean {
	const unchanged = normalizeForComparison(current) === record.content;
	if (mtimeMs === undefined || record.timestamp === undefined) return !unchanged;
	return mtimeMs > record.timestamp && !(!record.partial && unchanged);
}
