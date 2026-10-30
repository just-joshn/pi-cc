import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionState } from "../src/core/permissions/context.ts";
import { evaluatePermission } from "../src/core/permissions/evaluate.ts";

interface Observation {
	command: string;
	expected: { behavior: "allow" } | { behavior: "ask"; message: string };
	toolResult: string;
}

const CORPORA = [
	"removal-fuzz",
	"removal-fuzz-holdout",
	"removal-fuzz-blind",
	"removal-fuzz-blind2",
	"removal-fuzz-review1",
	"removal-fuzz-review2",
];
const root = join(realpathSync(tmpdir()), "p04-removal-replay");
const cwd = join(root, "workspace");
const home = join(root, "home");
const context = new PermissionState({ cwd, home, cliMode: "bypassPermissions" }).current();

function read<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(`../conformance/${name}`, import.meta.url), "utf8")) as T;
}

function decide(command: string): Observation["expected"] {
	const { decision } = evaluatePermission({ name: "Bash", input: { command } }, context);
	const actual =
		decision.behavior === "allow"
			? { behavior: "allow" }
			: { behavior: decision.behavior, message: decision.message };
	return JSON.parse(
		JSON.stringify(actual).replaceAll(cwd, "$WORKSPACE").replaceAll(home, "$HOME").replaceAll(root, "$CASE"),
	);
}

function assertParity({ command, expected }: Observation): void {
	expect(decide(command)).toEqual(expected);
}

/** The safety direction: a line Claude Code refuses is never allowed, even when the text differs. */
function assertNeverAllowsWhatClaudeRefuses({ command, expected }: Observation): void {
	if (expected.behavior === "ask") expect(decide(command).behavior).toBe("ask");
}

// Regression coverage for PR #14: results recorded from pinned claude 2.1.312, asserted against pi-cc.
describe.each(CORPORA)("the pinned Claude removal corpus %s", (name) => {
	const recorded = read<{ seed: number; entries: Observation[] }>(`${name}-fixtures.json`);
	const generated = read<{ seed: number; lines: string[] }>(`${name}-corpus.json`);
	const openFile = `${name}-open.json`;
	const open = existsSync(new URL(`../conformance/${openFile}`, import.meta.url))
		? read<{ differences: { command: string }[] }>(openFile).differences.map((entry) => entry.command)
		: [];
	const known = new Set(open);

	it.each(recorded.entries)("never allows what Claude Code refuses: $command", assertNeverAllowsWhatClaudeRefuses);

	it("holds 512 distinct generated commands in seed order", () => {
		expect(recorded.seed).toBe(generated.seed);
		expect(recorded.entries.map((entry) => entry.command)).toEqual(generated.lines);
		expect(new Set(generated.lines).size).toBe(512);
	});

	it.each(recorded.entries.filter((entry) => !known.has(entry.command)))(
		"matches Claude Code for $command",
		assertParity,
	);

	it.fails.each(recorded.entries.filter((entry) => known.has(entry.command)))(
		"P04b debt, stricter or message-only, stays open for $command",
		assertParity,
	);
});
