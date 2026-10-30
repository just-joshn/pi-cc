/** When the Claude Code profile writes its prompt record: once per conversation, again after compaction, or per request. */

export type SnapshotDecision =
	/** Write the record: there is none yet, or compaction dropped it. */
	| "record"
	/** Keep the record as it is, on this request and every later one and resume. */
	| "reuse"
	/** Keep the record but render the prompt fresh for each request. */
	| "project";

export interface SnapshotState {
	/** `--system-prompt-snapshot` resolved: on records once, off renders every request. */
	snapshot: boolean;
	/** The transcript replays a prompt record. */
	hasRecord: boolean;
}

/** The one decision the session applies at each turn boundary. */
export function snapshotDecision(state: SnapshotState): SnapshotDecision {
	if (!state.hasRecord) return "record";
	return state.snapshot ? "reuse" : "project";
}
