import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	type CcSettingsLocation,
	ccPolicyGate,
	ccProjectTrusted,
	loadCcSettings,
} from "../src/core/settings/cc/load.ts";
import { formatIgnoredProjectSettings, formatSettingsFailures } from "../src/core/settings/cc/report.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Side {
	root: string;
	config: string;
	workspace: string;
}

/** One isolated side, laid out the way the conformance harness lays out a case. */
function side(): Side {
	const root = mkdtempSync(join(tmpdir(), "pi-cc-settings-load-"));
	tempDirs.push(root);
	const config = join(root, "config");
	const workspace = join(root, "workspace");
	mkdirSync(config, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	return { root, config, workspace };
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function location(parts: Side, overrides: Partial<CcSettingsLocation> = {}): CcSettingsLocation {
	return {
		cwd: parts.workspace,
		home: join(parts.root, "home"),
		env: { CLAUDE_CONFIG_DIR: parts.config },
		platform: "darwin",
		version: "1.4.0",
		settingSources: undefined,
		projectTrusted: true,
		flagSettings: undefined,
		...overrides,
	};
}

describe("tier loading", () => {
	test("reads the user tier from CLAUDE_CONFIG_DIR", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBe("claude-haiku-4-5");
		expect(loaded.settings.sources.get("model")).toBe("user");
		expect(loaded.failures).toEqual([]);
	});

	test("reads the project and local tiers from the working directory", () => {
		const parts = side();
		write(join(parts.workspace, ".claude", "settings.json"), '{"model":"claude-sonnet-4-5"}');
		write(join(parts.workspace, ".claude", "settings.local.json"), '{"model":"claude-opus-4-5"}');
		expect(loadCcSettings(location(parts)).settings.model).toBe("claude-opus-4-5");
	});

	test("a missing file is not a failure and the path is still searched", () => {
		const parts = side();
		const loaded = loadCcSettings(location(parts));
		expect(loaded.failures).toEqual([]);
		expect(loaded.searched).toEqual([
			join(parts.config, "settings.json"),
			join(parts.workspace, ".claude", "settings.json"),
			join(parts.workspace, ".claude", "settings.local.json"),
			"/Library/Application Support/ClaudeCode/managed-settings.json",
		]);
	});

	test("a malformed tier is reported and the other tiers still load", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":');
		write(join(parts.workspace, ".claude", "settings.json"), '{"model":"claude-sonnet-4-5"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBe("claude-sonnet-4-5");
		expect(loaded.failures).toHaveLength(1);
		expect(loaded.failures[0]).toMatchObject({ kind: "malformed", source: "user" });
		expect(formatSettingsFailures(loaded.failures).slice(1)).toEqual([
			`  ${join(parts.config, "settings.json")}: Invalid or malformed JSON`,
		]);
	});

	test("a wrongly shaped tier names the key and contributes nothing", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5","hooks":"not-an-object"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBeUndefined();
		expect(loaded.failures[0]).toMatchObject({ kind: "shape", source: "user", key: "hooks" });
		expect(formatSettingsFailures(loaded.failures).slice(1)).toEqual([
			`  ${join(parts.config, "settings.json")} (hooks): Expected object, but received string`,
		]);
	});

	test("the block header matches the measured Claude Code wording", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), "[]");
		const lines = formatSettingsFailures(loadCcSettings(location(parts)).failures);
		expect(lines[0]).toContain("These settings files did not load");
		expect(lines[1]).toBe(`  ${join(parts.config, "settings.json")}: Expected object, but received array`);
	});
});

describe("setting sources", () => {
	test("--setting-sources project drops the user and local tiers", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5"}');
		write(join(parts.workspace, ".claude", "settings.json"), '{"model":"claude-sonnet-4-5"}');
		write(join(parts.workspace, ".claude", "settings.local.json"), '{"model":"claude-opus-4-5"}');
		expect(loadCcSettings(location(parts, { settingSources: ["project"] })).settings.model).toBe("claude-sonnet-4-5");
	});

	test("an empty source list admits no file tier but still admits the flag tier", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5","env":{"A":"user"}}');
		const loaded = loadCcSettings(
			location(parts, { settingSources: [], flagSettings: '{"model":"claude-fable-5"}' }),
		);
		expect(loaded.settings.model).toBe("claude-fable-5");
		expect(loaded.settings.env).toEqual({});
	});

	test("--setting-sources cannot exclude the policy tier", () => {
		const parts = side();
		const managed = "/Library/Application Support/ClaudeCode/managed-settings.json";
		const loaded = loadCcSettings(location(parts, { settingSources: ["project"] }));
		expect(loaded.searched).toContain(managed);
	});
});

