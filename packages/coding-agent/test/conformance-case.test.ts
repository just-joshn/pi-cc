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
		expect(cases.length).toBe(128);
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

	test("rejects env the harness owns", () => {
		for (const key of [
			"PATH",
			"HOME",
			"DISABLE_AUTOUPDATER",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_API_KEY",
		]) {
			expect(() => loadOne({ ...MINIMAL_CASE, env: { [key]: "/tmp/elsewhere" } })).toThrow(
				new RegExp(`env cannot replace "${key}" because the harness sets it`),
			);
		}
	});

	test("loads the env keys the ENV unit needs", () => {
		for (const key of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_CUSTOM_HEADERS",
			"ANTHROPIC_MODEL",
		]) {
			expect(loadOne({ ...MINIMAL_CASE, env: { [key]: "probe" } }).env).toEqual({ [key]: "probe" });
		}
	});

	test("loads the provider-env keys PR #6 selects models with", () => {
		for (const key of [
			"ANTHROPIC_SMALL_FAST_MODEL",
			"ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_DEFAULT_FABLE_MODEL",
		]) {
			expect(loadOne({ ...MINIMAL_CASE, env: { [key]: "claude-haiku-4-5" } }).env).toEqual({
				[key]: "claude-haiku-4-5",
			});
		}
	});

	test("removes only the reviewed harness key", () => {
		expect(loadOne({ ...MINIMAL_CASE, unset: ["ANTHROPIC_API_KEY"] }).unset).toEqual(["ANTHROPIC_API_KEY"]);
		for (const key of ["PATH", "HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
			expect(() => loadOne({ ...MINIMAL_CASE, unset: [key] })).toThrow(
				new RegExp(`unset names "${key}", which is not in the reviewed list`),
			);
		}
	});

	test("loads a request method and the header shapes a case asserts", () => {
		const requests = [
			{
				pathStartsWith: "/v1/messages",
				count: 1,
				method: "POST",
				headers: {
					authorization: "Bearer token",
					"x-api-key": null,
					"anthropic-beta": { contains: ["oauth-2025-04-20"], excludes: ["custom-beta"] },
				},
			},
		];
		expect(loadOne({ ...MINIMAL_CASE, compare: { requests } }).compare.requests).toEqual(requests);
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { requests: [{ method: " " }] } })).toThrow(
			/method must not be empty/,
		);
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { requests: [{ headers: { "": "x" } }] } })).toThrow(
			/empty header name/,
		);
	});

	test("rejects a timeout that is not a positive integer", () => {
		for (const value of [0, -1, 1.5]) {
			expect(() => loadOne({ ...MINIMAL_CASE, timeout_ms: value })).toThrow(/timeout_ms must be a positive integer/);
		}
	});

	test("keeps a positive integer timeout and the default", () => {
		expect(loadOne({ ...MINIMAL_CASE, timeout_ms: 1500 }).timeout_ms).toBe(1500);
		expect(loadOne(MINIMAL_CASE).timeout_ms).toBe(60000);
	});

	test("rejects a timeout Node cannot honor", () => {
		for (const value of [2 ** 31, 2 ** 60]) {
			expect(() => loadOne({ ...MINIMAL_CASE, timeout_ms: value })).toThrow(/timeout_ms must be at most 2147483647/);
		}
		expect(loadOne({ ...MINIMAL_CASE, timeout_ms: 2 ** 31 - 1 }).timeout_ms).toBe(2 ** 31 - 1);
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

interface VerifierRepro {
	label: string;
	argv?: string[];
	probe?: string;
	env?: Record<string, string>;
	stdin?: { kind: "text"; data: string };
}

/** One row per bypass a verification round reported, so a hole that reopens names itself. */
const VERIFIER_REPROS: VerifierRepro[] = [
	{
		label: "edit-permission-rules with permissions on stdin",
		argv: ["edit-permission-rules", "--json"],
		stdin: { kind: "text", data: '{"permissions":{"allow":[]}}' },
	},
	{ label: "edit-hook", argv: ["edit-hook"] },
	{ label: "edit-memory-settings", argv: ["edit-memory-settings"] },
	{ label: "edit-skill-overrides", argv: ["edit-skill-overrides"] },
	{ label: "edit-sandbox-settings", argv: ["edit-sandbox-settings"] },
	{ label: "edit-chrome-settings", argv: ["edit-chrome-settings"] },
	{ label: "import-conversations", argv: ["import-conversations"] },
	{ label: "drop-worktree-registrations", argv: ["drop-worktree-registrations"] },
	{ label: "design-login", argv: ["design-login"] },
	{ label: "apply-project-settings", argv: ["apply-project-settings"] },
	{ label: "remote-control", argv: ["remote-control"] },
	{ label: "rc", argv: ["rc"] },
	{ label: "mcp xaa setup", argv: ["mcp", "xaa", "setup"] },
	{ label: "mcp xaa clear", argv: ["mcp", "xaa", "clear"] },
	{ label: "--background", argv: ["--background"] },
	{ label: "--bg", argv: ["--bg"] },
	{ label: "stop", argv: ["stop", "probe-id"] },
	{ label: "kill", argv: ["kill", "probe-id"] },
	{ label: "attach", argv: ["attach", "probe-id"] },
	{ label: "auth", argv: ["auth"] },
	{ label: "LOGIN in any case", argv: ["LOGIN"] },
	{ label: "--login", argv: ["--login"] },
	{ label: "mcp add", argv: ["mcp", "add", "probe", "probe-command"] },
	{ label: "mcp list add", argv: ["mcp", "list", "add"] },
	{ label: "auto-mode reset -y", argv: ["auto-mode", "reset", "-y"] },
	{ label: "agents --cwd", argv: ["agents", "--cwd", "."] },
	{ label: "edit-hook after a prompt", argv: ["-p", "hello", "edit-hook"] },
	{ label: "--update", argv: ["--update"] },
	{ label: "--update=now after -p", argv: ["-p", "hi", "--update=now"] },
	{ label: "--worktree", argv: ["--worktree", "probe"] },
	{ label: "-w", argv: ["-w", "probe"] },
	{ label: "--plugin-dir", argv: ["--plugin-dir", "$WORKSPACE/p"] },
	{ label: "--plugin-url", argv: ["--plugin-url", "https://example.test/p.zip"] },
	{ label: "--file", argv: ["--file", "https://example.test/f"] },
	{ label: "--teleport", argv: ["--teleport"] },
	{ label: "--cloud", argv: ["--cloud"] },
	{ label: "--desktop", argv: ["--desktop"] },
	{ label: "--chrome", argv: ["--chrome"] },
	{ label: "--ide", argv: ["--ide"] },
	{ label: "--environment", argv: ["--environment", "probe"] },
	{ label: "--from-pr", argv: ["--from-pr", "1"] },
	{ label: "--tmux", argv: ["--tmux"] },
	{ label: "--remote-control-session-name-prefix", argv: ["--remote-control-session-name-prefix", "x"] },
	{ label: "nc -e", probe: "nc", argv: ["-e", "/bin/sh", "127.0.0.1", "1"] },
	{ label: "BUN_OPTIONS preload", env: { BUN_OPTIONS: "--preload=/tmp/probe.ts" } },
	{ label: "DYLD_LIBRARY_PATH", env: { DYLD_LIBRARY_PATH: "/tmp/probe" } },
	{ label: "DYLD_FRAMEWORK_PATH", env: { DYLD_FRAMEWORK_PATH: "/tmp/probe" } },
	{ label: "NODE_PATH", env: { NODE_PATH: "/tmp/probe" } },
	{ label: "NODE_OPTIONS", env: { NODE_OPTIONS: "--require=/tmp/probe.js" } },
	{ label: "CLAUDE_CODE_USE_BEDROCK", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
	{ label: "CLAUDE_CODE_USE_VERTEX", env: { CLAUDE_CODE_USE_VERTEX: "1" } },
	{ label: "CLAUDE_CODE_OAUTH_TOKEN", env: { CLAUDE_CODE_OAUTH_TOKEN: "probe" } },
	{ label: "GITHUB_TOKEN", env: { GITHUB_TOKEN: "probe" } },
	{ label: "CLAUDE_CODE_API_TOKEN_FILE_DESCRIPTOR", env: { CLAUDE_CODE_API_TOKEN_FILE_DESCRIPTOR: "3" } },
	{ label: "HTTPS_PROXY", env: { HTTPS_PROXY: "http://127.0.0.1:1" } },
	{ label: "ALL_PROXY", env: { ALL_PROXY: "http://127.0.0.1:1" } },
	{ label: "NODE_TLS_REJECT_UNAUTHORIZED", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
	{ label: "NODE_EXTRA_CA_CERTS", env: { NODE_EXTRA_CA_CERTS: "/tmp/probe.pem" } },
	{ label: "CLAUDE_CODE_API_BASE_URL", env: { CLAUDE_CODE_API_BASE_URL: "https://example.test" } },
	{ label: "PI_CONFORMANCE_PROBE", env: { PI_CONFORMANCE_PROBE: "1" } },
];

describe("reported bypasses", () => {
	test.each(VERIFIER_REPROS)("refuses $label", (repro: VerifierRepro) => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, probe: repro.probe, argv: repro.argv, env: repro.env, stdin: repro.stdin }),
		).toThrow(/is not in the reviewed allowlist|env cannot replace/);
	});
});

