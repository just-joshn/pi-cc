/**
 * Environment for a pi-internal spawn that lives in this package.
 *
 * The coding agent snapshots the process environment before a settings `env` block is applied and
 * installs that snapshot here. A spawn that runs before the install, or in a test that never installs
 * one, keeps `process.env`.
 */

let captured: NodeJS.ProcessEnv | undefined;

export function setInternalSpawnEnv(env: NodeJS.ProcessEnv): void {
	captured = { ...env };
}

export function internalSpawnEnv(): NodeJS.ProcessEnv {
	return captured ? { ...captured } : process.env;
}
