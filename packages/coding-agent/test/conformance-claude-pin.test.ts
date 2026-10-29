import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createClaudeSide, hashClaude } from "../conformance/sides/claude.ts";

const PINNED_BYTES = "#!/bin/sh\necho 2.1.312 (Claude Code)\n";
const SWAPPED_BYTES = "#!/bin/sh\necho fake\n";
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

function writeScript(dir: string, name: string, contents: string): string {
	const path = join(dir, name);
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
	return path;
}

/** A temp link to the pinned fixture, and a retarget onto a script that prints something else. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-claude-pin-"));
	tempDirs.push(dir);
	const pinned = writeScript(dir, "claude-2.1.312", PINNED_BYTES);
	const swapped = writeScript(dir, "claude-fake", SWAPPED_BYTES);
	const link = join(dir, "current");
	symlinkSync(pinned, link);
	const retarget = () => {
		unlinkSync(link);
		symlinkSync(swapped, link);
	};
	return { link, pinned: realpathSync(pinned), swapped: realpathSync(swapped), retarget };
}

describe("hashClaude", () => {
	test("reports the resolved target of a symlink and that target's digest", () => {
		const { link, pinned } = fixture();
		expect(hashClaude(link)).toEqual({ path: pinned, sha256: sha256(PINNED_BYTES) });
	});

	test("reports a dangling symlink as absent instead of throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cc-claude-pin-"));
		tempDirs.push(dir);
		const link = join(dir, "current");
		symlinkSync(join(dir, "missing"), link);
		expect(hashClaude(link)).toBeNull();
	});
});

describe("createClaudeSide", () => {
	test("commands and allows only the path the pin resolved, after the link is retargeted", () => {
		const { link, pinned, swapped, retarget } = fixture();
		const hash = hashClaude(link);
		if (hash === null) throw new Error("fixture link did not hash");
		retarget();
		const side = createClaudeSide(hash.path);
		expect(side.command()).toEqual([pinned]);
		expect(side.executableRoots()).toEqual([pinned]);
		expect(side.command()).not.toContain(swapped);
		expect(side.executableRoots()).not.toContain(swapped);
	});
});
