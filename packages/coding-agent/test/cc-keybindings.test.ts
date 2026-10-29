import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ChordResolver } from "../src/core/keybindings/chords.ts";
import { importCcKeybindings, parseKeySequence, resolveBindings } from "../src/core/keybindings/import-cc.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { KeybindingsSchema } from "../src/core/keybindings-schema.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setKeybindings(new KeybindingsManager());
});

function load(file: unknown) {
	const root = mkdtempSync(join(tmpdir(), "pi-keybindings-"));
	roots.push(root);
	const path = join(root, "keybindings.json");
	writeFileSync(path, JSON.stringify(file));
	const manager = KeybindingsManager.create(root);
	setKeybindings(manager);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, manager);
	return { path, manager, editor };
}

const cc = (bindings: Record<string, string | null>) => ({ bindings: [{ context: "Chat", bindings }] });

describe("CC keybinding file import", () => {
	it("validates the CC array envelope and rejects malformed blocks atomically", () => {
		expect(importCcKeybindings({ bindings: {} }, new Set()).diagnostics).toHaveLength(1);
		expect(
			importCcKeybindings({ bindings: [{ context: "Chat", bindings: { enter: 4 } }] }, new Set()).bindings,
		).toEqual([]);
	});

	it("normalizes aliases and validates each stroke", () => {
		expect(parseKeySequence(" Opt+K   CTRL+S ")).toEqual(["alt+k", "ctrl+s"]);
		expect(parseKeySequence("meta+PageUp")).toEqual(["alt+pageUp"]);
		for (const invalid of ["", "ctrl+ctrl+k", "ctrl+unknown", "ctrl+k ctrl+unknown", "ctrl++k"]) {
			expect(parseKeySequence(invalid)).toBeUndefined();
		}
	});

	it("reports unsupported actions and contexts without enabling them globally", () => {
		const { bindings, diagnostics } = importCcKeybindings(
			{
				bindings: [
					{ context: "Unknown", bindings: { enter: "chat:submit" } },
					{ context: "Chat", bindings: { "ctrl+s": "chat:stash", "ctrl+unknown": "chat:submit" } },
				],
			},
			new Set(),
		);
		expect(bindings).toEqual([]);
		expect(diagnostics).toHaveLength(3);
	});

	it("applies ordered null unbinding and keeps Chat declarations out of Global", () => {
		const imported = importCcKeybindings(
			{
				bindings: [
					{ context: "Global", bindings: { "ctrl+k": "chat:submit" } },
					{ context: "Chat", bindings: { "ctrl+k": null } },
				],
			},
			new Set(),
		);
		expect(resolveBindings([], imported.bindings, "Global")[0]?.action).toBe("tui.input.submit");
		expect(resolveBindings([], imported.bindings, "Chat")[0]?.action).toBeNull();
	});

	it("publishes schemas for native sequences and the CC envelope", () => {
		const schema = Compile(KeybindingsSchema);
		expect(schema.Check(cc({ "ctrl+k ctrl+s": "chat:submit", enter: null }))).toBe(true);
		expect(schema.Check({ "app.model.select": ["ctrl+k ctrl+s", "ctrl+l"] })).toBe(true);
		expect(schema.Check({ "app.model.select": "ctrl+k ctrl+ctrl+s" })).toBe(false);
		expect(schema.Check({ bindings: {} })).toBe(false);
		expect(schema.Check({ bindings: ["ctrl+k"] })).toBe(false);
	});
});

describe("prompt chord dispatch", () => {
	it("does not treat object prototype properties as action aliases", () => {
		const imported = importCcKeybindings(cc({ "ctrl+k": "constructor", "ctrl+s": "__proto__" }), new Set());
		expect(imported.bindings).toEqual([]);
		expect(imported.diagnostics).toHaveLength(2);
	});
	it("consumes a prefix and submits only after its final stroke", () => {
		const { editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\x0b");
		expect(editor.getText()).toBe("draft");
		expect(submitted).toEqual([]);
		editor.handleInput("\x13");
		expect(submitted).toEqual(["draft"]);
	});

	it("dispatches an app chord once despite repeated matches calls", () => {
		const { editor } = load(cc({ "ctrl+k ctrl+m": "chat:modelPicker" }));
		let count = 0;
		editor.onAction("app.model.select", () => count++);
		editor.handleInput("\x0b");
		editor.handleInput("\r");
		expect(count).toBe(1);
	});

	it("honors null unbindings and sequence reassignment", () => {
		const { editor } = load(cc({ enter: null, "ctrl+l": "chat:submit" }));
		let models = 0;
		const submitted: string[] = [];
		editor.onAction("app.model.select", () => models++);
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\r");
		expect(submitted).toEqual([]);
		editor.handleInput("\x0c");
		expect(submitted).toEqual(["draft"]);
		expect(models).toBe(0);
	});

	it("reprocesses a mismatching stroke and a new chord prefix", () => {
		const { editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\x0b");
		editor.handleInput("x");
		expect(editor.getText()).toBe("draftx");
		editor.handleInput("\x0b");
		editor.handleInput("\x0b");
		editor.handleInput("\x13");
		expect(submitted).toEqual(["draftx"]);
	});

	it("clears a pending chord when an extension consumes input", () => {
		const { editor } = load(cc({ "ctrl+k ctrl+s": "chat:modelPicker" }));
		let count = 0;
		editor.onAction("app.model.select", () => count++);
		editor.onExtensionShortcut = (data) => data === "x";
		editor.handleInput("\x0b");
		editor.handleInput("x");
		editor.handleInput("\x13");
		expect(count).toBe(0);
	});

	it("matches modifier permutations when unbinding a default", () => {
		const { manager } = load(cc({ "ctrl+shift+p": null }));
		expect(manager.getPromptKeys("app.model.cycleBackward")).not.toContain("shift+ctrl+p");
	});

	it("expires pending prefixes without treating a late suffix as completion", () => {
		const resolver = new ChordResolver();
		const bindings = importCcKeybindings(cc({ "ctrl+k ctrl+s": "chat:submit" }), new Set()).bindings;
		expect(resolver.resolve("\x0b", bindings, 0)).toEqual({ kind: "pending" });
		expect(resolver.resolve("\x13", bindings, 1000)).toEqual({ kind: "input", actions: new Set() });
	});

	it("imports native named-action chords alongside ordinary bindings and resets on reload", () => {
		const { path, manager, editor } = load({ "app.model.select": ["ctrl+k ctrl+s", "ctrl+l"] });
		expect(manager.getPromptKeys("app.model.select")).toEqual(["ctrl+l", "ctrl+k ctrl+s"]);
		let count = 0;
		editor.onAction("app.model.select", () => count++);
		editor.handleInput("\x0c");
		editor.handleInput("\x0b");
		editor.handleInput("\x13");
		expect(count).toBe(2);
		editor.handleInput("\x0b");
		writeFileSync(path, JSON.stringify(cc({ "ctrl+k ctrl+s": "chat:submit" })));
		manager.reload();
		editor.handleInput("\x13");
		expect(count).toBe(2);
	});

	it("restores match scope when a handler throws", () => {
		const { manager } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		expect(() =>
			manager.dispatchInput("\r", "Chat", () => {
				throw new Error("handler");
			}),
		).toThrow("handler");
		expect(manager.matches("\x0c", "app.model.select")).toBe(true);
	});
});
