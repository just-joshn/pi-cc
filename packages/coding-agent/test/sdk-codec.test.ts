import { describe, expect, test } from "vitest";
import { parseInputLine } from "../src/modes/sdk/codec.ts";

describe("parseInputLine", () => {
	test("reads a user message with string content", () => {
		const line = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } });
		expect(parseInputLine(line)).toEqual({ kind: "user", content: "hello", text: "hello", images: [] });
	});

	test("reads text and base64 image blocks, and keeps the blocks for replay", () => {
		const blocks = [
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
			{ type: "text", text: "here" },
		];
		const input = parseInputLine(JSON.stringify({ type: "user", message: { role: "user", content: blocks } }));
		expect(input).toEqual({
			kind: "user",
			content: blocks,
			text: "look\nhere",
			images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		});
	});

	test("ignores an image block that is not base64", () => {
		const blocks = [{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }];
		const input = parseInputLine(JSON.stringify({ type: "user", message: { role: "user", content: blocks } }));
		expect(input).toMatchObject({ kind: "user", images: [] });
	});

	test("reads a control request with its id and body", () => {
		const line = JSON.stringify({
			type: "control_request",
			request_id: "r1",
			request: { subtype: "set_model", model: "x" },
		});
		expect(parseInputLine(line)).toEqual({
			kind: "control",
			requestId: "r1",
			request: { subtype: "set_model", model: "x" },
		});
	});

	test("keeps a control request without an id, as Claude Code answers it", () => {
		const line = JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } });
		expect(parseInputLine(line)).toEqual({
			kind: "control",
			requestId: undefined,
			request: { subtype: "interrupt" },
		});
	});

	test("ignores keep_alive, unknown types, control answers and user content that is not text or blocks", () => {
		for (const record of [
			{ type: "keep_alive" },
			{ type: "bogus" },
			{ type: "control_response", response: { subtype: "success", request_id: "r" } },
			{ type: "user", message: { role: "user", content: 7 } },
		]) {
			expect(parseInputLine(JSON.stringify(record))).toEqual({ kind: "ignored" });
		}
		expect(parseInputLine("[1,2]")).toEqual({ kind: "ignored" });
	});

	test("keeps a control request that has no subtype, which is answered as an unsupported one", () => {
		const line = JSON.stringify({ type: "control_request", request_id: "r4", request: {} });
		expect(parseInputLine(line)).toEqual({ kind: "control", requestId: "r4", request: {} });
	});

	test("marks a line that is not JSON invalid with Claude Code's message", () => {
		expect(parseInputLine("not json")).toEqual({
			kind: "invalid",
			message: "Error parsing streaming input line (type=unknown, 8 chars): SyntaxError",
		});
	});

	test("marks a user message without a user role invalid, naming the role it found", () => {
		const expected = (role: string) => ({
			kind: "invalid",
			message: `Error: Expected message role 'user', got '${role}'`,
		});
		expect(parseInputLine(JSON.stringify({ type: "user" }))).toEqual(expected("undefined"));
		expect(parseInputLine(JSON.stringify({ type: "user", message: "text" }))).toEqual(expected("undefined"));
		expect(parseInputLine(JSON.stringify({ type: "user", message: { content: "x" } }))).toEqual(
			expected("undefined"),
		);
		expect(parseInputLine(JSON.stringify({ type: "user", message: { role: "assistant", content: "x" } }))).toEqual(
			expected("assistant"),
		);
	});
});
