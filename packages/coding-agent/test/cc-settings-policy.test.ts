import { describe, expect, test } from "vitest";
import { CC_KNOWN_PROVIDERS, EMPTY_CC_POLICY, parseCcPolicy, policyRefusal } from "../src/core/settings/cc/policy.ts";

describe("allowedProviders", () => {
	test("accepts a list of known providers, case-insensitively", () => {
		const parsed = parseCcPolicy({ allowedProviders: ["Anthropic", "bedrock"] });
		expect(parsed).toEqual({
			kind: "policy",
			policy: { ...EMPTY_CC_POLICY, allowedProviders: ["anthropic", "bedrock"] },
		});
	});

	test("refuses an empty list", () => {
		expect(parseCcPolicy({ allowedProviders: [] }).kind).toBe("refusal");
	});

	test("refuses a value that is not a list", () => {
		expect(parseCcPolicy({ allowedProviders: "anthropic" }).kind).toBe("refusal");
	});

	test("refuses a list naming a provider nothing can serve", () => {
		const parsed = parseCcPolicy({ allowedProviders: ["anthropic", "nonsense"] });
		expect(parsed.kind).toBe("refusal");
	});

	test("refuses a list with a non-string entry", () => {
		expect(parseCcPolicy({ allowedProviders: ["anthropic", 3] }).kind).toBe("refusal");
	});

	test("a missing value leaves no restriction", () => {
		expect(parseCcPolicy({})).toEqual({ kind: "policy", policy: EMPTY_CC_POLICY });
	});

	test("names every provider it accepts in the refusal", () => {
		const parsed = parseCcPolicy({ allowedProviders: ["nonsense"] });
		if (parsed.kind !== "refusal") throw new Error("expected a refusal");
		for (const provider of CC_KNOWN_PROVIDERS) {
			expect(parsed.message).toContain(provider);
		}
	});
});

describe("exposed switches", () => {
	test("reads the three managed-only switches and the login constraint", () => {
		const parsed = parseCcPolicy({
			allowManagedHooksOnly: true,
			allowManagedPermissionRulesOnly: true,
			allowManagedMcpServersOnly: true,
			forceLoginMethod: "claudeai",
		});
		expect(parsed).toEqual({
			kind: "policy",
			policy: {
				...EMPTY_CC_POLICY,
				allowManagedHooksOnly: true,
				allowManagedPermissionRulesOnly: true,
				allowManagedMcpServersOnly: true,
				forceLoginMethod: "claudeai",
			},
		});
	});

	test("a non-boolean switch reads as off", () => {
		expect(parseCcPolicy({ allowManagedHooksOnly: "yes" })).toEqual({ kind: "policy", policy: EMPTY_CC_POLICY });
	});
});

describe("version gate", () => {
	test("does nothing without requiredMinimumVersion", () => {
		expect(policyRefusal(EMPTY_CC_POLICY, "1.4.0")).toBeUndefined();
	});

	test("refuses when the requirement is above the running version", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMinimumVersion: "9.0.0" };
		expect(policyRefusal(policy, "1.4.0")).toContain("above the running version");
	});

	test("allows a requirement the running version meets", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.2.0" }, "1.4.0")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0" }, "1.4.0")).toBeUndefined();
	});

	test("refuses a requirement that is not a version", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMinimumVersion: "soon" };
		expect(policyRefusal(policy, "1.4.0")).toContain("not a valid version");
	});

	test("keeps the policy readable when the requirement parses", () => {
		const parsed = parseCcPolicy({ requiredMinimumVersion: "1.0.0" });
		if (parsed.kind !== "policy") throw new Error("expected a policy");
		expect(parsed.policy.requiredMinimumVersion).toBe("1.0.0");
	});
});
