import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	autoUpdateState,
	readUpdateVersionBand,
	selfUpdateSource,
	startupCheckFeed,
	UPDATE_FEED_ENV,
	updateTargetRefusal,
} from "../src/cli/update-gates.ts";

const FEED = "https://releases.example.test/latest";

describe("autoUpdateState", () => {
	test("is enabled with no variable set", () => {
		expect(autoUpdateState({})).toEqual({ kind: "enabled" });
	});

	test("DISABLE_AUTOUPDATER disables on a truthy value only", () => {
		for (const value of ["1", "true", "TRUE", "yes", "on"]) {
			expect(autoUpdateState({ DISABLE_AUTOUPDATER: value })).toEqual({
				kind: "disabled",
				envVar: "DISABLE_AUTOUPDATER",
			});
		}
		for (const value of ["0", "false", "", "no"]) {
			expect(autoUpdateState({ DISABLE_AUTOUPDATER: value })).toEqual({ kind: "enabled" });
		}
	});

	test("every gate reads Claude Code's truthy set, so 0 and false leave updates on", () => {
		for (const name of ["DISABLE_UPDATES", "DISABLE_AUTOUPDATER"]) {
			for (const value of ["0", "false", "no", "off", ""]) {
				expect(autoUpdateState({ [name]: value })).toEqual({ kind: "enabled" });
			}
			for (const value of ["1", "true", "Yes", "ON"]) {
				expect(autoUpdateState({ [name]: value }).kind).toBe("disabled");
			}
		}
		for (const value of ["0", "false"]) {
			expect(selfUpdateSource({ [UPDATE_FEED_ENV]: FEED, DISABLE_UPDATES: value })).toEqual({
				kind: "feed",
				url: FEED,
			});
		}
	});

	test("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC disables on any non-empty raw value, as Claude Code does", () => {
		for (const value of ["1", "0", "false", "no", "off", " ", "anything"]) {
			expect(autoUpdateState({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value })).toEqual({
				kind: "disabled",
				envVar: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
			});
		}
		expect(autoUpdateState({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" })).toEqual({ kind: "enabled" });
	});

	test("names the first variable set, in Claude Code's order", () => {
		expect(
			autoUpdateState({
				DISABLE_UPDATES: "1",
				DISABLE_AUTOUPDATER: "1",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			}),
		).toEqual({ kind: "disabled", envVar: "DISABLE_UPDATES" });
		expect(autoUpdateState({ DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toEqual({
			kind: "disabled",
			envVar: "DISABLE_AUTOUPDATER",
		});
		expect(autoUpdateState({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toEqual({
			kind: "disabled",
			envVar: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
		});
	});
});

describe("feed selection", () => {
	test("the startup check has no feed unless one is configured", () => {
		expect(startupCheckFeed({})).toBeUndefined();
		expect(startupCheckFeed({ [UPDATE_FEED_ENV]: "  " })).toBeUndefined();
		expect(startupCheckFeed({ [UPDATE_FEED_ENV]: FEED })).toBe(FEED);
	});

	test("the startup check stays off under any disabling variable", () => {
		expect(startupCheckFeed({ [UPDATE_FEED_ENV]: FEED, DISABLE_AUTOUPDATER: "1" })).toBeUndefined();
	});

	test("manual update ignores DISABLE_AUTOUPDATER but obeys DISABLE_UPDATES", () => {
		expect(selfUpdateSource({ [UPDATE_FEED_ENV]: FEED, DISABLE_AUTOUPDATER: "1" })).toEqual({
			kind: "feed",
			url: FEED,
		});
		expect(selfUpdateSource({ [UPDATE_FEED_ENV]: FEED, DISABLE_UPDATES: "1" })).toEqual({ kind: "admin-disabled" });
	});

	test("manual update reports no feed when none is configured", () => {
		expect(selfUpdateSource({})).toEqual({ kind: "no-feed" });
	});
});

describe("updateTargetRefusal", () => {
	const none = { minimumVersion: undefined, requiredMaximumVersion: undefined };

	test("allows anything with no bound", () => {
		expect(updateTargetRefusal("9.9.9", none)).toBeUndefined();
	});

	test("refuses a target below minimumVersion, boundary allowed", () => {
		const band = { ...none, minimumVersion: "1.5.0" };
		expect(updateTargetRefusal("1.4.9", band)).toBe("below your minimumVersion setting (1.5.0)");
		expect(updateTargetRefusal("1.5.0", band)).toBeUndefined();
	});

	test("refuses a target above the organization's maximum, boundary allowed", () => {
		const band = { ...none, requiredMaximumVersion: "2.0.0" };
		expect(updateTargetRefusal("2.0.1", band)).toBe("above your organization's requiredMaximumVersion (2.0.0)");
		expect(updateTargetRefusal("2.0.0", band)).toBeUndefined();
	});

	test("constrains nothing when the target or a bound is not a version", () => {
		expect(updateTargetRefusal("latest", { ...none, minimumVersion: "1.0.0" })).toBeUndefined();
		expect(updateTargetRefusal("1.0.0", { minimumVersion: "soon", requiredMaximumVersion: "x" })).toBeUndefined();
	});
});

describe("readUpdateVersionBand", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	test("reads minimumVersion from the user tier and ignores a project file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cc-update-band-"));
		roots.push(root);
		const config = join(root, "config");
		const workspace = join(root, "workspace");
		mkdirSync(config, { recursive: true });
		mkdirSync(join(workspace, ".claude"), { recursive: true });
		writeFileSync(join(config, "settings.json"), '{"minimumVersion":"1.5.0"}');
		writeFileSync(join(workspace, ".claude", "settings.json"), '{"minimumVersion":"9.0.0"}');

		const band = readUpdateVersionBand(workspace, { CLAUDE_CONFIG_DIR: config }, "1.4.0");

		expect(band.minimumVersion).toBe("1.5.0");
		expect(band.requiredMaximumVersion).toBeUndefined();
	});
});
