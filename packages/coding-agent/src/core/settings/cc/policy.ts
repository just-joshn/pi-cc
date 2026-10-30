/**
 * The managed-policy tier. Its keys that can stop a run are a provider set nothing can serve and a version
 * band (`requiredMinimumVersion`, `requiredMaximumVersion`) this build falls outside. The rest are exposed for the permission, hook and MCP units.
 */

import { gt, lt, valid } from "semver";
import { APP_NAME } from "../../../config.ts";

export interface CcPolicy {
	readonly allowedProviders: readonly string[] | undefined;
	readonly allowManagedHooksOnly: boolean;
	readonly allowManagedPermissionRulesOnly: boolean;
	readonly allowManagedMcpServersOnly: boolean;
	readonly requiredMinimumVersion: string | undefined;
	readonly requiredMaximumVersion: string | undefined;
	readonly forceLoginMethod: string | undefined;
}

export const EMPTY_CC_POLICY: CcPolicy = {
	allowedProviders: undefined,
	allowManagedHooksOnly: false,
	allowManagedPermissionRulesOnly: false,
	allowManagedMcpServersOnly: false,
	requiredMinimumVersion: undefined,
	requiredMaximumVersion: undefined,
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

/**
 * The version gate. A bound that is not a version is ignored, as Claude Code ignores it, so a typo in a
 * managed file cannot lock the fleet out. The refusal text is Claude Code's with this product's name.
 */
export function policyRefusal(policy: CcPolicy, version: string): string | undefined {
	const running = valid(version);
	if (running === null) {
		return undefined;
	}
	const minimum = policy.requiredMinimumVersion;
	if (minimum !== undefined && valid(minimum) !== null && lt(running, minimum)) {
		return (
			`${APP_NAME} ${version} is older than the minimum version required by your organization (${minimum}).\n` +
			`Update ${APP_NAME} using your organization's approved method, then try again. ` +
			`If automatic updates are available, \`${APP_NAME} update\` may also work.`
		);
	}
	const maximum = policy.requiredMaximumVersion;
	if (maximum !== undefined && valid(maximum) !== null && gt(running, maximum)) {
		return (
			`${APP_NAME} ${version} is newer than the maximum version allowed by your organization (${maximum}).\n` +
			`Your organization requires version ${maximum} or older. ` +
			`Install an approved version using your organization's approved method. \`${APP_NAME} install <version>\` may also work.`
		);
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
		requiredMaximumVersion:
			typeof values.requiredMaximumVersion === "string" ? values.requiredMaximumVersion : undefined,
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
