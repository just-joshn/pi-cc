import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export type ProjectTrustReading = { readonly kind: "decided"; readonly trusted: boolean } | { readonly kind: "ask" };

export interface ProjectTrustSignals {
	readonly cwd: string;
	readonly trustStore: ProjectTrustStore;
	/** pi's `--approve` / `--no-approve`. */
	readonly trustOverride?: boolean;
	readonly defaultProjectTrust?: DefaultProjectTrust;
}

/**
 * The part of pi's trust rule that needs no UI: a forced decision, a stored decision, or a default.
 * Prompting is the only branch left over, and only a run with a UI may take it.
 */
export function readProjectTrust(signals: ProjectTrustSignals): ProjectTrustReading {
	if (signals.trustOverride !== undefined) {
		return { kind: "decided", trusted: signals.trustOverride };
	}
	const decision = signals.trustStore.get(signals.cwd);
	if (decision !== null) {
		return { kind: "decided", trusted: decision };
	}
	switch (signals.defaultProjectTrust ?? SETTINGS_DEFAULTS.defaultProjectTrust) {
		case "always":
			return { kind: "decided", trusted: true };
		case "never":
			return { kind: "decided", trusted: false };
		case "ask":
			return { kind: "ask" };
	}
}

/**
 * The trust a run can apply before its runtime exists, which is what the settings layer needs: the rule
 * above, with "would prompt" kept separate so a later answer can admit what this reading withheld. A
 * mode without a UI resolves `ask` to untrusted, which is pi's rule and Claude Code's print-mode rule.
 * No trust-requiring resource means there is nothing to gate.
 */
export function readInitialProjectTrust(
	signals: ProjectTrustSignals & { readonly hasUI: boolean },
): boolean | "pending" {
	if (!hasTrustRequiringProjectResources(signals.cwd)) {
		return true;
	}
	const reading = readProjectTrust(signals);
	if (reading.kind === "decided") {
		return reading.trusted;
	}
	return signals.hasUI ? "pending" : false;
}

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const reading = readProjectTrust(options);
	if (reading.kind === "decided") {
		return reading.trusted;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
