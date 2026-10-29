/**
 * Per-case, per-side sandbox roots. Every path the sandbox profile names is realpath-resolved because
 * Seatbelt matches resolved paths: a profile that says `/var/...` instead of `/private/var/...`
 * silently denies writes to its own temp root.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Expands the case-file placeholders. `$HOME` is the side's temp home, never the real one. */
export function expandPlaceholders(value: string, roots: Roots): string {
	return value
		.split("$WORKSPACE")
		.join(roots.workspace)
		.split("$TMP")
		.join(roots.tmp)
		.split("$HOME")
		.join(roots.home)
		.split("$REAL_HOME")
		.join(REAL_HOME)
		.split("$FIXTURES")
		.join(FIXTURES_DIR);
}

export function baseEnv(roots: Roots, port: number | null): Record<string, string> {
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: roots.home,
		CLAUDE_CONFIG_DIR: roots.config,
		TMPDIR: roots.tmp,
		SHELL: "/bin/sh",
		USER: "probe",
		LOGNAME: "probe",
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		TERM: "dumb",
		NO_COLOR: "1",
		XDG_CONFIG_HOME: roots.xdgConfig,
		XDG_CACHE_HOME: roots.xdgCache,
		XDG_DATA_HOME: roots.xdgData,
		XDG_STATE_HOME: roots.xdgState,
		PI_OFFLINE: "1",
		PI_CODING_AGENT_DIR: roots.agent,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_AUTOUPDATER: "1",
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_GROWTHBOOK: "1",
	};
	if (port !== null) {
		env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
		env.ANTHROPIC_API_KEY = MODEL_API_KEY;
		env.NO_PROXY = "127.0.0.1,localhost";
	}
	return env;
}

export function seedFiles(roots: Roots, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const target = join(roots.workspace, path);
		if (relative(roots.workspace, target).startsWith("..")) throw new Error(`seeded path escapes workspace: ${path}`);
		mkdirp(dirname(target));
		writeFileSync(target, content);
	}
}

export function hashTree(dir: string): Map<string, string> {
	const hashes = new Map<string, string>();
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile()) {
				hashes.set(relative(dir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
			} else if (entry.isSymbolicLink()) {
				hashes.set(relative(dir, path), `symlink:${realpathSync(path)}`);
			}
		}
	};
	if (statSync(dir).isDirectory()) walk(dir);
	return hashes;
}

export interface ProfileOptions {
	roots: Roots;
	executableRoots: string[];
	network: boolean;
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
		"(allow mach-lookup)",
		...["com.apple.securityd", "com.apple.trustd", "com.apple.trustd.agent", "com.apple.keystore"].map(
			(service) => `(deny mach-lookup (global-name ${quote(service)}))`,
		),
		...["/usr/bin/security", "/usr/sbin/securityd", "/usr/bin/ssh-add", "/usr/bin/osascript"].map(
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
		...["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/dtracehelper"].map(
			(path) => `(allow file-write* (literal ${quote(path)}))`,
		),
		"(deny network*)",
	];
	if (options.network) {
		rules.push(
			'(allow network-inbound (local ip "localhost:*"))',
			'(allow network-outbound (remote ip "localhost:*"))',
			'(allow network-bind (local ip "localhost:*"))',
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
