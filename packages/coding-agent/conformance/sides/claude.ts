/** The reference side: the installed Claude Code binary, pinned by version and digest. */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { Side } from "../isolate.ts";

export const CLAUDE_BIN = process.env.CONFORMANCE_CLAUDE_BIN ?? "/Users/josh-desktop/.local/bin/claude";
export const CLAUDE_VERSION = "2.1.312";
export const CLAUDE_SHA256 = "6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620";
export const CLAUDE_BANNER = `${CLAUDE_VERSION} (Claude Code)`;

export interface ClaudeIdentity {
	/** The resolved binary path. It is the only path the harness ever executes. */
	path: string;
	sha256: string;
	banner: string | null;
	version: string | null;
	frozen: boolean;
}

/**
 * The installed binary and its digest. The path is resolved once here, and it is the only path later
 * steps execute, so retargeting the symlink cannot swap the program the digest describes. A path that
 * does not resolve or read is reported absent, never thrown. This never runs the binary, so a claude
 * that fails the pin is hashed and left alone rather than executed.
 */
export function hashClaude(binPath: string = CLAUDE_BIN): { path: string; sha256: string } | null {
	try {
		const path = realpathSync(binPath);
		return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
	} catch {
		return null;
	}
}

export function createClaudeSide(pinnedPath: string): Side {
	return {
		name: "claude",
		command: () => [pinnedPath],
		executableRoots: () => [pinnedPath],
		prepare: () => {},
	};
}
