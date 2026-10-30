import { describe, expect, test } from "vitest";
import { assembleCcPrompt } from "../src/core/system-prompt/assemble.ts";
import type { CcEnvironment } from "../src/core/system-prompt/environment.ts";
import { snapshotDecision } from "../src/core/system-prompt/snapshot.ts";
import { type BuildSystemPromptOptions, normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";

const environment: CcEnvironment = {
	cwd: "/work/project",
	isGitRepository: true,
	platform: "darwin",
	shell: "zsh",
	osVersion: "Darwin 27.0.0",
};

const options = (extra: Partial<BuildSystemPromptOptions> = {}) =>
	normalizeBuildSystemPromptOptions({ cwd: "/work/project", ...extra });

const within = (actual: number, target: number) => actual >= target * 0.85 && actual <= target * 1.15;

describe("Claude Code prompt assembly", () => {
	test("the default prompt matches the measured block sizes within 15 percent", () => {
		const record = assembleCcPrompt(options(), { bare: false }, environment);

		expect(within(record.identity.length, 62)).toBe(true);
		expect(within(record.working.length, 5914)).toBe(true);
		expect(within(record.context.length, 9235)).toBe(true);
		expect(record.context.startsWith("# Environment")).toBe(true);
		expect(record.context).toContain("/work/project");
	});

	test("an appended instruction grows the identity by length + 11 and the working prompt by length + 2", () => {
		const base = assembleCcPrompt(options(), { bare: false }, environment);
		const appended = assembleCcPrompt(
			options({ appendSystemPrompt: "PROBE_APPENDED_MARKER" }),
			{ bare: false },
			environment,
		);

		expect(appended.identity.length - base.identity.length).toBe(21 + 11);
		expect(appended.working.length - base.working.length).toBe(21 + 2);
		expect(appended.context).toBe(base.context);
	});

	test("a custom prompt replaces the working prompt and keeps the identity", () => {
		const base = assembleCcPrompt(options(), { bare: false }, environment);
		const custom = assembleCcPrompt(options({ customPrompt: "ONLY THIS" }), { bare: false }, environment);

		expect(custom.working).toBe("ONLY THIS");
		expect(custom.identity).toBe(base.identity);
	});

	test("bare shortens the working prompt to about 180 characters and drops the guidance", () => {
		const base = assembleCcPrompt(options(), { bare: false }, environment);
		const bare = assembleCcPrompt(options(), { bare: true }, environment);

		expect(within(bare.working.length, 180)).toBe(true);
		expect(bare.context.length).toBeLessThan(base.context.length / 2);
	});

	test("project instructions, skills and extension sections ride in the context, not the system blocks", () => {
		const record = assembleCcPrompt(
			options({
				contextFiles: [{ path: "/work/project/AGENTS.md", content: "PROJECT RULE" }],
				sections: { memory: "MEMORY NOTE" },
			}),
			{ bare: false },
			environment,
		);

		expect(record.context).toContain("PROJECT RULE");
		expect(record.context).toContain("MEMORY NOTE");
		expect(record.working).not.toContain("PROJECT RULE");
	});

	test("tool guidelines from extensions reach the context", () => {
		const record = assembleCcPrompt(
			options({ selectedTools: ["read"], promptGuidelines: ["Use the widget tool for widgets"] }),
			{ bare: false },
			environment,
		);

		expect(record.context).toContain("Use the widget tool for widgets");
	});
});

describe("snapshot decision", () => {
	test("records when there is no record, whatever the mode", () => {
		expect(snapshotDecision({ snapshot: true, hasRecord: false })).toBe("record");
		expect(snapshotDecision({ snapshot: false, hasRecord: false })).toBe("record");
	});

	test("reuses the record when snapshots are on", () => {
		expect(snapshotDecision({ snapshot: true, hasRecord: true })).toBe("reuse");
	});

	test("projects a fresh render each request when snapshots are off", () => {
		expect(snapshotDecision({ snapshot: false, hasRecord: true })).toBe("project");
	});
});
