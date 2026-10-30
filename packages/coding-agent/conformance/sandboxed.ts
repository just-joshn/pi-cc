/** Runs one program under a Seatbelt profile in its own process group and reaps whatever it leaves in the side's root. */

import { spawn } from "node:child_process";
import type { StdinSpec } from "./case.ts";
import type { Roots } from "./isolate.ts";
import type { ReapResult } from "./reap.ts";
import { killGroup, reap } from "./reap.ts";
import { writeStdin } from "./stdin.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	reaped: ReapResult;
}

export function runSandboxed(
	profilePath: string,
	argv: string[],
	cwd: string,
	roots: Roots,
	env: Record<string, string>,
	stdin: StdinSpec,
	timeoutMs: number,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(SANDBOX_EXEC, ["-f", profilePath, ...argv], {
			cwd,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		// A child that exits before reading stdin closes the pipe under us; that is not a case failure.
		child.stdin.on("error", () => {});
		let stdinFailure: unknown;
		const stdinAbort = new AbortController();
		const stdinDone = writeStdin(
			child.stdin,
			stdin,
			() => Buffer.concat(stdout).toString("utf8"),
			stdinAbort.signal,
		).then(
			() => child.stdin.end(),
			(error: unknown) => {
				stdinFailure = error;
				if (child.pid !== undefined) killGroup(child.pid);
			},
		);
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) killGroup(child.pid);
		}, timeoutMs);
		child.on("error", (error) => {
			stdinAbort.abort();
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", async (code) => {
			stdinAbort.abort();
			await stdinDone;
			clearTimeout(timer);
			const reaped =
				child.pid === undefined
					? { survived: false, converged: true }
					: await reap(roots.root, { group: child.pid });
			if (stdinFailure !== undefined) {
				reject(stdinFailure);
				return;
			}
			resolve({
				exitCode: code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
				reaped,
			});
		});
	});
}

