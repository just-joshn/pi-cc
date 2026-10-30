import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { parseVimInsertRemaps, type VimConfig } from "../src/index.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ESCAPE = "\x1b";
const KEYS: Record<string, string> = { "<Esc>": ESCAPE, "<Left>": "\x1b[D", "<Right>": "\x1b[C" };

function createEditor(config: VimConfig | undefined = { insertRemaps: new Map() }): Editor {
	const tui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editor = new Editor(tui, defaultEditorTheme);
	editor.setVimMode(config);
	return editor;
}

/** Sends one key the way CustomEditor does: vim first, then the editor. */
function key(editor: Editor, data: string): void {
	if (!editor.handleVimInput(data, data === ESCAPE)) editor.handleInput(data);
}

function press(editor: Editor, keys: string): void {
	for (const token of keys.match(/<Esc>|<Left>|<Right>|[\s\S]/gu) ?? []) key(editor, KEYS[token] ?? token);
}

const marked = (editor: Editor) => {
	const text = editor.getText();
	const offset = editor.getCursorOffset();
	return `${text.slice(0, offset)}|${text.slice(offset)}`;
};

const plain = (editor: Editor) => editor.render(40).map((line) => stripTerminalSequences(line).trimEnd());

describe("pending operator and count keys", () => {
	it("Delete with a pending operator cancels it without deleting forward", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>0");
		assert.strictEqual(editor.handleVimInput("d", false), true);
		assert.strictEqual(editor.handleVimInput("\x1b[3~", false), true);
		assert.strictEqual(marked(editor), "|abc");
		assert.strictEqual(editor.getVimMode(), "normal");
		press(editor, "x");
		assert.strictEqual(marked(editor), "|bc");
	});

	it("Delete with a pending count is swallowed and keeps the count", () => {
		const editor = createEditor();
		press(editor, "abcdef<Esc>0");
		assert.strictEqual(editor.handleVimInput("3", false), true);
		assert.strictEqual(editor.handleVimInput("\x1b[3~", false), true);
		assert.strictEqual(marked(editor), "|abcdef");
		press(editor, "x");
		assert.strictEqual(marked(editor), "|def");
	});

	it("Backspace with a pending operator deletes the character to the left", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>$");
		assert.strictEqual(editor.handleVimInput("d", false), true);
		assert.strictEqual(editor.handleVimInput("\x7f", false), true);
		assert.strictEqual(marked(editor), "a|c");
	});

	it("Backspace with a pending count moves left", () => {
		const editor = createEditor();
		press(editor, "abcd<Esc>$");
		assert.strictEqual(editor.handleVimInput("3", false), true);
		assert.strictEqual(editor.handleVimInput("\x7f", false), true);
		assert.strictEqual(marked(editor), "|abcd");
	});

	it("Backspace with a pending find is swallowed and the next key is still the find target", () => {
		const editor = createEditor();
		press(editor, "aibi<Esc>0");
		assert.strictEqual(editor.handleVimInput("f", false), true);
		assert.strictEqual(editor.handleVimInput("\x7f", false), true);
		assert.strictEqual(editor.getText(), "aibi");
		press(editor, "i");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(marked(editor), "a|ibi");
	});

	it("Enter with a pending operator reaches the editor and keeps the command", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>0d");
		assert.strictEqual(editor.handleVimInput("\r", false), false);
		assert.strictEqual(editor.handleVimInput("x", false), true);
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(marked(editor), "|abc");
	});
});

const SPECIAL = {
	delete: "\x1b[3~",
	backspace: "\x7f",
	tab: "\t",
	enter: "\r",
	home: "\x1b[H",
	end: "\x1b[F",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	insert: "\x1b[2~",
	f1: "\x1bOP",
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	shiftLeft: "\x1b[1;2D",
	shiftRight: "\x1b[1;2C",
	ctrlA: "\x01",
	ctrlW: "\x17",
	ctrlC: "\x03",
};

