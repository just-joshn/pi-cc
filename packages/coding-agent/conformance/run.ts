/** Runs each case against the pinned claude binary and the built pi-cc CLI, then prints a scoreboard. */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ConformanceCase, FileSpec, StdinSpec } from "./case.ts";
import { loadCases } from "./case.ts";
import type { Diff, Observation } from "./compare.ts";
import { compare } from "./compare.ts";
import type { Roots, Side, SideName, Violation } from "./isolate.ts";
import {
	baseEnv,
	createRoots,
	expandPlaceholders,
	findPresentPaths,
	hashTree,
	REAL_HOME,
	renderProfile,
	scanWorkspace,
	seedFiles,
} from "./isolate.ts";
import type { RecordedRequest } from "./mock/messages.ts";
import { startMockServer } from "./mock/messages.ts";
import { killGroup, reap, WARNINGS } from "./reap.ts";
import type { ClaudeIdentity } from "./sides/claude.ts";
import { CLAUDE_BANNER, CLAUDE_SHA256, CLAUDE_VERSION, createClaudeSide, hashClaude } from "./sides/claude.ts";
import { CLI_PATH, piCcSide } from "./sides/pi-cc.ts";
import { writeStdin } from "./stdin.ts";

type Verdict = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED";

interface SideRun {
	side: SideName;
	ran: boolean;
	diffs: Diff[];
	stderr: string;
	/** The case's reason when it declares this side not applicable. */
	notApplicable: string | null;
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
	/** The side left a process behind, which the harness killed before it hashed the workspace. */
	survivors: boolean;
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
	const claude = await probeClaude(runRoot);
	if (claude === null) {
		console.log("claude is absent. Every case runs on the pi-cc side and is reported unverified.\n");
	} else if (claude.sha256 !== CLAUDE_SHA256) {
		console.log(
			`claude at ${claude.path} has sha256 ${claude.sha256}, not the pinned ${CLAUDE_VERSION} ${CLAUDE_SHA256}.`,
		);
		console.log("It was not executed. Every verdict is unverified.\n");
	} else if (!claude.frozen && !values["allow-claude-version-drift"]) {
		console.log(`claude at ${claude.path} is ${claude.banner}, not the pinned ${CLAUDE_VERSION} ${CLAUDE_SHA256}.`);
		console.log("Every verdict is unverified. Pass --allow-claude-version-drift to compare anyway.\n");
	}

