import type { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { type CcTuiSettings, NO_CC_TUI } from "../src/core/settings/cc/tui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type Method = (this: unknown, ...args: never[]) => unknown;
const method = (name: string): Method => Reflect.get(InteractiveMode.prototype, name) as Method;
const withTui = (ccTui: Partial<CcTuiSettings>) => ({ ccTui: { ...NO_CC_TUI, ...ccTui } });

describe("InteractiveMode Claude Code terminal settings", () => {
	test("the still indicator is one frame for reduced motion and none for screen reader mode", () => {
		const still = method("ccStillIndicator");
		expect(still.call(withTui({}))).toBeUndefined();
		expect(still.call(withTui({ reducedMotion: true }))).toEqual({ frames: ["●"] });
		expect(still.call(withTui({ screenReader: true }))).toEqual({ frames: [] });
		expect(still.call(withTui({ screenReader: true, reducedMotion: true }))).toEqual({ frames: [] });
	});

	test("a rule is drawn normally and omitted in screen reader mode", () => {
		initTheme("dark");
		const newBorder = method("newBorder");
		const drawn = newBorder.call(withTui({})) as Container;
		const flat = newBorder.call(withTui({ screenReader: true })) as Container;
		expect(stripAnsi(drawn.render(10).join(""))).toBe("─".repeat(10));
		expect(flat.render(10)).toEqual([]);
	});

	test("the assistant theme caps prose only when a width is set", () => {
		const assistantTheme = method("getAssistantMarkdownTheme");
		const base = { codeBlockIndent: "  " };
		const getMarkdownThemeWithSettings = () => base;
		expect(assistantTheme.call({ ...withTui({}), getMarkdownThemeWithSettings })).toBe(base);
		expect(assistantTheme.call({ ...withTui({ maxProseWidth: 60 }), getMarkdownThemeWithSettings })).toEqual({
			codeBlockIndent: "  ",
			maxProseWidth: 60,
		});
	});

	test("rebinding a session re-reads the admitted settings, so a directory change is seen", () => {
		const applyCcTui = method("applyCcTui");
		let admitted: CcTuiSettings = { ...NO_CC_TUI, screenReader: true };
		const defaultEditor = { setVimMode: vi.fn(), setFlat: vi.fn() };
		const self = {
			options: { ccTui: () => admitted },
			ccTui: NO_CC_TUI,
			defaultEditor,
			workingIndicatorOptions: undefined,
			setWorkingIndicator: vi.fn(),
		};
		applyCcTui.call(self);
		expect(defaultEditor.setFlat).toHaveBeenLastCalledWith(true);
		admitted = { ...NO_CC_TUI, vim: { insertRemaps: new Map() } };
		applyCcTui.call(self);
		expect(defaultEditor.setFlat).toHaveBeenLastCalledWith(false);
		expect(defaultEditor.setVimMode).toHaveBeenLastCalledWith(admitted.vim);
		expect(self.setWorkingIndicator).toHaveBeenCalledTimes(2);
	});

	test("with no handoff the editor and indicators stay as pi's", () => {
		const applyCcTui = method("applyCcTui");
		const defaultEditor = { setVimMode: vi.fn(), setFlat: vi.fn() };
		const self = { options: {}, ccTui: NO_CC_TUI, defaultEditor, setWorkingIndicator: vi.fn() };
		applyCcTui.call(self);
		expect(self.ccTui).toBe(NO_CC_TUI);
		expect(defaultEditor.setVimMode).toHaveBeenCalledWith(undefined);
		expect(defaultEditor.setFlat).toHaveBeenCalledWith(false);
	});
});
