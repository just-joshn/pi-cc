/**
 * Claude Code memory discovery: the files loaded at startup (managed, user, the directory walk, auto
 * memory) and the files a file access below the working directory brings in.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { canonicalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { findGitPaths } from "../footer-data-provider.ts";
import { ccConfigDir, ccManagedDir } from "../settings/cc/paths.ts";
import { CC_FILE_SOURCES } from "../settings/cc/types.ts";
import { isAutoMemoryEnabled, resolveAutoMemoryDir, truncateMemoryIndex } from "./auto-memory.ts";
import { extractImportPaths, isTextPath, resolveImportPath, stripCommentBlocks } from "./imports.ts";
import { listRuleFiles, type MemoryRule, ruleGlobs, ruleMatches } from "./rules.ts";

export type MemoryType = "managed" | "user" | "project" | "local" | "auto";

/** One loaded memory file. `content` has its frontmatter and comment-only blocks removed. */
export interface MemoryFile {
	readonly path: string;
	readonly type: MemoryType;
	readonly content: string;
	/** The file that imported this one. */
	readonly parent?: string;
}

/** Everything discovery reads from outside the file system, already resolved. */
export interface MemoryLocation {
	readonly cwd: string;
	readonly home: string;
	readonly configDir: string;
	/** Undefined on a platform with no managed directory. */
	readonly managedDir: string | undefined;
	/** Admitted setting sources; `project` and `local` also require a trusted project. */
	readonly sources: { readonly user: boolean; readonly project: boolean; readonly local: boolean };
	/** `claudeMdExcludes` globs. */
	readonly excludes: readonly string[];
	readonly autoMemory: { readonly dir: string } | undefined;
	readonly disabled: boolean;
}

export interface MemorySnapshot {
	/** Startup memory, in the order it is shown to the model. */
	readonly files: readonly MemoryFile[];
	readonly autoMemoryDir: string | undefined;
	/** Where the snapshot was taken, for loading memory on file access. Absent when memory was never resolved. */
	readonly location?: MemoryLocation;
}

export interface MemoryLocationInput {
	readonly cwd: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: string;
	/** Merged Claude Code settings values. */
	readonly values: Readonly<Record<string, unknown>>;
	/** Tier names from `--setting-sources`. Undefined admits all three file tiers. */
	readonly settingSources: readonly string[] | undefined;
	readonly projectTrusted: boolean;
	/** Set by `--bare`, `--safe-mode` and `--no-context-files`. */
	readonly disabled: boolean;
}

/** Build the location discovery reads from the session's directory, environment, settings and flags. */
export function resolveMemoryLocation(input: MemoryLocationInput): MemoryLocation {
	const { cwd, home, env, values } = input;
	const configDir = ccConfigDir(env, home);
	const admitted = input.settingSources ?? CC_FILE_SOURCES;
	const disabled = input.disabled || Boolean(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS);
	const excludes = Array.isArray(values.claudeMdExcludes) ? values.claudeMdExcludes : [];
	return {
		cwd,
		home,
		configDir,
		managedDir: ccManagedDir(input.platform),
		sources: {
			user: admitted.includes("user"),
			project: input.projectTrusted && admitted.includes("project"),
			local: input.projectTrusted && admitted.includes("local"),
		},
		excludes: excludes.filter((pattern): pattern is string => typeof pattern === "string"),
		autoMemory:
			!disabled && isAutoMemoryEnabled(env, values)
				? { dir: resolveAutoMemoryDir(configDir, cwd, home, values) }
				: undefined,
		disabled,
	};
}

/** The memory loaded at startup, in order: managed, user, each directory from the top down to cwd, auto memory. */
export function discoverMemory(location: MemoryLocation): MemorySnapshot {
	if (location.disabled) {
		return { files: [], autoMemoryDir: undefined, location };
	}
	const load = createLoad(location, new Set());
	const { cwd, managedDir, configDir, sources } = location;
	const files: MemoryFile[] = [];
	if (managedDir !== undefined) {
		files.push(...loadMemoryFile(load, join(managedDir, "CLAUDE.md"), MANAGED));
		files.push(...loadRules(load, join(managedDir, ".claude", "rules"), MANAGED, cwd, isUnconditional));
	}
	if (sources.user) {
		files.push(...loadMemoryFile(load, join(configDir, "CLAUDE.md"), USER));
		files.push(...loadRules(load, join(configDir, "rules"), USER, cwd, isUnconditional));
	}
	if (sources.project || sources.local) {
		const shadowed = shadowedDirTest(cwd);
		for (const dir of ancestorsTopDown(cwd)) {
			if (sources.project && !shadowed(dir)) {
				files.push(...loadMemoryFile(load, join(dir, "CLAUDE.md"), PROJECT));
				files.push(...loadMemoryFile(load, join(dir, ".claude", "CLAUDE.md"), PROJECT));
				files.push(...loadRules(load, join(dir, ".claude", "rules"), PROJECT, dir, isUnconditional));
			}
			if (sources.local) {
				files.push(...loadMemoryFile(load, join(dir, "CLAUDE.local.md"), LOCAL));
			}
		}
	}
	const autoMemory = location.autoMemory === undefined ? undefined : readAutoMemory(location.autoMemory.dir);
	if (autoMemory !== undefined) {
		files.push(autoMemory);
	}
	return { files, autoMemoryDir: location.autoMemory?.dir, location };
}

