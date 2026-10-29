import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_LOGGED_IN_MESSAGE } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const CREDENTIAL_ENV_KEYS = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_OAUTH_TOKEN",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
]);

interface CliRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var) and the spawned CLI
	// resolves paths physically, so the fixture tree must use the physical root.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-print-no-credentials-")));
	tempDirs.push(dir);
	return dir;
}

function isolatedEnv(root: string, agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (CREDENTIAL_ENV_KEYS.has(key) || key.endsWith("_API_KEY") || key.endsWith("_OAUTH_TOKEN")) {
			delete env[key];
		}
	}
	return {
		...env,
		HOME: join(root, "home"),
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		XDG_CONFIG_HOME: join(root, "xdg-config"),
		XDG_CACHE_HOME: join(root, "xdg-cache"),
		XDG_DATA_HOME: join(root, "xdg-data"),
		XDG_STATE_HOME: join(root, "xdg-state"),
		[ENV_AGENT_DIR]: agentDir,
		PI_OFFLINE: "1",
	};
}

function runCli(argv: string[]): Promise<CliRun> {
	const root = createTempDir();
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	for (const dir of [
		agentDir,
		projectDir,
		join(root, "home"),
		join(root, "tmp"),
		join(root, "xdg-config"),
		join(root, "xdg-cache"),
		join(root, "xdg-data"),
		join(root, "xdg-state"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...argv], {
		cwd: projectDir,
		env: isolatedEnv(root, agentDir),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => stdout.push(chunk));
	child.stderr.on("data", (chunk: string) => stderr.push(chunk));
	return new Promise((resolveRun, rejectRun) => {
		child.on("error", rejectRun);
		child.on("close", (code) => resolveRun({ exitCode: code, stdout: stdout.join(""), stderr: stderr.join("") }));
	});
}

function jsonRecords(stdout: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			records.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			throw new Error(`stdout line is not a JSON record: ${line.slice(0, 80)}`);
		}
	}
	return records;
}

// Regression: every JSON print mode is a machine channel. A plaintext line on stdout breaks a
// JSONL consumer before it can read the failure, and Claude Code emits only records here.
describe("print mode without credentials", () => {
	for (const argv of [
		["--mode", "json", "hello"],
		["-p", "hello", "--output-format", "json"],
		["-p", "hello", "--output-format", "stream-json"],
	]) {
		it(`keeps stdout to JSON records for ${argv.join(" ")}`, { timeout: 120_000 }, async () => {
			const run = await runCli(argv);

			expect(run.exitCode).toBe(1);
			const records = jsonRecords(run.stdout);
			expect(records.length).toBeGreaterThan(0);
			expect(run.stdout).not.toContain(NOT_LOGGED_IN_MESSAGE);
		});
	}

	it("writes the session header json mode has always written", { timeout: 120_000 }, async () => {
		const run = await runCli(["--mode", "json", "hello"]);

		expect(jsonRecords(run.stdout)[0]?.type).toBe("session");
	});

	it("keeps the not-logged-in line on stdout in text mode", { timeout: 120_000 }, async () => {
		const run = await runCli(["-p", "hello"]);

		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe(`${NOT_LOGGED_IN_MESSAGE}\n`);
	});
});
