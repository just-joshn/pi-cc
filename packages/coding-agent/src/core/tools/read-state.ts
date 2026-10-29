/**
 * What the model has read, so a later Edit or Write can tell whether the file it means to change
 * is the file the model saw. One record store per session.
 */

/** One file as a Read returned it. */
export interface ReadRecord {
	/** The whole file, without a byte-order mark, with line endings normalized to `\n`. */
	readonly content: string;
	/** True when the Read returned only part of the file. */
	readonly partial: boolean;
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
