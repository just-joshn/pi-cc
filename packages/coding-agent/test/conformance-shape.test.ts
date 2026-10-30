import { describe, expect, test } from "vitest";
import { frameDiffs, shapeProblems } from "../conformance/shape.ts";

describe("shapeProblems", () => {
	test("requires the exact key set and flags an extra key", () => {
		expect(shapeProblems({ a: "$string" }, { a: "x" })).toEqual([]);
		expect(shapeProblems({ a: "$string" }, {})).toEqual(["$.a: missing"]);
		expect(shapeProblems({ a: "$string" }, { a: "x", b: 1 })).toEqual(["$.b: unexpected key"]);
	});

	test("an optional key may be absent but must match when present", () => {
		expect(shapeProblems({ "?a": "$number" }, {})).toEqual([]);
		expect(shapeProblems({ "?a": "$number" }, { a: 1 })).toEqual([]);
		expect(shapeProblems({ "?a": "$number" }, { a: "x" })).toEqual(['$.a: expected number, got string "x"']);
	});

	test("checks types, literals, null and nesting", () => {
		expect(
			shapeProblems(
				{ n: "$null", b: "$boolean", t: "done", o: { i: "$int" } },
				{ n: null, b: true, t: "done", o: { i: 2 } },
			),
		).toEqual([]);
		expect(shapeProblems("$int", 1.5)).toHaveLength(1);
		expect(shapeProblems("done", "other")).toHaveLength(1);
		expect(shapeProblems("$uuid", "not-a-uuid")).toHaveLength(1);
		expect(shapeProblems("$uuid", "0a7a5fd3-6894-4648-b782-bea059b1c205")).toEqual([]);
		expect(shapeProblems("$iso8601", "2026-10-29T07:59:21.138Z")).toEqual([]);
	});

	test("a plain array is a tuple, so length and order matter", () => {
		expect(shapeProblems(["$string", "$number"], ["a", 1])).toEqual([]);
		expect(shapeProblems(["$string", "$number"], [1, "a"])).toHaveLength(2);
		expect(shapeProblems(["$string"], ["a", "b"])).toEqual(["$: expected 1 elements, got 2"]);
	});

	test("combinators", () => {
		expect(shapeProblems({ $each: "$string" }, ["a", "b"])).toEqual([]);
		expect(shapeProblems({ $each: "$string" }, ["a", 1])).toHaveLength(1);
		expect(shapeProblems({ $map: "$number" }, { x: 1, y: 2 })).toEqual([]);
		expect(shapeProblems({ $oneOf: ["$string", "$null"] }, null)).toEqual([]);
		expect(shapeProblems({ $oneOf: ["$string", "$null"] }, 3)).toHaveLength(1);
		expect(shapeProblems({ $includes: ["Read", "Bash"] }, ["Bash", "Edit", "Read"])).toEqual([]);
		expect(shapeProblems({ $includes: ["Read", "Bash"] }, ["Read"])).toEqual(['$: missing "Bash"']);
		expect(shapeProblems({ $match: "^a+$" }, "aaa")).toEqual([]);
	});

	test("a reference expands a shape file and replaces dotted paths", () => {
		const frame = {
			type: "system",
			subtype: "status",
			status: "requesting",
			session_id: "0a7a5fd3-6894-4648-b782-bea059b1c205",
			uuid: "0a7a5fd3-6894-4648-b782-bea059b1c205",
		};
		expect(shapeProblems({ $ref: "cc-status-requesting" }, frame)).toEqual([]);
		expect(shapeProblems({ $ref: "cc-status-requesting", set: { status: "idle" } }, frame)).toHaveLength(1);
		expect(
			shapeProblems({ $ref: "cc-assistant-text", set: { "message.id": "msg_1" } }, frame).length,
		).toBeGreaterThan(0);
	});
});

describe("frameDiffs", () => {
	test("matches one shape per line in order and reports a count mismatch with the frame types", () => {
		const shapes = [{ type: "a" }, { type: "b" }];
		expect(frameDiffs(shapes, '{"type":"a"}\n{"type":"b"}\n', "frames")).toEqual([]);
		expect(frameDiffs(shapes, '{"type":"b"}\n{"type":"a"}\n', "frames")).toHaveLength(2);
		const missing = frameDiffs(shapes, '{"type":"a"}\n', "frames");
		expect(missing[0]?.actual).toContain("1 frames [a]");
	});

	test("a line that is not JSON is a diff", () => {
		expect(frameDiffs([{ type: "a" }], "nope\n", "frames")[0]?.expected).toBe("frame 0 parses");
	});
});
