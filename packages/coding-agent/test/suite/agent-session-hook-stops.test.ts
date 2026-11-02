import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { createHarness } from "./harness.ts";

it.each([0, 1, 2])("a post-tool stop in case %s prevents continuation and Stop resurrection", async (testCase) => {
	const executed: string[] = [];
	const harness = await createHarness({
		tools: [
			{
				name: "bash",
				label: "bash",
				description: "test",
				parameters: Type.Object({ command: Type.String() }),
				execute: async (_id, params) => {
					const { command } = params as { command: string };
					executed.push(command);
					return { content: [{ type: "text", text: command }], details: {} };
				},
			},
		],
	});
	harness.session.agent.toolExecution = testCase === 2 ? "parallel" : "sequential";
	const stop = vi.fn(async () => ({ continue: true }));
	let calls = 0;
	Object.assign(harness.session, {
		_hooks: {
			beginRun() {},
			submitPrompt: async (text: string) => ({ text, context: [] }),
			preTool: async () => undefined,
			postTool: async (_call: unknown, _model: unknown, text: string) => ({
				text,
				...(calls++ === testCase % 2 ? { stop: "enough" } : {}),
			}),
			postBatch: async () => ({ append: "", stop: false }),
			stop,
		},
	});
	onTestFinished(harness.cleanup);
	harness.setResponses([
		fauxAssistantMessage(
			["one", "two", "three"].map((command) => fauxToolCall("bash", { command })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("must not continue"),
	]);
	await harness.session.prompt("go");
	expect(executed).toEqual(testCase === 2 ? ["one", "two", "three"] : ["one", "two"].slice(0, (testCase % 2) + 1));
	expect(harness.getPendingResponseCount()).toBe(1);
	expect(stop).not.toHaveBeenCalled();
	expect(harness.session.takeHookStop()).toEqual({ event: "PostToolUse", reason: "enough" });
});
it("invalid PermissionRequest input fails closed instead of running the original command", async () => {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: {} }));
	const harness = await createHarness({
		tools: [
			{
				name: "bash",
				label: "bash",
				description: "test",
				parameters: Type.Object({ command: Type.String() }),
				execute,
			},
		],
	});
	Object.assign(harness.session, {
		_permissionGate: {
			decide: async () => ({ action: "run", updatedInput: { command: 42 } }),
		},
	});
	onTestFinished(harness.cleanup);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "original" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	expect(execute).not.toHaveBeenCalled();
	expect(harness.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
});