interface SpecialRow {
	readonly name: string;
	readonly text: string;
	/** Keys typed after Escape: positioning and the pending command. */
	readonly pending: string;
	readonly key: keyof typeof SPECIAL;
	/** Typed after the special key; shows whether the pending command survived. */
	readonly probe: string;
	/** `text|` with the cursor marked, after the probe. */
	readonly after: string;
	readonly mode?: string;
}

// Each row is derived from Claude Code's key router (chunk-hz2c9q6k.js:1496-1662). In normal mode Backspace maps to `\b`
// only from idle, count, operator and operator-count, Delete maps to `x` only from idle, operator and operator-count,
// arrows (shift included) become h/l/k/j into any pending command, Ctrl/Alt chords go to the editor with the pending
// command kept, and the other named keys (Tab, Home, End, PageUp, Insert, F-keys) are dropped with it kept.
const NORMAL_ROWS: readonly SpecialRow[] = [
	{ name: "Delete idle deletes forward", text: "abcdef", pending: "0", key: "delete", probe: "", after: "|bcdef" },
	{ name: "Delete after d cancels", text: "abcdef", pending: "0d", key: "delete", probe: "x", after: "|bcdef" },
	{ name: "Delete after d2 cancels", text: "abcdef", pending: "0d2", key: "delete", probe: "x", after: "|bcdef" },
	{ name: "Delete after a count keeps the count", text: "abcdef", pending: "03", key: "delete", probe: "x", after: "|def" },
	{ name: "Delete after f is swallowed", text: "abcdef", pending: "0f", key: "delete", probe: "c", after: "ab|cdef" },
	{ name: "Delete after r is swallowed", text: "abcdef", pending: "0r", key: "delete", probe: "Z", after: "|Zbcdef" },
	{ name: "Delete after g is swallowed", text: "abc\ndef", pending: "<Esc>G0g", key: "delete", probe: "g", after: "|abc\ndef" },
	{ name: "Backspace idle moves left", text: "abcdef", pending: "$", key: "backspace", probe: "x", after: "abcd|f" },
	{ name: "Backspace after a count moves left", text: "abcdef", pending: "$3", key: "backspace", probe: "x", after: "ab|def" },
	{ name: "Backspace after d deletes left", text: "abcdef", pending: "$d", key: "backspace", probe: "", after: "abcd|f" },
	{ name: "Backspace after d2 deletes two left", text: "abcdef", pending: "$d2", key: "backspace", probe: "", after: "abc|f" },
	{ name: "Backspace after f is swallowed", text: "abcdef", pending: "0lf", key: "backspace", probe: "e", after: "abcd|ef" },
	{ name: "Backspace after r is swallowed", text: "abcdef", pending: "0lr", key: "backspace", probe: "Z", after: "a|Zcdef" },
	{ name: "Tab idle is dropped", text: "abcdef", pending: "0", key: "tab", probe: "x", after: "|bcdef" },
	{ name: "Tab keeps a pending d", text: "abcdef", pending: "$d", key: "tab", probe: "h", after: "abcd|f" },
	{ name: "Home idle is dropped", text: "abcdef", pending: "", key: "home", probe: "x", after: "abcd|e" },
	{ name: "Home keeps a pending d", text: "abcdef", pending: "$d", key: "home", probe: "h", after: "abcd|f" },
	{ name: "End idle is dropped", text: "abcdef", pending: "0", key: "end", probe: "x", after: "|bcdef" },
	{ name: "PageUp keeps a count", text: "abcdef", pending: "03", key: "pageUp", probe: "x", after: "|def" },
	{ name: "PageDown idle is dropped", text: "abcdef", pending: "0", key: "pageDown", probe: "x", after: "|bcdef" },
	{ name: "Insert keeps a pending d", text: "abcdef", pending: "$d", key: "insert", probe: "h", after: "abcd|f" },
	{ name: "F1 keeps a count", text: "abcdef", pending: "03", key: "f1", probe: "x", after: "|def" },
	{ name: "Left after f is the find target", text: "abchef", pending: "0f", key: "left", probe: "x", after: "abc|ef" },
	{ name: "Right after r is the replacement", text: "abcdef", pending: "0r", key: "right", probe: "", after: "|lbcdef" },
	{ name: "Shift+Left idle moves left", text: "abcdef", pending: "", key: "shiftLeft", probe: "x", after: "abcd|f" },
	{ name: "Shift+Right idle moves right", text: "abcdef", pending: "0", key: "shiftRight", probe: "x", after: "a|cdef" },
	{ name: "Ctrl+W keeps a pending d", text: "abc def", pending: "$d", key: "ctrlW", probe: "h", after: "abc|f" },
	{ name: "Ctrl+A keeps a count", text: "abcdef", pending: "$3", key: "ctrlA", probe: "x", after: "|def" },
];

