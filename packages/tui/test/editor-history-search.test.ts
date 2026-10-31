import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor, type PromptHistoryEntry } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(vim = false): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	if (vim) editor.setVimMode({ insertRemaps: new Map() });
	editor.addToHistory("old Alpha alpha");
	editor.addToHistory("new ALPHA value");
	return editor;
}

function key(editor: Editor, data: string): void {
	if (!editor.handleVimInput(data, data === "\x1b")) editor.handleInput(data);
}

const screen = (editor: Editor) => editor.render(80).map(stripTerminalSequences).join("\n");

describe("prompt history reverse search", () => {
	it("deduplicates equal paste contents independently of their marker IDs", () => {
		const entries = [8, 1, 3].map((id) => ({
			text: `prompt [paste #${id} 12 chars]`,
			pastes: new Map([[id, id === 3 ? "different" : "same"]]),
		}));
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, {
			history: { read: () => entries, append: () => {} },
		});
		key(editor, "\x12");
		key(editor, "prompt");
		assert.equal(editor.getExpandedText(), "prompt same");
		key(editor, "\x12");
		assert.equal(editor.getExpandedText(), "prompt different");
	});

	it("retains the visual anchor on acceptance as the oracle does", () => {
		const editor = createEditor(true);
		editor.addToHistory("hello world");
		key(editor, "abc");
		key(editor, "\x1b");
		key(editor, "v");
		key(editor, "\x12");
		key(editor, "hello");
		key(editor, "\x1b");
		assert.equal(editor.getVimMode(), "visual");
		key(editor, "d");
		assert.equal(editor.getText(), "lo world");
	});
	it("loads stored prompts at search-open time and restores a matched paste on accept", () => {
		const entries: PromptHistoryEntry[] = [];
		const history = {
			read: () => entries.toReversed(),
			append: (entry: PromptHistoryEntry) => {
				entries.push({ text: entry.text, pastes: new Map(entry.pastes) });
			},
		};
		const prior = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, { history });
		const next = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, { history });
		key(prior, "older ");
		const pasted = "secret\n".repeat(12);
		key(prior, `\x1b[200~${pasted}\x1b[201~`);
		key(prior, "\r");
		key(next, "draft");
		key(next, "\x12");
		key(next, "older");
		key(next, "\t");
		assert.equal(next.getText(), "older [paste #1 +13 lines]");
		assert.equal(next.getExpandedText(), `older ${pasted}`);
		next.undo();
		assert.equal(next.getText(), "draft");
		key(next, "\x12");
		key(next, "secret");
		assert.match(screen(next), /no matching prompt:/);
	});

	it("buffers bracketed-paste query chunks instead of treating their bytes as shortcuts", () => {
		const editor = createEditor();
		key(editor, "\x12");
		key(editor, "\x1b[200~al");
		key(editor, "\x1b[201~pha");
		assert.equal(editor.getText(), "new ALPHA value");
		assert.match(screen(editor), /search prompts: alpha/);
	});

	it("accepts a retained match at its end when the changed query no longer matches", () => {
		const editor = createEditor();
		key(editor, "\x12");
		key(editor, "alpha");
		key(editor, "zzz");
		key(editor, "\x1b");
		assert.equal(editor.getText(), "new ALPHA value");
		assert.equal(editor.getCursorOffset(), 15);
	});
	it("opens without replacing the draft and searches newest first, ignoring case", () => {
		const editor = createEditor();
		editor.setBuffer("draft", 2);
		key(editor, "\x12");
		assert.match(screen(editor), /search prompts:/);
		assert.equal(editor.getText(), "draft");
		key(editor, "alpha");
		assert.equal(editor.getText(), "new ALPHA value");
		assert.equal(editor.getCursorOffset(), 4);
		key(editor, "\x12");
		assert.equal(editor.getText(), "old Alpha alpha");
		assert.equal(editor.getCursorOffset(), 10);
		key(editor, "\x12");
		assert.match(screen(editor), /no matching prompt: alpha/);
		assert.equal(editor.getText(), "old Alpha alpha");
		key(editor, "\x1b");
		assert.doesNotMatch(screen(editor), /search prompts:|no matching prompt:/);
		assert.equal(editor.getText(), "old Alpha alpha");
	});

	it("cancels to the original cursor, text, and paste contents", () => {
		const editor = createEditor();
		const paste = "line\n".repeat(12);
		key(editor, `\x1b[200~${paste}\x1b[201~`);
		const draft = editor.getText();
		editor.setBuffer(draft, 0);
		key(editor, "\x12");
		key(editor, "alpha");
		key(editor, "\x03");
		assert.equal(editor.getText(), draft);
		assert.equal(editor.getCursorOffset(), 0);
		assert.equal(editor.getExpandedText(), paste);
	});

	it("clearing the query restores the draft and backspace on empty keeps search open", () => {
		const editor = createEditor();
		editor.setBuffer("draft", 2);
		key(editor, "\x12");
		key(editor, "a");
		key(editor, "\x7f");
		assert.equal(editor.getText(), "draft");
		assert.equal(editor.getCursorOffset(), 2);
		assert.match(screen(editor), /search prompts:/);
		key(editor, "\x7f");
		assert.match(screen(editor), /search prompts:/);
		assert.equal(editor.getText(), "draft");
	});

	it("accepts with Tab and executes a match with Enter, but not an unmatched query", () => {
		const editor = createEditor();
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		key(editor, "\x12");
		key(editor, "alpha");
		key(editor, "\t");
		assert.deepEqual(submitted, []);
		assert.equal(editor.getText(), "new ALPHA value");
		key(editor, "\x12");
		key(editor, "missing");
		key(editor, "\r");
		assert.deepEqual(submitted, []);
		key(editor, "\x12");
		key(editor, "alpha");
		key(editor, "\r");
		assert.deepEqual(submitted, ["new ALPHA value"]);
		assert.equal(editor.getText(), "");
	});

	it("empty Enter executes the original draft and empty Ctrl+R does not select history", () => {
		const editor = createEditor();
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("draft");
		key(editor, "\x12");
		key(editor, "\x12");
		assert.equal(editor.getText(), "draft");
		key(editor, "\r");
		assert.equal(submitted, "draft");
	});

	it("skips duplicate prompt texts and restarts at newest when the query changes", () => {
		const editor = createEditor();
		editor.addToHistory("old Alpha alpha");
		key(editor, "\x12");
		key(editor, "alpha");
		key(editor, "\x12");
		assert.equal(editor.getText(), "new ALPHA value");
		key(editor, "\x12");
		assert.match(screen(editor), /no matching prompt:/);
		key(editor, "\x7f");
		assert.equal(editor.getText(), "old Alpha alpha");
	});

	it("normal slash opens search only while no Vim command is pending", () => {
		const editor = createEditor(true);
		key(editor, "draft");
		key(editor, "\x1b");
		key(editor, "d");
		key(editor, "/");
		assert.doesNotMatch(screen(editor), /search prompts:/);
		key(editor, "/");
		assert.match(screen(editor), /search prompts:/);
		assert.doesNotMatch(screen(editor), /-- INSERT --/);
		key(editor, "alpha");
		key(editor, "\x1b");
		assert.equal(editor.getVimMode(), "normal");
		assert.equal(editor.getCursorOffset(), 4);
		key(editor, "/");
		key(editor, "old");
		key(editor, "\x03");
		assert.equal(editor.getVimMode(), "normal");
		assert.equal(editor.getText(), "new ALPHA value");
		assert.equal(editor.getCursorOffset(), 4);
	});

	it("empty history keeps the draft and accepts a no-match without submitting", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setText("draft");
		key(editor, "\x12");
		key(editor, "missing");
		assert.match(screen(editor), /no matching prompt:/);
		key(editor, "\x1b");
		assert.equal(editor.getText(), "draft");
	});
});