	const results = new Map<string, CaseRun>();
	const allowDrift = values["allow-claude-version-drift"] === true;
	const compareClaude = claude !== null && claude.sha256 === CLAUDE_SHA256 && (claude.frozen || allowDrift);
	const sides: Side[] = compareClaude && claude !== null ? [createClaudeSide(claude.path), piCcSide] : [piCcSide];
	const execute = async (testCase: ConformanceCase): Promise<CaseRun> => {
		const cached = results.get(testCase.id);
		if (cached !== undefined) return cached;
		const skip = skipReason(testCase, claude === null);
		const run: CaseRun =
			skip === null
				? await runCase(testCase, sides, runRoot)
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
	const drift =
		claude !== null && !claude.frozen && compareClaude ? `claude ${claude.banner ?? "unknown version"}` : null;
	for (const run of ordered) printRow(run, drift);
	printTotals(ordered);
	writeReport(runRoot, claude, ordered, false, drift);

	const count = (verdict: Verdict) => ordered.filter((run) => run.verdict === verdict).length;
	return count("FAIL") === 0 && count("UNVERIFIED") === 0 ? 0 : 1;
}

/**
 * The pinned binary's identity. The digest is checked before anything runs, and the only version
 * probe runs inside the same sandbox as the cases, so an unpinned claude is never executed.
 */
async function probeClaude(runRoot: string): Promise<ClaudeIdentity | null> {
	const hashed = hashClaude();
	if (hashed === null) return null;
	if (hashed.sha256 !== CLAUDE_SHA256) return { ...hashed, banner: null, version: null, frozen: false };
	const roots = createRoots(runRoot, ".claude-probe", "claude");
	const profilePath = join(roots.out, "profile.sb");
	writeFileSync(profilePath, renderProfile({ roots, executableRoots: [hashed.path], port: null }));
	const probe = await runSandboxed(
		profilePath,
		[hashed.path, "--version"],
		roots.workspace,
		roots,
		baseEnv(roots, null),
		null,
		30_000,
	);
	const banner = probe.exitCode === 0 ? probe.stdout.trim() : null;
	return {
		...hashed,
		banner,
		version: banner === null ? null : banner.split(/\s+/)[0],
		frozen: banner === CLAUDE_BANNER,
	};
}

async function runCase(testCase: ConformanceCase, sides: Side[], runRoot: string): Promise<CaseRun> {
	const runs: SideRun[] = [];
	// The verdict is only PASS when every applicable side ran, so a claude side that was not selected reports here.
	if (!sides.some((side) => side.name === "claude")) {
		runs.push({ side: "claude", ran: false, diffs: [], stderr: "", notApplicable: null });
	}
	for (const side of sides) {
		const reason = testCase.notApplicable[side.name];
		if (reason !== undefined) {
			runs.push({ side: side.name, ran: false, diffs: [], stderr: "", notApplicable: reason });
			continue;
		}
		runs.push(await runSide(testCase, side, runRoot));
	}
	const failed = runs.some((run) => run.diffs.length > 0);
	const applicable = runs.filter((run) => run.notApplicable === null);
	const verified = applicable.length > 0 && applicable.every((run) => run.ran);
	const verdict: Verdict = failed ? "FAIL" : verified ? "PASS" : "UNVERIFIED";
	return { id: testCase.id, area: testCase.area, verdict, runs, skip: null };
}

async function runSide(testCase: ConformanceCase, side: Side, runRoot: string): Promise<SideRun> {
	const roots = createRoots(runRoot, testCase.id, side.name);
	const mock =
		testCase.model === null ? null : await startMockServer({ turns: testCase.model.turns, outDir: roots.out });
	const mockUrl = mock === null ? undefined : `http://127.0.0.1:${mock.port}`;
	try {
		seedFiles(roots, testCase.files, mockUrl);
		side.prepare(roots, mock?.port ?? null);
		const profilePath = join(roots.out, "profile.sb");
		writeFileSync(
			profilePath,
			renderProfile({ roots, executableRoots: side.executableRoots(), port: mock?.port ?? null }),
		);
		const command = testCase.binary === undefined ? side.command() : [testCase.binary];
		const argv = [...command, ...testCase.argv.map((argument) => expandPlaceholders(argument, roots, mockUrl))];
		const env = { ...baseEnv(roots, mock?.port ?? null) };
		for (const key of testCase.unset) delete env[key];
		for (const [key, value] of Object.entries(testCase.env)) env[key] = expandPlaceholders(value, roots, mockUrl);

		const cwd = testCase.cwd === undefined ? roots.workspace : join(roots.workspace, testCase.cwd);
		mkdirSync(cwd, { recursive: true });
		const workspaceBefore = hashTree(roots.workspace);
		const result = await runSandboxed(profilePath, argv, cwd, roots, env, testCase.stdin, testCase.timeout_ms);
		const workspaceAfter = scanWorkspace(roots, expectedFilePaths(testCase));
		const violations: Violation[] = [...workspaceAfter.violations];
		if (result.survivors) violations.push({ kind: "survivor", path: null });
		const observation: Observation = {
			timedOut: result.timedOut,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			requests: mock?.requests ?? [],
			workspaceBefore: workspaceBefore.entries,
			workspaceAfter: workspaceAfter.entries,
			fileText: workspaceAfter.text,
			forbiddenPathsFound: findPresentPaths(absentPaths(testCase, roots)),
			violations,
		};
		// The profile denies the side every write under `out/`, so nothing it planted can redirect these.
		writeFileSync(join(roots.out, "stdout.txt"), result.stdout);
		writeFileSync(join(roots.out, "stderr.txt"), result.stderr);
		writeFileSync(
			join(roots.out, "meta.json"),
			`${JSON.stringify({ argv, env, ...summarize(result, observation.requests) }, null, "\t")}\n`,
		);
		const diffs = compare(testCase.compare, observation, { sideRoot: roots.root, realHome: REAL_HOME });
		return { side: side.name, ran: true, diffs, stderr: result.stderr, notApplicable: null };
	} finally {
		if (mock !== null) await mock.close();
	}
}

/** The workspace-relative paths a case asserts on, so a `contains` check never reads a path it was not given. */
function expectedFilePaths(testCase: ConformanceCase): string[] {
	return (testCase.compare.files ?? []).map((spec: FileSpec) => (typeof spec === "string" ? spec : spec.path));
}

/** A `compare.absent` path that exists after the run is a containment failure, so the harness looks itself. */
function absentPaths(testCase: ConformanceCase, roots: Roots): string[] {
	// Resolved lexically, because the workspace moves out of the side's root before this runs.
	return (testCase.compare.absent ?? []).map((spec) => resolve(expandPlaceholders(spec, roots)));
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
	cwd: string,
	roots: Roots,
	env: Record<string, string>,
	stdin: StdinSpec,
	timeoutMs: number,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
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
			const survivors = child.pid === undefined ? false : await reap(child.pid, roots.root, startedAt);
			if (stdinFailure !== undefined) {
				reject(stdinFailure);
				return;
			}
			resolve({
				exitCode: code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
				survivors,
			});
		});
	});
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
	} else if (claude.sha256 !== CLAUDE_SHA256) {
		console.log(`claude: ${claude.path} sha256 ${claude.sha256} (not the pin, not executed)`);
	} else {
		const pin = claude.frozen ? "pinned" : allowDrift ? "drift allowed" : "unverified";
		console.log(`claude: ${claude.path} ${claude.banner ?? "no version output"} sha256 ${claude.sha256} (${pin})`);
	}
	console.log(`pi-cc:  ${CLI_PATH}\n`);
}

