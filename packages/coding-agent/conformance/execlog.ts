/**
 * Which process ids ran a program under a harness sandbox profile. Every profile reports `process-exec*`,
 * so the kernel writes "Sandbox: <name>(<pid>) allow process-exec* <path>" to the unified log for each exec
 * a sandboxed process makes, and every descendant of the side inherits the profile and cannot shed it.
 * The process table cannot tell the side's descendants from anyone else's once they are orphaned, and the
 * side's own chain can change directory and close every file; this log names them by pid regardless.
 *
 * One `log stream` runs for the whole harness. A line can reach it late, so `catchUp` runs a program under
 * a reporting profile of its own and waits for that line: lines for earlier execs have been written by then.
 */

import { spawn } from "node:child_process";

const LOG = "/usr/bin/log";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const TRUE = "/usr/bin/true";
const PREDICATE = 'sender == "Sandbox" AND eventMessage CONTAINS "allow process-exec"';
const SENTINEL_PROFILE =
	"(version 1)(deny default)(allow process-exec* (with report))(allow process-fork)(allow sysctl-read)(allow file-read*)";
const EXEC = /^Sandbox: .*?\((\d+)\) allow process-exec\*/;
/** `YYYY-MM-DD HH:MM:SS.ffffff-0700`, whose offset keeps the reading independent of the harness's own time zone. */
const STAMP = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\d*([+-]\d\d)(\d\d)$/;
const START_DEADLINE_MS = 15_000;
const CATCH_UP_DEADLINE_MS = 5_000;
const POLL_MS = 10;

export interface ExecLog {
	/** The pids that exec'd under a reporting profile at or after `sinceMs`, as of the last `catchUp`. */
	executedSince(sinceMs: number): Set<number>;
	/** True once every exec that happened before the call is in the log, false when that cannot be confirmed. */
	catchUp(): Promise<boolean>;
	close(): void;
}

/** Starts the stream and returns once it is delivering, or null when it never does. */
export async function startExecLog(): Promise<ExecLog | null> {
	const executed = new Map<number, number>();
	const stream = spawn(LOG, ["stream", "--predicate", PREDICATE, "--style", "ndjson"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const stop = () => stream.kill("SIGKILL");
	process.once("exit", stop);
	let pending = "";
	stream.stdout.setEncoding("utf8");
	stream.stdout.on("data", (chunk: string) => {
		const lines = (pending + chunk).split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const event = parseEvent(line);
			if (event !== null) executed.set(event.pid, event.at);
		}
	});
	stream.on("error", () => {});

	const catchUp = async (deadlineMs: number): Promise<boolean> => {
		const sentinel = spawn(SANDBOX_EXEC, ["-p", SENTINEL_PROFILE, TRUE], { stdio: "ignore" });
		const pid = sentinel.pid;
		sentinel.on("error", () => {});
		if (pid === undefined) return false;
		const deadline = Date.now() + deadlineMs;
		while (!executed.has(pid)) {
			if (Date.now() >= deadline || stream.exitCode !== null) return false;
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		return true;
	};
	const log: ExecLog = {
		executedSince: (sinceMs) => new Set([...executed].filter(([, at]) => at >= sinceMs).map(([pid]) => pid)),
		catchUp: () => catchUp(CATCH_UP_DEADLINE_MS),
		close: () => {
			process.off("exit", stop);
			stop();
		},
	};
	// The stream attaches a moment after it starts, so the first sentinels can be missed.
	const deadline = Date.now() + START_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (await catchUp(1_000)) return log;
	}
	log.close();
	return null;
}

function parseEvent(line: string): { pid: number; at: number } | null {
	if (!line.startsWith("{")) return null;
	let event: { eventMessage?: unknown; timestamp?: unknown };
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof event.eventMessage !== "string" || typeof event.timestamp !== "string") return null;
	const exec = EXEC.exec(event.eventMessage);
	const stamp = STAMP.exec(event.timestamp);
	if (exec === null || stamp === null) return null;
	const at = Date.parse(`${stamp[1]}T${stamp[2]}${stamp[3]}:${stamp[4]}`);
	return Number.isNaN(at) ? null : { pid: Number.parseInt(exec[1], 10), at };
}
