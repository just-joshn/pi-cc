/**
 * Per-case, per-side sandbox roots, and every syscall the harness makes on a path a side can write.
 *
 * Two rules hold here. A path the side controls is only ever read without following a link at its last
 * component, so the unsandboxed harness cannot be pointed at the operator's files. And a path the side
 * controls is only ever hashed or read after being classified, so a link, a fifo, or a mode that denies
 * the read becomes a reported violation instead of a crash, a hang, or leaked content.
 *
 * Every path the sandbox profile names is realpath-resolved because Seatbelt matches resolved paths: a
 * profile that says `/var/...` instead of `/private/var/...` silently denies writes to its own temp root.
 */

import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only programs a case may run besides the two sides. Case data names one of these keys, never a path. */
export const PROBES = { ls: "/bin/ls", nc: "/usr/bin/nc", open: "/usr/bin/open" } as const;

export type ProbeName = keyof typeof PROBES;

export type SideName = "claude" | "pi-cc";

export interface Side {
	readonly name: SideName;
	command(): string[];
	executableRoots(): string[];
	prepare(roots: Roots, port: number | null): void;
}

export interface Roots {
	side: SideName;
	root: string;
	home: string;
	config: string;
	tmp: string;
	workspace: string;
	out: string;
	xdgConfig: string;
	xdgCache: string;
	xdgData: string;
	xdgState: string;
	agent: string;
}

export const REAL_HOME = userInfo().homedir;

/** A case workspace holds source and config files, so a file past this is a plant, not case data. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

const MODEL_API_KEY = "sk-ant-conformance-fixture-0000000000000000";

export function createRoots(tmpRoot: string, caseId: string, side: SideName): Roots {
	const root = realpathSync(mkdirp(join(tmpRoot, caseId, side)));
	const roots: Roots = {
		side,
		root,
		home: mkdirp(join(root, "home")),
		config: mkdirp(join(root, "config")),
		tmp: mkdirp(join(root, "tmp")),
		workspace: mkdirp(join(root, "workspace")),
		out: mkdirp(join(root, "out")),
		xdgConfig: mkdirp(join(root, "xdg-config")),
		xdgCache: mkdirp(join(root, "xdg-cache")),
		xdgData: mkdirp(join(root, "xdg-data")),
		xdgState: mkdirp(join(root, "xdg-state")),
		agent: mkdirp(join(root, "agent")),
	};
	return roots;
}

/**
 * Expands the case-file placeholders. `$HOME` is the side's temp home, never the real one. `$AGENT` and
 * `$CONFIG` are each side's own config store (`PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`), so one case can
 * seed a credential into each side's store without naming either side.
 */
export function expandPlaceholders(value: string, roots: Roots): string {
	return value
		.split("$WORKSPACE")
		.join(roots.workspace)
		.split("$TMP")
		.join(roots.tmp)
		.split("$CONFIG")
		.join(roots.config)
		.split("$AGENT")
		.join(roots.agent)
		.split("$HOME")
		.join(roots.home)
		.split("$REAL_HOME")
		.join(REAL_HOME)
		.split("$FIXTURES")
		.join(FIXTURES_DIR);
}

/**
 * The environment every side runs with. The harness owns these keys and the loader refuses a case that
 * replaces one, because a case that replaced PATH, HOME, or a disable flag would measure itself instead
 * of the pinned binary. The key list is derived from this table so the loader and the runner cannot
 * disagree about what is owned.
 */
const HARNESS_ENV: Readonly<Record<string, (roots: Roots, port: number | null) => string | undefined>> = {
	PATH: () => "/usr/bin:/bin:/usr/sbin:/sbin",
	HOME: (roots) => roots.home,
	CLAUDE_CONFIG_DIR: (roots) => roots.config,
	TMPDIR: (roots) => roots.tmp,
	SHELL: () => "/bin/sh",
	USER: () => "probe",
	LOGNAME: () => "probe",
	LANG: () => "C",
	LC_ALL: () => "C",
	TZ: () => "UTC",
	TERM: () => "dumb",
	NO_COLOR: () => "1",
	XDG_CONFIG_HOME: (roots) => roots.xdgConfig,
	XDG_CACHE_HOME: (roots) => roots.xdgCache,
	XDG_DATA_HOME: (roots) => roots.xdgData,
	XDG_STATE_HOME: (roots) => roots.xdgState,
	PI_OFFLINE: () => "1",
	PI_CODING_AGENT_DIR: (roots) => roots.agent,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: () => "1",
	DISABLE_TELEMETRY: () => "1",
	DISABLE_AUTOUPDATER: () => "1",
	DISABLE_ERROR_REPORTING: () => "1",
	DISABLE_GROWTHBOOK: () => "1",
	ANTHROPIC_BASE_URL: (_roots, port) => (port === null ? undefined : `http://127.0.0.1:${port}`),
	ANTHROPIC_API_KEY: (_roots, port) => (port === null ? undefined : MODEL_API_KEY),
	NO_PROXY: (_roots, port) => (port === null ? undefined : "127.0.0.1,localhost"),
};

