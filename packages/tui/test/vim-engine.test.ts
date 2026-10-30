import assert from "node:assert";
import { describe, it } from "node:test";
import { type Buffer, INSERT_STATE, NORMAL_STATE, type VimInput, type VimState, vimKey } from "../src/vim/engine.ts";

interface Run {
	readonly text: string;
	readonly mode: string;
	readonly undos: number;
	readonly history: string[];
}

const tokens = (keys: string): string[] => keys.match(/<Esc>|<BS>|[\s\S]/gu) ?? [];

// A stand-in for the editor: it feeds keys to the engine and types printable pass-through keys itself.
// "|" in `marked` is the cursor.
function run(marked: string, keys: string, start: VimState = NORMAL_STATE, columns?: number): Run {
	let text = marked.replace("|", "");
	let offset = Math.max(0, marked.indexOf("|"));
	let state = start;
	let undos = 0;
	const history: string[] = [];
	for (const token of tokens(keys)) {
		const input: VimInput =
			token === "<Esc>" ? { kind: "escape" } : { kind: "key", key: token === "<BS>" ? "\b" : token };
		const buffer: Buffer = { text, offset, columns };
		const result = vimKey(state, input, buffer);
		state = result.state;
		if (result.undo) undos += 1;
		if (result.history) history.push(result.history);
		if (result.buffer) ({ text, offset } = result.buffer);
		else if (result.passThrough && input.kind === "key") {
			text = text.slice(0, offset) + input.key + text.slice(offset);
			offset += input.key.length;
		}
	}
	return { text: `${text.slice(0, offset)}|${text.slice(offset)}`, mode: state.mode, undos, history };
}

const normal = (from: string, keys: string) => run(from, keys);
const wrapped = (from: string, keys: string) => run(from, keys, NORMAL_STATE, 10);

function table(name: string, rows: ReadonlyArray<readonly [string, string, string]>, mode = "normal") {
	describe(name, () => {
		for (const [from, keys, to] of rows) {
			it(`${JSON.stringify(from)} ${keys} -> ${JSON.stringify(to)}`, () => {
				const result = normal(from, keys);
				assert.strictEqual(result.text, to);
				assert.strictEqual(result.mode, mode);
			});
		}
	});
}

table("vim motions", [
	["|foo bar", "e", "fo|o bar"],
	["fo|o bar", "e", "foo ba|r"],
	["|a b c d", "3w", "a b c |d"],
	["foo ba|r", "b", "foo |bar"],
	["|a.b c", "w", "a|.b c"],
	["|a.b c", "W", "a.b |c"],
	["|a.b c", "E", "a.|b c"],
	["x a.|b", "B", "x |a.b"],
	["  ab|c", "0", "|  abc"],
	["  ab|c", "^", "  |abc"],
	["|abc\nd", "$", "ab|c\nd"],
	["|abc\nd", "3$", "ab|c\nd"],
	["a|bc\ndef", "j", "abc\nd|ef"],
	["a\nde|f", "k", "|a\ndef"],
	["|a\nb\nc", "2j", "a\nb\n|c"],
	["abcd|e\nxy\nabcdef", "jj", "abcde\nxy\nabcd|ef"],
	["abcd|e\nxy\nabcdef", "jjk", "abcde\nx|y\nabcdef"],
	["abcd|e\nxy\nabcdef", "jjkk", "abcd|e\nxy\nabcdef"],
	["|a\n b\nc", "G", "a\n b\n|c"],
	["a\n b\n|c", "gg", "|a\n b\nc"],
	["|a\nb\nc", "2G", "a\n|b\nc"],
	["|a\nb\nc", "3gg", "a\nb\n|c"],
	["a\n|b", "h", "a\n|b"],
	["a|b\nc", "ll", "a|b\nc"],
	["a|b\nc", " ", "ab\n|c"],
	["a\n|bc", "<BS>", "|a\nbc"],
	["|ab", "3 ", "a|b"],
	["|a,b,c", "f,", "a|,b,c"],
	["|a,b,c", "2f,", "a,b|,c"],
	["|a,b,c", "t,", "|a,b,c"],
	["|ab,c", "t,", "a|b,c"],
	["a,b,|c", "F,", "a,b|,c"],
	["a,b,|c", "Tb", "a,b|,c"],
	["|a,b,c", "f,;", "a,b|,c"],
	["|a,b,c", "f,;,", "a|,b,c"],
	["|a,b,c", "2;", "|a,b,c"],
	["|a(b[c]d)e", "%", "a(b[c]d|)e"],
	["a(b[c]d|)e", "%", "a|(b[c]d)e"],
	["|a(b)", "%", "a(b|)"],
	["|ab", "2%", "|ab"],
	["|a b", "10l", "a |b"],
]);

