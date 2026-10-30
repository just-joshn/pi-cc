import type { Agent, AgentTurnDecision } from "@earendil-works/pi-agent-core";

/** A run is over budget once its spend reaches the limit. A spend that is not a number counts as over. */
export function budgetExhausted(spentUsd: number, limitUsd: number | undefined): boolean {
	return limitUsd !== undefined && !(spentUsd < limitUsd);
}

/** The `errors` text of the `error_max_budget_usd` result. */
export function budgetErrorText(spentUsd: number, limitUsd: number): string {
	if (Number.isNaN(spentUsd)) {
		return `Session cost is not a number (a usage or pricing fault upstream); refusing to continue under --max-budget-usd ${limitUsd}`;
	}
	return `Reached maximum budget ($${limitUsd})`;
}

/** What the text output prints for a run that went over budget. */
export function budgetStopLine(limitUsd: number): string {
	return `Error: Exceeded USD budget (${limitUsd})`;
}

export interface BudgetGate {
	/** Puts the agent's hooks back, once the run is over. */
	release(): void;
}

/**
 * Ends a run as soon as `exhausted()` turns true. Tool calls the over-budget request asked for are
 * blocked instead of run, and the loop ends after that request.
 */
export function gateBudget(agent: Agent, exhausted: () => boolean): BudgetGate {
	const previousFinish = agent.finishTurn;
	const previousBefore = agent.beforeToolCall;
	agent.beforeToolCall = async (context, signal) => {
		if (exhausted()) return { block: true, reason: "Budget exhausted", terminate: true };
		return previousBefore?.(context, signal);
	};
	agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
		const decision = (await previousFinish?.(turn, signal)) || undefined;
		if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
		return exhausted() ? { action: "end" } : decision;
	};
	return {
		release: () => {
			agent.finishTurn = previousFinish;
			agent.beforeToolCall = previousBefore;
		},
	};
}
