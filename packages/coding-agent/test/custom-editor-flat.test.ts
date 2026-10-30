import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createEditor() {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	editor.setText("hello");
	return editor;
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("CustomEditor flat mode", () => {
	it("draws rules above and below the prompt by default", () => {
		const lines = plain(createEditor().render(20));
		expect(lines[0]).toBe("─".repeat(20));
		expect(lines[lines.length - 1]).toBe("─".repeat(20));
	});

	it("leaves the rules out and keeps the prompt text in flat mode", () => {
		const editor = createEditor();
		editor.setFlat(true);
		const lines = plain(editor.render(20));
		expect(lines.join("\n")).not.toContain("─");
		expect(lines.join("\n")).toContain("hello");
		editor.setFlat(false);
		expect(plain(editor.render(20))[0]).toBe("─".repeat(20));
	});
});
