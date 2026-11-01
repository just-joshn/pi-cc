/**
 * File-path questions the permission checks ask: where a path really lands, whether it lies in the
 * working directories, whether it is a settings or shell-startup file, and whether a path rule
 * covers it.
 *
 * This is the first cut: one realpath of the deepest existing ancestor, with dangling links followed
 * by hand. The path-safety unit owns the full spelling walk and double canonicalization, and
 * replaces {@link canonicalPath} behind the same signatures.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const MAX_LINK_HOPS = 40;

export function canonicalPath(path: string, cwd: string): string {
	return landing(isAbsolute(path) ? resolve(path) : resolve(cwd, path), MAX_LINK_HOPS);
}

/**
 * Where a write to `full` lands. `realpath` fails on a link whose target is missing, and a write
 * through it creates the target, so the link is followed by hand: the first missing component that
 * is a link continues at its target.
 */
function landing(full: string, hops: number): string {
	try {
		return realpathSync(full);
	} catch {
		const parent = dirname(full);
		if (parent === full) return full;
		const real = join(landing(parent, hops), basename(full));
		const target = hops > 0 ? linkTarget(real) : undefined;
		return target === undefined ? real : landing(resolve(dirname(real), target), hops - 1);
	}
}

function linkTarget(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
	} catch {
		return undefined;
	}
}

export function isLeafSymlink(path: string, cwd: string): boolean {
	return linkTarget(isAbsolute(path) ? resolve(path) : resolve(cwd, path)) !== undefined;
}

function fold(path: string): string {
	return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

export function isInside(directory: string, path: string): boolean {
	const base = fold(directory);
	const target = fold(path);
	return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

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

/** The ask Claude Code raises before any tool edits a settings or shell-startup file, or undefined when the path is ordinary. */
export function editSafetyMessage(path: string): string | undefined {
	if (isSettingsFile(path)) return `Claude requested permissions to write to ${path}, but you haven't granted it yet.`;
	if (isSensitivePath(path)) return `Claude requested permissions to edit ${path} which is a sensitive file.`;
	return undefined;
}

export function isSettingsFile(absolute: string): boolean {
	return /(?:^|[/\\])\.claude[/\\]settings(?:\.local)?\.json$/i.test(absolute);
}

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
	return pattern.includes("/") ? `${base.cwd}/${pattern}` : pattern;
}

/** Whether a path rule's pattern covers the path, tried against the path as written and as it really lands. */
export function pathRuleMatches(pattern: string, path: string, base: PathRuleBase): boolean {
	const full = anchored(pattern.replace(/\/$/, ""), base);
	const prefix = full.includes("/") ? "^" : "(?:^|/)";
	const regex = new RegExp(`${prefix}${globSource(full)}(?:/.*)?$`, CASE_INSENSITIVE ? "si" : "s");
	const written = isAbsolute(path) ? resolve(path) : resolve(base.cwd, path);
	return [written, canonicalPath(path, base.cwd)].some((candidate) => regex.test(candidate));
}
