import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionState } from "../src/core/permissions/context.ts";
import { evaluatePermission } from "../src/core/permissions/evaluate.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(realpathSync(homedir()), "p04-removal-score-"));
const cwd = join(root, "workspace");
const home = join(root, "home");
mkdirSync(cwd);
mkdirSync(home);
const context = new PermissionState({ cwd, home, cliMode: "bypassPermissions" }).current();

function decide(command) {
	const { decision } = evaluatePermission({ name: "Bash", input: { command } }, context);
	const actual = decision.behavior === "allow" ? { behavior: "allow" } : { behavior: decision.behavior, message: decision.message };
	return JSON.parse(JSON.stringify(actual).replaceAll(cwd, "$WORKSPACE").replaceAll(home, "$HOME").replaceAll(root, "$CASE"));
}

const list = process.argv.includes("--list");
const only = process.argv.filter((arg) => !arg.startsWith("--")).slice(2);
const totals = { exact: 0, stricter: 0, "message-only": 0, unsafe: 0 };
const names = readdirSync(directory).filter((name) => name.endsWith("-fixtures.json") && (only.length === 0 || only.some((o) => name === `removal-fuzz${o === "main" ? "" : `-${o}`}-fixtures.json`)));
try {
	for (const name of names) {
		const { entries } = JSON.parse(readFileSync(join(directory, name), "utf8"));
		const counts = { exact: 0, stricter: 0, "message-only": 0, unsafe: 0 };
		for (const { command, expected } of entries) {
			const actual = decide(command);
			let direction = "exact";
			if (JSON.stringify(actual) !== JSON.stringify(expected))
				direction = expected.behavior === "allow" ? "stricter" : actual.behavior === "allow" ? "unsafe" : "message-only";
			counts[direction]++;
			if (list && direction !== "exact") console.log(`${direction}\t${JSON.stringify(command)}${direction === "message-only" ? `\n  want ${JSON.stringify(expected.message)}\n  got  ${JSON.stringify(actual.message)}` : ""}`);
		}
		for (const key in counts) totals[key] += counts[key];
		console.log(`${name.replace("-fixtures.json", "")}: ${JSON.stringify(counts)}`);
	}
	console.log(`total: ${JSON.stringify(totals)}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
