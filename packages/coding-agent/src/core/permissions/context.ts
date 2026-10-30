/**
 * The state every permission evaluation reads: the mode, the rules, the working directories.
 *
 * {@link PermissionState} is the one mutable object of a session. Evaluation takes the immutable
 * {@link PermissionContext} it hands out, so a mode change or a grant made while a call waits is
 * seen by the next evaluation and by nothing half-way through one.
 */

import { homedir } from "node:os";
import type { PermissionMode } from "./mode.ts";
import { parsePermissionMode, stricterMode } from "./mode.ts";
import { canonicalDirectories } from "./paths.ts";
import { type RuleBehavior, RuleSet, type RuleSource, rulesFromTexts } from "./rules.ts";

export interface PermissionContext {
	readonly mode: PermissionMode;
	readonly rules: RuleSet;
	readonly cwd: string;
	readonly home: string;
	/** The working directories as they really are on disk: the cwd first, then the added ones. */
	readonly directories: readonly string[];
	/** Whether `bypassPermissions` may take effect. Settings can disable it. */
	readonly bypassAvailable: boolean;
}

/** The inputs a session starts from: settings, flags and the working directory. */
export interface PermissionInit {
	readonly cwd: string;
	readonly home?: string;
	/** `permissions` of the merged settings. */
	readonly settings?: SettingsPermissions;
	readonly additionalDirectories?: readonly string[];
	/** `--permission-mode` or `--dangerously-skip-permissions`, already parsed. */
	readonly cliMode?: PermissionMode;
	readonly allowedTools?: readonly string[];
	readonly disallowedTools?: readonly string[];
}

export interface SettingsPermissions {
	readonly allow?: readonly string[];
	readonly ask?: readonly string[];
	readonly deny?: readonly string[];
	readonly defaultMode?: string;
	readonly disableBypassPermissionsMode?: string;
}

export class PermissionState {
	private mode: PermissionMode;
	private rules: RuleSet;
	private readonly cwd: string;
	private readonly home: string;
	private readonly directories: readonly string[];
	private readonly bypassAvailable: boolean;

	constructor(init: PermissionInit) {
		this.cwd = init.cwd;
		this.home = init.home ?? homedir();
		this.directories = canonicalDirectories(init.cwd, init.additionalDirectories ?? []);
		this.bypassAvailable = init.settings?.disableBypassPermissionsMode !== "disable";
		this.rules = new RuleSet([
			...rulesFromTexts(init.settings?.allow ?? [], "allow", "settings"),
			...rulesFromTexts(init.settings?.ask ?? [], "ask", "settings"),
			...rulesFromTexts(init.settings?.deny ?? [], "deny", "settings"),
			...rulesFromTexts(init.allowedTools ?? [], "allow", "cliArg"),
			...rulesFromTexts(init.disallowedTools ?? [], "deny", "cliArg"),
		]);
		this.mode = this.startMode(init);
	}

	/** The command line wins over `defaultMode`. A bypass request settings forbid becomes `default`. */
	private startMode(init: PermissionInit): PermissionMode {
		const requested = init.cliMode ?? parsePermissionMode(init.settings?.defaultMode) ?? "default";
		return requested === "bypassPermissions" && !this.bypassAvailable
			? stricterMode(requested, "default")
			: requested;
	}

	current(): PermissionContext {
		return {
			mode: this.mode,
			rules: this.rules,
			cwd: this.cwd,
			home: this.home,
			directories: this.directories,
			bypassAvailable: this.bypassAvailable,
		};
	}

	/** Sets the mode. A bypass request the settings forbid is refused, and the mode is left as it was. */
	setMode(mode: PermissionMode): boolean {
		if (mode === "bypassPermissions" && !this.bypassAvailable) return false;
		this.mode = mode;
		return true;
	}

	addRules(texts: readonly string[], behavior: RuleBehavior, source: RuleSource): void {
		this.rules = this.rules.with(rulesFromTexts(texts, behavior, source));
	}
}
