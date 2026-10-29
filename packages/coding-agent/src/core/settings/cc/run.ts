/**
 * One run's settings, split by trust.
 *
 * The user, flag and policy tiers are always read. The project and local tiers live in the repository,
 * so they are read only when pi's own trust flow trusts the project: an `env` block there reaches the
 * model client and the agent's tools, and a repository may not redirect either without a decision.
 *
 * A prompt cannot be answered before the runtime exists, so an `ask` rule opens this in the `pending`
 * phase with the project tiers withheld, and `settleRepoTiers` admits them once the answer is in. Every
 * list a settle returns is only what the open phase did not report, so the caller reports each line once.
 */

import type { CcSettingsLocation } from "./load.ts";
import { loadCcSettings } from "./load.ts";
import type { CcLoadResult, CcSettings, CcSettingsFailure, CcSettingsSkip, CcSettingsSource } from "./types.ts";

/** Whether pi trusts the project, or `pending` when only a prompt can answer. */
export type CcRepoTierTrust = boolean | "pending";

export type CcRunLocation = Omit<CcSettingsLocation, "projectTrusted">;

export interface CcSettleResult {
	/** The effective settings, now including the project and local tiers when they were trusted. */
	readonly settings: CcSettings;
	readonly failures: readonly CcSettingsFailure[];
	readonly skipped: readonly CcSettingsSkip[];
	/** Present project and local files that were not admitted. */
	readonly ignored: readonly string[];
}

export interface CcRunSettings {
	/** The effective settings. Repo-tier values appear only after a trusted settle. */
	readonly settings: CcSettings;
	readonly flagError: string | undefined;
	readonly refusal: string | undefined;
	readonly failures: readonly CcSettingsFailure[];
	readonly skipped: readonly CcSettingsSkip[];
	readonly ignored: readonly string[];
	settleRepoTiers(trusted: boolean): CcSettleResult;
}

function isRepoSource(source: CcSettingsSource): boolean {
	return source === "project" || source === "local";
}

export function openCcRunSettings(location: CcRunLocation, trust: CcRepoTierTrust): CcRunSettings {
	if (trust !== "pending") {
		const result: CcLoadResult = loadCcSettings({ ...location, projectTrusted: trust });
		return {
			settings: result.settings,
			flagError: result.flagError,
			refusal: result.refusal,
			failures: result.failures,
			skipped: result.skipped,
			ignored: result.ignored,
			settleRepoTiers: () => ({ settings: result.settings, failures: [], skipped: [], ignored: [] }),
		};
	}

	const withheld = loadCcSettings({ ...location, projectTrusted: false });
	let current = withheld.settings;
	let settled = false;
	return {
		get settings() {
			return current;
		},
		flagError: withheld.flagError,
		refusal: withheld.refusal,
		failures: withheld.failures,
		skipped: withheld.skipped,
		// Nothing is ignored until the answer is no: reporting it earlier would name a file the user may
		// still trust, before the prompt that asks.
		ignored: [],
		settleRepoTiers(trusted: boolean): CcSettleResult {
			// A later session in the same run asks again; the tiers are already admitted or withheld.
			if (settled) {
				return { settings: current, failures: [], skipped: [], ignored: [] };
			}
			settled = true;
			if (!trusted) {
				return { settings: current, failures: [], skipped: [], ignored: withheld.ignored };
			}
			const admitted = loadCcSettings({ ...location, projectTrusted: true });
			current = admitted.settings;
			return {
				settings: admitted.settings,
				failures: admitted.failures.filter((failure) => isRepoSource(failure.source)),
				skipped: admitted.skipped.filter((skip) => isRepoSource(skip.source)),
				ignored: [],
			};
		},
	};
}

/** One directory's settings, and the trust decision that admitted or withheld its repo tiers. */
export interface CcDirectoryAdmission {
	readonly cwd: string;
	readonly run: CcRunSettings;
}

export interface CcDirectoryAdmitResult {
	readonly admission: CcDirectoryAdmission;
	/** Set when an already-open directory was settled. A fresh open carries its own report. */
	readonly settled: CcSettleResult | undefined;
	readonly opened: boolean;
}

/**
 * Admit or withhold the repo tiers of `cwd` on `trust`, which must be that directory's own decision.
 *
 * A different directory does not reuse the previous load. Settling one directory's files with another
 * directory's boolean is the bug this function exists to make unrepresentable.
 */
export function admitCcDirectory(
	previous: CcDirectoryAdmission | undefined,
	location: CcRunLocation,
	cwd: string,
	trust: CcRepoTierTrust,
): CcDirectoryAdmitResult {
	if (previous !== undefined && previous.cwd === cwd) {
		if (trust === "pending") {
			return { admission: previous, settled: undefined, opened: false };
		}
		return {
			admission: previous,
			settled: previous.run.settleRepoTiers(trust),
			opened: false,
		};
	}
	return {
		admission: { cwd, run: openCcRunSettings({ ...location, cwd }, trust) },
		settled: undefined,
		opened: true,
	};
}
