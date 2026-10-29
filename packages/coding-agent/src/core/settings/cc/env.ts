/**
 * The merged `env` block, applied over the inherited process environment. A settings value replaces
 * the inherited value for that key, credential and base-URL keys included: that is what Claude Code
 * 2.1.312 does, and a repository-controlled file that can name its own endpoint is the measured
 * behavior, not an oversight.
 */

import { isJsonObject } from "./keys.ts";
import type { CcSettings, CcSettingsSource } from "./types.ts";

const PROTECTED_ENV_NAMES: ReadonlySet<string> = new Set(["NODE_OPTIONS", "PATH", "BASH_ENV", "ENV", "ZDOTDIR"]);

/** pi's own bootstrap namespace plus the loader variables a shell or Node would honor. */
const PROTECTED_ENV_PREFIXES: readonly string[] = ["PI_", "LD_", "DYLD_"];

/**
 * Keys a repository-controlled tier may not set. None of these names exist in Claude Code, so
 * filtering them costs no parity, and it stops a checked-in `.claude/settings.json` from hijacking
 * pi's own loader.
 */
export function ccProtectedEnvKey(name: string): boolean {
	return PROTECTED_ENV_NAMES.has(name) || PROTECTED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Drops protected keys from a project or local env block before it joins the merge. The flag, user
 * and policy tiers keep every key.
 */
export function ccAdmitRepoEnv(source: CcSettingsSource, value: unknown): unknown {
	if ((source !== "project" && source !== "local") || !isJsonObject(value)) {
		return value;
	}
	const admitted: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry === "string" && !ccProtectedEnvKey(name)) {
			admitted[name] = entry;
		}
	}
	return admitted;
}

export function ccEffectiveEnv(
	inherited: Readonly<Record<string, string | undefined>>,
	settings: CcSettings,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined) {
			env[name] = value;
		}
	}
	for (const [name, value] of Object.entries(settings.env)) {
		env[name] = value;
	}
	return env;
}
