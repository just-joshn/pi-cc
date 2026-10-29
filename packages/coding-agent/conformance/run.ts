/** Runs each case against the pinned claude binary and the built pi-cc CLI, then prints a scoreboard. */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ConformanceCase, StdinSpec } from "./case.ts";
import { loadCases } from "./case.ts";
import type { Diff, Observation } from "./compare.ts";
import { compare } from "./compare.ts";
import type { Roots, Side, SideName } from "./isolate.ts";
import { baseEnv, createRoots, expandPlaceholders, hashTree, REAL_HOME, renderProfile, seedFiles } from "./isolate.ts";
import type { RecordedRequest } from "./mock/messages.ts";
import { startMockServer } from "./mock/messages.ts";
import type { ClaudeIdentity } from "./sides/claude.ts";
import { CLAUDE_SHA256, CLAUDE_VERSION, claudeSide, identifyClaude } from "./sides/claude.ts";
import { CLI_PATH, piCcSide } from "./sides/pi-cc.ts";

type Verdict = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED";

interface SideRun {
	side: SideName;
	ran: boolean;
	diffs: Diff[];
	stderr: string;
}

interface CaseRun {
	id: string;
	area: string;
	verdict: Verdict;
	runs: SideRun[];
	skip: string | null;
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const CONFORMANCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			list: { type: "boolean", default: false },
			case: { type: "string" },
			area: { type: "string" },
			"allow-claude-version-drift": { type: "boolean", default: false },
		},
	});
	const all = loadCases(join(CONFORMANCE_DIR, "cases"));
	if (values.list) {
		for (const testCase of all) {
			const skip = testCase.skip.length > 0 ? ` (skip: ${testCase.skip.join(", ")})` : "";
			console.log(`${testCase.id}${skip}`);
		}
		return 0;
	}
	if (process.platform !== "darwin") {
		console.error("P01 isolation uses the macOS Seatbelt sandbox. Run this on macOS.");
		return 2;
	}
	const selected = all.filter(
		(testCase) =>
			(values.case === undefined || testCase.id === values.case) &&
			(values.area === undefined || testCase.area === values.area),
	);
	if (selected.length === 0) {
		console.error("No cases matched.");
		return 2;
	}

	const runRoot = join(process.env.CONFORMANCE_TMP ?? join(tmpdir(), "pi-cc-conformance"), runStamp());
	const probeHome = join(runRoot, ".probe-home");
	mkdirSync(probeHome, { recursive: true });
	const claude = identifyClaude(probeHome);
	if (claude === null) {
		console.log("claude is absent. Every case runs on the pi-cc side and is reported unverified.\n");
	} else if (!claude.frozen && !values["allow-claude-version-drift"]) {
		console.log(
			`claude at ${claude.path} is ${claude.banner} sha256 ${claude.sha256}, not the pinned ${CLAUDE_VERSION} ${CLAUDE_SHA256}.`,
		);
		console.log("Every verdict is unverified. Pass --allow-claude-version-drift to compare anyway.\n");
	}

	const results = new Map<string, CaseRun>();
	const allowDrift = values["allow-claude-version-drift"] === true;
	const compareClaude = claude !== null && (claude.frozen || allowDrift);
	const execute = async (testCase: ConformanceCase): Promise<CaseRun> => {
		const cached = results.get(testCase.id);
		if (cached !== undefined) return cached;
		const skip = skipReason(testCase, claude === null);
		const run: CaseRun =
			skip === null
				? await runCase(testCase, compareClaude, runRoot)
				: { id: testCase.id, area: testCase.area, verdict: "SKIP", runs: [], skip };
		results.set(testCase.id, run);
		return run;
	};

	printHeader(selected.length, all.length, claude, allowDrift);

	// The isolation gate proves the sandbox before any behavior is compared: a nonzero exit is not
	// denial evidence, so the isolation cases assert the seatbelt errno itself.
	const gate = all.filter((testCase) => testCase.area === "isolation");
	if (selected.some((testCase) => testCase.area !== "isolation")) {
		for (const testCase of gate) await execute(testCase);
		const failed = gate
			.map((testCase) => results.get(testCase.id))
			.filter((run): run is CaseRun => run?.verdict === "FAIL");
		if (failed.length > 0) {
			console.log("isolation gate failed; refusing to run the case phase.");
			for (const run of failed) printDiffs(run);
			writeReport(runRoot, claude, [...results.values()], true, null);
			return 1;
		}
		console.log(`isolation gate: ${gate.length} cases denied as expected\n`);
	}

	for (const testCase of selected) await execute(testCase);
	const ordered = selected.map((testCase) => results.get(testCase.id)!);
	const drift = claude !== null && !claude.frozen && allowDrift ? `claude ${claude.banner}` : null;
	for (const run of ordered) printRow(run, drift);
	printTotals(ordered);
	writeReport(runRoot, claude, ordered, false, drift);

	const count = (verdict: Verdict) => ordered.filter((run) => run.verdict === verdict).length;
	return count("FAIL") === 0 && count("UNVERIFIED") === 0 ? 0 : 1;
}

