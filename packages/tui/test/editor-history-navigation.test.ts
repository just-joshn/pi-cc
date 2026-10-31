import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Transition table captured from Claude Code 2.1.312 (sandboxed tmux sweep,
// store/vimnav/fix-round-3/): one submitted prompt per entry (one, two, three),
// vim editing mode, one probe key per cell from a fixed navigation state.

const KEY_DATA: Record<string, string> = {
	Up: "\x1b[A",
	Down: "\x1b[B",
	"C-r": "\x12",
	Escape: "\x1b",
	Enter: "\r",
	Tab: "\t",
	"C-c": "\x03",
	BSpace: "\x7f",
	Home: "\x1b[H",
	End: "\x1b[F",
};

function createEditor(): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	editor.setVimMode({ insertRemaps: new Map() });
	for (const text of ["one", "two", "three"]) editor.addToHistory(text);
	return editor;
}

function key(editor: Editor, name: string): void {
	const data = KEY_DATA[name] ?? name;
	if (!editor.handleVimInput(data, data === "\x1b")) editor.handleInput(data);
}

function run(editor: Editor, steps: string[]): void {
	for (const step of steps) key(editor, step);
}

function screen(editor: Editor): string {
	return editor.render(80).map(stripTerminalSequences).join("\n");
}

interface Expectation {
	body: string;
	cursor: number;
	rule: string;
	bar: "none" | "search" | "nomatch";
	insert: boolean;
}

const plain = "─".repeat(80);
const historyRule = (n: number, total: number) => `─── History ${n}/${total} ${"─".repeat(64)}`;

