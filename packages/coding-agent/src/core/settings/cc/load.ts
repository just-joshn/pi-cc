/**
 * Read each admitted tier, parse it, and merge once. A missing file is the normal case, a malformed
 * or wrongly shaped file is a failure the caller reports and skips, and nothing here throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseFlagSettings } from "./flag-tier.ts";
import { type CcFieldSkip, parseCcSettingsText } from "./keys.ts";
import { mergeCcSettings } from "./merge.ts";
import { ccSettingsPath } from "./paths.ts";
import { type CcPolicy, EMPTY_CC_POLICY, parseCcPolicy, policyRefusal } from "./policy.ts";
import {
	CC_FILE_SOURCES,
	CC_SETTINGS_ORDER,
	type CcLoadResult,
	type CcSettingsDocument,
	type CcSettingsFailure,
	type CcSettingsSkip,
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

/**
 * The trust decision is pi's, not a second rule: `readInitialProjectTrust` in `core/project-trust.ts`
 * owns it and `openCcRunSettings` in `run.ts` applies it to the project and local tiers.
 */
export function loadCcSettings(location: CcSettingsLocation): CcLoadResult {
	const admitted = admittedSources(location.settingSources);
	const documents: CcSettingsDocument[] = [];
	const failures: CcSettingsFailure[] = [];
	const skipped: CcSettingsSkip[] = [];
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
		readSettingsFile(source, path, documents, failures, skipped);
	}

	const flagError =
		location.flagSettings === undefined
			? undefined
			: readFlagSettings(location.flagSettings, location.cwd, documents, failures, skipped, searched);

	const gate = ccPolicyGate(
		policyValues(documents),
		location.version,
		ccSettingsPath("policy", location) ?? "managed-settings.json",
	);
	return {
		settings: mergeCcSettings(documents, gate.policy),
		failures,
		skipped,
		searched,
		ignored,
		refusal: gate.refusal,
		flagError,
	};
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
	failures: CcSettingsFailure[],
	skipped: CcSettingsSkip[],
): void {
	if (!existsSync(path)) {
		return;
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		// The failure kinds have no read kind, so an unreadable file is reported as a shape problem of
		// the whole document: it contributes nothing and appears under the same block.
		const detail = error instanceof Error ? error.message : String(error);
		failures.push({ kind: "shape", source, path, detail: `could not read the file: ${detail}` });
		return;
	}
	const parsed = parseCcSettingsText(text, source);
	if (parsed.kind === "document") {
		documents.push({ source, path, values: parsed.values });
		pushSkips(skipped, source, path, parsed.skipped);
		return;
	}
	if (parsed.kind === "malformed") {
		failures.push({ kind: "malformed", source, path, detail: "Invalid or malformed JSON" });
		return;
	}
	for (const problem of parsed.problems) {
		failures.push({ kind: "shape", source, path, key: problem.key, detail: problem.detail });
	}
}

/** Returns the fatal message for a `--settings` value Claude Code refuses to run with. */
function readFlagSettings(
	value: string,
	cwd: string,
	documents: CcSettingsDocument[],
	failures: CcSettingsFailure[],
	skipped: CcSettingsSkip[],
	searched: string[],
): string | undefined {
	const parsed = parseFlagSettings(value, cwd);
	switch (parsed.kind) {
		case "absent":
			return undefined;
		case "invalid-json":
			return "Invalid JSON provided to --settings";
		case "missing":
			return `Settings file not found: ${parsed.path}`;
		case "unreadable":
			return `Cannot use settings file (${parsed.detail}): ${parsed.path}`;
		case "document":
			searched.push(parsed.path);
			documents.push({ source: "flag", path: parsed.path, values: parsed.values });
			pushSkips(skipped, "flag", parsed.path, parsed.skipped);
			return undefined;
		case "malformed":
			searched.push(parsed.path);
			failures.push({ kind: "malformed", source: "flag", path: parsed.path, detail: "Invalid or malformed JSON" });
			return undefined;
		case "shape":
			searched.push(parsed.path);
			for (const problem of parsed.problems) {
				failures.push({
					kind: "shape",
					source: "flag",
					path: parsed.path,
					key: problem.key,
					detail: problem.detail,
				});
			}
			return undefined;
	}
}

function pushSkips(
	skipped: CcSettingsSkip[],
	source: CcSettingsSource,
	path: string,
	entries: readonly CcFieldSkip[],
): void {
	for (const entry of entries) {
		skipped.push({ source, path, key: entry.key, detail: entry.detail });
	}
}

function policyValues(documents: readonly CcSettingsDocument[]): Readonly<Record<string, unknown>> {
	return documents.find((document) => document.source === "policy")?.values ?? {};
}