function printRow(run: CaseRun, drift: string | null): void {
	const cells = run.runs.map((side) => {
		if (side.notApplicable !== null) return `${side.side} n/a`;
		return side.ran ? `${side.side} ${side.diffs.length === 0 ? "PASS" : "FAIL"}` : `${side.side} unverified`;
	});
	const label = drift === null ? "" : `  [${drift}]`;
	console.log(`${run.verdict.padEnd(10)} ${run.id.padEnd(38)} ${cells.join("  ")}${label}`);
	if (run.skip !== null) console.log(`           skipped: ${run.skip}`);
	for (const side of run.runs) {
		if (side.notApplicable !== null) console.log(`           ${side.side} not applicable: ${side.notApplicable}`);
	}
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
		const sideRuns = runs.flatMap((run) =>
			run.runs.filter((entry) => entry.side === side && entry.notApplicable === null),
		);
		const pass = sideRuns.filter((entry) => entry.ran && entry.diffs.length === 0).length;
		const fail = sideRuns.filter((entry) => entry.diffs.length > 0).length;
		const na = notApplicableCases(runs, side) === 0 ? "" : `, ${notApplicableCases(runs, side)} not applicable`;
		console.log(`${side.padEnd(7)} side: ${pass} pass, ${fail} fail${na}`);
	}
	const partial = notApplicableCases(runs);
	const note = partial === 0 ? "" : `; ${partial} with an n/a side`;
	console.log(
		`totals: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("UNVERIFIED")} unverified (of ${runs.length} cases${note})`,
	);
}

/** Cases where a side is not applicable, so a pass covers only the sides that ran. */
function notApplicableCases(runs: CaseRun[], side?: SideName): number {
	return runs.filter((run) =>
		run.runs.some((entry) => entry.notApplicable !== null && (side === undefined || entry.side === side)),
	).length;
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
		not_applicable: notApplicableCases(runs),
	};
	const report = {
		run: new Date().toISOString(),
		aborted,
		run_root: runRoot,
		...(WARNINGS.length === 0 ? {} : { warnings: WARNINGS }),
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
			...(run.runs.some((side) => side.notApplicable !== null)
				? {
						not_applicable: run.runs
							.filter((side) => side.notApplicable !== null)
							.map((side) => `${side.side}: ${side.notApplicable}`),
					}
				: {}),
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
