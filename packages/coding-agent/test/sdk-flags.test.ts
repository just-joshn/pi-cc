import { describe, expect, test } from "vitest";
import { sdkFlagProblem, sdkOutputFormat } from "../src/modes/sdk/flags.ts";

describe("sdkOutputFormat", () => {
	test("selects the SDK host for the json formats only", () => {
		expect(sdkOutputFormat({ outputFormat: "json" })).toBe("json");
		expect(sdkOutputFormat({ outputFormat: "stream-json" })).toBe("stream-json");
		expect(sdkOutputFormat({ outputFormat: "text" })).toBeUndefined();
		expect(sdkOutputFormat({})).toBeUndefined();
	});

	test("an explicit --mode keeps pi's own protocols", () => {
		expect(sdkOutputFormat({ mode: "json", outputFormat: "stream-json" })).toBeUndefined();
		expect(sdkOutputFormat({ mode: "rpc", outputFormat: "json" })).toBeUndefined();
	});
});

describe("sdkFlagProblem", () => {
	test("stream-json input needs stream-json output", () => {
		const message = "Error: --input-format=stream-json requires output-format=stream-json.";
		expect(sdkFlagProblem({ inputFormat: "stream-json" })).toBe(message);
		expect(sdkFlagProblem({ inputFormat: "stream-json", outputFormat: "json" })).toBe(message);
		expect(sdkFlagProblem({ inputFormat: "stream-json", outputFormat: "stream-json" })).toBeUndefined();
	});

	test("replay needs both formats", () => {
		const message =
			"Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.";
		expect(sdkFlagProblem({ replayUserMessages: true, outputFormat: "stream-json" })).toBe(message);
		expect(
			sdkFlagProblem({ replayUserMessages: true, inputFormat: "stream-json", outputFormat: "stream-json" }),
		).toBeUndefined();
	});

	test("partial messages need stream-json output", () => {
		const message = "Error: --include-partial-messages requires --print and --output-format=stream-json.";
		expect(sdkFlagProblem({ includePartialMessages: true })).toBe(message);
		expect(sdkFlagProblem({ includePartialMessages: true, outputFormat: "json" })).toBe(message);
		expect(sdkFlagProblem({ includePartialMessages: true, outputFormat: "stream-json" })).toBeUndefined();
	});

	test("an explicit --mode skips every coupling", () => {
		expect(
			sdkFlagProblem({ mode: "json", inputFormat: "stream-json", includePartialMessages: true }),
		).toBeUndefined();
	});
});
