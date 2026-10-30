import type { Agent, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { limitTurns } from "../src/modes/max-turns.ts";

function agentWith(finishTurn?: Agent["finishTurn"]): Agent {
	return { finishTurn } as Agent;
}

function turn(stopReason: string, toolResults: unknown[]): AgentTurnContext {
	return { message: { stopReason }, toolResults } as unknown as AgentTurnContext;
}

describe("limitTurns", () => {
	test("ends the run after the tool results of the request that reaches the limit", async () => {
		const agent = agentWith();
		const limit = limitTurns(agent, 2);
		expect(await agent.finishTurn?.(turn("toolUse", [{}]), undefined)).toBeUndefined();
		expect(limit.reached()).toBe(false);
		expect(await agent.finishTurn?.(turn("toolUse", [{}]), undefined)).toEqual({ action: "end" });
		expect(limit.reached()).toBe(true);
	});

	test("lets a request without tool calls finish on its own", async () => {
		const agent = agentWith();
		const limit = limitTurns(agent, 1);
		expect(await agent.finishTurn?.(turn("stop", []), undefined)).toBeUndefined();
		expect(limit.reached()).toBe(false);
	});

	test("does not count a failed or aborted request", async () => {
		const agent = agentWith();
		const limit = limitTurns(agent, 1);
		await agent.finishTurn?.(turn("error", []), undefined);
		await agent.finishTurn?.(turn("aborted", []), undefined);
		expect(await agent.finishTurn?.(turn("toolUse", [{}]), undefined)).toEqual({ action: "end" });
		expect(limit.reached()).toBe(true);
	});

	test("zero and no limit leave the agent alone", () => {
		const agent = agentWith();
		for (const value of [0, undefined]) {
			const limit = limitTurns(agent, value);
			expect(agent.finishTurn).toBeUndefined();
			expect(limit.reached()).toBe(false);
		}
	});

	test("a negative limit ends the run after the first request that called a tool", async () => {
		const agent = agentWith();
		limitTurns(agent, -1);
		expect(await agent.finishTurn?.(turn("toolUse", [{}]), undefined)).toEqual({ action: "end" });
	});

	test("asks the hook it replaced first, and puts it back on release", async () => {
		const seen: string[] = [];
		const previous: Agent["finishTurn"] = async () => {
			seen.push("previous");
			return { action: "continue" };
		};
		const agent = agentWith(previous);
		const limit = limitTurns(agent, 5);
		expect(await agent.finishTurn?.(turn("toolUse", [{}]), undefined)).toEqual({ action: "continue" });
		expect(seen).toEqual(["previous"]);
		limit.release();
		expect(agent.finishTurn).toBe(previous);
	});
});
