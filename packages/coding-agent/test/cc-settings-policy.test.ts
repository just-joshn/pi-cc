import { describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";
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
	test("does nothing without a bound", () => {
		expect(policyRefusal(EMPTY_CC_POLICY, "1.4.0")).toBeUndefined();
	});

	test("refuses a build older than the minimum with the organization's wording", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMinimumVersion: "9.0.0" };
		const refusal = policyRefusal(policy, "1.4.0") ?? "";
		expect(refusal).toContain("1.4.0 is older than the minimum version required by your organization (9.0.0).");
		expect(refusal).toContain("update` may also work.");
	});

	test("allows a build that meets the minimum, boundary included", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.2.0" }, "1.4.0")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0" }, "1.4.0")).toBeUndefined();
	});

	test("refuses a build newer than the maximum with the organization's wording", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.3.0" };
		const refusal = policyRefusal(policy, "1.4.0") ?? "";
		expect(refusal).toContain("1.4.0 is newer than the maximum version allowed by your organization (1.3.0).");
		expect(refusal).toContain("Your organization requires version 1.3.0 or older.");
		expect(refusal.endsWith(`\`${APP_NAME} install <version>\` may also work.`)).toBe(true);
	});

	test("a prerelease sorts below its release on the minimum, as semver without coercion does", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0" };
		expect(policyRefusal(policy, "1.4.0-rc.1")).toContain("1.4.0-rc.1 is older than the minimum version");
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0-rc.1" }, "1.4.0-rc.1")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0-rc.1" }, "1.4.0")).toBeUndefined();
	});

	test("a prerelease is under the maximum of its release and over the maximum of an earlier prerelease", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.4.0" }, "1.4.0-rc.1")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.4.0-rc.1" }, "1.4.0-rc.2")).toContain(
			"is newer than the maximum version",
		);
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.4.0-rc.1" }, "1.4.0")).toContain(
			"is newer than the maximum version",
		);
	});

	test("build metadata does not order versions", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.0+b" }, "1.4.0+a")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.4.0+a" }, "1.4.0+b")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "1.4.1" }, "1.4.0+b")).toContain("older");
	});

	test("a running version that is not semver is not gated", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "9.0.0" }, "dev")).toBeUndefined();
	});

	test("allows a build at or under the maximum", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.4.0" }, "1.4.0")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "2.0.0" }, "1.4.0")).toBeUndefined();
	});

	test("refuses when the band is empty, by whichever bound the build breaks", () => {
		const policy = { ...EMPTY_CC_POLICY, requiredMinimumVersion: "3.0.0", requiredMaximumVersion: "2.0.0" };
		expect(policyRefusal(policy, "1.4.0")).toContain("older than the minimum");
		expect(policyRefusal(policy, "2.5.0")).toContain("older than the minimum");
	});

	test("ignores a bound that is not a version instead of locking the build out", () => {
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMinimumVersion: "soon" }, "1.4.0")).toBeUndefined();
		expect(policyRefusal({ ...EMPTY_CC_POLICY, requiredMaximumVersion: "1.3" }, "1.4.0")).toBeUndefined();
	});

	test("keeps both bounds readable when they parse", () => {
		const parsed = parseCcPolicy({ requiredMinimumVersion: "1.0.0", requiredMaximumVersion: "2.0.0" });
		if (parsed.kind !== "policy") throw new Error("expected a policy");
		expect(parsed.policy.requiredMinimumVersion).toBe("1.0.0");
		expect(parsed.policy.requiredMaximumVersion).toBe("2.0.0");
	});
});
