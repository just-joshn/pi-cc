/**
 * The stderr blocks Claude Code prints for settings it could not use, and the line it prints for
 * project settings a trust decision suppressed. The wording of the first block is measured from
 * 2.1.312: a file that fails to load is named under one header, and a file that loaded is never
 * mentioned.
 */

import type { CcSettingsFailure } from "./types.ts";

const DID_NOT_LOAD_HEADER =
	"These settings files did not load, so nothing in them is in effect, including hooks and permission rules. Each loads again once the problem listed for it is fixed:";

export function formatSettingsFailures(failures: readonly CcSettingsFailure[]): string[] {
	if (failures.length === 0) {
		return [];
	}
	return [DID_NOT_LOAD_HEADER, ...failures.map((failure) => `  ${formatFailure(failure)}`)];
}

/** One line per ignored file, so a user can see which project settings the trust decision suppressed. */
export function formatIgnoredProjectSettings(paths: readonly string[]): string[] {
	return paths.map((path) => `Ignoring untrusted project settings: ${path}`);
}

function formatFailure(failure: CcSettingsFailure): string {
	switch (failure.kind) {
		case "malformed":
			return `${failure.path}: Invalid or malformed JSON`;
		case "shape": {
			const label = failure.key === undefined ? failure.path : `${failure.path} (${failure.key})`;
			return `${label}: ${failure.detail}`;
		}
	}
}