table("vim operators", [
	["a|bc", "x", "a|c"],
	["a|bc", "3x", "|a"],
	["|abc", "2x", "|c"],
	["a\n|b\nc", "dd", "a\n|c"],
	["a\n|b", "dd", "|a"],
	["|a\nb\nc", "2dd", "|c"],
	["|a\nb\nc", "d2d", "|c"],
	["|a", "dd", "|"],
	["a|bc\nd", "D", "|a\nd"],
	["a|bc\nd", "d$", "|a\nd"],
	["|one two", "dw", "|two"],
	["|one two three", "d2w", "|three"],
	["|one two three", "2dw", "|three"],
	["|one\ntwo", "dw", "|two"],
	["|one two", "de", "| two"],
	["one |two", "db", "|two"],
	["|ab,c", "dt,", "|,c"],
	["|ab,c", "df,", "|c"],
	["|a\nb\nc", "dj", "|c"],
	["a\n|b\nc", "dk", "|c"],
	["a\nb\n|c", "dj", "a\nb\n|c"],
	["|a\nb\nc", "dG", "|"],
	["a\n|b\nc", "dgg", "|c"],
	["|a\nb\nc", "d2G", "|c"],
	["foo b|ar baz", "diw", "foo | baz"],
	["foo b|ar baz", "daw", "foo |baz"],
	["a f|oo.bar b", "diW", "a | b"],
	["a f|oo.bar b", "daW", "a |b"],
	['say "hi |there" ok', 'di"', 'say "|" ok'],
	['say "hi |there" ok', 'da"', "say | ok"],
	["x 'a|b' y", "da'", "x | y"],
	["f(a, |b) x", "di(", "f(|) x"],
	["f(a, |b) x", "dib", "f(|) x"],
	["f(a, |b) x", "da(", "f| x"],
	["[1, |2]", "di[", "[|]"],
	["{a\nb|c}", "di{", "{|}"],
	["{\n  a|\n}", "di{", "{|}"],
	["x {|a} y", "daB", "x | y"],
	["<a |b>", "di<", "<|>"],
	["a |b", "di(", "a |b"],
	["|a\nb", "yyp", "a\n|a\nb"],
	["a\n|b", "yyP", "a\n|b\nb"],
	["|ab cd", "ywP", "ab| ab cd"],
	["|ab cd", "yep", "aa|bb cd"],
	["|a\nb", "ddp", "b\n|a"],
	["|a\nb", "Yp", "a\n|a\nb"],
	["|ab", "yl2p", "aa|ab"],
	["a|b", ">>", "  |ab"],
	["  a|b", "<<", "|ab"],
	["a|b\nc", "2>>", "  |ab\n  c"],
	["a|b\nc", ">w", "a|b\nc"],
	["|a\n   b", "J", "a| b"],
	["|a\n   b\nc", "3J", "a b| c"],
	["|a b c", "dw.", "|c"],
	["|a b c d e", "dw2.", "|d e"],
	["|abcdef", "x.", "|cdef"],
	["a|bc", "rx", "a|xc"],
	["|abc", "2rx", "x|xc"],
	["|abc", "5rx", "|abc"],
	["|aBc", "~", "A|Bc"],
	["|aBc", "3~", "Ab|C"],
	["a|b", "~", "a|B"],
]);