async function runCase(testCase: ConformanceCase, compareClaude: boolean, runRoot: string): Promise<CaseRun> {
	const runs: SideRun[] = [];
	for (const side of [claudeSide, piCcSide]) {
		if (side.name === "claude" && !compareClaude) {
			runs.push({ side: side.name, ran: false, diffs: [], stderr: "" });
			continue;
		}
		runs.push(await runSide(testCase, side, runRoot));
	}
	const failed = runs.some((run) => run.diffs.length > 0);
	const verdict: Verdict = failed ? "FAIL" : runs.some((run) => !run.ran) ? "UNVERIFIED" : "PASS";
	return { id: testCase.id, area: testCase.area, verdict, runs, skip: null };
}

async function runSide(testCase: ConformanceCase, side: Side, runRoot: string): Promise<SideRun> {
	const roots = createRoots(runRoot, testCase.id, side.name);
	seedFiles(roots, testCase.files);
	const mock =
		testCase.model === null ? null : await startMockServer({ turns: testCase.model.turns, outDir: roots.out });
	try {
		side.prepare(roots, mock?.port ?? null);
		const profilePath = join(roots.out, "profile.sb");
		writeFileSync(
			profilePath,
			renderProfile({ roots, executableRoots: side.executableRoots(), network: mock !== null }),
		);
		const command = testCase.binary === undefined ? side.command() : [testCase.binary];
		const argv = [...command, ...testCase.argv.map((argument) => expandPlaceholders(argument, roots))];
		const env = { ...baseEnv(roots, mock?.port ?? null) };
		for (const [key, value] of Object.entries(testCase.env)) env[key] = expandPlaceholders(value, roots);

		const workspaceBefore = hashTree(roots.workspace);
		const result = await runSandboxed(profilePath, argv, roots, env, testCase.stdin, testCase.timeout_ms);
		const observation: Observation = {
			timedOut: result.timedOut,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			requests: mock?.requests ?? [],
			workspaceBefore,
			workspaceAfter: hashTree(roots.workspace),
		};
		writeFileSync(join(roots.out, "stdout.txt"), result.stdout);
		writeFileSync(join(roots.out, "stderr.txt"), result.stderr);
		writeFileSync(
			join(roots.out, "meta.json"),
			`${JSON.stringify({ argv, env, ...summarize(result, observation.requests) }, null, "\t")}\n`,
		);
		const diffs = compare(testCase.compare, observation, { sideRoot: roots.root, realHome: REAL_HOME });
		return { side: side.name, ran: true, diffs, stderr: result.stderr };
	} finally {
		if (mock !== null) await mock.close();
	}
}

function summarize(result: ProcessResult, requests: RecordedRequest[]) {
	return {
		exit_code: result.exitCode,
		timed_out: result.timedOut,
		requests: requests.map((request) => ({ index: request.index, method: request.method, path: request.path })),
	};
}

function runSandboxed(
	profilePath: string,
	argv: string[],
	roots: Roots,
	env: Record<string, string>,
	stdin: StdinSpec,
	timeoutMs: number,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(SANDBOX_EXEC, ["-f", profilePath, ...argv], {
			cwd: roots.workspace,
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
		writeStdin(child.stdin, stdin);
		child.stdin.end();
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
	});
}

function writeStdin(stream: Writable, stdin: StdinSpec): void {
	if (stdin === null) return;
	if (stdin.kind === "text") {
		stream.write(stdin.data);
		return;
	}
	for (const line of stdin.lines) stream.write(`${line}\n`);
}

