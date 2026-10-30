import type { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { gateBudget } from "../src/core/usage/budget.ts";

function fakeAgent(): Agent {
	return { finishTurn: undefined, beforeToolCall: undefined } as unknown as Agent;
}

describe("gateBudget", () => {
	test("blocks tools and ends the run once exhausted, then restores the hooks", async () => {
		const agent = fakeAgent();
		let exhausted = false;
		const gate = gateBudget(agent, () => exhausted);
		const turn = { message: { stopReason: "toolUse" } } as never;
		expect(await agent.beforeToolCall?.({} as never)).toBeUndefined();
		expect(await agent.finishTurn?.(turn)).toBeUndefined();
		exhausted = true;
		expect(await agent.beforeToolCall?.({} as never)).toMatchObject({ block: true, terminate: true });
		expect(await agent.finishTurn?.(turn)).toEqual({ action: "end" });
		gate.release();
		expect(agent.finishTurn).toBeUndefined();
		expect(agent.beforeToolCall).toBeUndefined();
	});

	test("lets an errored or aborted request keep its own decision", async () => {
		const agent = fakeAgent();
		gateBudget(agent, () => true);
		expect(await agent.finishTurn?.({ message: { stopReason: "error" } } as never)).toBeUndefined();
	});
});
