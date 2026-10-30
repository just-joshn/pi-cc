import { describe, expect, test } from "vitest";
import { formatCcClock, resolveCcClock } from "../src/core/settings/cc/clock.ts";
import { parseCcSettingsText } from "../src/core/settings/cc/keys.ts";
import { mergeCcSettings } from "../src/core/settings/cc/merge.ts";
import { EMPTY_CC_POLICY } from "../src/core/settings/cc/policy.ts";
import { NO_CC_TUI, resolveCcTuiSettings } from "../src/core/settings/cc/tui.ts";
import type { CcSettings, CcSettingsDocument, CcSettingsSource } from "../src/core/settings/cc/types.ts";

function document(source: CcSettingsSource, values: Record<string, unknown>): CcSettingsDocument {
	return { source, path: `/settings/${source}.json`, values };
}

function settingsFrom(...documents: CcSettingsDocument[]): CcSettings {
	return mergeCcSettings(documents, EMPTY_CC_POLICY);
}

function problems(json: string): string[] {
	const parsed = parseCcSettingsText(json, "user");
	return parsed.kind === "shape" ? parsed.problems.map((p) => `${p.key}: ${p.detail}`) : [];
}

describe("validation of the terminal keys", () => {
	test("rejects the whole file with CC's messages for the strict keys", () => {
		expect(problems('{"prefersReducedMotion":"yes"}')).toEqual([
			"prefersReducedMotion: Expected boolean, but received string",
		]);
		expect(problems('{"axScreenReader":"yes"}')).toEqual(["axScreenReader: Expected boolean, but received string"]);
		expect(problems('{"tui":"x"}')).toEqual(['tui: Invalid value. Expected one of: "default", "fullscreen"']);
		expect(problems('{"timeFormat":5}')).toEqual(["timeFormat: Invalid input"]);
		expect(problems('{"timeZone":7}')).toEqual(["timeZone: Expected string, but received number"]);
	});

	test("accepts every admitted spelling", () => {
		for (const json of [
			'{"tui":"default"}',
			'{"tui":"fullscreen"}',
			'{"timeFormat":"24-hour-utc"}',
			'{"timeFormat":"whatever"}',
			'{"timeZone":"Nowhere/Land"}',
			'{"prefersReducedMotion":false,"axScreenReader":true}',
		]) {
			expect(parseCcSettingsText(json, "user").kind).toBe("document");
		}
	});

	test("drops invalid lenient keys without a report and keeps the rest", () => {
		const parsed = parseCcSettingsText(
			'{"maxProseWidth":39,"editorMode":"emacs","vimInsertModeRemaps":[1],"model":"m"}',
			"user",
		);
		expect(parsed).toEqual({ kind: "document", values: { model: "m" }, skipped: [] });
	});

	test("keeps lenient keys that pass", () => {
		const parsed = parseCcSettingsText(
			'{"maxProseWidth":40,"editorMode":"vim","vimInsertModeRemaps":{"jj":"<Esc>"}}',
			"user",
		);
		expect(parsed.kind === "document" && parsed.values).toEqual({
			maxProseWidth: 40,
			editorMode: "vim",
			vimInsertModeRemaps: { jj: "<Esc>" },
		});
		for (const width of ['"50"', "40.5", "null"]) {
			const dropped = parseCcSettingsText(`{"maxProseWidth":${width}}`, "user");
			expect(dropped.kind === "document" && dropped.values).toEqual({});
		}
	});
});

describe("operator-tier keys", () => {
	test("take the first of policy, flag, user that defines them and never project or local", () => {
		const settings = settingsFrom(
			document("user", { axScreenReader: false, vimInsertModeRemaps: { jj: "<Esc>" } }),
			document("project", { axScreenReader: true, vimInsertModeRemaps: { kk: "<Esc>" } }),
			document("local", { axScreenReader: true }),
			document("flag", { axScreenReader: true }),
		);
		expect(settings.operatorTier).toEqual({ axScreenReader: true, vimInsertModeRemaps: { jj: "<Esc>" } });
		expect(
			settingsFrom(document("policy", { axScreenReader: false }), document("flag", { axScreenReader: true }))
				.operatorTier,
		).toEqual({ axScreenReader: false });
	});

	test("a project-only value is absent", () => {
		const settings = settingsFrom(
			document("project", { axScreenReader: true }),
			document("local", { axScreenReader: true }),
		);
		expect(settings.operatorTier).toEqual({});
	});
});