/** Every word the old denylist named, so dropping the list cannot quietly reopen one. */
const FORMERLY_DENIED: string[][] = [
	["auth"],
	["login"],
	["logout"],
	["install"],
	["uninstall"],
	["update"],
	["upgrade"],
	["setup-token"],
	["purge"],
	["respawn"],
	["plugin"],
	["plugins"],
	["migrate-installer"],
	["import"],
	["gateway"],
	["ultrareview"],
	["rm"],
	["bg"],
	["stop"],
	["kill"],
	["attach"],
	["mcp", "add", "probe", "probe-command"],
	["mcp", "remove", "probe"],
	["mcp", "add-json", "probe", "{}"],
	["mcp", "add-from-claude-desktop"],
	["mcp", "reset-project-choices"],
];

describe("words the old denylist refused", () => {
	test.each(FORMERLY_DENIED.map((argv) => [argv]))("still refuses %j", (argv) => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv })).toThrow(/is not in the reviewed allowlist/);
	});
});

describe("words only the pi-cc side may run", () => {
	test.each(["update", "upgrade"])("%s loads when the claude side is not applicable", (word) => {
		const loaded = loadOne({ ...MINIMAL_CASE, argv: [word], not_applicable: { claude: "no release feed" } });
		expect(loaded.argv).toEqual([word]);
	});

	test.each(["update", "upgrade"])("%s is refused when the claude side would run it", (word) => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: [word] })).toThrow(
			/is not in the reviewed allowlist for a case the claude side runs/,
		);
		expect(() => loadOne({ ...MINIMAL_CASE, argv: [word], not_applicable: { "pi-cc": "x" } })).toThrow(
			/is not in the reviewed allowlist for a case the claude side runs/,
		);
	});

	test("a probe never takes the word", () => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, probe: "ls", argv: ["update"], not_applicable: { claude: "x" } }),
		).toThrow(/PROBE_ARGV\.ls\.words/);
	});
});

