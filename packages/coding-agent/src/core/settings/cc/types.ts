/** The Claude Code settings tiers, the effective value they merge into, and what one load reports. */

import type { CcPolicy } from "./policy.ts";

export type CcSettingsSource = "user" | "project" | "local" | "flag" | "policy";

/** The one order table. Later tiers win per key. `policy` is last: an operator tier, not a session tier. */
export const CC_SETTINGS_ORDER: readonly CcSettingsSource[] = ["user", "project", "local", "flag", "policy"];

/** The tiers `--setting-sources` can switch off. The flag and policy tiers are always admitted. */
export const CC_FILE_SOURCES: readonly CcSettingsSource[] = ["user", "project", "local"];

/** The effective settings. Only the keys P02 acts on are typed; `values` carries the rest. */
export interface CcSettings {
	readonly model: string | undefined;
	readonly env: Readonly<Record<string, string>>;
	readonly additionalDirectories: readonly string[];
	readonly policy: CcPolicy;
	/** Every merged key, including the ones later units own (permissions, hooks, mcpServers, ...). */
	readonly values: Readonly<Record<string, unknown>>;
	/** Which tier supplied the winning value, per key. Feeds the report and later units. */
	readonly sources: ReadonlyMap<string, CcSettingsSource>;
}

export type CcSettingsFailure =
	| { readonly kind: "malformed"; readonly source: CcSettingsSource; readonly path: string; readonly detail: string }
	| {
			readonly kind: "shape";
			readonly source: CcSettingsSource;
			readonly path: string;
			/** The key that failed; absent when the whole document did. */
			readonly key?: string;
			readonly detail: string;
	  };

/** One tier that parsed, with the tier it came from. */
export interface CcSettingsDocument {
	readonly source: CcSettingsSource;
	readonly path: string;
	readonly values: Readonly<Record<string, unknown>>;
}

export interface CcLoadResult {
	readonly settings: CcSettings;
	/** Malformed and shape failures only. A missing file is the normal case, not a failure. */
	readonly failures: readonly CcSettingsFailure[];
	/** Every path the loader considered, in `CC_SETTINGS_ORDER`, for attribution in a report. */
	readonly searched: readonly string[];
	/** Project and local files that exist but were skipped because the project is not trusted. */
	readonly ignored: readonly string[];
	/** Set when the managed policy forbids this run. The message names the policy file. */
	readonly refusal: string | undefined;
}
