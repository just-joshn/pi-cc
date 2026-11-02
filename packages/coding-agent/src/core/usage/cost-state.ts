/** The cost-state record: what a session persists per finished turn and what a resume restores from it. */

import type { CostStateEntry, SessionEntry } from "../session-manager.ts";
import type { UsageReportInput } from "./report.ts";
import type { SessionClock } from "./session-clock.ts";

/** The totals a cost_state entry carries, Claude Code's cost-state record adapted to pi's entries. */
export type CostState = Omit<CostStateEntry, "type" | "id" | "parentId" | "timestamp">;

/** The newest cost_state entry's totals, last-wins; undefined when the session saved none. */
export function restoredCostState(entries: readonly SessionEntry[]): CostState | undefined {
	let restored: CostState | undefined;
	for (const entry of entries) {
		if (entry.type === "cost_state") restored = entry;
	}
	return restored;
}

/** The cost-state of a report input, timed by the clock that timed its wall duration. */
export function costStateOf(input: UsageReportInput, clock: SessionClock, now: number = Date.now()): CostState {
	return {
		totalDuration: clock.elapsed(now),
		startTime: clock.sessionStartTime(),
		totalCostUSD: input.totalCostUSD,
		totalAPIDuration: input.apiMs,
		totalLinesAdded: input.linesAdded,
		totalLinesRemoved: input.linesRemoved,
		modelUsage: Object.fromEntries(input.models),
		hasUnknownModelCost: input.hasUnknownModelCost,
	};
}