describe("allowlist messages", () => {
	test("names the word and the list it belongs in", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["edit-permission-rules", "--json"] })).toThrow(
			/argv word "edit-permission-rules" is not in the reviewed allowlist, so add it to SIDE_ARGV\.words in conformance\/allowlist\.ts after review/,
		);
	});

	test("names the flag and the list it belongs in", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["--background"] })).toThrow(
			/argv flag "--background" is not in the reviewed allowlist, so add it to SIDE_ARGV\.flags/,
		);
	});

	test("names a short flag", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv: ["-w", "probe"] })).toThrow(
			/argv flag "-w" is not in the reviewed allowlist/,
		);
	});

	test("names the probe's own list", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, probe: "nc", argv: ["-e", "/bin/sh"] })).toThrow(
			/argv flag "-e" is not in the reviewed allowlist, so add it to PROBE_ARGV\.nc\.flags/,
		);
	});

	test("names the env key and the list it belongs in", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, env: { BUN_OPTIONS: "--preload=/tmp/probe.ts" } })).toThrow(
			/env key "BUN_OPTIONS" is not in the reviewed allowlist, so add it to CASE_ENV_KEYS in conformance\/allowlist\.ts after review/,
		);
	});
});

const READ_ONLY_ARGV: [string[], string?][] = [
	[["-p", "hello"]],
	[["-p", "Reply with exactly PROBE_OK"]],
	[["--output-format", "json"]],
	[["--model", "sonnet"]],
	[["--output-format=json"]],
	[["--settings", "{}"]],
	[["--setting-sources", "project"]],
	[["--model", "claude-haiku-4-5"]],
	[["--tools", "Read,Bash"]],
	[["--disallowedTools", "Agent,Bash"]],
	[["--permission-mode", "acceptEdits"]],
	[["-A", "$HOME"], "ls"],
];

describe("keeps the argv a case writes", () => {
	test.each(READ_ONLY_ARGV)("loads %j", (argv, probe) => {
		expect(loadOne({ ...MINIMAL_CASE, probe, argv }).argv).toEqual(argv);
	});
});