const VISUAL_ROWS: readonly SpecialRow[] = [
	{ name: "Tab keeps a count", text: "abcdef", pending: "0v3", key: "tab", probe: "ld", after: "|ef", mode: "normal" },
	{ name: "Home is dropped", text: "abcdef", pending: "0vl", key: "home", probe: "d", after: "|cdef", mode: "normal" },
	{ name: "Left after a count moves that far", text: "abcdef", pending: "$v2", key: "left", probe: "d", after: "ab|c", mode: "normal" },
	{ name: "Left after f cancels the find", text: "abcdef", pending: "0vf", key: "left", probe: "d", after: "|bcdef", mode: "normal" },
	{ name: "Backspace after r cancels the replace", text: "abcdef", pending: "0vr", key: "backspace", probe: "d", after: "|bcdef", mode: "normal" },
	{ name: "Delete after a count cancels it", text: "abcdef", pending: "0v2", key: "delete", probe: "d", after: "|bcdef", mode: "normal" },
	{ name: "Enter after a count moves down", text: "ab\ncd\nef", pending: "<Esc>ggv1", key: "enter", probe: "d", after: "|d\nef", mode: "normal" },
	{ name: "Enter after i cancels the object", text: "ab\ncd", pending: "<Esc>ggvi", key: "enter", probe: "d", after: "|b\ncd", mode: "normal" },
	{ name: "Shift+Right moves right", text: "abcdef", pending: "0v", key: "shiftRight", probe: "d", after: "|cdef", mode: "normal" },
	{ name: "Ctrl+A leaves visual mode without snapping", text: "abcdef", pending: "0v$", key: "ctrlA", probe: "", after: "abcdef|", mode: "normal" },
];

describe("special keys by pending state", () => {
	const run = (editor: Editor, row: SpecialRow) => {
		press(editor, "<Esc>");
		editor.setText(row.text);
		press(editor, `<Esc>${row.pending}`);
		key(editor, SPECIAL[row.key]);
		press(editor, row.probe);
	};
	for (const [label, rows, mode] of [
		["normal", NORMAL_ROWS, "normal"],
		["visual", VISUAL_ROWS, "visual"],
	] as const) {
		describe(label, () => {
			for (const row of rows) {
				it(row.name, () => {
					const editor = createEditor();
					run(editor, row);
					assert.strictEqual(marked(editor), row.after);
					assert.strictEqual(editor.getVimMode(), row.mode ?? mode);
				});
			}
		});
	}
});

