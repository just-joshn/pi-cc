/** Running one command hook: the shell, the JSON on stdin, the environment, and the clock. */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandHandler } from "./config.ts";

/** What one handler produced, whatever its kind. */
export interface RawResult {
	/** The exit status of a command. An http hook has none. */
	readonly code: number | null;
	/** The HTTP status of an http hook's answer, when it got one. */
	readonly status?: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly failure?: "timed out" | "cancelled" | "failed to start";
}

export interface CommandContext {
	readonly cwd: string;
	readonly projectDir: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
}

const OUTPUT_LIMIT = 1024 * 1024;

/** Runs the handler with `input` as one JSON line on stdin. Never rejects. */
export function runCommand(handler: CommandHandler, input: unknown, context: CommandContext): Promise<RawResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let failure: RawResult["failure"];
		const options = {
			cwd: context.cwd,
			env: { ...process.env, ...context.env, CLAUDE_PROJECT_DIR: context.projectDir },
			stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		};
		const child = handler.args
			? spawn(handler.command, [...handler.args], options)
			: spawn(handler.command, { ...options, shell: true });
		const kill = (reason: NonNullable<RawResult["failure"]>) => {
			failure ??= reason;
			try {
				if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => kill("timed out"), handler.timeoutMs);
		const onAbort = () => kill("cancelled");
		if (context.signal?.aborted) onAbort();
		else context.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < OUTPUT_LIMIT) stdout += stdoutDecoder.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < OUTPUT_LIMIT) stderr += stderrDecoder.write(chunk);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(`${JSON.stringify(input)}\n`);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			context.signal?.removeEventListener("abort", onAbort);
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			resolve(failure === undefined ? { code, stdout, stderr } : { code, stdout, stderr, failure });
		};
		child.on("error", (error) => {
			failure ??= "failed to start";
			stderr ||= error.message;
			finish(null);
		});
		child.on("close", finish);
	});
}