export const HARNESS_ENV_KEYS: readonly string[] = Object.keys(HARNESS_ENV);

export function baseEnv(roots: Roots, port: number | null): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, resolve] of Object.entries(HARNESS_ENV)) {
		const value = resolve(roots, port);
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Seeds a case's files inside its side root, expanding placeholders in paths and contents. */
export function seedFiles(roots: Roots, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const target = seedTarget(roots, path);
		mkdirp(dirname(target));
		// Expanded in the content too, so a case can name its own workspace inside a file it seeds (a
		// trust record, or a settings file that has to point at the side root).
		writeFileSync(target, expandPlaceholders(content, roots));
	}
}

/**
 * A bare path seeds the workspace. A `$`-rooted path seeds the directory it names, so a case can write
 * the user settings file or a home-directory file the side reads before the workspace exists. Either
 * way the target stays inside the side's own root.
 */
function seedTarget(roots: Roots, path: string): string {
	if (!path.startsWith("$")) {
		const target = join(roots.workspace, path);
		if (relative(roots.workspace, target).startsWith("..")) throw new Error(`seeded path escapes workspace: ${path}`);
		return target;
	}
	const target = expandPlaceholders(path, roots);
	if (relative(roots.root, target).startsWith("..")) throw new Error(`seeded path escapes the case root: ${path}`);
	return target;
}

/** Every violation the harness can report against a side. Case data names one of these. */
export const VIOLATION_KINDS = [
	"symlink",
	"escaping-symlink",
	"dangling-symlink",
	"not-regular-file",
	"unreadable",
	"survivor",
] as const;

export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export interface Violation {
	kind: ViolationKind;
	/** A workspace-relative path, or null for the workspace itself and for a live descendant. */
	path: string | null;
}

export interface TreeScan {
	/** Relative path to an opaque value. Only a regular file the walk could read carries a digest. */
	entries: Map<string, string>;
	/** The text of the wanted paths, read in the same pass that hashed them. */
	text: Map<string, string>;
	violations: Violation[];
}

/**
 * Hashes a side's tree without following a link, opening a special file, or throwing on what the side
 * left behind. A link, a fifo or socket, an entry the walk could not read, and a file over the read cap
 * each become a violation and are never opened, so nothing downstream can be pointed at the operator's
 * files or block on a pipe. The tree's own anchor is checked first: a side can rename its workspace and
 * leave a link in its place, and the harness must never walk what that link names.
 *
 * `wanted` names the paths whose text the caller compares. Their text is kept from the same open that
 * produced the digest, so what the harness hashes and what it reports cannot come from two states of
 * the tree. The walk keeps its own stack rather than recursing, so a tree of any depth is reported
 * rather than overflowing the stack.
 */
export function hashTree(dir: string, wanted: readonly string[] = []): TreeScan {
	const scan: TreeScan = { entries: new Map(), text: new Map(), violations: [] };
	const wantedPaths = new Set(wanted);
	const root = realpathOrNull(dir);
	if (root === null) {
		scan.violations.push({ kind: "unreadable", path: null });
		return scan;
	}
	const anchor = lstatOrNull(dir);
	if (anchor === null) {
		scan.violations.push({ kind: "unreadable", path: null });
		return scan;
	}
	if (anchor.isSymbolicLink()) {
		scan.violations.push({ kind: "symlink", path: null });
		return scan;
	}
	if (!anchor.isDirectory()) {
		scan.violations.push({ kind: "not-regular-file", path: null });
		return scan;
	}
	const pending: { path: string; prefix: string }[] = [{ path: dir, prefix: "" }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		scanDirectory(current.path, current.prefix, root, wantedPaths, scan, pending);
	}
	return scan;
}

/** The paths that exist, where a dangling link counts as present: the side tried to create something. */
export function findPresentPaths(paths: readonly string[]): string[] {
	return paths.filter((path) => lstatOrNull(path) !== null);
}

function scanDirectory(
	current: string,
	prefix: string,
	root: string,
	wanted: Set<string>,
	scan: TreeScan,
	pending: { path: string; prefix: string }[],
): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(current, { withFileTypes: true });
	} catch (error) {
		const path = prefix === "" ? null : prefix;
		scan.entries.set(path ?? ".", `unreadable:${errorCode(error)}`);
		scan.violations.push({ kind: "unreadable", path });
		return;
	}
	for (const entry of entries) {
		const path = join(current, entry.name);
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			pending.push({ path, prefix: relative });
			continue;
		}
		if (entry.isSymbolicLink()) {
			const target = readlinkOrNull(path);
			if (target === null) {
				scan.entries.set(relative, "unreadable:link");
				scan.violations.push({ kind: "unreadable", path: relative });
				continue;
			}
			const kind = linkKind(path, target, root);
			scan.entries.set(relative, `symlink:${kind}:${target}`);
			scan.violations.push({ kind, path: relative });
			continue;
		}
		if (!entry.isFile()) {
			scan.entries.set(relative, `special:${specialKind(entry)}`);
			scan.violations.push({ kind: "not-regular-file", path: relative });
			continue;
		}
		readRegularFile(path, relative, wanted.has(relative), scan);
	}
}

