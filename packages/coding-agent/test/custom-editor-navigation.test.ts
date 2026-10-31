import { setKeybindings, stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => setKeybindings(new KeybindingsManager()));

function createEditor(vim = false, bindings = new KeybindingsManager()) {
	setKeybindings(bindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, bindings, {
		promptShortcuts: true,
	});
	if (vim) editor.setVimMode({ insertRemaps: new Map() });
	return editor;
}

const screen = (editor: CustomEditor) => editor.render(100).map(stripTerminalSequences).join("\n");

describe("prompt navigation before application shortcuts", () => {
	it.each(["/", "\x12"])("keeps help above search opened with %j until Escape dismisses help", (open) => {
		const editor = createEditor(true);
		editor.handleInput("a");
		editor.handleInput("\x1b");
		editor.handleInput("?");
		editor.handleInput(open);
		expect(screen(editor)).toContain("/ for commands");
		expect(screen(editor)).not.toContain("search prompts:");
		editor.handleInput("alpha");
		expect(editor.getText()).toBe("a");
		editor.handleInput("\x1b");
		expect(screen(editor)).not.toContain("/ for commands");
		expect(screen(editor)).toContain("search prompts:");
	});

	it("keeps global actions active during search and restores the draft before transcript toggle", () => {
		const editor = createEditor();
		let thinking = 0;
		let tools = 0;
		editor.actionHandlers.set("app.thinking.toggle", () => thinking++);
		editor.actionHandlers.set("app.tools.expand", () => tools++);
		editor.addToHistory("alpha stored");
		editor.setText("draft");
		editor.handleInput("\x12");
		editor.handleInput("alpha");
		editor.handleInput("\x14");
		expect(thinking).toBe(1);
		expect(screen(editor)).toContain("search prompts: alpha");
		editor.handleInput("\x0f");
		expect(tools).toBe(1);
		expect(editor.getText()).toBe("draft");
		expect(screen(editor)).not.toContain("search prompts:");
	});

	it("keeps imported Global bindings active while Chat bindings stay inactive in search", () => {
		const bindings = new KeybindingsManager();
		bindings.cc.setBindings([
			{ keys: ["ctrl+y"], action: "app.thinking.toggle", global: true },
			{ keys: ["ctrl+b"], action: "app.thinking.toggle" },
			{ keys: ["ctrl+c"], action: "app.thinking.toggle", global: true },
		]);
		const editor = createEditor(false, bindings);
		let calls = 0;
		editor.actionHandlers.set("app.thinking.toggle", () => calls++);
		editor.handleInput("\x12");
		editor.handleInput("\x02");
		expect(calls).toBe(0);
		editor.handleInput("\x19");
		expect(calls).toBe(1);
		expect(screen(editor)).toContain("search prompts:");
		editor.handleInput("\x03");
		expect(calls).toBe(1);
		expect(screen(editor)).not.toContain("search prompts:");
	});

	it("uses configured shortcuts in the help sheet", () => {
		const editor = createEditor(
			false,
			new KeybindingsManager({ "app.editor.external": "ctrl+y", "tui.editor.undo": "ctrl+j" }),
		);
		editor.handleInput("?");
		expect(screen(editor)).toContain("ctrl + y to edit in $EDITOR");
		expect(screen(editor)).toContain("ctrl + j to undo");
		expect(screen(editor)).not.toContain("ctrl + g to edit in $EDITOR");
	});

	it("uses imported chord spellings in the help sheet", () => {
		const bindings = new KeybindingsManager();
		bindings.cc.setBindings([{ keys: ["ctrl+k", "ctrl+y"], action: "app.editor.external" }]);
		const editor = createEditor(false, bindings);
		editor.handleInput("?");
		expect(screen(editor)).toContain("ctrl + k ctrl + y to edit in");
	});
	it("preserves literal question marks in an unconfigured pi editor", () => {
		const bindings = new KeybindingsManager();
		setKeybindings(bindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, bindings);
		editor.handleInput("?");
		expect(editor.getText()).toBe("?");
		expect(screen(editor)).not.toContain("/ for commands");
	});

	it("disabling CC prompt settings closes help and restores literal question marks", () => {
		const editor = createEditor();
		editor.handleInput("?");
		editor.setPromptShortcuts(false);
		expect(screen(editor)).not.toContain("/ for commands");
		editor.handleInput("?");
		expect(editor.getText()).toBe("?");
	});

	it("help keeps cursor-only keys and Escape dismisses without leaving insert mode", () => {
		const editor = createEditor(true);
		editor.handleInput("?");
		editor.handleInput("\x01");
		expect(screen(editor)).toContain("/ for commands");
		editor.handleInput("\x1b");
		expect(screen(editor)).not.toContain("/ for commands");
		expect(editor.getVimMode()).toBe("insert");
	});
	it("Ctrl+C in search restores the draft instead of running app.clear", () => {
		const editor = createEditor(true);
		editor.addToHistory("history match");
		editor.setBuffer("draft", 2);
		let cleared = false;
		editor.onAction("app.clear", () => {
			cleared = true;
		});
		editor.handleInput("\x12");
		editor.handleInput("match");
		editor.handleInput("\x03");
		expect(editor.getText()).toBe("draft");
		expect(editor.getCursorOffset()).toBe(2);
		expect(cleared).toBe(false);
	});

	it("Escape accepts search without leaving insert mode or interrupting", () => {
		const editor = createEditor(true);
		editor.addToHistory("history match");
		let interrupted = false;
		editor.onEscape = () => {
			interrupted = true;
		};
		editor.handleInput("\x12");
		editor.handleInput("match");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("history match");
		expect(editor.getVimMode()).toBe("insert");
		expect(interrupted).toBe(false);
	});

	it("question mark toggles help on empty input without inserting text", () => {
		const editor = createEditor();
		editor.handleInput("?");
		expect(editor.getText()).toBe("");
		expect(screen(editor)).toContain("/ for commands");
		editor.handleInput("?");
		expect(screen(editor)).not.toContain("/ for commands");
	});

	it("typing closes help while question mark on nonempty insert text is literal", () => {
		const editor = createEditor(true);
		editor.handleInput("?");
		expect(screen(editor)).toContain("ctrl + g to edit in $EDITOR");
		expect(screen(editor)).not.toContain("-- INSERT --");
		editor.handleInput("a");
		expect(screen(editor)).not.toContain("/ for commands");
		editor.handleInput("?");
		expect(editor.getText()).toBe("a?");
	});

	it("normal question mark toggles help with nonempty text, but not during a command", () => {
		const editor = createEditor(true);
		editor.handleInput("abc");
		editor.handleInput("\x1b");
		editor.handleInput("d");
		editor.handleInput("?");
		expect(screen(editor)).not.toContain("/ for commands");
		editor.handleInput("?");
		expect(screen(editor)).toContain("/ for commands");
		editor.handleInput("\x1b");
		expect(screen(editor)).not.toContain("/ for commands");
		expect(editor.getText()).toBe("abc");
	});
});
