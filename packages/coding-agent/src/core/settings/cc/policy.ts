/**
 * The managed-policy tier. Two of its keys can stop a run: a provider set nothing can serve, and a
 * minimum version above this build. The rest are exposed for the permission, hook and MCP units.
 */

import { coerce, lt, valid } from "semver";

export interface CcPolicy {
	readonly allowedProviders: readonly string[] | undefined;
	readonly allowManagedHooksOnly: boolean;
	readonly allowManagedPermissionRulesOnly: boolean;
	readonly allowManagedMcpServersOnly: boolean;
	readonly requiredMinimumVersion: string | undefined;
	readonly forceLoginMethod: string | undefined;
}

export const EMPTY_CC_POLICY: CcPolicy = {
	allowedProviders: undefined,
	allowManagedHooksOnly: false,
	allowManagedPermissionRulesOnly: false,
	allowManagedMcpServersOnly: false,
	requiredMinimumVersion: undefined,
	forceLoginMethod: undefined,
};

/**
 * The provider labels a managed policy may name: every backend Claude Code can select. pi reports its
 * first-party provider as `anthropic`, so that is the spelling a first-party policy uses.
 */
export const CC_KNOWN_PROVIDERS: readonly string[] = ["anthropic", "bedrock", "vertex", "foundry", "mantle", "gateway"];

export type CcPolicyParse =
	| { readonly kind: "policy"; readonly policy: CcPolicy }
	| { readonly kind: "refusal"; readonly message: string };

/**
 * Reads the policy tier. An `allowedProviders` value that is not a non-empty list of known providers
 * refuses, because a policy file that cannot say which providers may serve is not a permission.
 */
export function parseCcPolicy(values: Readonly<Record<string, unknown>>): CcPolicyParse {
	let providers: readonly string[] | undefined;
	if (values.allowedProviders !== undefined) {
		providers = providerList(values.allowedProviders);
		if (providers === undefined) {
			return {
				kind: "refusal",
				message: `allowedProviders must be a non-empty list of known providers (${CC_KNOWN_PROVIDERS.join(", ")})`,
			};
		}
	}
	return { kind: "policy", policy: { ...readSwitches(values), allowedProviders: providers } };
}

/** The version gate. An unparsable requirement refuses rather than letting the run through. */
export function policyRefusal(policy: CcPolicy, version: string): string | undefined {
	const minimum = policy.requiredMinimumVersion;
	if (minimum === undefined) {
		return undefined;
	}
	if (valid(minimum) === null) {
		return `requiredMinimumVersion "${minimum}" is not a valid version`;
	}
	const running = coerce(version);
	if (running === null) {
		return undefined;
	}
	if (lt(running, minimum)) {
		return `requiredMinimumVersion ${minimum} is above the running version ${version}`;
	}
	return undefined;
}

function readSwitches(values: Readonly<Record<string, unknown>>): Omit<CcPolicy, "allowedProviders"> {
	return {
		allowManagedHooksOnly: values.allowManagedHooksOnly === true,
		allowManagedPermissionRulesOnly: values.allowManagedPermissionRulesOnly === true,
		allowManagedMcpServersOnly: values.allowManagedMcpServersOnly === true,
		requiredMinimumVersion:
			typeof values.requiredMinimumVersion === "string" ? values.requiredMinimumVersion : undefined,
		forceLoginMethod: typeof values.forceLoginMethod === "string" ? values.forceLoginMethod : undefined,
	};
}

function providerList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	if (value.some((entry) => typeof entry !== "string")) {
		return undefined;
	}
	const providers = value.map((entry: string) => entry.trim().toLowerCase());
	return providers.every((name) => CC_KNOWN_PROVIDERS.includes(name)) ? providers : undefined;
}
