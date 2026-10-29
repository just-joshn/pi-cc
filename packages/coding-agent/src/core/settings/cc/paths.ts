/** The settings file each tier reads, mirroring the paths Claude Code 2.1.312 uses. */

import { join, posix, win32 } from "node:path";
import type { CcSettingsSource } from "./types.ts";

export interface CcPathLocation {
	readonly cwd: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: string;
}

/** `$CLAUDE_CONFIG_DIR` when set and non-empty, else `~/.claude`. */
export function ccConfigDir(env: CcPathLocation["env"], home: string): string {
	const configDir = env.CLAUDE_CONFIG_DIR;
	return configDir !== undefined && configDir.length > 0 ? configDir : join(home, ".claude");
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function userSettingsPath(env: CcPathLocation["env"], home: string): string {
	return join(ccConfigDir(env, home), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.json");
}

export function localSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.local.json");
}

/** The operator directory. Undefined on a platform Claude Code has no managed directory for. */
export function ccManagedDir(platform: string): string | undefined {
	switch (platform) {
		case "darwin":
			return "/Library/Application Support/ClaudeCode";
		case "linux":
			return "/etc/claude-code";
		case "win32":
			return "C:\\Program Files\\ClaudeCode";
		default:
			return undefined;
	}
}

/** The operator tier's settings file, inside `ccManagedDir`. */
export function managedSettingsPath(platform: string): string | undefined {
	const dir = ccManagedDir(platform);
	if (dir === undefined) {
		return undefined;
	}
	return (platform === "win32" ? win32 : posix).join(dir, "managed-settings.json");
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
