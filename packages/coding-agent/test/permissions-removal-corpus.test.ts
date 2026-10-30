import { readFileSync, realpathSync } from "node:fs";
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

const recorded: { seed: number; entries: Observation[] } = JSON.parse(
	readFileSync(new URL("../conformance/removal-fuzz-fixtures.json", import.meta.url), "utf8"),
);
const generated: { seed: number; lines: string[] } = JSON.parse(
	readFileSync(new URL("../conformance/removal-fuzz-corpus.json", import.meta.url), "utf8"),
);
const open: { queue: string; differences: { command: string }[] } = JSON.parse(
	readFileSync(new URL("../conformance/removal-fuzz-open.json", import.meta.url), "utf8"),
);
const knownDifferences = new Set(open.differences.map((entry) => entry.command));
const root = join(realpathSync(tmpdir()), "p04-removal-replay");
const cwd = join(root, "workspace");
const home = join(root, "home");
const context = new PermissionState({ cwd, home, cliMode: "bypassPermissions" }).current();

// Regression coverage for PR #14.
describe("the pinned Claude removal corpus", () => {
	it("contains all 512 distinct generated commands in seed order", () => {
		expect(recorded.seed).toBe(generated.seed);
		expect(recorded.entries.map((entry) => entry.command)).toEqual(generated.lines);
		expect(new Set(generated.lines).size).toBe(512);
	});

	function assertParity({ command, expected }: Observation): void {
		const { decision } = evaluatePermission({ name: "Bash", input: { command } }, context);
		const actual =
			decision.behavior === "allow"
				? { behavior: "allow" }
				: { behavior: decision.behavior, message: decision.message };
		const normalized = JSON.parse(
			JSON.stringify(actual).replaceAll(cwd, "$WORKSPACE").replaceAll(home, "$HOME").replaceAll(root, "$CASE"),
		);
		expect(normalized).toEqual(expected);
	}

	it.each(recorded.entries.filter((entry) => !knownDifferences.has(entry.command)))(
		"matches the permission result for $command",
		assertParity,
	);

	it.fails.each(recorded.entries.filter((entry) => knownDifferences.has(entry.command)))(
		"P04b remains open for $command",
		assertParity,
	);

	it("accounts for every open P04b row without treating it as accepted parity", () => {
		expect(open.queue).toBe("P04b");
		expect(knownDifferences.size).toBe(81);
		for (const command of knownDifferences) expect(generated.lines).toContain(command);
	});
});
