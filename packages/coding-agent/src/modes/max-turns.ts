/** Claude Code's `--max-turns`: ends a run once that many model requests have finished and tools were still called. */

import type { Agent, AgentTurnDecision } from "@earendil-works/pi-agent-core";

export interface TurnLimit {
	/** Whether the limit ended the run. */
	reached(): boolean;
	/** Puts the agent's turn hook back, once the run is over. */
	release(): void;
}

/**
 * Counts the model requests of one prompt and ends the run after the tool results of the request that
 * reaches `limit`. Zero or no limit never ends it. A negative limit ends it after the first request that
 * called a tool, as Claude Code does (measured).
 */
export function limitTurns(agent: Agent, limit: number | undefined): TurnLimit {
	if (limit === undefined || limit === 0) return { reached: () => false, release: () => {} };
	const previous = agent.finishTurn;
	let finished = 0;
	let reached = false;
	agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
		const decision = (await previous?.(turn, signal)) || undefined;
		if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
		finished += 1;
		if (finished < limit || turn.toolResults.length === 0) return decision;
		reached = true;
		return signal?.aborted ? decision : { action: "end" };
	};
	return {
		reached: () => reached,
		release: () => {
			agent.finishTurn = previous;
		},
	};
}
