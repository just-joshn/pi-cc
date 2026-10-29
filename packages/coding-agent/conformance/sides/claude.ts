/** The reference side: the installed Claude Code binary, pinned by version and digest. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Side } from "../isolate.ts";

export const CLAUDE_BIN = process.env.CONFORMANCE_CLAUDE_BIN ?? "/Users/josh-desktop/.local/bin/claude";
export const CLAUDE_VERSION = "2.1.312";
export const CLAUDE_SHA256 = "6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620";
export const CLAUDE_BANNER = `${CLAUDE_VERSION} (Claude Code)`;

export interface ClaudeIdentity {
	path: string;
	sha256: string;
	banner: string | null;
	version: string | null;
	frozen: boolean;
}

/**
 * The installed binary and its digest. This never runs the binary, so a claude that fails the pin
 * is hashed and left alone rather than executed.
 */
export function hashClaude(): { path: string; sha256: string } | null {
	if (!existsSync(CLAUDE_BIN)) return null;
	const digest = createHash("sha256")
		.update(readFileSync(realpathSync(CLAUDE_BIN)))
		.digest("hex");
	return { path: CLAUDE_BIN, sha256: digest };
}

export const claudeSide: Side = {
	name: "claude",
	command: () => [CLAUDE_BIN],
	executableRoots: () => (existsSync(CLAUDE_BIN) ? [realpathSync(CLAUDE_BIN)] : []),
	prepare: () => {},
};
