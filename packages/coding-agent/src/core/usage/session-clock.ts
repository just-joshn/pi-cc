/** Claude Code's session wall clock: one anchor plus an optional logical start. */

/** The clock's anchors, for in-process handoff. */
export interface SessionClockSnapshot {
	startMs: number;
	sessionStartMs: number | undefined;
}

/** The wall clock of a session. Wall duration includes idle time; only the transitions move the anchor. */
export class SessionClock {
	private startMs: number;
	private sessionStartMs: number | undefined;

	/** Starts the clock at `now`. */
	constructor(now: number = Date.now()) {
		this.startMs = now;
	}

	/** Wall duration since the anchor, idle included, floored at zero as Claude Code floors it. */
	elapsed(now: number = Date.now()): number {
		return Math.max(0, now - this.startMs);
	}

	/** Re-anchors to now, dropping the logical start: a fresh session was claimed. */
	restartClock(now: number = Date.now()): void {
		this.startMs = now;
		this.sessionStartMs = undefined;
	}

	/** Re-anchors to now: the conversation was reset (`/new`, `/clear`). */
	reset(now: number = Date.now()): void {
		this.restartClock(now);
	}

	/**
	 * Re-anchors so elapsed continues at `totalDuration`. Idle time between sessions counts: resuming a
	 * three-day-old session jumps the wall duration by the three days. The logical start clamps to the
	 * new anchor, as Claude Code's `anchorLogicalStart` does.
	 */
	restore(totalDuration: number, startTime: number | undefined, now: number = Date.now()): void {
		this.startMs = now - totalDuration;
		this.sessionStartMs = startTime === undefined ? undefined : Math.min(startTime, this.startMs);
	}

	/** The logical session start: the anchored start when one is set, else the wall anchor. */
	sessionStartTime(): number {
		return this.sessionStartMs ?? this.startMs;
	}

	/** The anchors. */
	snapshot(): SessionClockSnapshot {
		return { startMs: this.startMs, sessionStartMs: this.sessionStartMs };
	}
}
