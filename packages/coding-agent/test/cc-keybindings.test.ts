import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ChordResolver } from "../src/core/keybindings/chords.ts";
import { importCcKeybindings, parseKeySequence, resolveBindings } from "../src/core/keybindings/import-cc.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { KeybindingsSchema } from "../src/core/keybindings-schema.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

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

	it("rejects mixed native and CC root fields with diagnostics", () => {
		const mixed = { ...cc({ "ctrl+y": "chat:submit" }), "app.model.select": "ctrl+b" };
		expect(Compile(KeybindingsSchema).Check(mixed)).toBe(false);
		const { manager } = load(mixed);
		expect(manager.getImportDiagnostics()).toEqual([
			"Unsupported CC keybinding root field: app.model.select. Native and CC file formats cannot be mixed",
		]);
		expect(manager.getPromptKeys("tui.input.submit")).not.toContain("ctrl+y");
		expect(manager.getPromptKeys("app.model.select")).not.toContain("ctrl+b");
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

	it.each([
		["esc", "escape"],
		["escape", "esc"],
		["return", "enter"],
		["enter", "return"],
	] as const)("unbinds native %s with CC %s", (native, imported) => {
		const overrides = importCcKeybindings(cc({ [imported]: null }), new Set()).bindings;
		expect(
			resolveBindings([{ context: "Global", keys: [native], action: "tui.input.submit" }], overrides, "Chat"),
		).toEqual([
			{ context: "Chat", keys: [imported === "esc" || imported === "escape" ? "escape" : "enter"], action: null },
		]);
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

	it("exposes imported prompt keys and chord prefixes to extension conflict checks", () => {
		const { manager } = load(cc({ "ctrl+y": "chat:submit", "ctrl+b ctrl+s": "chat:modelPicker", "ctrl+l": null }));
		const config = manager.getEffectiveConfig();
		expect(config["tui.input.submit"]).toContain("ctrl+y");
		expect(config["app.model.select"]).toContain("ctrl+b");
		expect(config["app.model.select"]).not.toContain("ctrl+l");
		expect(manager.matches("\x0c", "app.model.select")).toBe(true);
		expect(manager.getKeys("tui.input.submit")).toEqual(["enter"]);
	});

	it("blocks extension shortcuts for imported reserved keys and chord prefixes", async () => {
		const { manager } = load(cc({ "ctrl+y": "chat:submit", "ctrl+b ctrl+s": "chat:modelPicker", "ctrl+l": null }));
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				for (const key of ["ctrl+y", "ctrl+b", "ctrl+l", "ctrl+c", "ctrl+f"] as const) {
					pi.registerShortcut(key, { handler: async () => {} });
				}
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const shortcuts = runner.getShortcuts(manager.getEffectiveConfig());
			expect(shortcuts.has("ctrl+y")).toBe(false);
			expect(shortcuts.has("ctrl+b")).toBe(false);
			expect(shortcuts.has("ctrl+c")).toBe(false);
			expect(shortcuts.has("ctrl+l")).toBe(true);
			expect(shortcuts.has("ctrl+f")).toBe(true);
		} finally {
			warn.mockRestore();
		}
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