table(
	"vim insert entries",
	[
		["a|b", "iX", "aX|b"],
		["a|b", "aX", "abX|"],
		["  a|b", "IX", "  X|ab"],
		["|ab\nc", "AX", "abX|\nc"],
		["|a\nb", "oX", "a\nX|\nb"],
		["a\n|b", "OX", "a\nX|\nb"],
		["a\n|bc\nd", "ccX", "a\nX|\nd"],
		["a\n|bc\nd", "SX", "a\nX|\nd"],
		["a|bc", "CX", "aX|"],
		["a|bc", "sX", "aX|c"],
		["|abcd", "2sX", "X|cd"],
		["|foo bar", "cwX", "X| bar"],
		["|foo bar", "ceX", "X| bar"],
		["foo |bar", "cbX", "X|bar"],
		["foo b|ar baz", "ciwX", "foo X| baz"],
		['"a|b"', 'ci"X', '"X|"'],
		["|a b", "cwX", "X| b"],
		["|ab  cd", "2cwX", "X|"],
	],
	"insert",
);

describe("vim insert mode", () => {
	it("Escape leaves insert mode and steps left onto the last typed character", () => {
		const result = run("|", "abc<Esc>", INSERT_STATE);
		assert.strictEqual(result.text, "ab|c");
		assert.strictEqual(result.mode, "normal");
	});

	it("Escape at the start of a line stays put", () => {
		assert.strictEqual(run("|", "<Esc>", INSERT_STATE).text, "|");
	});

	it(". repeats a change with the text typed in insert mode", () => {
		assert.strictEqual(run("|foo bar", "ciwX<Esc>w.").text, "X |X");
	});

	it(". repeats an append with its typed text", () => {
		assert.strictEqual(run("|a\nb", "Ax<Esc>j.").text.replace("|", ""), "ax\nbx");
	});

	it(". repeats plain typing from the first insert session", () => {
		assert.strictEqual(run("|", "ab<Esc>.", INSERT_STATE).text.replace("|", ""), "aabb");
	});

	describe("dot repeat after an empty insert", () => {
		it("i<Esc> leaves . doing nothing", () => {
			const result = run("|ab", "i<Esc>.");
			assert.strictEqual(result.text, "|ab");
			assert.strictEqual(result.mode, "normal");
		});

		it("o<Esc> leaves . opening another empty line below, in insert mode", () => {
			const result = run("|ab", "o<Esc>.");
			assert.strictEqual(result.text, "ab\n\n|");
			assert.strictEqual(result.mode, "insert");
		});

		it("O<Esc> leaves . opening another empty line above, in insert mode", () => {
			const result = run("|ab", "O<Esc>.");
			assert.strictEqual(result.text, "|\n\nab");
			assert.strictEqual(result.mode, "insert");
		});

		it("s<Esc> leaves . substituting again, in insert mode", () => {
			const result = run("|ab", "s<Esc>.");
			assert.strictEqual(result.text, "|");
			assert.strictEqual(result.mode, "insert");
		});

		it("cw<Esc> leaves . changing again, in insert mode", () => {
			const result = run("|foo bar", "cw<Esc>.");
			assert.strictEqual(result.text, "|bar");
			assert.strictEqual(result.mode, "insert");
		});

		it("o with typed text repeats the open line plus the text, in insert mode", () => {
			const result = run("|ab", "oX<Esc>.");
			assert.strictEqual(result.text, "ab\nX\n|X");
			assert.strictEqual(result.mode, "insert");
		});

		it("x then i<Esc> leaves . doing nothing", () => {
			const result = run("|ab", "xi<Esc>.");
			assert.strictEqual(result.text, "|b");
			assert.strictEqual(result.mode, "normal");
		});

		it("a replay that opens insert keeps insert mode after more typing and Escape records only the new typing", () => {
			const result = run("|ab", "o<Esc>.Z<Esc>");
			assert.strictEqual(result.text, "ab\n\n|Z");
			assert.strictEqual(result.mode, "normal");
		});
	});

	it("u asks the editor to undo once, ignoring a count", () => {
		assert.strictEqual(run("|a", "u3u").undos, 2);
	});

	it("an unknown key cancels a pending operator without editing", () => {
		assert.strictEqual(run("|ab", "dzx").text, "|b");
	});

	it("an operator followed by a different operator cancels", () => {
		assert.strictEqual(run("|ab", "dcx").text, "|b");
	});

	it("counts stop at 10000", () => {
		assert.strictEqual(run("|a", "99999l").text, "|a");
	});

	it("0 starts a motion only when no count began", () => {
		assert.strictEqual(run("  a|b", "0").text, "|  ab");
		assert.strictEqual(run("|abcdefghijkl", "10l").text, "abcdefghij|kl");
	});

	it("k on the first line and j on the last line ask for history", () => {
		assert.deepStrictEqual(run("|a", "k").history, ["up"]);
		assert.deepStrictEqual(run("|a", "j").history, ["down"]);
		assert.deepStrictEqual(run("|a\nb", "j").history, []);
		assert.deepStrictEqual(run("|a", "2k").history, []);
	});

	it("Escape in normal mode clears a pending command and otherwise passes through", () => {
		const pending = vimKey(NORMAL_STATE, { kind: "key", key: "d" }, { text: "a", offset: 0 });
		assert.strictEqual(pending.state.pending, "d");
		const cleared = vimKey(pending.state, { kind: "escape" }, { text: "a", offset: 0 });
		assert.strictEqual(cleared.passThrough, false);
		assert.strictEqual(cleared.state.pending, "");
		assert.strictEqual(vimKey(cleared.state, { kind: "escape" }, { text: "a", offset: 0 }).passThrough, true);
	});

	it("other keys pass through in both modes and clear a pending command", () => {
		const pending = vimKey(NORMAL_STATE, { kind: "key", key: "d" }, { text: "a", offset: 0 });
		const other = vimKey(pending.state, { kind: "other" }, { text: "a", offset: 0 });
		assert.strictEqual(other.passThrough, true);
		assert.strictEqual(other.state.pending, "");
		assert.strictEqual(vimKey(INSERT_STATE, { kind: "other" }, { text: "a", offset: 0 }).passThrough, true);
	});
});

