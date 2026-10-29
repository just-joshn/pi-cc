import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FLAG_SETTINGS_LABEL, parseFlagSettings } from "../src/core/settings/cc/flag-tier.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-flag-tier-"));
	tempDirs.push(dir);
	return dir;
}

function fileWith(content: string): string {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, content);
	return path;
}

describe("inline JSON", () => {
	test("names inline failures the way Claude Code does", () => {
		expect(FLAG_SETTINGS_LABEL).toBe("--settings (inline JSON)");
	});

	test("a bracketed value is parsed as JSON", () => {
		const parsed = parseFlagSettings('{"model":"claude-opus-4-5"}', "/irrelevant");
		expect(parsed).toEqual({
			kind: "document",
			path: FLAG_SETTINGS_LABEL,
			values: { model: "claude-opus-4-5" },
			skipped: [],
		});
	});

	test("surrounding whitespace does not change the decision", () => {
		const parsed = parseFlagSettings('  {"env":{"A":"1"}}  ', "/irrelevant");
		expect(parsed.kind).toBe("document");
	});

	test("malformed inline JSON is fatal, not a failure", () => {
		expect(parseFlagSettings('{"model":}', "/irrelevant")).toEqual({ kind: "invalid-json" });
	});

	test("an empty object is a valid empty document", () => {
		expect(parseFlagSettings("{}", "/irrelevant")).toEqual({
			kind: "document",
			path: FLAG_SETTINGS_LABEL,
			values: {},
			skipped: [],
		});
	});

	test("a value that opens a brace but does not close one is a path", () => {
		expect(parseFlagSettings('{"model":"x"', "/irrelevant")).toEqual({
			kind: "missing",
			path: join("/irrelevant", '{"model":"x"'),
		});
	});

	test("an empty or whitespace-only value is no tier at all", () => {
		expect(parseFlagSettings("", "/irrelevant")).toEqual({ kind: "absent" });
		expect(parseFlagSettings("   ", "/irrelevant")).toEqual({ kind: "absent" });
	});
});

describe("file paths", () => {
	test("a path is resolved against the working directory", () => {
		const path = fileWith('{"model":"claude-sonnet-4-5"}');
		const parsed = parseFlagSettings("settings.json", join(path, ".."));
		expect(parsed).toEqual({ kind: "document", path, values: { model: "claude-sonnet-4-5" }, skipped: [] });
	});

	test("an absolute path is used as given", () => {
		const path = fileWith('{"model":"claude-sonnet-4-5"}');
		expect(parseFlagSettings(path, "/irrelevant")).toEqual({
			kind: "document",
			path,
			values: { model: "claude-sonnet-4-5" },
			skipped: [],
		});
	});

	test("a malformed file names its path and detail", () => {
		const path = fileWith('{"model":');
		expect(parseFlagSettings(path, "/irrelevant")).toEqual({ kind: "malformed", path });
	});

	test("a file holding valid JSON that is not an object is a shape failure", () => {
		const path = fileWith("[]");
		const parsed = parseFlagSettings(path, "/irrelevant");
		expect(parsed).toMatchObject({ kind: "shape", path });
		if (parsed.kind !== "shape") throw new Error("expected a shape failure");
		expect(parsed.problems[0].detail).toBe("Expected object, but received array");
	});

	test("a missing file is reported as missing", () => {
		const path = join(tempDir(), "absent.json");
		expect(parseFlagSettings(path, "/irrelevant")).toEqual({ kind: "missing", path });
	});

	test("a directory is reported as unreadable", () => {
		const dir = tempDir();
		const parsed = parseFlagSettings(dir, "/irrelevant");
		expect(parsed).toMatchObject({ kind: "unreadable", path: dir });
		if (parsed.kind !== "unreadable") throw new Error("expected an unreadable failure");
		expect(parsed.detail.length).toBeGreaterThan(0);
	});
});
