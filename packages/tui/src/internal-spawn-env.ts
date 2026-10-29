let captured: NodeJS.ProcessEnv | undefined;

export function setInternalSpawnEnv(env: NodeJS.ProcessEnv): void {
	captured = { ...env };
}

export function internalSpawnEnv(): NodeJS.ProcessEnv {
	return captured ? { ...captured } : process.env;
}
