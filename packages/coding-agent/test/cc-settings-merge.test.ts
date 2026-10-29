import { describe, expect, test } from "vitest";
import { mergeCcSettings, withAdditionalDirectories } from "../src/core/settings/cc/merge.ts";
import { EMPTY_CC_POLICY } from "../src/core/settings/cc/policy.ts";
import { CC_SETTINGS_ORDER, type CcSettingsDocument, type CcSettingsSource } from "../src/core/settings/cc/types.ts";

function document(source: CcSettingsSource, values: Record<string, unknown>): CcSettingsDocument {
	return { source, path: `/settings/${source}.json`, values };
}

describe("precedence", () => {
	test("orders the tiers as the one table says", () => {
		expect(CC_SETTINGS_ORDER).toEqual(["user", "project", "local", "flag", "policy"]);
	});

	test("the last tier to define a key wins", () => {
		const settings = mergeCcSettings(
			[
				document("user", { model: "user-model" }),
				document("project", { model: "project-model" }),
				document("local", { model: "local-model" }),
				document("flag", { model: "flag-model" }),
				document("policy", { model: "policy-model" }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.model).toBe("policy-model");
		expect(settings.sources.get("model")).toBe("policy");
	});

	test("document order inside one tier does not matter", () => {
		const settings = mergeCcSettings(
			[document("flag", { model: "second" }), document("flag", { model: "first" })],
			EMPTY_CC_POLICY,
		);
		expect(settings.model).toBe("first");
	});

	test("records which tier supplied each key", () => {
		const settings = mergeCcSettings(
			[document("user", { theme: "dark" }), document("project", { model: "project-model" })],
			EMPTY_CC_POLICY,
		);
		expect(settings.sources.get("theme")).toBe("user");
		expect(settings.sources.get("model")).toBe("project");
	});
});

describe("per-key merge rules", () => {
	test("arrays concatenate and dedupe", () => {
		const settings = mergeCcSettings(
			[document("user", { availableModels: ["a", "b"] }), document("project", { availableModels: ["b", "c"] })],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.availableModels).toEqual(["a", "b", "c"]);
	});

	test("fallbackModel is replaced, not concatenated", () => {
		const settings = mergeCcSettings(
			[document("user", { fallbackModel: "user-model" }), document("flag", { fallbackModel: "flag-model" })],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.fallbackModel).toBe("flag-model");
	});

	test("extraKnownMarketplaces and managedMcpServers shallow-merge", () => {
		const settings = mergeCcSettings(
			[
				document("user", { extraKnownMarketplaces: { one: { source: "a" } } }),
				document("project", { extraKnownMarketplaces: { two: { source: "b" } } }),
				document("policy", { managedMcpServers: { one: { command: "a" } } }),
				document("user", { managedMcpServers: { two: { command: "b" } } }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.extraKnownMarketplaces).toEqual({ one: { source: "a" }, two: { source: "b" } });
		expect(settings.values.managedMcpServers).toEqual({ one: { command: "a" }, two: { command: "b" } });
	});

	test("an object key the rules do not name is replaced whole", () => {
		const settings = mergeCcSettings(
			[
				document("user", { permissions: { allow: ["Read"] } }),
				document("project", { permissions: { deny: ["Bash"] } }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.permissions).toEqual({ deny: ["Bash"] });
	});
});

describe("env", () => {
	test("unions across tiers and wins per variable", () => {
		const settings = mergeCcSettings(
			[
				document("user", { env: { A: "user", B: "user" } }),
				document("project", { env: { B: "project" } }),
				document("flag", { env: { C: "flag" } }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.env).toEqual({ A: "user", B: "project", C: "flag" });
	});

	test("keeps credential and base-URL keys a repository sets", () => {
		const settings = mergeCcSettings(
			[
				document("project", {
					env: { ANTHROPIC_API_KEY: "sk-ant-poison-project", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
				}),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.env).toEqual({
			ANTHROPIC_API_KEY: "sk-ant-poison-project",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
		});
	});

	test("drops pi's own bootstrap keys from project and local tiers", () => {
		const settings = mergeCcSettings(
			[
				document("project", { env: { PI_CODING_AGENT_DIR: "/elsewhere", NODE_OPTIONS: "--inspect", KEPT: "1" } }),
				document("local", { env: { PATH: "/evil", LD_PRELOAD: "x", DYLD_INSERT_LIBRARIES: "y" } }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.env).toEqual({ KEPT: "1" });
	});

	test("lets the user and flag tiers set pi's bootstrap keys", () => {
		const settings = mergeCcSettings(
			[document("user", { env: { PI_CODING_AGENT_DIR: "/mine" } }), document("flag", { env: { PATH: "/mine" } })],
			EMPTY_CC_POLICY,
		);
		expect(settings.env).toEqual({ PI_CODING_AGENT_DIR: "/mine", PATH: "/mine" });
	});
});

describe("policy post-merge stage", () => {
	test("policy's availableModels, enforceAvailableModels and modelPicker replace the merge", () => {
		const settings = mergeCcSettings(
			[
				document("flag", {
					availableModels: ["flag-model"],
					enforceAvailableModels: false,
					modelPicker: { mode: "flag" },
				}),
				document("policy", {
					availableModels: ["policy-model"],
					enforceAvailableModels: true,
					modelPicker: { mode: "policy" },
				}),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.availableModels).toEqual(["policy-model"]);
		expect(settings.values.enforceAvailableModels).toBe(true);
		expect(settings.values.modelPicker).toEqual({ mode: "policy" });
		expect(settings.sources.get("availableModels")).toBe("policy");
	});

	test("deniedModels is deleted when the policy tier omits it", () => {
		const settings = mergeCcSettings([document("project", { deniedModels: ["project-model"] })], EMPTY_CC_POLICY);
		expect(settings.values.deniedModels).toBeUndefined();
		expect(settings.sources.has("deniedModels")).toBe(false);
	});

	test("deniedModels survives when the policy tier defines it", () => {
		const settings = mergeCcSettings(
			[
				document("project", { deniedModels: ["project-model"] }),
				document("policy", { deniedModels: ["policy-model"] }),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.deniedModels).toEqual(["policy-model"]);
	});
});

describe("typed accessors", () => {
	test("a non-string model is not exposed as the effective model", () => {
		const settings = mergeCcSettings([document("user", { model: 5 })], EMPTY_CC_POLICY);
		expect(settings.model).toBeUndefined();
	});

	test("every merged key stays readable through values", () => {
		const settings = mergeCcSettings(
			[
				document("project", {
					hooks: { PreToolUse: [] },
					statusLine: { type: "command" },
					sandbox: { enabled: true },
				}),
			],
			EMPTY_CC_POLICY,
		);
		expect(settings.values.hooks).toEqual({ PreToolUse: [] });
		expect(settings.values.statusLine).toEqual({ type: "command" });
		expect(settings.values.sandbox).toEqual({ enabled: true });
	});
});

describe("additional directories", () => {
	test("records --add-dir values and dedupes them", () => {
		const base = mergeCcSettings([document("user", { model: "m" })], EMPTY_CC_POLICY);
		const withOne = withAdditionalDirectories(base, ["/one"]);
		expect(withAdditionalDirectories(withOne, ["/one", "/two"]).additionalDirectories).toEqual(["/one", "/two"]);
	});

	test("returns the same value when there is nothing to add", () => {
		const base = mergeCcSettings([], EMPTY_CC_POLICY);
		expect(withAdditionalDirectories(base, [])).toBe(base);
		expect(base.additionalDirectories).toEqual([]);
	});
});
