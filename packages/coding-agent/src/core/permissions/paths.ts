/**
 * File-path questions the permission checks ask: where a path really lands, whether it lies in the
 * working directories, whether it is a settings or shell-startup file, and whether a path rule
 * covers it.
 *
 * This is the first cut: one realpath of the deepest existing ancestor. The path-safety unit owns
 * the full spelling walk, leaf-symlink refusal and double canonicalization, and replaces
 * {@link canonicalPath} behind the same signatures.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/** The absolute path with symlinks resolved as far as the file system has the path. */
export function canonicalPath(path: string, cwd: string): string {
	return realOrAncestor(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
}

function realOrAncestor(full: string): string {
	try {
		return realpathSync(full);
	} catch {
		const parent = dirname(full);
		return parent === full ? full : join(realOrAncestor(parent), basename(full));
	}
}

function fold(path: string): string {
	return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

export function isInside(directory: string, path: string): boolean {
	const base = fold(directory);
	const target = fold(path);
	return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** The working directories as they really are on disk. */
export function canonicalDirectories(cwd: string, additional: readonly string[]): string[] {
	return [cwd, ...additional].map((directory) => canonicalPath(directory, cwd));
}

export function insideDirectories(directories: readonly string[], path: string): boolean {
	return directories.some((directory) => isInside(directory, path));
}

const SENSITIVE_DIRECTORIES = [
	".git",
	".vscode",
	".idea",
	".claude",
	".husky",
	".cargo",
	".devcontainer",
	".yarn",
	".mvn",
];
const SENSITIVE_FILES = new Set(
	[
		".gitconfig",
		".gitmodules",
		".bashrc",
		".bash_profile",
		".zshrc",
		".zprofile",
		".profile",
		".zshenv",
		".zlogin",
		".zlogout",
		".bash_login",
		".bash_aliases",
		".bash_logout",
		".envrc",
		".ripgreprc",
		".mcp.json",
		".claude.json",
		".npmrc",
		".yarnrc",
		".yarnrc.yml",
		".pnp.cjs",
		".pnp.loader.mjs",
		".pnpmfile.cjs",
		"bunfig.toml",
		".bunfig.toml",
		".bazelrc",
		".bazelversion",
		".bazeliskrc",
		".pre-commit-config.yaml",
		"lefthook.yml",
		".lefthook.yml",
		"lefthook.yaml",
		".lefthook.yaml",
		"gradle-wrapper.properties",
		"maven-wrapper.properties",
		".devcontainer.json",
		"pyrightconfig.json",
	].map((name) => name.toLowerCase()),
);

/** Files whose edit changes what runs later. Claude Code asks before editing them even where it would accept edits. */
export function isSensitivePath(absolute: string): boolean {
	const segments = absolute.split(/[/\\]/).map((segment) => segment.toLowerCase());
	const last = segments.at(-1) ?? "";
	if (SENSITIVE_FILES.has(last)) return true;
	return (
		segments.slice(0, -1).some((segment) => SENSITIVE_DIRECTORIES.includes(segment)) ||
		segments.join("/").includes(".config/git/")
	);
}

/** A Claude Code settings file: `.claude/settings.json` or `.claude/settings.local.json` under any directory. */
export function isSettingsFile(absolute: string): boolean {
	return /(?:^|[/\\])\.claude[/\\]settings(?:\.local)?\.json$/i.test(absolute);
}

// -- path rules -------------------------------------------------------------------------------------

export interface PathRuleBase {
	readonly cwd: string;
	readonly home: string;
}

function escapeRegex(text: string): string {
	return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globSource(glob: string): string {
	let out = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] as string;
		if (char === "*" && glob[index + 1] === "*") {
			out += ".*";
			index++;
			if (glob[index + 1] === "/") index++;
		} else if (char === "*") out += "[^/]*";
		else if (char === "?") out += "[^/]";
		else out += escapeRegex(char);
	}
	return out;
}

/** Where a rule's path pattern is anchored: `//x` is absolute, `~/x` is home, `/x` is the project root, `./x` and `x` are the working directory. */
function anchored(pattern: string, base: PathRuleBase): string {
	if (pattern.startsWith("//")) return pattern.slice(1);
	if (pattern.startsWith("~/")) return `${base.home}/${pattern.slice(2)}`;
	if (pattern.startsWith("/")) return `${base.cwd}${pattern}`;
	if (pattern.startsWith("./")) return `${base.cwd}/${pattern.slice(2)}`;
	return pattern;
}

/** Whether a path rule's pattern covers the path, tried against the path as written and as it really lands. */
export function pathRuleMatches(pattern: string, path: string, base: PathRuleBase): boolean {
	const full = anchored(pattern.replace(/\/$/, ""), base);
	const prefix = full.includes("/") ? "^" : "(?:^|/)";
	const regex = new RegExp(`${prefix}${globSource(full)}(?:/.*)?$`, CASE_INSENSITIVE ? "si" : "s");
	const written = isAbsolute(path) ? resolve(path) : resolve(base.cwd, path);
	return [written, canonicalPath(path, base.cwd)].some((candidate) => regex.test(candidate));
}