// One probe key applied to each navigation state; expectations are the Claude
// Code frames (state setups run in insert mode; the search draws its bar).
const TABLE: { state: [string, string[]]; key: string; want: Expectation }[] = [
	{
		state: ["browmid", ["Up", "Up"]],
		key: "BSpace",
		want: { body: "tw", cursor: 2, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "C-r",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Down",
		want: { body: "three", cursor: 0, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "End",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Escape",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "none", insert: false },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Home",
		want: { body: "two", cursor: 0, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Tab",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "Up",
		want: { body: "one", cursor: 3, rule: historyRule(1, 3), bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "j",
		want: { body: "twoj", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "k",
		want: { body: "twok", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browmid", ["Up", "Up"]],
		key: "x",
		want: { body: "twox", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "BSpace",
		want: { body: "thre", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "C-r",
		want: { body: "three", cursor: 5, rule: historyRule(3, 3), bar: "search", insert: false },
	},
	{ state: ["brownew", ["Up"]], key: "Down", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{
		state: ["brownew", ["Up"]],
		key: "End",
		want: { body: "three", cursor: 5, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{ state: ["brownew", ["Up"]], key: "Enter", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{
		state: ["brownew", ["Up"]],
		key: "Escape",
		want: { body: "three", cursor: 4, rule: historyRule(3, 3), bar: "none", insert: false },
	},
	{
		state: ["brownew", ["Up"]],
		key: "Home",
		want: { body: "three", cursor: 0, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "Tab",
		want: { body: "three", cursor: 5, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "Up",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "j",
		want: { body: "threej", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "k",
		want: { body: "threek", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["brownew", ["Up"]],
		key: "x",
		want: { body: "threex", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "BSpace",
		want: { body: "on", cursor: 2, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "C-r",
		want: { body: "one", cursor: 3, rule: historyRule(1, 3), bar: "search", insert: false },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Down",
		want: { body: "two", cursor: 0, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "End",
		want: { body: "one", cursor: 3, rule: historyRule(1, 3), bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Escape",
		want: { body: "one", cursor: 2, rule: historyRule(1, 3), bar: "none", insert: false },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Home",
		want: { body: "one", cursor: 0, rule: historyRule(1, 3), bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Tab",
		want: { body: "one", cursor: 3, rule: historyRule(1, 3), bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "Up",
		want: { body: "one", cursor: 3, rule: historyRule(1, 3), bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "j",
		want: { body: "onej", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "k",
		want: { body: "onek", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["browold", ["Up", "Up", "Up"]],
		key: "x",
		want: { body: "onex", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["kedit", ["Escape", "k", "x"]],
		key: "k",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "none", insert: false },
	},
	{
		state: ["kedit", ["Escape", "k", "x"]],
		key: "Up",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: false },
	},
	{
		state: ["kedit", ["Escape", "k", "x"]],
		key: "j",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: false },
	},
	{ state: ["draft", []], key: "BSpace", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "C-r", want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false } },
	{ state: ["draft", []], key: "Down", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "End", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "Enter", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "Escape", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: false } },
	{ state: ["draft", []], key: "Home", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "Tab", want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true } },
	{
		state: ["draft", []],
		key: "Up",
		want: { body: "three", cursor: 5, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{ state: ["draft", []], key: "j", want: { body: "j", cursor: 1, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "k", want: { body: "k", cursor: 1, rule: plain, bar: "none", insert: true } },
	{ state: ["draft", []], key: "x", want: { body: "x", cursor: 1, rule: plain, bar: "none", insert: true } },
	{
		state: ["drafttext", ["hello"]],
		key: "BSpace",
		want: { body: "hell", cursor: 4, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "C-r",
		want: { body: "hello", cursor: 5, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Down",
		want: { body: "hello", cursor: 5, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "End",
		want: { body: "hello", cursor: 5, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Escape",
		want: { body: "hello", cursor: 4, rule: plain, bar: "none", insert: false },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Home",
		want: { body: "hello", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Tab",
		want: { body: "hello", cursor: 5, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "Up",
		want: { body: "three", cursor: 5, rule: historyRule(3, 3), bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "j",
		want: { body: "helloj", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "k",
		want: { body: "hellok", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["drafttext", ["hello"]],
		key: "x",
		want: { body: "hellox", cursor: 6, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "BSpace",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "C-r",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Down",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "End",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Escape",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Home",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Tab",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "Up",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "j",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "k",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchbrow", ["Up", "Up", "C-r"]],
		key: "x",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "BSpace",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "C-r",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Down",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "End",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Escape",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Home",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Tab",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "Up",
		want: { body: "", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "j",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "k",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchdraft", ["C-r"]],
		key: "x",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "BSpace",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "C-r",
		want: { body: "one", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Down",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "End",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Escape",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Home",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Tab",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "none", insert: true },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "Up",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "j",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "k",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchmatch", ["Up", "Up", "C-r", "o"]],
		key: "x",
		want: { body: "two", cursor: 2, rule: historyRule(2, 3), bar: "nomatch", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "BSpace",
		want: { body: "two", cursor: 3, rule: historyRule(2, 3), bar: "search", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "C-r",
		want: { body: "one", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Down",
		want: { body: "one", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "End",
		want: { body: "one", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Escape",
		want: { body: "one", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Home",
		want: { body: "one", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Tab",
		want: { body: "one", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "Up",
		want: { body: "one", cursor: 0, rule: plain, bar: "search", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "j",
		want: { body: "one", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "k",
		want: { body: "one", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchmoved", ["Up", "Up", "C-r", "o", "C-r"]],
		key: "x",
		want: { body: "one", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "BSpace",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "C-r",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Down",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "End",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Enter",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Escape",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Home",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Tab",
		want: { body: "", cursor: 0, rule: plain, bar: "none", insert: true },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "Up",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "j",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "k",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
	{
		state: ["searchnomatch", ["C-r", "z", "z"]],
		key: "x",
		want: { body: "", cursor: 0, rule: plain, bar: "nomatch", insert: false },
	},
];

describe("prompt navigation transition table (claude 2.1.312 sweep)", () => {
	for (const { state, key: probe, want } of TABLE) {
		it(`${state[0]} + ${probe}`, () => {
			const editor = createEditor();
			run(editor, state[1]);
			key(editor, probe);
			assert.equal(editor.getText(), want.body, "body");
			assert.equal(editor.getCursorOffset(), want.cursor, "cursor offset");
			assert.equal(screen(editor).split("\n")[0], want.rule, "top rule");
			const view = screen(editor);
			assert.equal(/search prompts:/.test(view), want.bar === "search", "search bar");
			assert.equal(/no matching prompt:/.test(view), want.bar === "nomatch", "no-match bar");
			assert.equal(/-- INSERT --/.test(view), want.insert, "insert badge");
		});
	}
});

describe("prompt navigation sequences (claude 2.1.312 probes)", () => {
	it("Up x Up keeps browsing and returns the edited entry as an override", () => {
		const editor = createEditor();
		run(editor, ["Up", "x", "Up", "Up", "Down", "Down"]);
		assert.equal(editor.getText(), "threex", "edited entry returns from its slot");
		assert.equal(editor.getCursorOffset(), 0, "Down installs with the cursor at the start");
		assert.equal(screen(editor).split("\n")[0], historyRule(3, 3));
		key(editor, "Down");
		assert.equal(editor.getText(), "");
		assert.equal(screen(editor).split("\n")[0], plain);
	});

	it("editing during browsing keeps the History rule only while the text matches the entry", () => {
		const editor = createEditor();
		run(editor, ["Up"]);
		assert.equal(screen(editor).split("\n")[0], historyRule(3, 3));
		key(editor, "x");
		assert.equal(editor.getText(), "threex");
		assert.equal(screen(editor).split("\n")[0], plain, "edited entry hides the rule");
	});

	it("Down restores the draft with the cursor at the start, and Down on the draft is a no-op", () => {
		const editor = createEditor();
		run(editor, ["h", "e", "l", "l", "o", "Up", "Down"]);
		assert.equal(editor.getText(), "hello");
		assert.equal(editor.getCursorOffset(), 0);
		key(editor, "Down");
		assert.equal(editor.getText(), "hello");
		assert.equal(editor.getCursorOffset(), 0);
	});

	it("Down installs the newer entry with the cursor at the start", () => {
		const editor = createEditor();
		run(editor, ["Up", "Up", "Down"]);
		assert.equal(editor.getText(), "three");
		assert.equal(editor.getCursorOffset(), 0);
		key(editor, "X");
		assert.equal(editor.getText(), "Xthree");
	});

	it("a moved search match cancels to plain and browsing resumes from the browsed slot", () => {
		const editor = createEditor();
		run(editor, ["Up", "Up", "C-r", "o", "C-r", "Escape"]);
		assert.equal(editor.getText(), "one");
		assert.equal(screen(editor).split("\n")[0], plain, "rule is stale-free plain after Esc");
		run(editor, ["Up"]);
		assert.equal(editor.getText(), "one");
		assert.equal(screen(editor).split("\n")[0], historyRule(1, 3), "clamped at the matched slot");
		run(editor, ["Down"]);
		assert.equal(editor.getText(), "one", "override saved over the checked-out slot");
		assert.equal(screen(editor).split("\n")[0], historyRule(2, 3));
		run(editor, ["Down"]);
		assert.equal(editor.getText(), "three");
		assert.equal(screen(editor).split("\n")[0], historyRule(3, 3));
	});

	it("emptying the search query restores the browsed entry and the rule returns", () => {
		const editor = createEditor();
		run(editor, ["Up", "Up", "C-r", "o", "C-r", "BSpace"]);
		assert.equal(editor.getText(), "two");
		assert.equal(screen(editor).split("\n")[0], historyRule(2, 3));
		assert.match(screen(editor), /search prompts:/);
	});

	it("a search match that comes back to the browsed entry brings the rule back", () => {
		const editor = createEditor();
		run(editor, ["Up", "Up", "C-r", "t"]);
		assert.equal(editor.getText(), "three");
		assert.equal(screen(editor).split("\n")[0], plain, "moved match hides the rule");
		run(editor, ["C-r"]);
		assert.equal(editor.getText(), "two");
		assert.equal(screen(editor).split("\n")[0], historyRule(2, 3), "match back on the browsed entry");
	});

	it("Ctrl+C holds an edited browsed entry and the next Up restores it", () => {
		const editor = createEditor();
		run(editor, ["Up", "x"]);
		assert.equal(editor.holdClearedOnInterrupt(), true);
		assert.equal(editor.getText(), "");
		key(editor, "Up");
		assert.equal(editor.getText(), "threex", "held value restored");
		assert.equal(editor.getCursorOffset(), 6);
		assert.equal(screen(editor).split("\n")[0], plain);
		key(editor, "Up");
		assert.equal(editor.getText(), "three");
		assert.equal(screen(editor).split("\n")[0], historyRule(3, 3), "browsing restarts from the newest");
	});

	it("Ctrl+C declines to hold an unedited browsed entry or an empty draft", () => {
		const editor = createEditor();
		run(editor, ["Up"]);
		assert.equal(editor.holdClearedOnInterrupt(), false);
		assert.equal(editor.getText(), "three");
		const empty = createEditor();
		assert.equal(empty.holdClearedOnInterrupt(), false);
	});
});
