/** Auto memory: whether it is on, where its directory is, and how its `MEMORY.md` index is read. */

import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import { canonicalizePath } from "../../utils/paths.ts";
import { findGitPaths } from "../footer-data-provider.ts";

/** Whether auto memory is on for these environment variables and merged Claude Code settings values. */
export function isAutoMemoryEnabled(
	env: Readonly<Record<string, string | undefined>>,
	values: Readonly<Record<string, unknown>>,
): boolean {
	const disable = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY?.toLowerCase();
	if (disable !== undefined && TRUTHY.has(disable)) {
		return false;
	}
	if (disable !== undefined && FALSY.has(disable)) {
		return true;
	}
	if (env.CLAUDE_CODE_SIMPLE) {
		return false;
	}
	return values.autoMemoryEnabled !== false;
}

/** The auto memory directory, with a trailing separator: `autoMemoryDirectory` when valid, else the per-project default. */
export function resolveAutoMemoryDir(
	configDir: string,
	cwd: string,
	home: string,
	values: Readonly<Record<string, unknown>>,
): string {
	const configured = validMemoryDirectory(values.autoMemoryDirectory, home);
	if (configured !== undefined) {
		return configured;
	}
	return `${join(configDir, "projects", projectSlug(projectKey(cwd)), "memory")}/`;
}

/** The directory name a project key maps to: non-alphanumerics become `-`, and long keys keep a hash suffix. */
export function projectSlug(key: string): string {
	const slug = key.replace(/[^a-zA-Z0-9]/g, "-");
	if (slug.length <= MAX_SLUG_LENGTH) {
		return slug;
	}
	return `${slug.slice(0, MAX_SLUG_LENGTH)}-${Math.abs(javaStringHash(key)).toString(36)}`;
}

/** `MEMORY.md` content after the line and character limits, with a note appended when anything was cut. */
export function truncateMemoryIndex(content: string): string {
	const trimmed = content.trim();
	const lines = trimmed.split("\n");
	let kept = lines.length > MAX_INDEX_LINES ? lines.slice(0, MAX_INDEX_LINES).join("\n") : trimmed;
	const overChars = kept.length > MAX_INDEX_CHARS;
	if (overChars) {
		const lastBreak = kept.lastIndexOf("\n", MAX_INDEX_CHARS);
		kept = kept.slice(0, lastBreak > 0 ? lastBreak : MAX_INDEX_CHARS);
	}
	if (kept.length === trimmed.length) {
		return trimmed;
	}
	const keptLines = kept.split("\n").length;
	const limit = overChars ? `${MAX_INDEX_LINES} lines and ${MAX_INDEX_CHARS} characters` : `${MAX_INDEX_LINES} lines`;
	const cut = lines.length - keptLines;
	return `${kept}\n\n> Note: MEMORY.md has ${lines.length} lines and only the first ${limit} are loaded, so ${cut} line${cut === 1 ? "" : "s"} from line ${keptLines + 1} on were left out. Keep each index entry to one short line and move details into topic files.`;
}

/** Create the auto memory directory so the model can write into it. Failures are left to the first write. */
export function ensureAutoMemoryDir(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const MAX_SLUG_LENGTH = 200;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_CHARS = 25000;

function validMemoryDirectory(value: unknown, home: string): string | undefined {
	if (typeof value !== "string" || value.includes("\0")) {
		return undefined;
	}
	const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
	const normalized = normalize(expanded).replace(/[\\/]+$/, "");
	if (!isAbsolute(normalized) || normalized.length < 3 || parse(normalized).root === normalized) {
		return undefined;
	}
	return `${normalized}/`.normalize("NFC");
}

// The main checkout's root, shared by every worktree of the repository, so they share one memory.
function projectKey(cwd: string): string {
	const git = findGitPaths(cwd);
	if (git === null) {
		return cwd;
	}
	const commonGitDir = canonicalizePath(git.commonGitDir);
	return basename(commonGitDir) === ".git" ? dirname(commonGitDir) : canonicalizePath(git.repoDir);
}

function javaStringHash(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
	}
	return hash;
}
