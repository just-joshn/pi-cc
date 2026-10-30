/** Persists a "don't ask again" grant into the project's local settings file. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds `ruleText` to `permissions.allow` of `<project>/.claude/settings.local.json`. Returns the file, or undefined when it could not be written. */
export function persistAllowRule(project: string, ruleText: string): string | undefined {
	const file = join(project, ".claude", "settings.local.json");
	try {
		const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
		if (!isObject(parsed)) return undefined;
		const permissions = isObject(parsed.permissions) ? parsed.permissions : {};
		const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
		if (allow.includes(ruleText)) return file;
		const next = { ...parsed, permissions: { ...permissions, allow: [...allow, ruleText] } };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
		return file;
	} catch {
		return undefined;
	}
}
