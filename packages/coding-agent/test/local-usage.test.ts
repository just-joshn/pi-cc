import { describe, expect, test } from "vitest";
import { normalizeCommandName, parseLocalUsageCommand } from "../src/modes/local-usage.ts";
import type { LocalCommandFrame, ResultFrame } from "../src/modes/sdk/frames.ts";
import { SessionLedger } from "../src/modes/sdk/result.ts";
import { localCommandFrame } from "../src/modes/sdk/synthetic.ts";

describe("local usage command parsing", () => {
	test("matches the three aliases with optional arguments", () => {
		expect(parseLocalUsageCommand("/usage")).toEqual({ command: "usage", args: "" });
		expect(parseLocalUsageCommand("/cost")).toEqual({ command: "cost", args: "" });
		expect(parseLocalUsageCommand("  /stats  ")).toEqual({ command: "stats", args: "" });
		expect(parseLocalUsageCommand("/usage now please")).toEqual({ command: "usage", args: "now please" });
	});

	test("rejects everything else, /status included", () => {
		expect(parseLocalUsageCommand("/status")).toBeUndefined();
		expect(parseLocalUsageCommand("/usagex")).toBeUndefined();
		expect(parseLocalUsageCommand("what does /cost mean")).toBeUndefined();
		expect(parseLocalUsageCommand("usage")).toBeUndefined();
		expect(parseLocalUsageCommand("")).toBeUndefined();
	});

	test("normalizes command names the way the result frame reports them", () => {
		expect(normalizeCommandName("usage")).toBe("usage");
		expect(normalizeCommandName("Cost")).toBe("cost");
		expect(normalizeCommandName("some-plugin command!")).toBe("some_plugin_command_");
		expect(normalizeCommandName("x".repeat(80))).toHaveLength(64);
	});
});

describe("local command frames", () => {
	test("the assistant frame mirrors Claude Code's synthetic local-command row", () => {
		const frame: LocalCommandFrame = localCommandFrame({
			sessionId: "s1",
			text: "Total cost:            $0.0000",
			command: "cost",
			args: "",
		});
		expect(frame.type).toBe("assistant");
		expect(frame.parent_tool_use_id).toBeNull();
		expect(frame.local_command_source).toBe("local");
		expect(frame.local_command_run).toEqual({ command: "cost", args: "" });
		expect(frame.local_command_outcome).toEqual({ kind: "success" });
		expect(frame.session_id).toBe("s1");
		expect(frame.message).toMatchObject({
			role: "assistant",
			stop_reason: "end_turn",
			stop_sequence: null,
			content: [{ type: "text", text: "Total cost:            $0.0000" }],
		});
	});

	test("the result frame carries the command name and a zero usage block", () => {
		const ledger = new SessionLedger();
		const result: ResultFrame = ledger.localCommandResult("s1", 2_000, 1_000, "usage", "the block");
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
			local_command: "usage",
			result: "the block",
			stop_reason: "end_turn",
			num_turns: 1,
			duration_ms: 1_000,
			total_cost_usd: 0,
		});
		expect(result.usage).toMatchObject({
			input_tokens: 0,
			output_tokens: 0,
			server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
			service_tier: "standard",
			inference_geo: "",
			speed: "standard",
		});
		expect(result.model_usage_since_last_result).toEqual({});
	});

	test("a resumed session's local command result reports the restored total", () => {
		const ledger = new SessionLedger();
		ledger.seed(1.25);
		const result = ledger.localCommandResult("s1", 2_000, 1_000, "usage", "the block");
		expect(result.total_cost_usd).toBeCloseTo(1.25);
	});
});
