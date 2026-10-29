import type { CcSettingsLocation } from "./load.ts";
import { loadCcSettings } from "./load.ts";
import type { CcLoadResult, CcSettings, CcSettingsFailure, CcSettingsSkip, CcSettingsSource } from "./types.ts";

export type CcRepoTierTrust = boolean | "pending";

export type CcRunLocation = Omit<CcSettingsLocation, "projectTrusted">;

export interface CcSettleResult {
	readonly settings: CcSettings;
	readonly failures: readonly CcSettingsFailure[];
	readonly skipped: readonly CcSettingsSkip[];
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
