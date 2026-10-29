/** The stderr lines for settings that did not load and for project settings trust suppressed. */

import type { CcSettingsFailure } from "./types.ts";

export function formatSettingsFailures(failures: readonly CcSettingsFailure[]): string[] {
	return failures.map(formatFailure);
}

/** One line per ignored file, so a user can see which project settings the trust decision suppressed. */
export function formatIgnoredProjectSettings(paths: readonly string[]): string[] {
	return paths.map((path) => `Ignoring untrusted project settings: ${path}`);
}

function formatFailure(failure: CcSettingsFailure): string {
	switch (failure.kind) {
		case "missing":
			return `${failure.path} was not found`;
		case "malformed":
			return `${failure.path} did not load: Invalid or malformed JSON: ${failure.detail}`;
		case "shape":
			return `${failure.path} did not load: ${failure.detail}`;
	}
}
