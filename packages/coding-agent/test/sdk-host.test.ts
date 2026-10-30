import { PassThrough } from "node:stream";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SdkHost, type SdkHostOptions } from "../src/modes/sdk/host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type Frame = Record<string, any>;

const echoTool: AgentTool = {
	name: "echo",
	label: "echo",
	description: "echo",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `echo:${(params as { value: string }).value}` }],
		details: {},
	}),
};

const userLine = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } });
const controlLine = (id: string, subtype: string, extra: object = {}) =>
	JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...extra } });

describe("SdkHost", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(
		options: Partial<SdkHostOptions>,
		prompts: string[],
		setup: (harness: Harness) => void,
		input = new PassThrough(),
		harnessOptions: Parameters<typeof createHarness>[0] = {},
	) {
		const harness = await createHarness({ tools: [echoTool], ...harnessOptions });
		harnesses.push(harness);
		setup(harness);
		const written: string[] = [];
		const failures: string[] = [];
		const host = new SdkHost(() => harness.session, {
			outputFormat: "stream-json",
			inputFormat: "text",
			verbose: true,
			includePartial: false,
			replayUser: false,
			permissionMode: "default",
			hasAuth: () => true,
			input,
			env: {},
			write: (text) => written.push(text),
			fail: (message) => failures.push(message),
			...options,
		});
		harness.session.subscribe((event) => host.onEvent(event));
		const exitCode = await host.run(prompts.map((text) => ({ content: text, text, images: [] })));
		const frames = written.flatMap((text) =>
			text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Frame),
		);
		return { frames, written, failures, exitCode, harness };
	}

	const label = (frame: Frame) => (frame.subtype ? `${frame.type}/${frame.subtype}` : frame.type);

	it("writes init, one assistant row per content block, the tool result, and a result for one turn", async () => {
		const { frames, exitCode } = await run({}, ["go"], (harness) =>
			harness.setResponses([
				fauxAssistantMessage([fauxText("looking"), fauxToolCall("echo", { value: "a" }, { id: "toolu_1" })], {
					stopReason: "toolUse",
					responseId: "msg_one",
				}),
				fauxAssistantMessage("done", { responseId: "msg_two" }),
			]),
		);

		expect(frames.map(label)).toEqual([
			"system/init",
			"assistant",
			"assistant",
			"user",
			"assistant",
			"result/success",
		]);
		expect(frames[1].message).toMatchObject({ id: "msg_one", content: [{ type: "text", text: "looking" }] });
		expect(frames[2].message).toMatchObject({
			id: "msg_one",
			content: [{ type: "tool_use", id: "toolu_1", name: "echo", input: { value: "a" } }],
		});
		expect(frames[3].message.content).toEqual([{ tool_use_id: "toolu_1", type: "tool_result", content: "echo:a" }]);
		expect(frames[3].tool_use_result).toBe("echo:a");
		expect(frames[5]).toMatchObject({ is_error: false, num_turns: 2, result: "done", terminal_reason: "completed" });
		expect(exitCode).toBe(0);
	});

	it("writes partial stream events around each block when asked, and a status before every request", async () => {
		const { frames } = await run({ includePartial: true }, ["go"], (harness) =>
			harness.setResponses([
				fauxAssistantMessage([fauxText("a"), fauxToolCall("echo", { value: "b" }, { id: "toolu_1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]),
		);

		const events = frames.map((frame) =>
			frame.type === "stream_event" ? `event/${frame.event.type}` : label(frame),
		);
		expect(events.slice(0, 5)).toEqual([
			"system/init",
			"system/status",
			"event/message_start",
			"event/content_block_start",
			"event/content_block_delta",
		]);
		expect(events.filter((entry) => entry === "system/status")).toHaveLength(2);
		const firstMessage = events.indexOf("event/message_stop");
		expect(events.slice(firstMessage - 1, firstMessage + 3)).toEqual([
			"event/message_delta",
			"event/message_stop",
			"user",
			"system/status",
		]);
		const stops = events.filter((entry) => entry === "event/content_block_stop");
		expect(stops).toHaveLength(3);
		const assistantBeforeStop = events.indexOf("assistant");
		expect(events[assistantBeforeStop + 1]).toBe("event/content_block_stop");
	});

	it("replays each stdin user message once, before the model answers", async () => {
		const input = new PassThrough();
		input.end(`${[userLine("one"), userLine([{ type: "text", text: "two" }])].join("\n")}\n`);
		const { frames } = await run(
			{ inputFormat: "stream-json", replayUser: true },
			[],
			(harness) => harness.setResponses([fauxAssistantMessage("A"), fauxAssistantMessage("B")]),
			input,
		);

		expect(frames.map(label)).toEqual([
			"system/init",
			"user",
			"assistant",
			"result/success",
			"system/init",
			"user",
			"assistant",
			"result/success",
		]);
		expect(frames[1]).toMatchObject({ isReplay: true, message: { role: "user", content: "one" } });
		expect(frames[5].message.content).toEqual([{ type: "text", text: "two" }]);
		expect(frames[7].result_index).toBe(1);
		expect(frames[7].total_cost_usd).toBeGreaterThanOrEqual(frames[3].total_cost_usd);
		expect(frames[7].num_turns).toBe(1);
	});

	it("answers control requests before the turn they precede, in order", async () => {
		const input = new PassThrough();
		input.end(
			`${[
				controlLine("r1", "set_permission_mode", { mode: "acceptEdits" }),
				controlLine("r2", "bogus_subtype"),
				controlLine("r3", "set_permission_mode", { mode: "nonsense" }),
				controlLine("r4", "interrupt"),
				userLine("go"),
			].join("\n")}\n`,
		);
		const { frames } = await run(
			{ inputFormat: "stream-json" },
			[],
			(harness) => harness.setResponses([fauxAssistantMessage("ok")]),
			input,
		);

		expect(frames.map(label)).toEqual([
			"control_response",
			"system/status",
			"control_response",
			"control_response",
			"control_response",
			"system/init",
			"assistant",
			"result/success",
		]);
		expect(frames[0].response).toEqual({ subtype: "success", request_id: "r1", response: { mode: "acceptEdits" } });
		expect(frames[1]).toMatchObject({ status: null, permissionMode: "acceptEdits" });
		expect(frames[2].response).toEqual({
			subtype: "error",
			request_id: "r2",
			error: "Unsupported control request subtype: bogus_subtype",
		});
		expect(frames[3].response).toMatchObject({ subtype: "error", request_id: "r3", error_code: "invalid_mode" });
		expect(frames[4].response).toEqual({ subtype: "success", request_id: "r4", response: { still_queued: [] } });
		expect(frames[5].permissionMode).toBe("acceptEdits");
	});

	it("answers initialize with Claude Code's 21 response keys", async () => {
		const input = new PassThrough();
		input.end(`${[controlLine("probe_req_1", "initialize"), userLine("go")].join("\n")}\n`);
		const { frames } = await run(
			{ inputFormat: "stream-json" },
			[],
			(harness) => harness.setResponses([fauxAssistantMessage("ok")]),
			input,
		);

		const { response } = frames[0];
		expect(Object.keys(response.response)).toEqual([
			"commands",
			"agents",
			"output_style",
			"available_output_styles",
			"user_output_styles_dir",
			"models",
			"account",
			"pid",
			"claude_code_version",
			"current_permission_mode",
			"feedback_mode",
			"analytics_disabled",
			"remote_control_auto_enable",
			"remote_control_auto_connect_default",
			"remote_control_available",
			"remote_control_auto_on_by_default",
			"ide_rc_auto_enable_gate",
			"fast_mode_state",
			"fast_mode_disabled_reason",
			"session_state",
			"capabilities",
		]);
		expect(response.request_id).toBe("probe_req_1");
		expect(response.pending_permission_requests).toEqual([]);
	});

	it("set_model switches to a known model and rejects an unknown one", async () => {
		const input = new PassThrough();
		input.end(
			`${[
				controlLine("a", "set_model", { model: "no-such-model" }),
				controlLine("b", "set_model"),
				controlLine("c", "set_model", { model: "faux-b" }),
				userLine("go"),
			].join("\n")}\n`,
		);
		const { frames, harness } = await run(
			{ inputFormat: "stream-json" },
			[],
			(h) => h.setResponses([fauxAssistantMessage("ok")]),
			input,
			{ models: [{ id: "faux-a" }, { id: "faux-b" }] },
		);

		expect(frames[0].response).toMatchObject({ subtype: "error", request_id: "a", error_code: "invalid_model" });
		expect(frames[1].response).toMatchObject({ subtype: "error", request_id: "b", error_code: "invalid_model" });
		expect(frames[2].response).toEqual({ subtype: "success", request_id: "c", response: { model: "faux-b" } });
		expect(harness.session.model?.id).toBe("faux-b");
		expect(frames[3].model).toBe("faux-b");
	});

	it("reads credentials for the model selected at turn time, so set_model to an authenticated model logs in", async () => {
		let current: Harness | undefined;
		const input = new PassThrough();
		input.end(`${[controlLine("a", "set_model", { model: "faux-b" }), userLine("go")].join("\n")}\n`);
		const { frames, exitCode } = await run(
			{ inputFormat: "stream-json", hasAuth: () => current?.session.model?.id === "faux-b" },
			[],
			(h) => {
				current = h;
				h.setResponses([fauxAssistantMessage("ok")]);
			},
			input,
			{ models: [{ id: "faux-a" }, { id: "faux-b" }] },
		);

		expect(frames.map(label)).toEqual(["control_response", "system/init", "assistant", "result/success"]);
		expect(frames[1]).toMatchObject({ model: "faux-b", apiKeySource: "oauth" });
		expect(frames[3]).toMatchObject({ is_error: false, result: "ok" });
		expect(exitCode).toBe(0);
	});

	it("keeps each model's own limits in the cumulative modelUsage after set_model", async () => {
		const input = new PassThrough();
		const { frames } = await run(
			{ inputFormat: "stream-json" },
			[],
			(h) => {
				h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
				let ended = 0;
				h.session.subscribe((event) => {
					if (event.type === "agent_end" && ++ended === 1) {
						input.write(`${controlLine("m", "set_model", { model: "faux-b" })}\n${userLine("again")}\n`);
						input.end();
					}
				});
				input.write(`${userLine("first")}\n`);
			},
			input,
			{
				models: [
					{ id: "faux-a", contextWindow: 1000, maxTokens: 100 },
					{ id: "faux-b", contextWindow: 2000, maxTokens: 200 },
				],
			},
		);

		const results = frames.filter((frame) => frame.type === "result");
		expect(results).toHaveLength(2);
		expect(results[1].modelUsage["faux-a"]).toMatchObject({ contextWindow: 1000, maxOutputTokens: 100 });
		expect(results[1].modelUsage["faux-b"]).toMatchObject({ contextWindow: 2000, maxOutputTokens: 200 });
	});

	it("interrupt during a running turn aborts it, answers, and still writes the turn's result", async () => {
		const input = new PassThrough();
		const blockingTool: AgentTool = {
			name: "block",
			label: "block",
			description: "waits for abort",
			parameters: Type.Object({}),
			execute: (_id, _params, signal) =>
				new Promise((resolve) => {
					input.write(`${controlLine("stop", "interrupt")}\n`);
					input.end();
					signal?.addEventListener("abort", () =>
						resolve({ content: [{ type: "text", text: "aborted" }], details: {} }),
					);
				}),
		};
		const { frames } = await run(
			{ inputFormat: "stream-json" },
			[],
			(h) =>
				h.setResponses([
					fauxAssistantMessage([fauxToolCall("block", {}, { id: "toolu_1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("never"),
				]),
			(() => {
				input.write(`${userLine("go")}\n`);
				return input;
			})(),
			{ tools: [blockingTool] },
		);

		expect(frames.find((frame) => frame.type === "control_response")?.response).toEqual({
			subtype: "success",
			request_id: "stop",
			response: { still_queued: [] },
		});
		expect(frames.at(-1)).toMatchObject({ type: "result" });
	});

	it("end_session answers and stops without running the queued message", async () => {
		const input = new PassThrough();
		input.end(`${[controlLine("r1", "end_session"), userLine("never")].join("\n")}\n`);
		const { frames, exitCode } = await run({ inputFormat: "stream-json" }, [], () => {}, input);

		expect(frames).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "r1" } }]);
		expect(exitCode).toBe(0);
	});

	it("fails with Claude Code's message on a line that is not JSON and writes no frame", async () => {
		const input = new PassThrough();
		input.end(`not json\n${userLine("go")}\n`);
		const { written, failures, exitCode } = await run({ inputFormat: "stream-json" }, [], () => {}, input);

		expect(written).toEqual([]);
		expect(failures).toEqual(["Error parsing streaming input line (type=unknown, 8 chars): SyntaxError"]);
		expect(exitCode).toBe(1);
	});

	it("reports a missing credential as frames and exit 1, without calling the model", async () => {
		const { frames, exitCode, harness } = await run({ hasAuth: () => false }, ["go"], (h) =>
			h.setResponses([fauxAssistantMessage("never")]),
		);

		expect(frames.map(label)).toEqual(["system/init", "assistant", "result/success"]);
		expect(frames[0].apiKeySource).toBe("none");
		expect(frames[1]).toMatchObject({ error: "authentication_failed", is_api_error_message: true });
		expect(frames[2]).toMatchObject({
			is_error: true,
			terminal_reason: "api_error",
			result: "Not logged in \u00b7 Please run /login",
		});
		expect(exitCode).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("json output writes one result document without the stream-only delta", async () => {
		const { written, frames } = await run({ outputFormat: "json", verbose: false }, ["go"], (h) =>
			h.setResponses([fauxAssistantMessage("ok")]),
		);

		expect(written).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "result", result: "ok", is_error: false });
		expect(frames[0]).not.toHaveProperty("model_usage_since_last_result");
	});

	it("json output with verbose writes every frame as one array", async () => {
		const { written } = await run({ outputFormat: "json", verbose: true }, ["go"], (h) =>
			h.setResponses([fauxAssistantMessage("ok")]),
		);

		expect(written).toHaveLength(1);
		const document = JSON.parse(written[0] as string) as Frame[];
		expect(document.map(label)).toEqual(["system/init", "assistant", "result/success"]);
	});

	it("reports a provider error as an error result and exit 1", async () => {
		const { frames, exitCode } = await run({}, ["go"], (h) =>
			h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]),
		);

		const result = frames.at(-1) as Frame;
		expect(result).toMatchObject({ type: "result", is_error: true, terminal_reason: "api_error" });
		expect(exitCode).toBe(1);
	});
});
