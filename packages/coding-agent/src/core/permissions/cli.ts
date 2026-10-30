import type { PermissionInit, SettingsPermissions } from "./context.ts";
import { parsePermissionMode } from "./mode.ts";
import { parseRuleText } from "./rules.ts";

export interface PermissionFlags {
	readonly permissionMode?: string;
	readonly permissionPrompts?: string;
	readonly dangerouslySkipPermissions?: boolean;
	readonly allowedTools?: readonly string[];
	readonly disallowedTools?: readonly string[];
}

export interface PermissionSetup {
	readonly init: PermissionInit;
	readonly prompts: "host" | "none";
	readonly deniedToolPatterns: readonly string[];
	readonly warnings: readonly string[];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function settingsPermissions(values: Readonly<Record<string, unknown>>): SettingsPermissions {
	const raw = values.permissions;
	if (typeof raw !== "object" || raw === null) return {};
	const permissions = raw as Record<string, unknown>;
	return {
		allow: strings(permissions.allow),
		ask: strings(permissions.ask),
		deny: strings(permissions.deny),
		...(typeof permissions.defaultMode === "string" ? { defaultMode: permissions.defaultMode } : {}),
		...(permissions.blockReadsOutsideWorkingDirectories === true
			? { blockReadsOutsideWorkingDirectories: true }
			: {}),
		...(typeof permissions.disableBypassPermissionsMode === "string"
			? { disableBypassPermissionsMode: permissions.disableBypassPermissionsMode }
			: {}),
	};
}

/** The rules the flags give are split on commas and spaces outside parentheses, as Claude Code splits `--allowedTools`. */
export function splitToolList(entries: readonly string[]): string[] {
	const tools: string[] = [];
	for (const entry of entries) {
		let depth = 0;
		let current = "";
		for (const char of entry) {
			if (char === "(") depth++;
			if (char === ")") depth = Math.max(0, depth - 1);
			if ((char === "," || /\s/.test(char)) && depth === 0) {
				if (current !== "") tools.push(current);
				current = "";
			} else current += char;
		}
		if (current !== "") tools.push(current);
	}
	return tools;
}

function deniedPatterns(denyTexts: readonly string[]): string[] {
	const patterns: string[] = [];
	for (const text of denyTexts) {
		const rule = parseRuleText(text);
		if (rule === undefined || rule.content !== undefined) continue;
		const isServer = rule.toolName.startsWith("mcp__") && rule.toolName.split("__").length === 2;
		patterns.push(isServer ? `${rule.toolName}__*` : rule.toolName.replace(/__\*$/, "__*"));
	}
	return patterns;
}

export function permissionSetup(
	flags: PermissionFlags,
	settingsValues: Readonly<Record<string, unknown>>,
	addDir: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): PermissionSetup {
	const settings = settingsPermissions(settingsValues);
	const rawDirectories = (settingsValues.permissions as { additionalDirectories?: unknown } | undefined)
		?.additionalDirectories;
	const additionalDirectories = [...strings(rawDirectories), ...addDir];
	const warnings: string[] = [];
	let cliMode = parsePermissionMode(flags.permissionMode);
	if (flags.dangerouslySkipPermissions) cliMode = "bypassPermissions";
	if (cliMode === "auto" || (cliMode === undefined && settings.defaultMode === "auto")) {
		warnings.push(
			"Permission mode auto needs the auto-mode classifier, which this build does not have. Calls are asked about as in the default mode.",
		);
	}
	const allowedTools = splitToolList(flags.allowedTools ?? []);
	const disallowedTools = splitToolList(flags.disallowedTools ?? []);
	return {
		init: {
			cwd,
			settings,
			additionalDirectories,
			...(cliMode === undefined ? {} : { cliMode }),
			allowedTools,
			disallowedTools,
			removalWaiverRequested:
				(env.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS ?? "") !== "" &&
				(env.CLAUDE_CODE_CHILD_SESSION ?? "") === "",
			...(typeof settingsValues.useAutoModeDuringPlan === "boolean"
				? { useAutoModeDuringPlan: settingsValues.useAutoModeDuringPlan }
				: {}),
		},
		prompts: flags.permissionPrompts === "none" ? "none" : "host",
		deniedToolPatterns: deniedPatterns([...(settings.deny ?? []), ...disallowedTools]),
		warnings,
	};
}
