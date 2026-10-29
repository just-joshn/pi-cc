import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ConformanceCase, loadCases } from "../conformance/case.ts";

const CASES_DIR = join(import.meta.dirname, "..", "conformance", "cases");

function loadOne(caseJson: Record<string, unknown>): ConformanceCase {
	const root = mkdtempSync(join(tmpdir(), "pi-cc-case-"));
	mkdirSync(join(root, "cli"), { recursive: true });
	writeFileSync(join(root, "cli", "probe.json"), JSON.stringify({ area: "cli", ...caseJson }));
	return loadCases(root)[0];
}

const MINIMAL_CASE = {
	id: "cli/probe",
	argv: [],
	model: null,
	compare: { exit: 0 },
};

describe("loadCases", () => {
	test("loads every shipped case", () => {
		const cases = loadCases(CASES_DIR);
		expect(cases.length).toBeGreaterThan(20);
	});

	test("rejects a misspelled compare key", () => {
		expect(() =>
			loadOne({
				...MINIMAL_CASE,
				compare: { ext: 0, stdout: { kind: "text", equals: "" } },
			}),
		).toThrow(/compare has unknown key "ext"/);
	});

	test("rejects a misspelled key inside a stdout spec", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { stdout: { kind: "text", eqals: "x" } } })).toThrow(
			/compare\.stdout has unknown key "eqals"/,
		);
	});

	test("rejects a misspelled key inside a request spec", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { requests: [{ pathStartWith: "/v1" }] } })).toThrow(
			/compare\.requests\[0\] has unknown key "pathStartWith"/,
		);
	});

	test("rejects a misspelled top-level key", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, compar: { exit: 0 } })).toThrow(/case has unknown key "compar"/);
	});

	test("rejects a case that runs a subcommand the harness must never reach", () => {
		for (const subcommand of ["login", "logout", "update", "install", "setup-token"]) {
			expect(() => loadOne({ ...MINIMAL_CASE, argv: [subcommand] })).toThrow(
				new RegExp(`argv must not run "${subcommand}"`),
			);
		}
	});

	test("rejects --update", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["--update"] })).toThrow(/argv must not contain "--update"/);
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["-p", "hi", "--update=now"] })).toThrow(
			/argv must not contain "--update=now"/,
		);
	});

	test("rejects the remaining subcommands that mutate or authenticate", () => {
		for (const token of ["plugins", "import", "gateway", "ultrareview", "rm", "--bg"]) {
			expect(() => loadOne({ ...MINIMAL_CASE, argv: [token] })).toThrow(new RegExp(`argv must not run "${token}"`));
			expect(() => loadOne({ ...MINIMAL_CASE, argv: ["-p", "hello", token] })).toThrow(
				new RegExp(`argv must not run "${token}"`),
			);
		}
	});
});

describe("turn shapes", () => {
	test("rejects a turn that sets two kinds", () => {
		expect(() =>
			loadOne({
				...MINIMAL_CASE,
				model: { turns: [{ text: "a", tool_use: { name: "Read", input: {} } }] },
			}),
		).toThrow(/model\.turns\[0\] must set exactly one of .* found text, tool_use/);
	});

	test("rejects a non-string text even when another kind is present", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, model: { turns: [{ text: 5, sse: [] }] } })).toThrow(
			/model\.turns\[0\] must set exactly one of .* found text, sse/,
		);
	});

	test("rejects a non-string text", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, model: { turns: [{ text: 5 }] } })).toThrow(
			/model\.turns\[0\]\.text must be a string/,
		);
	});

	test("rejects a turn that sets no kind", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, model: { turns: [{}] } })).toThrow(
			/model\.turns\[0\] must set exactly one of .* found none/,
		);
	});

	test("loads each turn kind", () => {
		const turns = [
			{ text: "hello" },
			{ tool_use: { name: "Read", input: { path: "a" } } },
			{ tool_uses: [{ name: "Read", input: { path: "a" } }] },
			{ sse: [{ event: "message" }] },
		];
		expect(loadOne({ ...MINIMAL_CASE, model: { turns } }).model?.turns).toEqual(turns);
	});
});

describe("stdout allowExtra", () => {
	test("loads a boolean allowExtra", () => {
		const loaded = loadOne({ ...MINIMAL_CASE, compare: { exit: 0, stdout: { kind: "help", allowExtra: false } } });
		expect(loaded.compare.stdout).toMatchObject({ kind: "help", allowExtra: false });
	});

	test("rejects a non-boolean allowExtra", () => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, compare: { exit: 0, stdout: { kind: "help", allowExtra: "yes" } } }),
		).toThrow(/compare\.stdout\.allowExtra must be a boolean/);
	});
});

const DENIED_ARGV: string[][] = [
	["upgrade"],
	["--verbose", "update"],
	["--", "login"],
	["--model", "x", "setup-token"],
	["LOGIN"],
	["auth", "logout"],
	["purge"],
	["respawn"],
	["plugin", "install", "x"],
];

describe("denied argv tokens", () => {
	test.each(DENIED_ARGV.map((argv) => [argv]))("rejects %j", (argv) => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv })).toThrow(/argv must not run "/);
	});

	test("names the offending token and the rule", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["--", "login"] })).toThrow(
			/argv must not run "login": the harness never runs a claude subcommand that authenticates, installs, or mutates/,
		);
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["--login"] })).toThrow(/argv must not run "--login"/);
	});
});

describe("probe table", () => {
	test.each([
		["ls", "/bin/ls"],
		["nc", "/usr/bin/nc"],
		["open", "/usr/bin/open"],
	])("resolves probe %s to %s", (probe, path) => {
		expect(loadOne({ ...MINIMAL_CASE, probe }).binary).toBe(path);
	});

	test("rejects a probe that is not in the table", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, probe: "sh" })).toThrow(/unknown probe "sh"/);
	});

	test("rejects a probe that is a path", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, probe: "/bin/sh" })).toThrow(/unknown probe "\/bin\/sh"/);
	});

	test("rejects case data that names a binary path", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, binary: "/bin/sh" })).toThrow(/case has unknown key "binary"/);
	});
});
