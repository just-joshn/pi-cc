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
	test("a value that starts with a brace is parsed as JSON", () => {
		const parsed = parseFlagSettings('{"model":"claude-opus-4-5"}', "/irrelevant");
		expect(parsed).toEqual({
			kind: "document",
			path: FLAG_SETTINGS_LABEL,
			values: { model: "claude-opus-4-5" },
		});
	});

	test("surrounding whitespace does not change the decision", () => {
		const parsed = parseFlagSettings('  {"env":{"A":"1"}}  ', "/irrelevant");
		expect(parsed.kind).toBe("document");
	});

	test("malformed inline JSON is a failure, not a throw", () => {
		const parsed = parseFlagSettings('{"model":', "/irrelevant");
		expect(parsed).toMatchObject({ kind: "failure", path: FLAG_SETTINGS_LABEL, malformed: true });
	});

	test("inline JSON of the wrong shape is a shape failure", () => {
		expect(parseFlagSettings("{}", "/irrelevant")).toEqual({
			kind: "document",
			path: FLAG_SETTINGS_LABEL,
			values: {},
		});
	});
});

describe("file paths", () => {
	test("a path is resolved against the working directory", () => {
		const path = fileWith('{"model":"claude-sonnet-4-5"}');
		const parsed = parseFlagSettings("settings.json", join(path, ".."));
		expect(parsed).toEqual({ kind: "document", path, values: { model: "claude-sonnet-4-5" } });
	});

	test("an absolute path is used as given", () => {
		const path = fileWith('{"model":"claude-sonnet-4-5"}');
		expect(parseFlagSettings(path, "/irrelevant")).toEqual({
			kind: "document",
			path,
			values: { model: "claude-sonnet-4-5" },
		});
	});

	test("a malformed file names its path and detail", () => {
		const path = fileWith('{"model":');
		const parsed = parseFlagSettings(path, "/irrelevant");
		expect(parsed).toMatchObject({ kind: "failure", path, malformed: true });
	});

	test("a file holding valid JSON that is not an object is a shape failure", () => {
		const path = fileWith("[]");
		const parsed = parseFlagSettings(path, "/irrelevant");
		expect(parsed).toMatchObject({ kind: "failure", path, malformed: false });
	});

	test("a missing file is a read failure, not a throw", () => {
		const path = join(tempDir(), "absent.json");
		const parsed = parseFlagSettings(path, "/irrelevant");
		expect(parsed).toMatchObject({ kind: "failure", path, malformed: true });
		if (parsed.kind !== "failure") throw new Error("expected a failure");
		expect(parsed.detail).toContain("could not read the file");
	});
});
