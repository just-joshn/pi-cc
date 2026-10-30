/**
 * What may update this build, and what a release may not be. pi-cc has no Anthropic release feed. Its
 * only release source is a feed URL the operator names in `PI_CC_UPDATE_FEED_URL`, so with none set
 * `update` reports that and the startup check stays silent. The gates below are Claude Code's local ones.
 */

import { homedir } from "node:os";
import { gt, lt, valid } from "semver";
import { loadCcSettings } from "../core/settings/cc/load.ts";

/** The environment variable naming the operator's own release feed. */
export const UPDATE_FEED_ENV = "PI_CC_UPDATE_FEED_URL";

export type AutoUpdateState = { readonly kind: "enabled" } | { readonly kind: "disabled"; readonly envVar: string };

export type SelfUpdateSource =
	| { readonly kind: "admin-disabled" }
	| { readonly kind: "no-feed" }
	| { readonly kind: "feed"; readonly url: string };

/** The version bounds an update target must respect: the user's `minimumVersion`, the policy's maximum. */
export interface UpdateVersionBand {
	readonly minimumVersion: string | undefined;
	readonly requiredMaximumVersion: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the startup check may run. The first variable set wins, in Claude Code's order. Manual
 * `update` ignores these except `DISABLE_UPDATES`, as Claude Code's does.
 */
export function autoUpdateState(env: Env): AutoUpdateState {
	if (env.DISABLE_UPDATES) return { kind: "disabled", envVar: "DISABLE_UPDATES" };
	if (TRUTHY.has((env.DISABLE_AUTOUPDATER ?? "").toLowerCase())) {
		return { kind: "disabled", envVar: "DISABLE_AUTOUPDATER" };
	}
	if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
		return { kind: "disabled", envVar: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" };
	}
	return { kind: "enabled" };
}

/** The feed a check may read, or undefined when updates are disabled or no feed is configured. */
export function startupCheckFeed(env: Env): string | undefined {
	if (autoUpdateState(env).kind === "disabled") return undefined;
	return configuredFeed(env);
}

/** Where `update` gets a release, which an administrator's `DISABLE_UPDATES` overrides. */
export function selfUpdateSource(env: Env): SelfUpdateSource {
	if (env.DISABLE_UPDATES) return { kind: "admin-disabled" };
	const url = configuredFeed(env);
	return url === undefined ? { kind: "no-feed" } : { kind: "feed", url };
}

/**
 * Why an update to `target` must not happen, or undefined. A bound that is not a version constrains
 * nothing, and so does a target that is not one.
 */
export function updateTargetRefusal(target: string, band: UpdateVersionBand): string | undefined {
	if (valid(target) === null) return undefined;
	const minimum = band.minimumVersion;
	if (minimum !== undefined && valid(minimum) !== null && lt(target, minimum)) {
		return `below your minimumVersion setting (${minimum})`;
	}
	const maximum = band.requiredMaximumVersion;
	if (maximum !== undefined && valid(maximum) !== null && gt(target, maximum)) {
		return `above your organization's requiredMaximumVersion (${maximum})`;
	}
	return undefined;
}

/** Reads the bounds from the user and managed tiers only: `update` runs before any project is trusted. */
export function readUpdateVersionBand(cwd: string, env: Env, version: string): UpdateVersionBand {
	const loaded = loadCcSettings({
		cwd,
		home: homedir(),
		env,
		platform: process.platform,
		version,
		settingSources: ["user"],
		projectTrusted: false,
		flagSettings: undefined,
	});
	const minimum = loaded.settings.values.minimumVersion;
	return {
		minimumVersion: typeof minimum === "string" ? minimum : undefined,
		requiredMaximumVersion: loaded.settings.policy.requiredMaximumVersion,
	};
}

function configuredFeed(env: Env): string | undefined {
	const url = env[UPDATE_FEED_ENV]?.trim();
	return url ? url : undefined;
}
