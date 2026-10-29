/** The settings file each tier reads, mirroring the paths Claude Code 2.1.312 uses. */

import { join } from "node:path";
import type { CcSettingsSource } from "./types.ts";

export interface CcPathLocation {
	readonly cwd: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: string;
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function userSettingsPath(env: CcPathLocation["env"], home: string): string {
	const configDir = env.CLAUDE_CONFIG_DIR;
	const base = configDir !== undefined && configDir.length > 0 ? configDir : join(home, ".claude");
	return join(base, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.json");
}

export function localSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.local.json");
}

/** The operator tier. Undefined on a platform Claude Code has no managed directory for. */
export function managedSettingsPath(platform: string): string | undefined {
	switch (platform) {
		case "darwin":
			return "/Library/Application Support/ClaudeCode/managed-settings.json";
		case "linux":
			return "/etc/claude-code/managed-settings.json";
		case "win32":
			return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
		default:
			return undefined;
	}
}

/** One lookup for the loader, so every path mapping lives in this file. */
export function ccSettingsPath(source: CcSettingsSource, location: CcPathLocation): string | undefined {
	switch (source) {
		case "user":
			return userSettingsPath(location.env, location.home);
		case "project":
			return projectSettingsPath(location.cwd);
		case "local":
			return localSettingsPath(location.cwd);
		case "policy":
			return managedSettingsPath(location.platform);
		case "flag":
			return undefined;
	}
}
