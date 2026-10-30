import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeStdin } from "../conformance/stdin.ts";

afterEach(() => vi.useRealTimers());

describe("paced stdin", () => {
	test("a waitfor timeout fails and never sends the remaining input", async () => {
		vi.useFakeTimers();
		const stream = new PassThrough();
		const written: string[] = [];
		stream.on("data", (chunk) => written.push(chunk.toString()));
		const result = writeStdin(stream, { kind: "stream-json", lines: ["#waitfor ready", "must not run"] }, () => "");
		const assertion = expect(result).rejects.toThrow(/waitfor.*ready/);
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		expect(written).toEqual([]);
	});
	test("waits for output before sending the next line", async () => {
		vi.useFakeTimers();
		const stream = new PassThrough();
		let stdout = "";
		const written: string[] = [];
		stream.on("data", (chunk) => written.push(chunk.toString()));
		const result = writeStdin(stream, { kind: "stream-json", lines: ["#waitfor ready", "go"] }, () => stdout);
		expect(written).toEqual([]);
		stdout = "ready";
		await vi.advanceTimersByTimeAsync(50);
		await result;
		expect(written).toEqual(["go\n"]);
	});
});
