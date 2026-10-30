import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const DIR = new URL("../conformance/provenance/", import.meta.url);
const README = readFileSync(new URL("README.md", DIR), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function rowDigests(file: string): string[] {
	const row = README.split("\n").find((line) => line.startsWith(`| \`${file}\``));
	if (row === undefined) throw new Error(`README has no row for ${file}`);
	return [...row.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1]);
}

describe("the pinned dossier probe profiles", () => {
	test.each(["probe-strict.sb", "probe-loopback.sb"])(
		"%s README row carries its copy and normalized digests",
		(file) => {
			const text = readFileSync(new URL(file, DIR), "utf8");
			const normalized = text.replace(/\/private\/tmp\/claude-re-probe-[a-z0-9]+/g, "SENTINEL");

			const [copy, , normalizedDigest] = rowDigests(file);

			expect(copy).toBe(sha256(text));
			expect(normalizedDigest).toBe(sha256(normalized));
		},
	);
});
