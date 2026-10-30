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
		violations: [],
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

describe("compare.containment", () => {
	test("passes when the harness reports the violation the case planted", () => {
		expect(
			checks(
				{ containment: [{ kind: "escaping-symlink", path: "secret.log" }, { kind: "survivor" }] },
				{
					violations: [
						{ kind: "escaping-symlink", path: "secret.log" },
						{ kind: "survivor", path: null },
					],
				},
			),
		).toEqual([]);
	});

	test("fails on a violation the case did not plant", () => {
		const diffs = compare(
			{ containment: [] },
			observation({ violations: [{ kind: "escaping-symlink", path: "secret.log" }] }),
			CONTEXT,
		);
		expect(diffs).toEqual([
			{ check: "containment", expected: "no side violation", actual: "escaping-symlink at secret.log" },
		]);
	});

	test("fails when the harness did not report the planted violation", () => {
		expect(checks({ containment: [{ kind: "dangling-symlink", path: "dangling.log" }] })).toEqual(["containment"]);
		expect(checks({ containment: [{ kind: "survivor" }] }, { violations: [] })).toEqual(["containment"]);
	});

	test("matches the workspace anchor by kind alone", () => {
		expect(checks({ containment: [{ kind: "symlink" }] }, { violations: [{ kind: "symlink", path: null }] })).toEqual(
			[],
		);
		expect(
			compare(
				{ containment: [{ kind: "symlink" }] },
				observation({ violations: [{ kind: "symlink", path: "a.log" }] }),
				CONTEXT,
			),
		).toEqual([
			{ check: "containment", expected: "no side violation", actual: "symlink at a.log" },
			{ check: "containment", expected: "symlink", actual: "not reported" },
		]);
	});
});

describe("compare.requests", () => {
	const posted = {
		index: 0,
		path: "/v1/messages",
		method: "POST",
		headers: { authorization: "Bearer token", "anthropic-beta": "oauth-2025-04-20, other", "x-extra": "kept" },
		body: { model: "claude-sonnet-5-5" },
	};

	test("passes when the method and the named headers match, and ignores the rest", () => {
		expect(
			checks(
				{
					requests: [
						{
							method: "POST",
							headers: {
								authorization: "Bearer token",
								"x-api-key": null,
								"anthropic-beta": { contains: ["oauth-2025-04-20"], excludes: ["custom-beta"] },
							},
						},
					],
				},
				{ requests: [posted] },
			),
		).toEqual([]);
	});

	test("fails a method or header assertion when the side sent no request", () => {
		expect(
			checks(
				{
					requests: [
						{
							method: "PUT",
							headers: { authorization: "Bearer token" },
						},
					],
				},
				{ requests: [] },
			),
		).toEqual(["requests.method", "requests.headers"]);
	});

	test("names a method or header that does not match", () => {
		expect(checks({ requests: [{ method: "GET" }] }, { requests: [posted] })).toEqual(["requests.method"]);
		expect(checks({ requests: [{ headers: { authorization: null } }] }, { requests: [posted] })).toEqual([
			"requests.headers",
		]);
		expect(
			checks(
				{ requests: [{ headers: { "anthropic-beta": { excludes: ["oauth-2025-04-20"] } } }] },
				{ requests: [posted] },
			),
		).toEqual(["requests.headers"]);
	});

	test("bodyExcludes passes on a body without the text and fails on one with it", () => {
		const spec: CompareSpec = { requests: [{ pathStartsWith: "/v1/messages", bodyExcludes: ["secret"] }] };
		expect(checks(spec, { requests: [posted] })).toEqual([]);
		expect(checks(spec, { requests: [{ ...posted, body: { model: "secret" } }] })).toEqual(["requests.bodyExcludes"]);
	});

	test("bodyExcludes fails when no request matched, like bodyIncludes", () => {
		const excludes: CompareSpec = { requests: [{ pathStartsWith: "/v1/logs", bodyExcludes: ["secret"] }] };
		const includes: CompareSpec = { requests: [{ pathStartsWith: "/v1/logs", bodyIncludes: ["secret"] }] };
		expect(checks(excludes, { requests: [posted] })).toEqual(["requests.bodyExcludes"]);
		expect(checks(includes, { requests: [posted] })).toEqual(["requests.bodyIncludes"]);
	});
});

describe("compare.requests body patterns", () => {
	const request = (body: unknown) => ({ index: 0, path: "/v1/messages", method: "POST", headers: {}, body });
	const requests = [request({ system: "first" }), request({ messages: [{ content: "1\tx\n<system-reminder>" }] })];

	test("reads the last matched request's serialized body", () => {
		const spec: CompareSpec = {
			requests: [{ pathStartsWith: "/v1/messages", bodyMatch: ["\\\\n<system-reminder>"] }],
		};
		expect(checks(spec, { requests })).toEqual([]);
	});

	test("fails body patterns when the side sent no matching request", () => {
		const spec: CompareSpec = {
			requests: [{ pathStartsWith: "/v1/messages", bodyMatch: ["^"], bodyNotMatch: ["never-sent"] }],
		};
		expect(checks(spec, { requests: [] })).toEqual(["requests.bodyMatch", "requests.bodyNotMatch"]);
	});

	test("fails a pattern that must not match", () => {
		const spec: CompareSpec = { requests: [{ bodyMatch: ["first"], bodyNotMatch: ["system-reminder"] }] };
		expect(checks(spec, { requests })).toEqual(["requests.bodyMatch", "requests.bodyNotMatch"]);
	});
});