describe("project trust", () => {
	test("an untrusted project skips project and local and lists the files it ignored", () => {
		const parts = side();
		const project = join(parts.workspace, ".claude", "settings.json");
		write(project, '{"model":"claude-sonnet-4-5"}');
		const loaded = loadCcSettings(location(parts, { projectTrusted: false }));
		expect(loaded.settings.model).toBeUndefined();
		expect(loaded.ignored).toEqual([project]);
		expect(formatIgnoredProjectSettings(loaded.ignored)).toEqual([`Ignoring untrusted project settings: ${project}`]);
	});

	test("an untrusted project with no .claude directory reports nothing", () => {
		expect(loadCcSettings(location(side(), { projectTrusted: false })).ignored).toEqual([]);
	});

	test("no trust decision allows the project tiers", () => {
		expect(ccProjectTrusted({ decision: null })).toBe(true);
	});

	test("a false trust entry denies them", () => {
		expect(ccProjectTrusted({ decision: false })).toBe(false);
	});

	test("a true trust entry allows them", () => {
		expect(ccProjectTrusted({ decision: true })).toBe(true);
	});

	test("--no-approve denies and --approve allows, over the store", () => {
		expect(ccProjectTrusted({ decision: true, trustOverride: false })).toBe(false);
		expect(ccProjectTrusted({ decision: false, trustOverride: true })).toBe(true);
	});

	test("defaultProjectTrust never denies an undecided path", () => {
		expect(ccProjectTrusted({ decision: null, defaultProjectTrust: "never" })).toBe(false);
		expect(ccProjectTrusted({ decision: null, defaultProjectTrust: "always" })).toBe(true);
		expect(ccProjectTrusted({ decision: true, defaultProjectTrust: "never" })).toBe(true);
	});
});

describe("flag tier", () => {
	test("inline JSON wins over every file tier", () => {
		const parts = side();
		write(join(parts.workspace, ".claude", "settings.local.json"), '{"model":"claude-opus-4-5"}');
		const loaded = loadCcSettings(location(parts, { flagSettings: '{"model":"claude-fable-5"}' }));
		expect(loaded.settings.model).toBe("claude-fable-5");
		expect(loaded.settings.sources.get("model")).toBe("flag");
	});

	test("a malformed --settings file is reported and skipped, never fatal", () => {
		const parts = side();
		const path = join(parts.workspace, "broken-settings.json");
		write(path, '{"model":');
		write(join(parts.workspace, ".claude", "settings.json"), '{"model":"claude-sonnet-4-5"}');
		const loaded = loadCcSettings(location(parts, { flagSettings: path }));
		expect(loaded.settings.model).toBe("claude-sonnet-4-5");
		const block = formatSettingsFailures(loaded.failures).join("\n");
		expect(block).toContain("did not load");
		expect(block).toContain("Invalid or malformed JSON");
		expect(block).toContain(path);
	});
});

describe("policy tier", () => {
	const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";

	test("no policy file leaves the policy empty", () => {
		const gate = ccPolicyGate({}, "1.4.0", MANAGED);
		expect(gate.refusal).toBeUndefined();
		expect(gate.policy.allowedProviders).toBeUndefined();
	});

	test("a policy above the running version refuses and names the file", () => {
		const gate = ccPolicyGate({ requiredMinimumVersion: "9.0.0" }, "1.4.0", MANAGED);
		expect(gate.refusal).toContain(MANAGED);
		expect(gate.refusal).toContain("above the running version");
	});

	test("an unusable provider list refuses and names the file", () => {
		const gate = ccPolicyGate({ allowedProviders: [] }, "1.4.0", MANAGED);
		expect(gate.refusal).toContain(MANAGED);
		expect(gate.refusal).toContain("allowedProviders");
	});

	test("a usable provider list is exposed without a refusal", () => {
		const gate = ccPolicyGate({ allowedProviders: ["anthropic"] }, "1.4.0", MANAGED);
		expect(gate.refusal).toBeUndefined();
		expect(gate.policy.allowedProviders).toEqual(["anthropic"]);
	});
});
