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

	it("Delete with a pending count deletes forward and keeps the count", () => {
		const editor = createEditor();
		press(editor, "abcdef<Esc>0");
		assert.strictEqual(editor.handleVimInput("3", false), true);
		key(editor, "\x1b[3~");
		assert.strictEqual(marked(editor), "|bcdef");
		press(editor, "l");
		assert.strictEqual(marked(editor), "bcd|ef");
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

	it("Backspace with a pending find deletes backward and keeps the find", () => {
		const editor = createEditor();
		press(editor, "abid<Esc>h");
		assert.strictEqual(editor.handleVimInput("f", false), true);
		key(editor, "\x7f");
		assert.strictEqual(editor.getText(), "aid");
		key(editor, "i");
		assert.strictEqual(editor.getVimMode(), "normal");
		assert.strictEqual(marked(editor), "a|id");
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
