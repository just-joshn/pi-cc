/**
 * The pi-cc side: the built bundle under `packages/coding-agent`, launched by the same node that runs
 * the harness. Like the claude side it is configured by the environment alone, so `prepare` seeds
 * nothing and a case must reach the mock server through the same variables the reference side reads.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Side } from "../isolate.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = realpathSync(join(CONFORMANCE_DIR, "../../.."));
export const CLI_PATH = join(REPO_ROOT, "packages/coding-agent/dist/bundle/cli.js");

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
	prepare: () => {},
};