describe("vim registers and put", () => {
	it("a character register puts after the cursor with p", () => {
		assert.strictEqual(run("|abc", "xp").text, "b|ac");
	});

	it("a line register puts below and the cursor lands on the first non-blank", () => {
		assert.strictEqual(run("  |a\nb", "yyp").text, "  a\n  |a\nb");
	});

	it("an empty register does nothing", () => {
		assert.strictEqual(run("|ab", "p").text, "|ab");
	});

	it("yank empty range clears the register", () => {
		assert.strictEqual(run("|ab", "xy0p").text, "|b");
	});
});

describe("vim edge semantics", () => {
	it("dw on the last word of a line joins the next line, as Claude Code does", () => {
		assert.strictEqual(run("a |b\nc", "dw").text, "a |c");
	});

	it("cw on a one-character word changes only that character", () => {
		assert.strictEqual(run("|a b", "cwX<Esc>").text.replace("|", ""), "X b");
	});

	it("; after t stays put like Claude Code's find", () => {
		assert.strictEqual(run("|xa,b,c", "t,;").text, "x|a,b,c");
	});

	it("dd on a middle line lands on the next line's first non-blank", () => {
		assert.strictEqual(run("a\n|b\n  c", "dd").text, "a\n  |c");
	});

	it("dd with a count past the last line is a no-op on the last line", () => {
		assert.strictEqual(run("a\n|b", "2dd").text, "a\n|b");
	});

	it("o on the last line opens a line below", () => {
		assert.strictEqual(run("a|b", "ox<Esc>").text, "ab\n|x");
	});

	it("X and R are not normal-mode commands", () => {
		assert.strictEqual(run("a|b", "X").text, "a|b");
		assert.strictEqual(run("a|b", "R").text, "a|b");
	});
});

describe("vim over paste markers", () => {
	const M = "[paste #1 +12 lines]";
	table("markers", [
		[`|a${M}b`, "ll", `a${M}|b`],
		[`a${M}|b`, "h", `a|${M}b`],
		[`a|${M}b`, "x", "a|b"],
		[`|a${M}`, "$", `a|${M}`],
		[`|a ${M} b`, "w", `a |${M} b`],
		[`|a ${M} b`, "2w", `a ${M} |b`],
		[`a|${M}b`, "dl", "a|b"],
	]);
});