describe("Editor vim mode", () => {
	it("starts in insert mode and reports undefined when off", () => {
		const editor = createEditor();
		assert.strictEqual(editor.getVimMode(), "insert");
		editor.setVimMode(undefined);
		assert.strictEqual(editor.getVimMode(), undefined);
		assert.strictEqual(editor.handleVimInput("x", false), false);
		assert.strictEqual(editor.handleVimInput(ESCAPE, true), false);
	});

	it("insert -> Escape -> normal -> motions -> edit -> undo", () => {
		const editor = createEditor();
		press(editor, "hello world<Esc>");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(marked(editor), "hello worl|d");
		press(editor, "0w");
		assert.strictEqual(marked(editor), "hello |world");
		press(editor, "dw");
		assert.strictEqual(marked(editor), "hello| ");
		press(editor, "u");
		assert.strictEqual(editor.getText(), "hello world");
		press(editor, "u");
		assert.strictEqual(editor.getText(), "");
	});

	it("normal mode consumes letters instead of typing them", () => {
		const editor = createEditor();
		press(editor, "ab<Esc>zq");
		assert.strictEqual(editor.getText(), "ab");
	});

	it("Enter and control keys are left to the editor in normal mode", () => {
		const editor = createEditor();
		press(editor, "ab<Esc>");
		assert.strictEqual(editor.handleVimInput("\r", false), false);
		assert.strictEqual(editor.handleVimInput("\x01", false), false);
	});

	it("Escape in normal mode passes through only with nothing pending", () => {
		const editor = createEditor();
		press(editor, "ab<Esc>");
		assert.strictEqual(editor.handleVimInput(ESCAPE, true), false);
		press(editor, "d");
		assert.strictEqual(editor.handleVimInput(ESCAPE, true), true);
		assert.strictEqual(editor.handleVimInput(ESCAPE, true), false);
	});

	it("Escape in insert mode is consumed", () => {
		const editor = createEditor();
		assert.strictEqual(editor.handleVimInput(ESCAPE, true), true);
		assert.strictEqual(editor.getVimMode(), "normal");
	});

	it("arrow keys move the cursor in normal mode and stay on a character", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>");
		press(editor, "<Left><Left>");
		assert.strictEqual(marked(editor), "|abc");
		press(editor, "<Right><Right><Right><Right>");
		assert.strictEqual(marked(editor), "ab|c");
	});

	it("an insert session is one undo step", () => {
		const editor = createEditor();
		press(editor, "one two three<Esc>");
		press(editor, "0cwuno three<Esc>");
		assert.strictEqual(editor.getText(), "uno three two three");
		press(editor, "u");
		assert.strictEqual(editor.getText(), "one two three");
	});

	it("x on a paste marker deletes it whole and other markers keep their content", () => {
		const editor = createEditor();
		const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		editor.handleInput(`a`);
		editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		editor.handleInput(`b`);
		editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		editor.handleInput(`c`);
		const text = editor.getText();
		assert.match(text, /^a\[paste #1 \+12 lines\]b\[paste #2 \+12 lines\]c$/);
		press(editor, "<Esc>0l");
		assert.strictEqual(editor.getCursorOffset(), 1);
		press(editor, "l");
		assert.strictEqual(editor.getCursorOffset(), 1 + "[paste #1 +12 lines]".length);
		press(editor, "0lx");
		assert.strictEqual(editor.getText(), "ab[paste #2 +12 lines]c");
		assert.strictEqual(editor.getExpandedText(), `ab${big}c`);
	});

	it("put brings a deleted paste marker back with its content", () => {
		const editor = createEditor();
		const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		editor.handleInput("a");
		editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		press(editor, "<Esc>0lxp");
		assert.strictEqual(editor.getText(), "a[paste #1 +12 lines]");
		assert.strictEqual(editor.getExpandedText(), `a${big}`);
	});

	it("k on the first line recalls history, j on the last returns", () => {
		const editor = createEditor();
		editor.addToHistory("older prompt");
		press(editor, "<Esc>k");
		assert.strictEqual(editor.getText(), "older prompt");
		assert.strictEqual(editor.getVimMode(), "normal");
		press(editor, "j");
		assert.strictEqual(editor.getText(), "");
	});

	it("setBuffer replaces text and cursor as one undo step", () => {
		const editor = createEditor(undefined);
		editor.setText("abc");
		editor.setBuffer("xyz\nw", 5);
		assert.strictEqual(marked(editor), "xyz\nw|");
		editor.undo();
		assert.strictEqual(editor.getText(), "abc");
	});

	it("tabs stay normalized and the text engine never sees one", () => {
		const editor = createEditor();
		editor.setText("a\tb");
		assert.strictEqual(editor.getText(), "a    b");
		press(editor, "<Esc>0wx");
		assert.strictEqual(editor.getText(), "a    ");
	});
});

describe("Editor vim insert remaps", () => {
	function withClock(remaps: unknown) {
		const clock = { now: 1000 };
		const editor = createEditor({ insertRemaps: parseVimInsertRemaps(remaps), now: () => clock.now });
		return { editor, clock };
	}

	it("jj within the window removes the first j and enters normal mode", () => {
		const { editor, clock } = withClock({ jj: "<Esc>" });
		press(editor, "ab");
		press(editor, "j");
		clock.now += 999;
		press(editor, "j");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(editor.getText(), "ab");
		assert.strictEqual(marked(editor), "a|b");
	});

	it("jj outside the window types both characters", () => {
		const { editor, clock } = withClock({ jj: "<Esc>" });
		press(editor, "j");
		clock.now += 1001;
		press(editor, "j");
		assert.strictEqual(editor.getVimMode(), "insert");
		assert.strictEqual(editor.getText(), "jj");
	});

	it("another key between the two cancels the pending remap", () => {
		const { editor } = withClock({ jj: "<Esc>" });
		press(editor, "jxj");
		assert.strictEqual(editor.getVimMode(), "insert");
		assert.strictEqual(editor.getText(), "jxj");
	});

	it("moving the cursor between the two cancels the pending remap", () => {
		const { editor } = withClock({ jj: "<Esc>" });
		press(editor, "j<Left>j");
		assert.strictEqual(editor.getVimMode(), "insert");
		assert.strictEqual(editor.getText(), "jj");
	});

	it("a distinct remap pair works and the first character alone does not leave insert", () => {
		const { editor } = withClock({ jk: "<ESC>" });
		press(editor, "j");
		assert.strictEqual(editor.getVimMode(), "insert");
		press(editor, "k");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(editor.getText(), "");
	});

	it("a read carrying both characters enters normal mode without typing", () => {
		const { editor } = withClock({ jj: "<Esc>" });
		press(editor, "ab");
		assert.strictEqual(editor.handleVimInput("jj", false), true);
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(editor.getText(), "ab");
	});

	it("remaps do nothing in normal mode", () => {
		const { editor } = withClock({ jj: "<Esc>" });
		press(editor, "ab<Esc>");
		press(editor, "jj");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(editor.getText(), "ab");
	});

	it("the remap leaves a one-step undo for the whole insert session", () => {
		const { editor } = withClock({ jj: "<Esc>" });
		press(editor, "hello jj");
		press(editor, "u");
		assert.strictEqual(editor.getText(), "");
	});
});

describe("Editor vim render", () => {
	it("shows -- INSERT -- under the editor only in insert mode", () => {
		const editor = createEditor();
		editor.setPaddingX(1);
		const insert = plain(editor);
		assert.strictEqual(insert.at(-1), " -- INSERT --");
		press(editor, "<Esc>");
		const normal = plain(editor);
		assert.strictEqual(normal.length, insert.length - 1);
		assert.ok(!normal.some((line) => line.includes("INSERT")));
	});

	it("renders byte-identically to an editor without vim when vim is off or in normal mode", () => {
		const reference = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		const editor = createEditor();
		reference.setText("same text");
		reference.setBuffer("same text", 8);
		editor.setText("same text");
		press(editor, "<Esc>");
		assert.deepStrictEqual(editor.render(40), reference.render(40));
		editor.setVimMode(undefined);
		assert.deepStrictEqual(editor.render(40), reference.render(40));
	});

	it("turning vim on again keeps the current mode", () => {
		const editor = createEditor();
		press(editor, "<Esc>");
		editor.setVimMode({ insertRemaps: parseVimInsertRemaps({ jj: "<Esc>" }) });
		assert.strictEqual(editor.getVimMode(), "normal");
	});
});

describe("gj and gk follow the rendered wrap", () => {
	it("gj moves to the next display row at the width the editor last rendered", () => {
		const editor = createEditor();
		editor.setText("aaaa bbbb cccc dddd");
		editor.render(11);
		press(editor, "<Esc>0l");
		assert.strictEqual(marked(editor), "a|aaa bbbb cccc dddd");
		press(editor, "gj");
		assert.strictEqual(marked(editor), "aaaa bbbb c|ccc dddd");
		press(editor, "gk");
		assert.strictEqual(marked(editor), "a|aaa bbbb cccc dddd");
	});

	it("gj is j before any wrap exists", () => {
		const editor = createEditor();
		editor.setText("abc\ndef");
		editor.render(40);
		press(editor, "<Esc>ggj0");
		press(editor, "gk");
		press(editor, "gj");
		assert.strictEqual(marked(editor), "abc\n|def");
	});
});

describe("Editor vim visual mode", () => {
	const INVERSE = "\x1b[7m";

	it("shows -- VISUAL -- and -- VISUAL LINE -- under the editor, and nothing once it is left", () => {
		const editor = createEditor();
		editor.setPaddingX(1);
		press(editor, "abc<Esc>0v");
		assert.strictEqual(editor.getVimMode(), "visual");
		assert.strictEqual(plain(editor).at(-1), " -- VISUAL --");
		press(editor, "V");
		assert.strictEqual(plain(editor).at(-1), " -- VISUAL LINE --");
		press(editor, "<Esc>");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.ok(!plain(editor).some((line) => line.includes("VISUAL")));
	});

	it("Escape snaps the cursor back onto the last character", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>0v$");
		assert.strictEqual(marked(editor), "abc|");
		press(editor, "<Esc>");
		assert.strictEqual(marked(editor), "ab|c");
	});

	it("inverts the selected span and only in visual mode", () => {
		const editor = createEditor();
		press(editor, "abc def<Esc>0");
		assert.ok(!editor.render(40).join("").includes(INVERSE));
		press(editor, "vl");
		const lines = editor.render(40);
		assert.ok(lines.some((line) => line.includes(`${INVERSE}a\x1b[27m`)));
		press(editor, "<Esc>");
		assert.ok(!editor.render(40).join("").includes(INVERSE));
	});

	it("inverts whole lines for V", () => {
		const editor = createEditor();
		editor.setText("one\ntwo\nthree");
		press(editor, "<Esc>ggVj");
		const lines = editor.render(40);
		assert.ok(lines.some((line) => line.includes(`${INVERSE}one\x1b[27m`)));
		assert.ok(!lines.some((line) => line.includes(`${INVERSE}three`)));
	});

	it("a visual change and what it types undo as one step", () => {
		const editor = createEditor();
		press(editor, "abc def<Esc>0vecXY<Esc>");
		assert.strictEqual(editor.getText(), "XY def");
		press(editor, "u");
		assert.strictEqual(editor.getText(), "abc def");
	});

	it("Enter moves down like j and does not leave visual mode", () => {
		const editor = createEditor();
		editor.setText("a\nb");
		press(editor, "<Esc>ggv");
		key(editor, "\r");
		assert.strictEqual(marked(editor), "a\n|b");
		assert.strictEqual(editor.getVimMode(), "visual");
	});

	it("Enter during a visual find searches for the newline", () => {
		const editor = createEditor();
		editor.setText("ab\ncd");
		press(editor, "<Esc>ggvf");
		assert.strictEqual(editor.handleVimInput("\r", false), true);
		assert.strictEqual(editor.getVimMode(), "visual");
		press(editor, "d");
		assert.strictEqual(editor.getText(), "cd");
	});

	it("Enter during a visual replace puts a newline in", () => {
		const editor = createEditor();
		editor.setText("ab\ncd");
		press(editor, "<Esc>ggvr");
		assert.strictEqual(editor.handleVimInput("\r", false), true);
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(editor.getText(), "\nb\ncd");
	});

	it("a key outside vim's table leaves visual mode and is consumed", () => {
		const editor = createEditor();
		press(editor, "abc<Esc>0v");
		assert.strictEqual(editor.handleVimInput("\x03", false), true);
		assert.strictEqual(editor.getVimMode(), "normal");
	});
});