function readRegularFile(path: string, relative: string, keepText: boolean, scan: TreeScan): void {
	const refuse = (reason: string) => {
		scan.entries.set(relative, `unreadable:${reason}`);
		scan.violations.push({ kind: "unreadable", path: relative });
	};
	try {
		const fd = openNoFollow(path);
		try {
			if (fstatSync(fd).size > MAX_READ_BYTES) {
				refuse("too-large");
				return;
			}
			const content = readFileSync(fd);
			scan.entries.set(relative, createHash("sha256").update(content).digest("hex"));
			if (keepText) scan.text.set(relative, content.toString("utf8"));
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		refuse(errorCode(error));
	}
}

/** How a link relates to the tree it sits in, decided from where its target lands, not from its text. */
function linkKind(linkPath: string, target: string, root: string): ViolationKind {
	const landed = realpathOrNull(resolve(dirname(linkPath), target));
	if (landed === null) return "dangling-symlink";
	if (landed === root || landed.startsWith(`${root}/`)) return "symlink";
	return "escaping-symlink";
}

function specialKind(entry: Dirent): string {
	if (entry.isFIFO()) return "fifo";
	if (entry.isSocket()) return "socket";
	if (entry.isBlockDevice()) return "block-device";
	if (entry.isCharacterDevice()) return "character-device";
	return "unknown";
}

/** Opens a side-controlled path without following a link at its last component. */
function openNoFollow(path: string): number {
	return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function readlinkOrNull(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

function errorCode(error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	return typeof code === "string" ? code : "unknown";
}

/**
 * The mach services a case may look up. The list is empty because nothing needs one: with every
 * service denied the cases pass on both sides, and an empty list is what keeps the host's pasteboard
 * (`com.apple.pboard`), Shortcuts, LaunchServices, and keychain services unreachable. Add a name only
 * after a case fails on a logged denial. To log them, put `(debug deny)` in the profile and run
 * `log stream --predicate 'sender == "Sandbox"'`; each missing service shows up as
 * `deny(1) mach-lookup <name>`.
 */
const ALLOWED_MACH_SERVICES: readonly string[] = [];

export interface ProfileOptions {
	roots: Roots;
	executableRoots: string[];
	/** The mock model server's port, the only loopback port the profile opens. Null for no network. */
	port: number | null;
}

export function renderProfile(options: ProfileOptions): string {
	const { roots } = options;
	const executableRoots = options.executableRoots.map((path) => realpathSync(path));
	const rules = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec*)",
		"(allow process-fork)",
		"(allow signal (target self))",
		"(allow signal (target children))",
		"(allow sysctl-read)",
		"(deny mach-lookup)",
		...ALLOWED_MACH_SERVICES.map((service) => `(allow mach-lookup (global-name ${quote(service)}))`),
		...["/usr/bin/security", "/usr/sbin/securityd", "/usr/bin/ssh-add", "/usr/bin/osascript", "/usr/bin/open"].map(
			(path) => `(deny process-exec (literal ${quote(path)}))`,
		),
		"(allow file-read-metadata)",
		"(allow file-read*)",
		...[
			REAL_HOME,
			"/Library/Keychains",
			"/private/var/db/dslocal",
			"/Library/Application Support/ClaudeCode",
			"/etc/claude-code",
		].map((path) => `(deny file-read* (subpath ${quote(path)}))`),
		...executableRoots.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
		`(allow file-read* (subpath ${quote(roots.root)}))`,
		"(deny file-write*)",
		`(allow file-write* (subpath ${quote(roots.root)}))`,
		// The harness writes its evidence into `out/` after the run, and the mock appends its request
		// log there during it. A side that could write there could plant a link for the harness to
		// follow, so the allow is taken back: the last matching rule wins.
		`(deny file-write* (subpath ${quote(roots.out)}))`,
		...["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/dtracehelper"].map(
			(path) => `(allow file-write* (literal ${quote(path)}))`,
		),
		"(deny network*)",
	];
	if (options.port !== null) {
		const loopback = `localhost:${options.port}`;
		rules.push(
			`(allow network-inbound (local ip ${quote(loopback)}))`,
			`(allow network-outbound (remote ip ${quote(loopback)}))`,
			`(allow network-bind (local ip ${quote(loopback)}))`,
		);
	}
	rules.push("");
	return rules.join("\n");
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function mkdirp(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}