function skipReason(testCase: ConformanceCase, claudeAbsent: boolean): string | null {
	for (const reason of testCase.skip) {
		if (reason === "macos-only" && process.platform !== "darwin") return reason;
		if (reason === "needs-tty") return reason;
		if (reason === "spec-gap") return reason;
		if (reason === "claude-binary-absent" && claudeAbsent) return reason;
	}
	return null;
}

function runStamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function printHeader(selected: number, total: number, claude: ClaudeIdentity | null, allowDrift: boolean): void {
	console.log(`pi-cc conformance: ${selected} of ${total} cases`);
	if (claude === null) {
		console.log("claude: absent");
	} else {
		const pin = claude.frozen ? "pinned" : allowDrift ? "drift allowed" : "unverified";
		console.log(`claude: ${claude.path} ${claude.banner} sha256 ${claude.sha256} (${pin})`);
	}
	console.log(`pi-cc:  ${CLI_PATH}\n`);
}

function printRow(run: CaseRun, drift: string | null): void {
	const cells = run.runs.map((side) =>
		side.ran ? `${side.side} ${side.diffs.length === 0 ? "PASS" : "FAIL"}` : `${side.side} unverified`,
	);
	const label = drift === null ? "" : `  [${drift}]`;
	console.log(`${run.verdict.padEnd(10)} ${run.id.padEnd(38)} ${cells.join("  ")}${label}`);
	if (run.skip !== null) console.log(`           skipped: ${run.skip}`);
	printDiffs(run);
}

function printDiffs(run: CaseRun): void {
	for (const side of run.runs) {
		for (const diff of side.diffs) {
			console.log(
				`           ${side.side} ${diff.check}: expected ${oneLine(diff.expected)}, actual ${oneLine(diff.actual)}`,
			);
		}
		if (run.area === "isolation" && side.ran && side.diffs.length === 0) {
			console.log(`           ${side.side} evidence: ${oneLine(side.stderr)}`);
		}
	}
}

function printTotals(runs: CaseRun[]): void {
	const count = (verdict: Verdict) => runs.filter((run) => run.verdict === verdict).length;
	for (const side of ["claude", "pi-cc"] as SideName[]) {
		const sideRuns = runs.flatMap((run) => run.runs.filter((entry) => entry.side === side));
		const pass = sideRuns.filter((entry) => entry.ran && entry.diffs.length === 0).length;
		const fail = sideRuns.filter((entry) => entry.diffs.length > 0).length;
		console.log(`${side.padEnd(7)} side: ${pass} pass, ${fail} fail`);
	}
	console.log(
		`totals: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("UNVERIFIED")} unverified (of ${runs.length} cases)`,
	);
}

function writeReport(
	runRoot: string,
	claude: ClaudeIdentity | null,
	runs: CaseRun[],
	aborted: boolean,
	drift: string | null,
): void {
	const totals = {
		pass: runs.filter((run) => run.verdict === "PASS").length,
		fail: runs.filter((run) => run.verdict === "FAIL").length,
		skip: runs.filter((run) => run.verdict === "SKIP").length,
		unverified: runs.filter((run) => run.verdict === "UNVERIFIED").length,
	};
	const report = {
		run: new Date().toISOString(),
		aborted,
		run_root: runRoot,
		claude:
			claude === null
				? null
				: {
						path: claude.path,
						sha256: claude.sha256,
						version: claude.version,
						banner: claude.banner,
						frozen: claude.frozen,
					},
		totals,
		cases: runs.map((run) => ({
			id: run.id,
			verdict: run.verdict,
			skip: run.skip,
			...(drift === null ? {} : { claude_version: drift }),
			diffs: run.runs.flatMap((side) =>
				side.diffs.map((diff) => `${side.side} ${diff.check}: ${diff.expected} != ${diff.actual}`),
			),
		})),
	};
	const outDir = join(CONFORMANCE_DIR, ".out");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`\nreport: ${join(outDir, "report.json")}`);
}

function oneLine(text: string): string {
	const line = text.split("\n").find((entry) => entry.trim().length > 0);
	return line === undefined ? "(no output)" : line.trim().slice(0, 400);
}

process.exit(await main());
