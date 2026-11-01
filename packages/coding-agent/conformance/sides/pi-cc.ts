/** The pi-cc bundle and its offline ripgrep dependency, prepared inside each side's isolated agent directory. */

import { execFileSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Side } from "../isolate.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = realpathSync(join(CONFORMANCE_DIR, "../../.."));
export const CLI_PATH = join(REPO_ROOT, "packages/coding-agent/dist/bundle/cli.js");

let ripgrep: { path: string; dylibs: string[] } | undefined;

export const piCcSide: Side = {
	name: "pi-cc",
	command: () => [realpathSync(process.execPath), CLI_PATH],
	executableRoots: () => [
		realpathSync(process.execPath),
		dirname(dirname(realpathSync(process.execPath))),
		join(REPO_ROOT, "package.json"),
		join(REPO_ROOT, "packages/coding-agent"),
		join(REPO_ROOT, "node_modules"),
		...hostRipgrep().dylibs,
	],
	prepare: (roots) => {
		const bin = join(roots.agent, "bin");
		mkdirSync(bin, { recursive: true });
		const target = join(bin, "rg");
		copyFileSync(hostRipgrep().path, target, constants.COPYFILE_EXCL);
		chmodSync(target, 0o755);
	},
};

function hostRipgrep(): { path: string; dylibs: string[] } {
	if (ripgrep !== undefined) return ripgrep;
	try {
		const path = realpathSync("/opt/homebrew/bin/rg");
		const pcre = "/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib";
		const dylibs = new Set<string>();
		for (const binary of [path, realpathSync(pcre)]) {
			const output = execFileSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8" });
			for (const line of output.split("\n").slice(1)) {
				const dependency = /^\s+(\S+) \(compatibility version/.exec(line)?.[1];
				if (
					dependency === undefined ||
					dependency.startsWith("/usr/lib/") ||
					dependency.startsWith("/System/Library/")
				)
					continue;
				if (dependency !== pcre) throw new Error(`unaudited ripgrep dylib ${dependency}`);
				dylibs.add(realpathSync(dependency));
			}
		}
		ripgrep = { path, dylibs: [...dylibs] };
		return ripgrep;
	} catch (error) {
		throw new Error(
			"Conformance requires the host /opt/homebrew/bin/rg and its audited PCRE2 dylib. No download was attempted.",
			{ cause: error },
		);
	}
}