describe("resolveCcTuiSettings", () => {
	const inputs = { axScreenReaderFlag: false, env: {} };

	test("no settings resolves to the pi defaults", () => {
		expect(resolveCcTuiSettings(settingsFrom(), inputs)).toEqual(NO_CC_TUI);
	});

	test("maps tui onto pi's two screen modes", () => {
		expect(resolveCcTuiSettings(settingsFrom(document("user", { tui: "fullscreen" })), inputs).tuiMode).toBe(
			"fullscreen",
		);
		expect(resolveCcTuiSettings(settingsFrom(document("user", { tui: "default" })), inputs).tuiMode).toBe("regular");
	});

	test("reads reduced motion and prose width from any tier", () => {
		const resolved = resolveCcTuiSettings(
			settingsFrom(document("project", { prefersReducedMotion: true, maxProseWidth: 60 })),
			inputs,
		);
		expect(resolved.reducedMotion).toBe(true);
		expect(resolved.maxProseWidth).toBe(60);
	});

	test("screen reader precedence is flag, then environment, then the operator tiers", () => {
		const on = settingsFrom(document("user", { axScreenReader: true }));
		const off = settingsFrom(document("user", { axScreenReader: false }));
		expect(resolveCcTuiSettings(on, inputs).screenReader).toBe(true);
		expect(resolveCcTuiSettings(off, { axScreenReaderFlag: true, env: {} }).screenReader).toBe(true);
		// The environment value is used raw: any non-empty string enables, even "false" or "0",
		// and an empty one disables without consulting the setting (chunk-mn8jmdnf.js:108-113).
		expect(
			resolveCcTuiSettings(on, { axScreenReaderFlag: false, env: { CLAUDE_AX_SCREEN_READER: "false" } })
				.screenReader,
		).toBe(true);
		expect(
			resolveCcTuiSettings(off, { axScreenReaderFlag: false, env: { CLAUDE_AX_SCREEN_READER: "0" } })
				.screenReader,
		).toBe(true);
		expect(
			resolveCcTuiSettings(on, { axScreenReaderFlag: false, env: { CLAUDE_AX_SCREEN_READER: "" } })
				.screenReader,
		).toBe(false);
		expect(
			resolveCcTuiSettings(off, { axScreenReaderFlag: false, env: { CLAUDE_AX_SCREEN_READER: "true" } })
				.screenReader,
		).toBe(true);
	});

	test("a project tier cannot turn screen reader mode on", () => {
		const resolved = resolveCcTuiSettings(settingsFrom(document("project", { axScreenReader: true })), inputs);
		expect(resolved.screenReader).toBe(false);
	});

	test("vim is on only for editorMode vim, with the remaps from the operator tiers", () => {
		expect(
			resolveCcTuiSettings(settingsFrom(document("user", { editorMode: "normal" })), inputs).vim,
		).toBeUndefined();
		const vim = resolveCcTuiSettings(
			settingsFrom(
				document("user", { editorMode: "vim", vimInsertModeRemaps: { jj: "<Esc>", abc: "<Esc>" } }),
				document("project", { vimInsertModeRemaps: { kk: "<Esc>" } }),
			),
			inputs,
		).vim;
		expect([...(vim?.insertRemaps.keys() ?? [])]).toEqual(["jj"]);
	});
});

describe("clock", () => {
	const instant = new Date("2026-10-30T18:05:09Z");

	test("auto, and a value with no percent sign, leave the host rendering", () => {
		expect(formatCcClock(resolveCcClock("auto", undefined), instant)).toBeUndefined();
		expect(formatCcClock(resolveCcClock("nonsense", undefined), instant)).toBeUndefined();
		expect(formatCcClock(resolveCcClock(undefined, undefined), instant)).toBeUndefined();
	});

	test("the presets honor the zone", () => {
		expect(formatCcClock(resolveCcClock("24-hour", "UTC"), instant)).toBe("18:05");
		expect(formatCcClock(resolveCcClock("12-hour", "UTC"), instant)).toBe("06:05\u202fPM");
		expect(formatCcClock(resolveCcClock("24-hour", "Asia/Tokyo"), instant)).toBe("03:05");
	});

	test("24-hour-utc ignores the zone and marks the minute with Z", () => {
		expect(formatCcClock(resolveCcClock("24-hour-utc", "Asia/Tokyo"), instant)).toBe("18:05Z");
	});

	test("an unknown zone falls back to the system zone", () => {
		expect(resolveCcClock("24-hour", "Nowhere/Land").timeZone).toBeUndefined();
	});

	test("strftime patterns", () => {
		const at = (pattern: string, zone = "UTC") => formatCcClock(resolveCcClock(pattern, zone), instant, {});
		expect(at("%H:%M")).toBe("18:05");
		expect(at("%Y-%m-%d %T")).toBe("2026-10-30 18:05:09");
		expect(at("%F %R")).toBe("2026-10-30 18:05");
		expect(at("%I:%M %p")).toBe("06:05 PM");
		expect(at("%-I:%M%P")).toBe("6:05pm");
		expect(at("%a %b %e", "UTC")).toBe("Fri Oct 30");
		expect(at("%H:%M", "Asia/Tokyo")).toBe("03:05");
		expect(at("%z", "Asia/Tokyo")).toBe("+0900");
		expect(at("100%%")).toBe("100%");
		expect(at("%Q")).toBe("%Q");
		expect(at("%s")).toBe(String(instant.getTime() / 1000));
	});

	test("a pattern is capped at 100 characters and stripped of control characters", () => {
		const clock = resolveCcClock(`%H\u0007${"x".repeat(200)}`, "UTC");
		expect(clock.kind === "pattern" && clock.pattern.length).toBe(100);
		expect(clock.kind === "pattern" && clock.pattern.includes("\u0007")).toBe(false);
	});
});
