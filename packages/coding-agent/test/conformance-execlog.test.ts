import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ExecLog, startExecLog } from "../conformance/execlog.ts";
import {
	acquireProcessTable,
	PROCESS_TABLE_LOCK_TIMEOUT_MS,
	releaseProcessTable,
} from "./conformance-process-table.ts";

const darwin = process.platform === "darwin";
const PROFILE = (report: boolean) =>
	`(version 1)(deny default)(allow process-exec*${report ? " (with report)" : ""})(allow process-fork)(allow sysctl-read)(allow file-read*)`;

let execLog: ExecLog | null = null;

beforeAll(acquireProcessTable, PROCESS_TABLE_LOCK_TIMEOUT_MS);
beforeAll(async () => {
	execLog = await startExecLog();
}, 30_000);
afterAll(() => {
	execLog?.close();
	releaseProcessTable();
});

function run(profile: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], { stdio: "ignore" });
		child.on("error", reject);
		child.on("exit", () => resolve(child.pid ?? -1));
	});
}

describe.skipIf(!darwin)("the sandbox exec log", () => {
	test("starts, and names the pid of a program that ran under a reporting profile", async () => {
		expect(execLog).not.toBeNull();
		const since = Date.now() - 100;
		const reported = await run(PROFILE(true));

		expect(await execLog?.catchUp()).toBe(true);

		expect(execLog?.executedSince(since).has(reported)).toBe(true);
	});

	test("does not name a program whose profile does not report", async () => {
		const since = Date.now() - 100;
		const silent = await run(PROFILE(false));

		expect(await execLog?.catchUp()).toBe(true);

		expect(execLog?.executedSince(since).has(silent)).toBe(false);
	});

	test("does not name a pid that ran before the cutoff", async () => {
		const reported = await run(PROFILE(true));
		expect(await execLog?.catchUp()).toBe(true);

		expect(execLog?.executedSince(Date.now() + 60_000).has(reported)).toBe(false);
	});
});
