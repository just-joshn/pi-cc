import { describe, expect, test } from "vitest";
import { autoMemoryPromptSection } from "../src/core/memory/wrapper.ts";
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
	date: "2026-10-30",
};

const options = (extra: Partial<BuildSystemPromptOptions> = {}) =>
	normalizeBuildSystemPromptOptions({ cwd: "/work/project", ...extra });

const within = (actual: number, target: number) => actual >= target * 0.85 && actual <= target * 1.15;

const total = (record: ReturnType<typeof assembleCcPrompt>) => record.working.length + (record.dynamic?.length ?? 0);

describe("Claude Code prompt assembly", () => {
	const memory = { memory: autoMemoryPromptSection("/home/probe/memory/") };

	test("the default prompt matches the measured block sizes within 15 percent", () => {
		const record = assembleCcPrompt(options({ sections: memory }), { bare: false }, environment);

		expect(within(record.identity.length, 62)).toBe(true);
		expect(within(total(record), 5914)).toBe(true);
		expect(within(record.context?.length ?? 0, 9235)).toBe(true);
		expect(record.context?.startsWith("# Environment")).toBe(true);
		expect(record.context).toContain("/work/project");
	});

	test("the session-specific part is the memory section, which exclude-dynamic moves out of the working block", () => {
		const record = assembleCcPrompt(options({ sections: memory }), { bare: false }, environment);

		expect(within(record.working.length, 3260)).toBe(true);
		expect(within(record.dynamic?.length ?? 0, 2626)).toBe(true);
		expect(record.dynamic).toContain("Auto memory directory: /home/probe/memory/");
	});

	test("without a memory directory the session-specific part shrinks to a short note", () => {
		const record = assembleCcPrompt(options(), { bare: false }, environment);

		expect(within(total(record), 3564)).toBe(true);
	});

	test("an appended instruction grows the working prompt by length + 2 and the identity by a fixed 32", () => {
		const base = assembleCcPrompt(options(), { bare: false }, environment);
		const short = assembleCcPrompt(options({ appendSystemPrompt: "x".repeat(21) }), { bare: false }, environment);
		const long = assembleCcPrompt(options({ appendSystemPrompt: "x".repeat(51) }), { bare: false }, environment);

		expect(short.identity.length - base.identity.length).toBe(32);
		expect(long.identity.length - base.identity.length).toBe(32);
		expect(short.working.length - base.working.length).toBe(21 + 2);
		expect(long.working.length - base.working.length).toBe(51 + 2);
		expect(short.context).toBe(base.context);
	});

	test("a custom prompt is the whole working prompt, with no session-specific part, and keeps the context", () => {
		const base = assembleCcPrompt(options(), { bare: false }, environment);
		const custom = assembleCcPrompt(options({ customPrompt: "ONLY THIS" }), { bare: false }, environment);

		expect(custom.working).toBe("ONLY THIS");
		expect(custom.dynamic).toBeUndefined();
		expect(custom.identity).toBe(base.identity);
		expect(custom.context).toBe(base.context);
	});

	test("bare reduces the working prompt to the directory and date and sends no context", () => {
		const bare = assembleCcPrompt(options(), { bare: true }, environment);

		expect(bare.working).toBe("CWD: /work/project\nDate: 2026-10-30");
		expect(bare.dynamic).toBeUndefined();
		expect(bare.context).toBeUndefined();
	});

	test("project instructions join the session-specific part and skills and extension sections ride in the context", () => {
		const record = assembleCcPrompt(
			options({
				contextFiles: [{ path: "/work/project/AGENTS.md", content: "PROJECT RULE" }],
				sections: { extra: "EXTRA NOTE" },
			}),
			{ bare: false },
			environment,
		);

		expect(record.dynamic).toContain("PROJECT RULE");
		expect(record.context).not.toContain("PROJECT RULE");
		expect(record.context).toContain("EXTRA NOTE");
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

	test("tool guidelines still reach the context under a custom prompt", () => {
		const record = assembleCcPrompt(
			options({ customPrompt: "X", selectedTools: ["read"], promptGuidelines: ["Use the widget tool for widgets"] }),
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
