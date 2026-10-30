import assert from "node:assert";
import { describe, it } from "node:test";
import { parseVimInsertRemaps, REMAP_WINDOW_MS, stepRemap } from "../src/vim/remaps.ts";

describe("parseVimInsertRemaps", () => {
	it("keeps a valid two-character remap to <Esc>", () => {
		assert.deepStrictEqual([...parseVimInsertRemaps({ jj: "<Esc>" })], [["jj", "<Esc>"]]);
	});

	it("accepts the value in any case and returns the canonical form", () => {
		assert.deepStrictEqual(
			[...parseVimInsertRemaps({ jk: "<ESC>", kj: "<esc>" })],
			[
				["jk", "<Esc>"],
				["kj", "<Esc>"],
			],
		);
	});

	it("drops keys that are not exactly two characters", () => {
		assert.strictEqual(parseVimInsertRemaps({ jjj: "<Esc>", j: "<Esc>", "": "<Esc>" }).size, 0);
	});

	it("drops keys with control or separator characters", () => {
		assert.strictEqual(parseVimInsertRemaps({ "j\n": "<Esc>", "j ": "<Esc>", "\u00a0j": "<Esc>" }).size, 0);
	});

	it("drops keys that are not two terminal columns wide", () => {
		assert.strictEqual(parseVimInsertRemaps({ 你好: "<Esc>", 你: "<Esc>" }).size, 0);
	});

	it("normalizes keys to NFC", () => {
		const remaps = parseVimInsertRemaps({ "e\u0301j": "<Esc>" });
		assert.deepStrictEqual([...remaps.keys()], ["\u00e9j"]);
	});

	it("drops values other than the string <esc>", () => {
		assert.strictEqual(parseVimInsertRemaps({ jj: "<Enter>", jk: 1, kk: null, kj: ["<Esc>"] }).size, 0);
	});

	it("returns an empty map for input that is not an object", () => {
		for (const raw of [undefined, null, "jj", 3, ["jj"], [["jj", "<Esc>"]]]) {
			assert.strictEqual(parseVimInsertRemaps(raw).size, 0);
		}
	});
});

describe("stepRemap", () => {
	const remaps = parseVimInsertRemaps({ jj: "<Esc>" });

	it("records the first character of a remap", () => {
		const step = stepRemap(remaps, undefined, "j", { text: "", offset: 0 }, 100);
		assert.deepStrictEqual(step, { pending: { char: "j", at: 100, offsetAfter: 1 } });
	});

	it("ignores characters that start no remap", () => {
		assert.deepStrictEqual(stepRemap(remaps, undefined, "x", { text: "", offset: 0 }, 0), {});
	});

	it("fires on the second character inside the window", () => {
		const pending = { char: "j", at: 100, offsetAfter: 1 };
		const step = stepRemap(remaps, pending, "j", { text: "j", offset: 1 }, 100 + REMAP_WINDOW_MS);
		assert.deepStrictEqual(step, { fire: "pair" });
	});

	it("does not fire outside the window, and records the new first character instead", () => {
		const pending = { char: "j", at: 100, offsetAfter: 1 };
		const step = stepRemap(remaps, pending, "j", { text: "j", offset: 1 }, 101 + REMAP_WINDOW_MS);
		assert.strictEqual(step.fire, undefined);
		assert.strictEqual(step.pending?.at, 101 + REMAP_WINDOW_MS);
	});

	it("does not fire when the cursor moved or the first character is gone", () => {
		const pending = { char: "j", at: 100, offsetAfter: 1 };
		assert.strictEqual(stepRemap(remaps, pending, "j", { text: "j", offset: 0 }, 150).fire, undefined);
		assert.strictEqual(stepRemap(remaps, pending, "j", { text: "x", offset: 1 }, 150).fire, undefined);
	});

	it("fires when one read carries both characters", () => {
		assert.deepStrictEqual(stepRemap(remaps, undefined, "jj", { text: "", offset: 0 }, 0), { fire: "chunk" });
		assert.deepStrictEqual(stepRemap(remaps, undefined, "jk", { text: "", offset: 0 }, 0), {});
	});

	it("does nothing without remaps", () => {
		assert.deepStrictEqual(stepRemap(parseVimInsertRemaps({}), undefined, "j", { text: "", offset: 0 }, 0), {});
	});
});
