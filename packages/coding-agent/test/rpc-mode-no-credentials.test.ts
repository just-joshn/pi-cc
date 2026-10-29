import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const RESPONSE_TIMEOUT_MS = 30_000;
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

interface RpcResponseLine {
	type: "response";
	command: string;
	success?: unknown;
}

interface RpcProbe {
	lines: string[];
	response: RpcResponseLine;
	exitCodeAtResponse: number | null;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var) and the spawned CLI
	// resolves paths physically, so the fixture tree must use the physical root.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rpc-no-credentials-")));
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

function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function isGetStateResponse(value: unknown): value is RpcResponseLine {
	if (typeof value !== "object" || value === null) return false;
	return "type" in value && value.type === "response" && "command" in value && value.command === "get_state";
}

function waitForGetState(child: ChildProcessWithoutNullStreams, lines: string[]): Promise<RpcResponseLine> {
	return new Promise((resolveResponse, rejectResponse) => {
		let partial = "";
		let stderr = "";
		const timer = setTimeout(() => {
			rejectResponse(
				new Error(
					`no get_state response within ${RESPONSE_TIMEOUT_MS}ms\nstdout: ${JSON.stringify(lines)}\nstderr: ${stderr}`,
				),
			);
		}, RESPONSE_TIMEOUT_MS);
		const settle = () => clearTimeout(timer);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk: string) => {
			const parts = (partial + chunk).split("\n");
			partial = parts.pop() ?? "";
			for (const line of parts) {
				if (line.trim().length === 0) continue;
				lines.push(line);
				const parsed = parseJsonLine(line);
				if (isGetStateResponse(parsed)) {
					settle();
					resolveResponse(parsed);
				}
			}
		});
		child.on("error", (error) => {
			settle();
			rejectResponse(error);
		});
		child.on("close", (code) => {
			settle();
			rejectResponse(
				new Error(
					`rpc mode exited with code ${code} before answering get_state\nstdout: ${JSON.stringify(lines)}\nstderr: ${stderr}`,
				),
			);
		});

		child.stdin.write('{"type":"get_state","id":"1"}\n');
	});
}

async function runRpcProbe(): Promise<RpcProbe> {
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

	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "--mode", "rpc"], {
		cwd: projectDir,
		env: isolatedEnv(root, agentDir),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines: string[] = [];
	try {
		const response = await waitForGetState(child, lines);
		return { lines, response, exitCodeAtResponse: child.exitCode };
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await once(child, "close");
		}
	}
}

describe("rpc mode without credentials", () => {
	// Regression: rpc clients must be able to connect with a default model and no credentials,
	// then call set_model themselves.
	it("answers get_state on stdout instead of exiting as not logged in", { timeout: 60_000 }, async () => {
		const { lines, response, exitCodeAtResponse } = await runRpcProbe();

		expect({ type: response.type, command: response.command, success: response.success }).toEqual({
			type: "response",
			command: "get_state",
			success: true,
		});
		expect(lines.filter((line) => parseJsonLine(line) === undefined)).toEqual([]);
		expect(lines.filter((line) => line.includes("Not logged in"))).toEqual([]);
		expect(exitCodeAtResponse).toBeNull();
	});
});
