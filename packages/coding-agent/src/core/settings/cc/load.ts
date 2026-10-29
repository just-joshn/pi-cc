/**
 * Read each admitted tier, parse it, and merge once. A missing file is the normal case, a malformed
 * or wrongly shaped file is a failure the caller reports and skips, and nothing here throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { SETTINGS_DEFAULTS } from "../../settings-defaults.ts";
import type { DefaultProjectTrust } from "../../settings-manager.ts";
import { parseFlagSettings } from "./flag-tier.ts";
import { parseCcSettingsText } from "./keys.ts";
import { mergeCcSettings } from "./merge.ts";
import { ccSettingsPath } from "./paths.ts";
import { type CcPolicy, EMPTY_CC_POLICY, parseCcPolicy, policyRefusal } from "./policy.ts";
import {
	CC_FILE_SOURCES,
	CC_SETTINGS_ORDER,
	type CcLoadResult,
	type CcSettingsDocument,
	type CcSettingsFailure,
	type CcSettingsSource,
} from "./types.ts";

export interface CcSettingsLocation {
	readonly cwd: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: string;
	/** The running version, for the policy's `requiredMinimumVersion` gate. */
	readonly version: string;
	/** Tier names from `--setting-sources`. Undefined admits the three default file tiers. */
	readonly settingSources: readonly string[] | undefined;
	readonly projectTrusted: boolean;
	/** The raw `--settings` value: inline JSON or a file path. */
	readonly flagSettings: string | undefined;
}

export interface CcTrustSignals {
	/** The trust store's decision for this path, or null when it has none. */
	readonly decision: boolean | null;
	/** pi's `--approve` / `--no-approve`. */
	readonly trustOverride?: boolean;
	readonly defaultProjectTrust?: DefaultProjectTrust;
}

/**
 * R2: absence of a trust decision allows the project tiers, which is what a fresh-config print run of
 * 2.1.312 does. Only an explicit no denies them: a false entry, `--no-approve`, or
 * `defaultProjectTrust: "never"`.
 */
export function ccProjectTrusted(signals: CcTrustSignals): boolean {
	if (signals.trustOverride !== undefined) {
		return signals.trustOverride;
	}
	if (signals.decision !== null) {
		return signals.decision;
	}
	return (signals.defaultProjectTrust ?? SETTINGS_DEFAULTS.defaultProjectTrust) !== "never";
}

export function loadCcSettings(location: CcSettingsLocation): CcLoadResult {
	const admitted = admittedSources(location.settingSources);
	const documents: CcSettingsDocument[] = [];
	const failures: CcSettingsFailure[] = [];
	const searched: string[] = [];
	const ignored: string[] = [];

	for (const source of CC_SETTINGS_ORDER) {
		if (source === "flag") {
			continue;
		}
		const path = ccSettingsPath(source, location);
		if (path === undefined) {
			continue;
		}
		searched.push(path);
		if (!admitted.has(source)) {
			continue;
		}
		if (!location.projectTrusted && isRepoSource(source)) {
			if (existsSync(path)) {
				ignored.push(path);
			}
			continue;
		}
		const failure = readSettingsFile(source, path, documents);
		if (failure !== undefined) {
			failures.push(failure);
		}
	}

	if (location.flagSettings !== undefined) {
		readFlagSettings(location.flagSettings, location.cwd, documents, failures, searched);
	}

	const gate = ccPolicyGate(
		policyValues(documents),
		location.version,
		ccSettingsPath("policy", location) ?? "managed-settings.json",
	);
	return { settings: mergeCcSettings(documents, gate.policy), failures, searched, ignored, refusal: gate.refusal };
}

/**
 * Parses the policy tier and applies its two gates. A refusal names the file, because the operator who
 * wrote it is the only one who can fix it.
 */
export function ccPolicyGate(
	values: Readonly<Record<string, unknown>>,
	version: string,
	path: string,
): { readonly policy: CcPolicy; readonly refusal: string | undefined } {
	const parsed = parseCcPolicy(values);
	if (parsed.kind === "refusal") {
		return { policy: EMPTY_CC_POLICY, refusal: `${path}: ${parsed.message}` };
	}
	const gated = policyRefusal(parsed.policy, version);
	return { policy: parsed.policy, refusal: gated === undefined ? undefined : `${path}: ${gated}` };
}

/** R1: `--setting-sources` narrows the file tiers only; the flag and policy tiers are always admitted. */
function admittedSources(settingSources: readonly string[] | undefined): ReadonlySet<CcSettingsSource> {
	const requested = settingSources ?? CC_FILE_SOURCES;
	const admitted = new Set<CcSettingsSource>(["policy"]);
	for (const source of requested) {
		if (CC_FILE_SOURCES.includes(source as CcSettingsSource)) {
			admitted.add(source as CcSettingsSource);
		}
	}
	return admitted;
}

function isRepoSource(source: CcSettingsSource): boolean {
	return source === "project" || source === "local";
}

function readSettingsFile(
	source: CcSettingsSource,
	path: string,
	documents: CcSettingsDocument[],
): CcSettingsFailure | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { kind: "malformed", source, path, detail: `could not read the file: ${detail}` };
	}
	const parsed = parseCcSettingsText(text);
	if (parsed.kind === "document") {
		documents.push({ source, path, values: parsed.values });
		return undefined;
	}
	return parsed.kind === "malformed"
		? { kind: "malformed", source, path, detail: parsed.detail }
		: { kind: "shape", source, path, detail: parsed.detail };
}

function readFlagSettings(
	value: string,
	cwd: string,
	documents: CcSettingsDocument[],
	failures: CcSettingsFailure[],
	searched: string[],
): void {
	const parsed = parseFlagSettings(value, cwd);
	searched.push(parsed.path);
	if (parsed.kind === "document") {
		documents.push({ source: "flag", path: parsed.path, values: parsed.values });
		return;
	}
	failures.push({
		kind: parsed.malformed ? "malformed" : "shape",
		source: "flag",
		path: parsed.path,
		detail: parsed.detail,
	});
}

function policyValues(documents: readonly CcSettingsDocument[]): Readonly<Record<string, unknown>> {
	return documents.find((document) => document.source === "policy")?.values ?? {};
}
