import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadCases } from "../conformance/case.ts";

function load(extra: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "directives-"));
	try {
		mkdirSync(join(dir, "sdk"));
		writeFileSync(
			join(dir, "sdk", "test.json"),
			JSON.stringify({ id: "sdk/test", area: "sdk", model: null, compare: {}, ...extra }),
		);
		return loadCases(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("conformance pacing directives", () => {
	test.each([-1, 0.5, 2147483648, "5"])("rejects hold_ms %s", (hold_ms) => {
		expect(() => load({ model: { turns: [{ text: "ok", hold_ms }] } })).toThrow(/hold_ms/);
	});
	test.each(["-1", "NaN", "Infinity", "2147483648", "0.5", ""])("rejects sleep %s", (value) => {
		expect(() => load({ stdin: { kind: "stream-json", lines: [`#sleep ${value}`] } })).toThrow(/sleep/);
	});
	test("rejects an invalid waitfor regexp before spawning a side", () => {
		expect(() => load({ stdin: { kind: "stream-json", lines: ["#waitfor ["] } })).toThrow(/waitfor/);
	});
	test("accepts zero and bounded delays and a valid regexp", () => {
		expect(
			load({
				model: { turns: [{ text: "ok", hold_ms: 0 }] },
				stdin: { kind: "stream-json", lines: ["#sleep 0", "#sleep 2147483647", "#waitfor ready"] },
			}),
		).toHaveLength(1);
	});
});
