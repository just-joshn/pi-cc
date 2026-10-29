/** The reference side: the installed Claude Code binary, pinned by version and digest. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Side } from "../isolate.ts";

export const CLAUDE_BIN = process.env.CONFORMANCE_CLAUDE_BIN ?? "/Users/josh-desktop/.local/bin/claude";
export const CLAUDE_VERSION = "2.1.312";
export const CLAUDE_SHA256 = "6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620";

export interface ClaudeIdentity {
	path: string;
	sha256: string;
	version: string;
	banner: string;
	frozen: boolean;
}

export function identifyClaude(probeHome: string): ClaudeIdentity | null {
	if (!existsSync(CLAUDE_BIN)) return null;
	const realPath = realpathSync(CLAUDE_BIN);
	const sha256 = createHash("sha256").update(readFileSync(realPath)).digest("hex");
	const banner = execFileSync(realPath, ["--version"], {
		encoding: "utf8",
		timeout: 30_000,
		env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: probeHome, TERM: "dumb", NO_COLOR: "1" },
	}).trim();
	const version = banner.split(/\s+/)[0];
	const frozen = sha256 === CLAUDE_SHA256 && banner === `${CLAUDE_VERSION} (Claude Code)`;
	return { path: CLAUDE_BIN, sha256, version, banner, frozen };
}

export const claudeSide: Side = {
	name: "claude",
	command: () => [CLAUDE_BIN],
	executableRoots: () => (existsSync(CLAUDE_BIN) ? [realpathSync(CLAUDE_BIN)] : []),
	prepare: () => {},
};
