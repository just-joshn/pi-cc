/**
 * The pi-cc side: the built bundle under `packages/coding-agent`, launched by the same node that runs
 * the harness. Its transport configuration lives in the seeded agent dir, not in the environment, so
 * `prepare` writes the two files that make the fork talk to the case's mock server.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Side } from "../isolate.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = realpathSync(join(CONFORMANCE_DIR, "../../.."));
export const CLI_PATH = join(REPO_ROOT, "packages/coding-agent/dist/bundle/cli.js");
const AGENT_API_KEY = "conformance-fixture";

export const piCcSide: Side = {
	name: "pi-cc",
	command: () => [realpathSync(process.execPath), CLI_PATH],
	executableRoots: () => [
		realpathSync(process.execPath),
		dirname(dirname(realpathSync(process.execPath))),
		join(REPO_ROOT, "package.json"),
		join(REPO_ROOT, "packages/coding-agent"),
		join(REPO_ROOT, "node_modules"),
	],
	prepare: (roots, port) => {
		if (port === null) return;
		writeFileSync(
			join(roots.agent, "models.json"),
			`${JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKey: AGENT_API_KEY } } })}\n`,
		);
		writeFileSync(
			join(roots.agent, "settings.json"),
			`${JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5" })}\n`,
		);
	},
};
