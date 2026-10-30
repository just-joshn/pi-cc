/**
 * The one precedence pass: `CC_SETTINGS_ORDER`, later tiers win per key using the rules in keys.ts,
 * and then the policy post-merge stage. Nothing else in the settings layer orders tiers.
 */

import { ccAdmitRepoEnv } from "./env.ts";
import { isJsonObject, mergeValue, POLICY_DROPPED, POLICY_FORCED } from "./keys.ts";
import type { CcPolicy } from "./policy.ts";
import { CC_SETTINGS_ORDER, type CcSettings, type CcSettingsDocument, type CcSettingsSource } from "./types.ts";

export function mergeCcSettings(documents: readonly CcSettingsDocument[], policy: CcPolicy): CcSettings {
	const values: Record<string, unknown> = {};
	const sources = new Map<string, CcSettingsSource>();
	const pluginOptions: Record<string, Record<string, unknown>> = {};

	for (const source of CC_SETTINGS_ORDER) {
		for (const document of documents) {
			if (document.source !== source) {
				continue;
			}
			for (const [key, raw] of Object.entries(document.values)) {
				const next = key === "env" ? ccAdmitRepoEnv(source, raw) : raw;
				values[key] = mergeValue(key, values[key], next);
				sources.set(key, source);
			}
			if (PLUGIN_OPTION_SOURCES.has(source)) {
				mergePluginOptions(pluginOptions, document.values.pluginConfigs);
			}
		}
	}

	applyPolicyStage(values, sources, documents);

	return {
		model: typeof values.model === "string" ? values.model : undefined,
		env: envValues(values.env),
		additionalDirectories: [],
		policy,
		values,
		sources,
		pluginOptions,
	};
}

/** R9: `--add-dir` records directories on the loaded value for the tool and permission units. */
export function withAdditionalDirectories(settings: CcSettings, directories: readonly string[]): CcSettings {
	if (directories.length === 0) {
		return settings;
	}
	const seen = new Set(settings.additionalDirectories);
	const merged = [...settings.additionalDirectories];
	for (const directory of directories) {
		if (!seen.has(directory)) {
			seen.add(directory);
			merged.push(directory);
		}
	}
	return { ...settings, additionalDirectories: merged };
}

/**
 * Policy keys that replace instead of merge, and the one policy key deleted when policy omits it.
 * `deniedModels` is a deny list: an absent policy list must not inherit a lower tier's list, and a
 * defined one replaces rather than concatenating.
 */
function applyPolicyStage(
	values: Record<string, unknown>,
	sources: Map<string, CcSettingsSource>,
	documents: readonly CcSettingsDocument[],
): void {
	const policyValues = documents.find((document) => document.source === "policy")?.values;
	const defined = isJsonObject(policyValues) ? policyValues : {};
	for (const key of [...POLICY_FORCED, ...POLICY_DROPPED]) {
		if (key in defined) {
			values[key] = defined[key];
			sources.set(key, "policy");
		}
	}
	for (const key of POLICY_DROPPED) {
		if (!(key in defined)) {
			delete values[key];
			sources.delete(key);
		}
	}
}

// Claude Code reads `pluginConfigs.<id>.options` from these tiers only; a repo cannot set a plugin's options.
const PLUGIN_OPTION_SOURCES: ReadonlySet<CcSettingsSource> = new Set(["user", "flag", "policy"]);

function mergePluginOptions(target: Record<string, Record<string, unknown>>, pluginConfigs: unknown): void {
	if (!isJsonObject(pluginConfigs)) {
		return;
	}
	for (const [id, config] of Object.entries(pluginConfigs)) {
		if (isJsonObject(config) && isJsonObject(config.options)) {
			target[id] = { ...target[id], ...config.options };
		}
	}
}

function envValues(value: unknown): Record<string, string> {
	const env: Record<string, string> = {};
	if (!isJsonObject(value)) {
		return env;
	}
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			env[name] = entry;
		}
	}
	return env;
}
