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
import { formatIgnoredProjectSettings, formatSettingsFailures, formatSkippedSettings } from "../src/core/settings/cc/report.ts";

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
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5","sandbox":"not-an-object"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBeUndefined();
		expect(loaded.failures[0]).toMatchObject({ kind: "shape", source: "user", key: "sandbox" });
		expect(formatSettingsFailures(loaded.failures).slice(1)).toEqual([
			`  ${join(parts.config, "settings.json")} (sandbox): Expected object, but received string`,
		]);
	});

	test("a wrong hooks type is skipped and the rest of the file loads", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"model":"claude-haiku-4-5","hooks":"not-an-object"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.failures).toEqual([]);
		expect(loaded.settings.model).toBe("claude-haiku-4-5");
		expect(loaded.settings.values.hooks).toBeUndefined();
		expect(formatSkippedSettings(loaded.skipped)).toEqual([
			"These settings entries were skipped; the rest of each file is in effect:",
			`  ${path} (hooks): "hooks" must be an object mapping event names to matcher arrays; received string. This field was ignored.`,
		]);
	});

	test("a document with a whole-file problem reports only the whole-file block", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"model":5,"hooks":"not-an-object"}');
		const loaded = loadCcSettings(location(parts));
		expect(formatSkippedSettings(loaded.skipped)).toEqual([]);
		const lines = formatSettingsFailures(loaded.failures);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe(`  ${path} (model): Expected string, but received number`);
	});

	test("an empty file loads as no settings", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), "");
		write(join(parts.workspace, ".claude", "settings.json"), "   \n");
		const loaded = loadCcSettings(location(parts));
		expect(loaded.failures).toEqual([]);
		expect(loaded.settings.values).toEqual({});
	});

	test("a null file is reported as malformed JSON", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, "null");
		expect(formatSettingsFailures(loadCcSettings(location(parts)).failures).slice(1)).toEqual([
			`  ${path}: Invalid or malformed JSON`,
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

describe("env block", () => {
	test("coerces every value to a string", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(
			path,
			'{"env":{"CLAUDE_CODE_MAX_OUTPUT_TOKENS":4096,"PI_DEBUG":true,"FROM_ARRAY":[8192],"NULLED":null,"OBJECT":{}}}',
		);
		const loaded = loadCcSettings(location(parts));
		expect(loaded.failures).toEqual([]);
		expect(loaded.settings.env).toEqual({
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
			PI_DEBUG: "true",
			FROM_ARRAY: "8192",
			NULLED: "null",
			OBJECT: "[object Object]",
		});
	});

	test("an env block that is not a record rejects the file", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"model":"claude-haiku-4-5","env":"nope"}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBeUndefined();
		expect(formatSettingsFailures(loaded.failures).slice(1)).toEqual([
			`  ${path} (env): Expected record, but received string`,
		]);
	});
});

describe("permissions", () => {
	test("a rule list that is not an array rejects the file", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5"}');
		write(join(parts.workspace, ".claude", "settings.json"), '{"model":"claude-sonnet-4-5"}');
		const localPath = join(parts.workspace, ".claude", "settings.local.json");
		write(localPath, '{"permissions":{"allow":"Read"}}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.settings.model).toBe("claude-sonnet-4-5");
		expect(formatSettingsFailures(loaded.failures).slice(1)).toEqual([
			`  ${localPath} (permissions.allow): Expected array, but received string`,
		]);
	});

	test("a non-string rule is removed and reported as skipped", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"model":"claude-haiku-4-5","permissions":{"allow":["Read",1],"deny":["Bash"]}}');
		const loaded = loadCcSettings(location(parts));
		expect(loaded.failures).toEqual([]);
		expect(loaded.settings.model).toBe("claude-haiku-4-5");
		expect(loaded.settings.values.permissions).toEqual({ allow: ["Read"], deny: ["Bash"] });
		expect(formatSkippedSettings(loaded.skipped).slice(1)).toEqual([
			`  ${path} (permissions.allow): Non-string value in allow array was removed`,
		]);
	});

	test("a non-string additional directory rejects the file", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"permissions":{"additionalDirectories":[1]}}');
		expect(formatSettingsFailures(loadCcSettings(location(parts)).failures).slice(1)).toEqual([
			`  ${path} (permissions.additionalDirectories.0): Expected string, but received number`,
		]);
	});

	test("an unknown default mode reports the enumerated values", () => {
		const parts = side();
		const path = join(parts.config, "settings.json");
		write(path, '{"permissions":{"defaultMode":"nope"}}');
		expect(formatSettingsFailures(loadCcSettings(location(parts)).failures).slice(1)).toEqual([
			`  ${path} (permissions.defaultMode): Invalid value. Expected one of: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"`,
		]);
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

	test("a missing --settings path is fatal", () => {
		const parts = side();
		const path = join(parts.workspace, "absent.json");
		expect(loadCcSettings(location(parts, { flagSettings: path })).flagError).toBe(`Settings file not found: ${path}`);
	});

	test("a directory passed to --settings is fatal", () => {
		const parts = side();
		const dir = join(parts.workspace, "settings-dir");
		mkdirSync(dir, { recursive: true });
		const loaded = loadCcSettings(location(parts, { flagSettings: dir }));
		expect(loaded.flagError).toContain("Cannot use settings file (");
		expect(loaded.flagError).toContain(dir);
	});

	test("inline --settings JSON that does not parse is fatal", () => {
		expect(loadCcSettings(location(side(), { flagSettings: '{"model":}' })).flagError).toBe(
			"Invalid JSON provided to --settings",
		);
	});

	test("an empty --settings value is not a tier", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":"claude-haiku-4-5"}');
		const loaded = loadCcSettings(location(parts, { flagSettings: "   " }));
		expect(loaded.flagError).toBeUndefined();
		expect(loaded.failures).toEqual([]);
		expect(loaded.settings.model).toBe("claude-haiku-4-5");
		expect(loaded.searched).toHaveLength(4);
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
