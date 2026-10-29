import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { captureStartupEnv, startupEnv } from "../src/utils/internal-env.ts";

const { spawnProcessMock, spawnProcessSyncMock } = vi.hoisted(() => ({
	spawnProcessMock: vi.fn(),
	spawnProcessSyncMock: vi.fn(),
}));

vi.mock("../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/child-process.ts")>()),
	spawnProcess: spawnProcessMock,
	spawnProcessSync: spawnProcessSyncMock,
}));

afterEach(() => {
	vi.unstubAllEnvs();
	spawnProcessMock.mockReset();
	spawnProcessSyncMock.mockReset();
});

describe("startupEnv", () => {
	beforeEach(() => {
		captureStartupEnv();
	});

	it("leaves out a key that a settings env block adds after startup", () => {
		vi.stubEnv("PI_TEST_SETTINGS_ENV_ONLY", "1");
		expect(process.env.PI_TEST_SETTINGS_ENV_ONLY).toBe("1");
		expect(startupEnv()).not.toHaveProperty("PI_TEST_SETTINGS_ENV_ONLY");
	});

	it("returns a fresh object that callers may mutate", () => {
		const snapshot = startupEnv();
		snapshot.PI_TEST_LEAKED_KEY = "1";
		expect(startupEnv()).not.toHaveProperty("PI_TEST_LEAKED_KEY");
		expect(startupEnv()).not.toBe(snapshot);
	});

	it("reports the state captured by the latest captureStartupEnv call", () => {
		expect(startupEnv()).not.toHaveProperty("PI_TEST_RECAPTURED_KEY");
		vi.stubEnv("PI_TEST_RECAPTURED_KEY", "second");
		captureStartupEnv();
		expect(startupEnv().PI_TEST_RECAPTURED_KEY).toBe("second");
	});
});

describe("pi-internal spawns", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		captureStartupEnv();
		tempDir = join(tmpdir(), `internal-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		spawnProcessSyncMock.mockReturnValue({
			pid: 1,
			output: [null, "/usr/local/lib/node_modules", ""],
			stdout: "/usr/local/lib/node_modules",
			stderr: "",
			status: 0,
			signal: null,
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// `npm root -g` decides which directory the legacy global package lookup reads extension code from.
	it("gives the package manager's npm probe the startup env, not the settings env", () => {
		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: ["npm:some-package"] }),
		});
		vi.stubEnv("npm_config_prefix", "/repo/prefix");
		vi.stubEnv("BUN_INSTALL", "/repo/bun");

		packageManager.getInstalledPath("npm:some-package", "user");

		expect(spawnProcessSyncMock).toHaveBeenCalledTimes(1);
		const [command, args, options] = spawnProcessSyncMock.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		expect([command, ...args]).toEqual(["npm", "root", "-g"]);
		// The child environment is the snapshot exactly, so the settings value for a key never reaches it,
		// whichever keys this machine happens to have in its own environment.
		expect(options.env).toEqual(startupEnv());
		expect(options.env.npm_config_prefix).toBe(startupEnv().npm_config_prefix);
		expect(options.env.npm_config_prefix).not.toBe("/repo/prefix");
		expect(options.env.BUN_INSTALL).not.toBe("/repo/bun");
	});
});
