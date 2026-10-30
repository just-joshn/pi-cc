/** `.claude/rules` directories: which files they hold, which files a rule applies to, and when it is unconditional. */

import { type Dirent, opendirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { expand } from "brace-expansion";
import ignore from "ignore";

/** A rule file. `globs` undefined means the rule applies everywhere and loads at startup. */
export interface MemoryRule {
	readonly path: string;
	readonly type: "managed" | "user" | "project";
	/** The directory `globs` are relative to. */
	readonly base: string;
	readonly globs: readonly string[] | undefined;
	readonly content: string;
}

/**
 * The `.md` files under `rulesDir`, depth first in the directory's own listing order. Symlinked
 * directories are followed once each. `admits` sees the real path of every symlinked entry and the
 * entry is skipped when it returns false.
 */
export function listRuleFiles(rulesDir: string, admits: (realPath: string) => boolean): string[] {
	const files: string[] = [];
	collectRuleFiles(rulesDir, admits, new Set(), files);
	return files;
}

/** The `globs` a rule's frontmatter `paths` value names, or undefined when the rule is unconditional. */
export function ruleGlobs(paths: unknown): string[] | undefined {
	const entries = typeof paths === "string" ? [paths] : Array.isArray(paths) ? paths : [];
	const patterns = entries
		.filter((entry): entry is string => typeof entry === "string")
		.flatMap(splitTopLevelCommas)
		.flatMap((pattern) => expand(pattern.trim(), { max: 1000 }))
		.map((pattern) => (pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern))
		.filter((pattern) => pattern.length > 0);
	if (patterns.length === 0 || patterns.every((pattern) => pattern === "**")) {
		return undefined;
	}
	return patterns;
}

/** Whether a conditional rule applies to `file`, matched with gitignore semantics relative to the rule's base. */
export function ruleMatches(rule: MemoryRule, file: string): boolean {
	if (rule.globs === undefined) {
		return false;
	}
	const rel = relative(rule.base, file);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
		return false;
	}
	try {
		return ignore()
			.add([...rule.globs])
			.ignores(rel.split(sep).join("/"));
	} catch {
		return false;
	}
}

function collectRuleFiles(
	dir: string,
	admits: (realPath: string) => boolean,
	visited: Set<string>,
	files: string[],
): void {
	const real = realPathOrUndefined(dir);
	if (real === undefined || visited.has(real)) {
		return;
	}
	visited.add(real);
	// opendir yields entries in the file system's own order; readdirSync sorts them.
	let handle: ReturnType<typeof opendirSync>;
	try {
		handle = opendirSync(dir);
	} catch {
		return;
	}
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			const path = join(dir, entry.name);
			const kind = entryKind(entry, path, admits);
			if (kind === "directory") {
				collectRuleFiles(path, admits, visited, files);
			} else if (kind === "file" && entry.name.endsWith(".md")) {
				files.push(path);
			}
		}
	} finally {
		handle.closeSync();
	}
}

function entryKind(
	entry: Dirent,
	path: string,
	admits: (realPath: string) => boolean,
): "directory" | "file" | undefined {
	if (entry.isDirectory()) {
		return "directory";
	}
	if (entry.isFile()) {
		return "file";
	}
	if (!entry.isSymbolicLink()) {
		return undefined;
	}
	const real = realPathOrUndefined(path);
	if (real === undefined || !admits(real)) {
		return undefined;
	}
	try {
		const stats = statSync(real);
		return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
	} catch {
		return undefined;
	}
}

function realPathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function splitTopLevelCommas(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth = Math.max(0, depth - 1);
		} else if (char === "," && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}
