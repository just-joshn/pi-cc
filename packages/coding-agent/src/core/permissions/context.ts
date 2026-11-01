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
	/** Plan mode leaves a Bash command that is not read-only to the auto-mode classifier, so no allow rule runs it. */
	readonly autoModeDuringPlan: boolean;
	/** `permissions.blockReadsOutsideWorkingDirectories`: reads outside the working directories are refused or held, bypass included. */
	readonly blockReadsOutsideWorkingDirectories: boolean;
	/** The operator waived the dangerous-removal breaker and nothing in the session, a rule or a PermissionRequest hook, could have narrowed a removal. */
	readonly removalWaived: boolean;
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
	/** `useAutoModeDuringPlan` of the merged settings. Defaults to true, as in Claude Code. */
	readonly useAutoModeDuringPlan?: boolean;
	/** `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` is set and this is not a child session. */
	readonly removalWaiverRequested?: boolean;
	/** A PermissionRequest hook is configured. Such a hook can answer any ask, so the removal waiver no longer holds. */
	readonly permissionRequestHooks?: boolean;
}

export interface SettingsPermissions {
	readonly allow?: readonly string[];
	readonly ask?: readonly string[];
	readonly deny?: readonly string[];
	readonly defaultMode?: string;
	readonly disableBypassPermissionsMode?: string;
	readonly blockReadsOutsideWorkingDirectories?: boolean;
}

export class PermissionState {
	private mode: PermissionMode;
	private rules: RuleSet;
	private readonly cwd: string;
	private readonly home: string;
	private readonly directories: readonly string[];
	private readonly bypassAvailable: boolean;
	private readonly autoModeDuringPlan: boolean;
	private readonly blockReads: boolean;
	private readonly removalWaiverRequested: boolean;
	private readonly permissionRequestHooks: boolean;

	constructor(init: PermissionInit) {
		this.cwd = init.cwd;
		this.home = init.home ?? homedir();
		this.directories = canonicalDirectories(init.cwd, init.additionalDirectories ?? []);
		this.bypassAvailable = init.settings?.disableBypassPermissionsMode !== "disable";
		this.autoModeDuringPlan = init.useAutoModeDuringPlan !== false;
		this.blockReads = init.settings?.blockReadsOutsideWorkingDirectories === true;
		this.removalWaiverRequested = init.removalWaiverRequested === true;
		this.permissionRequestHooks = init.permissionRequestHooks === true;
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
			autoModeDuringPlan: this.autoModeDuringPlan,
			blockReadsOutsideWorkingDirectories: this.blockReads,
			removalWaived:
				this.removalWaiverRequested && !this.blockReads && !this.permissionRequestHooks && !this.narrowingRules(),
		};
	}

	/** Any deny or ask rule on a tool a removal could be judged under voids the waiver, as it does in Claude Code. */
	private narrowingRules(): boolean {
		return (["deny", "ask"] as const).some((behavior) =>
			this.rules.of(behavior).some((rule) => ["Bash", "Edit", "Read"].includes(rule.toolName)),
		);
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
