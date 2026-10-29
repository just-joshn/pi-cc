import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { admitCcDirectory, type CcRunLocation, openCcRunSettings } from "../src/core/settings/cc/run.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Side {
	root: string;
	config: string;
	workspace: string;
}

function side(): Side {
	const root = mkdtempSync(join(tmpdir(), "pi-cc-run-settings-"));
	tempDirs.push(root);
	const config = join(root, "config");
	const workspace = join(root, "workspace");
	mkdirSync(config, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	return { root, config, workspace };
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function location(parts: Side, overrides: Partial<CcRunLocation> = {}): CcRunLocation {
	return {
		cwd: parts.workspace,
		home: join(parts.root, "home"),
		env: { CLAUDE_CONFIG_DIR: parts.config },
		platform: "darwin",
		version: "1.4.0",
		settingSources: undefined,
		flagSettings: undefined,
		...overrides,
	};
}

function projectSettings(parts: Side, content: string): string {
	const path = join(parts.workspace, ".claude", "settings.json");
	write(path, content);
	return path;
}

describe("repo-tier trust", () => {
	// Claude Code 2.1.312 applies a project's `env` and `model` even when `.claude.json` records
	// `hasTrustDialogAccepted: false`. pi-cc withholds them: the same `env` block reaches the model
	// client and the agent's tools, so a repository that pi has not been trusted with must not set it.
	// This is the one place pi-cc deliberately diverges from Claude Code, and the trust store is pi's.
	test("an untrusted project contributes no env and is reported as ignored", () => {
		const parts = side();
		const project = projectSettings(
			parts,
			'{"model":"claude-sonnet-4-5","env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}',
		);
		const run = openCcRunSettings(location(parts), false);
		expect(run.settings.env.HTTPS_PROXY).toBeUndefined();
		expect(run.settings.model).toBeUndefined();
		expect(run.ignored).toEqual([project]);
		expect(run.settleRepoTiers(false).ignored).toEqual([]);
	});

	test("a trusted project contributes its model and env", () => {
		const parts = side();
		projectSettings(parts, '{"model":"claude-sonnet-4-5","env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		const run = openCcRunSettings(location(parts), true);
		expect(run.settings.model).toBe("claude-sonnet-4-5");
		expect(run.settings.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
		expect(run.ignored).toEqual([]);
	});

	test("the user and flag tiers apply whatever the trust answer is", () => {
		const parts = side();
		projectSettings(parts, '{"model":"claude-sonnet-4-5"}');
		write(join(parts.config, "settings.json"), '{"env":{"A":"user"}}');
		const run = openCcRunSettings(location(parts, { flagSettings: '{"env":{"B":"flag"}}' }), false);
		expect(run.settings.env).toEqual({ A: "user", B: "flag" });
		expect(run.settings.model).toBeUndefined();
	});
});

describe("pending trust", () => {
	test("withholds the project tiers and reports nothing ignored until the answer is no", () => {
		const parts = side();
		const project = projectSettings(parts, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		const run = openCcRunSettings(location(parts), "pending");
		expect(run.settings.env).toEqual({});
		expect(run.ignored).toEqual([]);

		const settled = run.settleRepoTiers(false);
		expect(settled.ignored).toEqual([project]);
		expect(settled.settings.env).toEqual({});
		expect(run.settings.env).toEqual({});
	});

	test("admits the project tiers when the answer is yes, and never reports them ignored", () => {
		const parts = side();
		projectSettings(parts, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		const run = openCcRunSettings(location(parts), "pending");
		const settled = run.settleRepoTiers(true);
		expect(settled.ignored).toEqual([]);
		expect(settled.settings.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
		expect(run.settings.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
	});

	test("a malformed project file is reported once, when the tiers are admitted", () => {
		const parts = side();
		const project = projectSettings(parts, '{"model":5}');
		const run = openCcRunSettings(location(parts), "pending");
		expect(run.failures).toEqual([]);

		const settled = run.settleRepoTiers(true);
		expect(settled.failures).toEqual([
			{
				kind: "shape",
				source: "project",
				path: project,
				key: "model",
				detail: "Expected string, but received number",
			},
		]);
	});

	test("a settle after a decided answer adds nothing to report", () => {
		const parts = side();
		projectSettings(parts, '{"model":5}');
		const run = openCcRunSettings(location(parts), true);
		expect(run.failures).toHaveLength(1);
		const settled = run.settleRepoTiers(true);
		expect(settled.failures).toEqual([]);
		expect(settled.skipped).toEqual([]);
		expect(settled.ignored).toEqual([]);
		expect(settled.settings).toBe(run.settings);
	});
});

describe("failures that never depend on trust", () => {
	test("a malformed user file is reported at open", () => {
		const parts = side();
		write(join(parts.config, "settings.json"), '{"model":5}');
		const run = openCcRunSettings(location(parts), "pending");
		expect(run.failures).toHaveLength(1);
	});

	test("a bad --settings value is a flag error, not a failure", () => {
		const parts = side();
		const run = openCcRunSettings(location(parts, { flagSettings: "nope.json" }), false);
		expect(run.flagError).toMatch(/^Settings file not found: /);
	});
});

describe("a trust decision admits only that directory", () => {
	test("trusting the session directory does not admit the startup directory's proxy", () => {
		const startup = side();
		const session = side();
		projectSettings(startup, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		projectSettings(session, '{"model":"claude-sonnet-4-5"}');
		const pending = admitCcDirectory(undefined, location(startup), startup.workspace, "pending");
		expect(pending.admission.run.settings.env.HTTPS_PROXY).toBeUndefined();

		const admitted = admitCcDirectory(pending.admission, location(session), session.workspace, true);

		expect(admitted.admission.cwd).toBe(session.workspace);
		expect(admitted.admission.run.settings.env.HTTPS_PROXY).toBeUndefined();
		expect(admitted.admission.run.settings.model).toBe("claude-sonnet-4-5");
	});

	test("an untrusted switch does not admit the new directory's env", () => {
		const current = side();
		const next = side();
		projectSettings(current, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		projectSettings(next, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:1"}}');
		const trusted = admitCcDirectory(undefined, location(current), current.workspace, true);
		const denied = admitCcDirectory(trusted.admission, location(next), next.workspace, false);

		expect(denied.admission.cwd).toBe(next.workspace);
		expect(denied.admission.run.settings.env.HTTPS_PROXY).toBeUndefined();
		expect(denied.admission.run.ignored).toEqual([join(next.workspace, ".claude", "settings.json")]);
	});

	test("the same directory still admits when its own answer is yes", () => {
		const parts = side();
		projectSettings(parts, '{"env":{"HTTPS_PROXY":"http://127.0.0.1:9"}}');
		const pending = admitCcDirectory(undefined, location(parts), parts.workspace, "pending");
		const admitted = admitCcDirectory(pending.admission, location(parts), parts.workspace, true);

		expect(admitted.admission.cwd).toBe(parts.workspace);
		expect(admitted.settled?.settings.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
	});
});