/**
 * The memory an access to `file` brings in, leaving out every path in `loaded`: matching managed and
 * user rules, then for each directory below cwd down to the file's own its memory files and rules,
 * then the matching project rules of cwd and its ancestors. Imports never leave cwd here.
 */
export function memoryForFileAccess(file: string, location: MemoryLocation, loaded: ReadonlySet<string>): MemoryFile[] {
	if (location.disabled) {
		return [];
	}
	const { cwd, managedDir, configDir, sources } = location;
	const load = createLoad(location, new Set(loaded));
	const target = fileInsideCwd(load, resolve(cwd, file));
	if (target === undefined) {
		return [];
	}
	load.processed.add(target.path);
	const matchesTarget = (rule: MemoryRule) => rule.globs !== undefined && ruleMatches(rule, target.path);
	const files: MemoryFile[] = [];
	if (managedDir !== undefined) {
		files.push(...loadRules(load, join(managedDir, ".claude", "rules"), MANAGED, cwd, matchesTarget));
	}
	if (sources.user) {
		files.push(...loadRules(load, join(configDir, "rules"), NESTED_USER, cwd, matchesTarget));
	}
	for (const dir of nestedDirs(target)) {
		if (sources.project) {
			files.push(...loadMemoryFile(load, join(dir, "CLAUDE.md"), PROJECT));
			files.push(...loadMemoryFile(load, join(dir, ".claude", "CLAUDE.md"), PROJECT));
		}
		if (sources.local) {
			files.push(...loadMemoryFile(load, join(dir, "CLAUDE.local.md"), LOCAL));
		}
		if (sources.project) {
			files.push(...loadRules(load, join(dir, ".claude", "rules"), PROJECT, dir, isUnconditional));
			files.push(...loadRules(load, join(dir, ".claude", "rules"), PROJECT, dir, matchesTarget));
		}
	}
	if (sources.project) {
		const shadowed = shadowedDirTest(cwd);
		for (const dir of ancestorsTopDown(cwd)) {
			if (!shadowed(dir)) {
				files.push(...loadRules(load, join(dir, ".claude", "rules"), PROJECT, dir, matchesTarget));
			}
		}
	}
	return files;
}

/** The memory type a file gets and whether its imports may leave the working directory. */
interface Origin<Type extends MemoryType = MemoryType> {
	readonly type: Type;
	readonly includeExternal: boolean;
}

/** State shared by one load: every path already taken, the exclude patterns with their real-path variants, and cwd's spellings. */
interface Load {
	readonly location: MemoryLocation;
	readonly processed: Set<string>;
	readonly excludes: readonly string[];
	/** cwd as given and as its real path. */
	readonly cwdRoots: readonly string[];
}

/** A memory file as read: frontmatter, the text imports are scanned in, and the processed content. */
interface MemoryDocument {
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
	readonly content: string;
}

// Project imports outside cwd would need a per-project approval pi-cc does not ask for yet.
const MANAGED: Origin<"managed"> = { type: "managed", includeExternal: false };
const USER: Origin<"user"> = { type: "user", includeExternal: true };
const NESTED_USER: Origin<"user"> = { type: "user", includeExternal: false };
const PROJECT: Origin<"project"> = { type: "project", includeExternal: false };
const LOCAL: Origin = { type: "local", includeExternal: false };
const MAX_IMPORT_DEPTH = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const EXCLUDABLE: ReadonlySet<MemoryType> = new Set(["user", "project", "local"]);

function isUnconditional(rule: MemoryRule): boolean {
	return rule.globs === undefined;
}

function createLoad(location: MemoryLocation, processed: Set<string>): Load {
	return {
		location,
		processed,
		excludes: location.excludes.flatMap(withRealPathVariant),
		cwdRoots: [location.cwd, canonicalizePath(location.cwd)],
	};
}

/** A file and, depth first in order of appearance, the files it imports. */
function loadMemoryFile(
	load: Load,
	path: string,
	origin: Origin,
	depth = 0,
	parent?: string,
	read?: MemoryDocument,
): MemoryFile[] {
	const key = normalize(path);
	if (depth >= MAX_IMPORT_DEPTH || load.processed.has(key)) {
		return [];
	}
	const real = realPathOrUndefined(path) ?? key;
	if (load.processed.has(real) || isExcluded(load, origin.type, [key, real])) {
		return [];
	}
	load.processed.add(key);
	load.processed.add(real);
	if (depth > 0 && !origin.includeExternal && !isInsideCwd(load, real)) {
		return [];
	}
	const document = read ?? readMemoryDocument(path);
	if (document === undefined || document.content.trim().length === 0) {
		return [];
	}
	const file: MemoryFile = { path, type: origin.type, content: document.content, ...(parent ? { parent } : {}) };
	const imports = extractImportPaths(document.body).flatMap((importPath) => {
		const target = resolveImportPath(importPath, dirname(real), load.location.home);
		if (target === undefined || (!origin.includeExternal && !isInsideCwd(load, target))) {
			return [];
		}
		return loadMemoryFile(load, target, origin, depth + 1, path);
	});
	return [file, ...imports];
}

