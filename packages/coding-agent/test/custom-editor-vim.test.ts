import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const ESCAPE = "\x1b";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createEditor(vim: boolean) {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	let escapes = 0;
	editor.onEscape = () => {
		escapes++;
	};
	if (vim) editor.setVimMode({ insertRemaps: new Map() });
	return { editor, escapes: () => escapes };
}

describe("CustomEditor vim mode", () => {
	it("leaves Escape to the interrupt handler when vim is off", () => {
		const { editor, escapes } = createEditor(false);
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(1);
	});

	it("consumes Escape in insert mode and enters normal mode without interrupting", () => {
		const { editor, escapes } = createEditor(true);
		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(0);
		expect(editor.getVimMode()).toBe("normal");
		expect(editor.getText()).toBe("ab");
	});

	it("reaches onEscape for Escape in normal mode with nothing pending", () => {
		const { editor, escapes } = createEditor(true);
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(0);
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(1);
	});

	it("uses Escape to clear a pending command in normal mode instead of interrupting", () => {
		const { editor, escapes } = createEditor(true);
		editor.handleInput(ESCAPE);
		editor.handleInput("d");
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(0);
		editor.handleInput(ESCAPE);
		expect(escapes()).toBe(1);
	});

	it("edits with normal-mode keys and keeps typed letters out of the text", () => {
		const { editor } = createEditor(true);
		for (const key of "hello world") editor.handleInput(key);
		editor.handleInput(ESCAPE);
		for (const key of "0dwz") editor.handleInput(key);
		expect(editor.getText()).toBe("world");
		editor.handleInput("u");
		expect(editor.getText()).toBe("hello world");
	});

	it("still submits with Enter in normal mode", () => {
		const { editor } = createEditor(true);
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("h");
		editor.handleInput("i");
		editor.handleInput(ESCAPE);
		editor.handleInput("\r");
		expect(submitted).toBe("hi");
	});

	it("runs app actions bound to control keys in normal mode", () => {
		const { editor } = createEditor(true);
		let ran = 0;
		editor.onAction("app.clear", () => {
			ran++;
		});
		editor.handleInput(ESCAPE);
		editor.handleInput("\x03");
		expect(ran).toBe(1);
	});
});
