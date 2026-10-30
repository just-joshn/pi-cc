import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const DIR = new URL("../conformance/provenance/", import.meta.url);
const README = readFileSync(new URL("README.md", DIR), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The one line that differs between a copy and the dossier's live profile names the RE run's scratch directory.
const SENTINEL_PATH = "\\/private\\/tmp\\/claude-re-probe-[a-z0-9]+";

function rowFor(file: string): string[] {
	const row = README.split("\n").find((line) => line.startsWith(`| \`${file}\``));
	if (row === undefined) throw new Error(`README has no row for ${file}`);
	return [...row.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1]);
}

describe("the pinned dossier probe profiles", () => {
	test.each(["probe-strict.sb", "probe-loopback.sb"])("%s README row carries its current digests", (file) => {
		const text = readFileSync(new URL(file, DIR), "utf8");

		const digests = rowFor(file);

		expect(digests).toContain(sha256(text));
		expect(digests).toContain(sha256(text.replace(new RegExp(SENTINEL_PATH, "g"), "SENTINEL")));
	});

	test.each(["probe-strict.sb", "probe-loopback.sb"])("%s differs from its dossier source on the sentinel line only", (file) => {
		const lines = readFileSync(new URL(file, DIR), "utf8").split("\n");
		const sentinelLines = lines.filter((line) => new RegExp(SENTINEL_PATH).test(line));

		expect(sentinelLines).toHaveLength(1);
		expect(README.replace(/\s+/g, " ")).toContain("only the sentinel line differs");
	});
});
