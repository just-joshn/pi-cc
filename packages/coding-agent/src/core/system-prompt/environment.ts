/** The machine facts the per-machine context lists. */

import { existsSync } from "node:fs";
import { release, type } from "node:os";
import { basename, dirname, join } from "node:path";

export interface CcEnvironment {
	cwd: string;
	isGitRepository: boolean;
	platform: string;
	shell: string;
	osVersion: string;
}

/** Read the facts of this machine for a working directory. */
export function readCcEnvironment(cwd: string): CcEnvironment {
	return {
		cwd,
		isGitRepository: insideGitRepository(cwd),
		platform: process.platform,
		shell: basename(process.env.SHELL ?? "") || "unknown",
		osVersion: `${type()} ${release()}`,
	};
}

function insideGitRepository(start: string): boolean {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return true;
		if (dirname(dir) === dir) return false;
	}
}