/** Entries no case writes, removed this round. A word or flag that creeps back names itself here. */
const SUBTRACTED: string[][] = [
	["mcp"],
	["mcp", "list"],
	["mcp", "get", "probe"],
	["agents", "--json"],
	["auto-mode", "config"],
	["auto-mode", "defaults"],
	["auto-mode", "critique"],
	["logs"],
	["doctor"],
	["text"],
	["high"],
	["--mcp-config", "probe"],
	["--agents=probe"],
	["--dangerously-skip-permissions"],
	["--print"],
	["probe"],
	["--add-dir", "."],
];

describe("entries no case writes", () => {
	test.each(SUBTRACTED.map((argv) => [argv]))("refuses %j", (argv) => {
		expect(() => loadOne({ ...MINIMAL_CASE, argv })).toThrow(/is not in the reviewed allowlist/);
	});
});

describe("file assertions", () => {
	test("loads a bare path and a path with fragments", () => {
		const files = ["a.txt", { path: "b.txt", contains: ["x"] }];
		expect(loadOne({ ...MINIMAL_CASE, compare: { exit: 0, files } }).compare.files).toEqual(files);
	});

	test("rejects a path that reaches outside the workspace", () => {
		for (const path of ["/etc/passwd", "../outside.txt", "a/../../b"]) {
			expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, files: [path] } })).toThrow(
				/must be relative to the workspace, without "\.\."/,
			);
			expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, files: [{ path }] } })).toThrow(
				/must be relative to the workspace, without "\.\."/,
			);
		}
	});

	test("rejects a misspelled fragment key", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, files: [{ path: "a", contain: ["x"] }] } })).toThrow(
			/compare\.files\[0\] has unknown key "contain"/,
		);
	});

	test("loads absent paths and rejects a relative one", () => {
		const absent = ["$REAL_HOME/marker.txt", "/tmp/marker.txt"];
		expect(loadOne({ ...MINIMAL_CASE, compare: { exit: 0, absent } }).compare.absent).toEqual(absent);
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, absent: ["marker.txt"] } })).toThrow(
			/must be absolute or start with a \$ placeholder/,
		);
	});
});

describe("not applicable sides", () => {
	test("loads a side with its reason", () => {
		const reason = "hooks land in P08";
		expect(loadOne({ ...MINIMAL_CASE, not_applicable: { "pi-cc": reason } }).notApplicable).toEqual({
			"pi-cc": reason,
		});
	});

	test("rejects a key that is not a side", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, not_applicable: { claude_code: "x" } })).toThrow(
			/not_applicable key "claude_code" is not a side \(claude, pi-cc\)/,
		);
	});

	test("rejects a reason that says nothing", () => {
		for (const reason of ["", "   "]) {
			expect(() => loadOne({ ...MINIMAL_CASE, not_applicable: { "pi-cc": reason } })).toThrow(/needs a reason/);
		}
		expect(() => loadOne({ ...MINIMAL_CASE, not_applicable: { "pi-cc": 7 } })).toThrow(
			/not_applicable\.pi-cc must be a string/,
		);
	});

	test("rejects a case that excludes every side", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, not_applicable: { claude: "a", "pi-cc": "b" } })).toThrow(
			/not_applicable names every side, so the case would assert nothing/,
		);
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

describe("containment declarations", () => {
	test("loads a planted violation with and without a path", () => {
		const containment = [{ kind: "escaping-symlink", path: "secret.log" }, { kind: "survivor" }];
		expect(loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment } }).compare.containment).toEqual(containment);
	});

	test("rejects a kind the harness cannot report", () => {
		expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind: "escape" }] } })).toThrow(
			/is not a violation kind/,
		);
	});

	test("rejects a path that reaches outside the workspace", () => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind: "symlink", path: "/etc/hosts" }] } }),
		).toThrow(/must be relative to the workspace, without "\.\."/);
	});

	test("rejects a path on a survivor, which is a process", () => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind: "survivor", path: "late.txt" }] } }),
		).toThrow(/is a process, not a path/);
	});

	test("rejects a misspelled key", () => {
		expect(() =>
			loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind: "symlink", target: "a" }] } }),
		).toThrow(/compare\.containment\[0\] has unknown key "target"/);
	});
});

describe("containment declarations that could never match", () => {
	test("rejects a link kind with no path", () => {
		for (const kind of ["escaping-symlink", "dangling-symlink"]) {
			expect(() => loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind }] } })).toThrow(
				/\.path is required/,
			);
		}
	});

	test("rejects a path spelling the scan never produces", () => {
		for (const path of ["./secret.log", "secret.log/"]) {
			expect(() =>
				loadOne({ ...MINIMAL_CASE, compare: { exit: 0, containment: [{ kind: "symlink", path }] } }),
			).toThrow(/without "\.\/" or a trailing "\/"/);
		}
	});
});
