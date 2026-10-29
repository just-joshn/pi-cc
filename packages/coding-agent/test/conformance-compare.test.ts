import { describe, expect, test } from "vitest";
import type { CompareSpec } from "../conformance/case.ts";
import type { Observation } from "../conformance/compare.ts";
import { compare } from "../conformance/compare.ts";

const CONTEXT = { sideRoot: "/run/side", realHome: "/Users/probe" };

function observation(overrides: Partial<Observation> = {}): Observation {
	return {
		timedOut: false,
		exitCode: 0,
		stdout: "",
		stderr: "",
		requests: [],
		workspaceBefore: new Map([["hook.log", "written"]]),
		workspaceAfter: new Map([["hook.log", "written"]]),
		fileText: new Map([["hook.log", "inside=ok\nescape=denied\n"]]),
		forbiddenPathsFound: [],
		...overrides,
	};
}

function checks(spec: CompareSpec, overrides: Partial<Observation> = {}): string[] {
	return compare(spec, observation(overrides), CONTEXT).map((diff) => diff.check);
}

describe("compare.files", () => {
	test("passes when the declared file was written", () => {
		expect(checks({ files: ["hook.log"] }, { workspaceBefore: new Map([["hook.log", "seeded"]]) })).toEqual([]);
	});

	test("fails when the declared file was not written", () => {
		const diffs = compare({ files: ["hook.log"] }, observation({ workspaceAfter: new Map() }), CONTEXT);
		expect(diffs).toEqual([{ check: "files", expected: "hook.log written", actual: "absent" }]);
	});

	test("fails on a write the case did not declare", () => {
		const after = new Map([
			["hook.log", "written"],
			["surprise.txt", "hash"],
		]);
		const before = new Map([["hook.log", "written"]]);
		expect(checks({ files: ["hook.log"] }, { workspaceBefore: before, workspaceAfter: after })).toEqual(["files"]);
	});

	test("passes when every declared fragment is in the file", () => {
		expect(checks({ files: [{ path: "hook.log", contains: ["inside=ok", "escape=denied"] }] })).toEqual([]);
	});

	test("names the missing fragment", () => {
		const diffs = compare({ files: [{ path: "hook.log", contains: ["escape=ok"] }] }, observation(), CONTEXT);
		expect(diffs).toEqual([
			{ check: "files.contains", expected: "hook.log contains escape=ok", actual: "inside=ok" },
		]);
	});

	test("fails a fragment check when the file is absent", () => {
		const diffs = compare(
			{ files: [{ path: "hook.log", contains: ["inside=ok"] }] },
			observation({ workspaceAfter: new Map() }),
			CONTEXT,
		);
		expect(diffs.map((diff) => diff.check)).toEqual(["files"]);
	});
});

describe("compare.absent", () => {
	test("passes when nothing escaped", () => {
		expect(checks({ absent: ["/Users/probe/marker.txt"] })).toEqual([]);
	});

	test("fails and names the path that exists", () => {
		const diffs = compare(
			{ absent: ["/Users/probe/marker.txt"] },
			observation({ forbiddenPathsFound: ["/Users/probe/marker.txt"] }),
			CONTEXT,
		);
		expect(diffs).toEqual([{ check: "files.absent", expected: "/Users/probe/marker.txt absent", actual: "present" }]);
	});
});
