/**
 * The environment pi started with, for pi's own subprocesses.
 *
 * A settings `env` block is written into `process.env` so the agent's own tools and the model client
 * see it, which is what Claude Code does. Pi's own subprocesses must not see it: an npm prefix, an
 * npm config file, a bun install root, or a git config named by a repository's `.claude/settings.json`
 * decides which code pi loads, and `NODE_TLS_REJECT_UNAUTHORIZED` would turn off verification for
 * pi's own HTTPS clients. The snapshot is taken before any settings layer runs.
 */

let captured: Readonly<NodeJS.ProcessEnv> = { ...process.env };

/** Re-reads `process.env`. Called once at startup, before a settings `env` block is applied. */
export function captureStartupEnv(): void {
	captured = { ...process.env };
}

/**
 * The environment for a pi-internal spawn. Every pi subprocess that is not the agent's own tool runs
 * with this: the package manager, git, the ripgrep and fd probes, session sharing, the browser, the
 * editor, the clipboard, and a pi subagent process.
 */
export function startupEnv(): NodeJS.ProcessEnv {
	return { ...captured };
}