/** The rule files under `rulesDir` that `select` keeps, each followed by its imports. */
function loadRules(
	load: Load,
	rulesDir: string,
	origin: Origin<MemoryRule["type"]>,
	base: string,
	select: (rule: MemoryRule) => boolean,
): MemoryFile[] {
	const admits = (realPath: string) => origin.includeExternal || isInsideCwd(load, realPath);
	if (isSymlink(rulesDir) || isSymlink(dirname(rulesDir))) {
		const real = realPathOrUndefined(rulesDir);
		if (real === undefined || !admits(real)) {
			return [];
		}
	}
	return listRuleFiles(rulesDir, admits).flatMap((path) => {
		const document = readMemoryDocument(path);
		if (document === undefined) {
			return [];
		}
		const rule: MemoryRule = {
			path,
			type: origin.type,
			base,
			globs: ruleGlobs(document.frontmatter.paths),
			content: document.content,
		};
		return select(rule) ? loadMemoryFile(load, path, origin, 0, undefined, document) : [];
	});
}

function readAutoMemory(dir: string): MemoryFile | undefined {
	const path = join(dir, "MEMORY.md");
	const document = readMemoryDocument(path);
	if (document === undefined || document.content.trim().length === 0) {
		return undefined;
	}
	return { path, type: "auto", content: truncateMemoryIndex(document.content) };
}

function readMemoryDocument(path: string): MemoryDocument | undefined {
	if (!isTextPath(path)) {
		return undefined;
	}
	let text: string;
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
			return undefined;
		}
		text = stripBom(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(text);
	} catch {
		parsed = { frontmatter: {}, body: text };
	}
	return { frontmatter: parsed.frontmatter, body: parsed.body, content: stripCommentBlocks(parsed.body) };
}

function isExcluded(load: Load, type: MemoryType, candidates: readonly string[]): boolean {
	if (!EXCLUDABLE.has(type) || load.excludes.length === 0) {
		return false;
	}
	return candidates.some((candidate) => {
		const path = candidate.replace(/\\/g, "/");
		return load.excludes.some((pattern) => minimatch(path, pattern, { dot: true }));
	});
}

// An absolute pattern also matches through the real path of its literal directory, so `/tmp/...`
// excludes the same files as `/private/tmp/...` on macOS.
function withRealPathVariant(pattern: string): string[] {
	if (!isAbsolute(pattern)) {
		return [pattern];
	}
	const glob = pattern.search(/[*?{[]/);
	const literalDir = dirname(glob === -1 ? pattern : pattern.slice(0, glob));
	const real = realPathOrUndefined(literalDir);
	return real === undefined || real === literalDir ? [pattern] : [pattern, real + pattern.slice(literalDir.length)];
}

/** A path inside cwd, as given or else as its real path, with the cwd spelling it lies under. */
interface FileInCwd {
	readonly path: string;
	readonly root: string;
}

function fileInsideCwd(load: Load, path: string): FileInCwd | undefined {
	const real = realPathOrUndefined(path);
	for (const candidate of real === undefined ? [path] : [path, real]) {
		const root = load.cwdRoots.find((cwdRoot) => isInside(candidate, cwdRoot));
		if (root !== undefined) {
			return { path: candidate, root };
		}
	}
	return undefined;
}

function isInsideCwd(load: Load, path: string): boolean {
	return load.cwdRoots.some((root) => isInside(path, root));
}

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `dir` and its ancestors from the top down, without the file system root. */
function ancestorsTopDown(dir: string): string[] {
	const dirs: string[] = [];
	for (let current = dir; current !== parse(current).root; current = dirname(current)) {
		dirs.unshift(current);
	}
	return dirs;
}

/** The directories strictly below cwd down to the directory holding the file, from the top down. */
function nestedDirs(file: FileInCwd): string[] {
	const segments = relative(file.root, dirname(file.path))
		.split(sep)
		.filter((segment) => segment.length > 0);
	return segments.map((_, index) => join(file.root, ...segments.slice(0, index + 1)));
}

/**
 * A linked worktree nested inside its main checkout sees the main checkout's directories as
 * ancestors. Those get no project memory: the worktree carries its own copy of the same files.
 */
function shadowedDirTest(cwd: string): (dir: string) => boolean {
	const git = findGitPaths(cwd);
	if (git === null) {
		return () => false;
	}
	const commonGitDir = canonicalizePath(git.commonGitDir);
	const worktreeRoot = canonicalizePath(git.repoDir);
	const mainRoot = dirname(commonGitDir);
	if (basename(commonGitDir) !== ".git" || !worktreeRoot.startsWith(`${mainRoot}${sep}`)) {
		return () => false;
	}
	return (dir) => {
		const real = canonicalizePath(dir);
		return isInside(real, mainRoot) && !isInside(real, worktreeRoot);
	};
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function realPathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}