describe("vim unicode", () => {
	it("moves over a combined emoji as one character", () => {
		assert.strictEqual(run("|👩‍👩‍👧x", "l").text, "👩‍👩‍👧|x");
	});

	it("x deletes a whole grapheme", () => {
		assert.strictEqual(run("|e\u0301b", "x").text, "|b");
	});
});

function wrappedTable(name: string, rows: ReadonlyArray<readonly [string, string, string]>) {
	describe(name, () => {
		for (const [from, keys, to] of rows) {
			it(`${JSON.stringify(from)} ${keys} -> ${JSON.stringify(to)}`, () => {
				const result = wrapped(from, keys);
				assert.strictEqual(result.text, to);
				assert.strictEqual(result.mode, "normal");
			});
		}
	});
}

// Rows at 10 columns: "aaaa bbbb " | "cccc dddd " | "eeee ffff". Claude Code: gj and gk are display-row moves.
wrappedTable("vim gj and gk over wrapped rows", [
	["aa|aa bbbb cccc dddd", "gj", "aaaa bbbb cc|cc dddd"],
	["aaaa bbbb cc|cc dddd", "gk", "aa|aa bbbb cccc dddd"],
	["a|aaa bbbb cccc dddd eeee ffff", "2gj", "aaaa bbbb cccc dddd e|eee ffff"],
	["aaaa bbbb cccc dddd e|eee ffff", "2gk", "a|aaa bbbb cccc dddd eeee ffff"],
	["aaaa bbbb cccc dddd e|eee ffff", "gk", "aaaa bbbb c|ccc dddd eeee ffff"],
	["a|aaa bbbb cccc dddd eeee ffff", "gjgj", "aaaa bbbb cccc dddd e|eee ffff"],
	// Past the last row the cursor still goes as far as it can.
	["aa|aa bbbb cccc dddd", "3gj", "aaaa bbbb cc|cc dddd"],
	["aaaa bbbb cc|cc dddd", "gj", "aaaa bbbb cc|cc dddd"],
	["aa|aa bbbb cccc dddd", "gk", "aa|aa bbbb cccc dddd"],
	// A row shorter than the column clamps it, and the column is not remembered across wrapped rows.
	["aaaa bbb|b cc", "gj", "aaaa bbbb c|c"],
	["aaaa bbbb c|c", "gk", "a|aaa bbbb cc"],
	// Between unwrapped lines the display column is remembered, like j and k.
	["abcdef|gh\nab\nabcdefgh", "gjgj", "abcdefgh\nab\nabcdef|gh"],
	["abcdefgh\nab\nabcdef|gh", "gkgk", "abcdef|gh\nab\nabcdefgh"],
	// Not j: a wrapped line's second row is one gj away.
	["aa|aa bbbb cccc dddd\nxyz", "gj", "aaaa bbbb cc|cc dddd\nxyz"],
]);

wrappedTable("vim gj and gk with an operator", [
	["aa|aa bbbb cccc dddd", "dgj", "aa|cc dddd"],
	["aaaa bbbb cc|cc dddd", "dgk", "aa|cc dddd"],
	["aa|aa bbbb cccc dddd", "cgjX<Esc>", "aa|Xcc dddd"],
	["aa|aa bbbb cccc dddd", "ygj", "aa|aa bbbb cccc dddd"],
	["a|aaa bbbb cccc dddd eeee ffff", "d2gj", "a|eee ffff"],
	// When the rows run out only the cursor moves: no edit.
	["aaaa bbbb cc|cc dddd", "dgj", "aaaa bbbb cc|cc dddd"],
	["aa|aa bbbb cccc dddd", "dgk", "aa|aa bbbb cccc dddd"],
	["aa|aa bbbb cccc dddd", "d3gj", "aaaa bbbb cc|cc dddd"],
	["aaaa bbbb cc|cc dddd", "d3gk", "aa|aa bbbb cccc dddd"],
]);

describe("vim gj and gk without a wrap width", () => {
	it("move like j and k", () => {
		assert.strictEqual(normal("ab|c\ndef", "gj").text, "abc\nde|f");
		assert.strictEqual(normal("abc\nde|f", "gk").text, "ab|c\ndef");
		assert.strictEqual(normal("ab|c\ndef\nghi", "dgj").text, "|ghi");
	});
});
