import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { CcLayer } from "../src/core/keybindings/cc-layer.ts";
import { importCcKeybindings, parseKeySequence, resolveLayer } from "../src/core/keybindings/import-cc.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { KeybindingsSchema } from "../src/core/keybindings-schema.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const roots: string[] = [];
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "cc-keybindings-env-"));
	roots.push(root);
	vi.stubEnv("CLAUDE_CONFIG_DIR", root);
});
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setKeybindings(new KeybindingsManager());
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function load(file: unknown) {
	const root = mkdtempSync(join(tmpdir(), "pi-keybindings-"));
	roots.push(root);
	const path = join(root, "keybindings.json");
	writeFileSync(path, JSON.stringify(file));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	const manager = KeybindingsManager.create(root);
	setKeybindings(manager);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, manager);
	return { path, root, manager, editor };
}

const cc = (bindings: Record<string, string | null>) => ({ bindings: [{ context: "Chat", bindings }] });
const ccGlobal = (bindings: Record<string, string | null>) => ({ bindings: [{ context: "Global", bindings }] });

function writeCcFile(bindings: unknown) {
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "keybindings.json"), JSON.stringify(bindings));
}

const slashProvider = (items: { value: string; label: string }[]) => ({
	getSuggestions: async () => ({ items, prefix: "/" }),
	applyCompletion: (lines: string[], cursorLine: number, _cursorCol: number, item: { value: string }) => ({
		lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
		cursorLine,
		cursorCol: item.value.length,
	}),
});

function newEditor(manager: KeybindingsManager) {
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, manager);
}

/** Records the observable outcome of keystrokes: editor text and which app handlers ran. */
function probe(file: unknown, ccFile?: unknown) {
	if (ccFile !== undefined) writeCcFile(ccFile);
	const { manager, editor } = load(file);
	const events: string[] = [];
	editor.onAction("app.clear", () => events.push("clear"));
	editor.onAction("app.model.select", () => events.push("model"));
	editor.onAction("app.message.copy", () => events.push("copy"));
	editor.onCtrlD = () => events.push("exit");
	editor.onEscape = () => events.push("escape");
	editor.onSubmit = (text) => events.push(`submit:${text}`);
	return {
		manager,
		editor,
		events,
		press(...keys: string[]) {
			for (const key of keys) editor.handleInput(key);
			return { text: editor.getText(), events: [...events] };
		},
	};
}

describe("CC keybinding file import", () => {
	it("validates the CC array envelope and rejects malformed blocks atomically", () => {
		expect(importCcKeybindings({ bindings: {} }, new Set()).diagnostics).toHaveLength(1);
		expect(
			importCcKeybindings({ bindings: [{ context: "Chat", bindings: { enter: 4 } }] }, new Set()).bindings,
		).toEqual([]);
	});

	it("rejects a malformed block on disk without applying an earlier valid block", () => {
		const { manager } = load({
			bindings: [
				{ context: "Chat", bindings: { "ctrl+y": "chat:submit" } },
				{ context: "Chat", bindings: { "ctrl+l": 4 } },
			],
		});
		expect(manager.getImportDiagnostics()).toHaveLength(1);
		expect(manager.cc.active).toBe(false);
	});

	it("ignores unknown CC root fields including help metadata and native action fields", () => {
		const mixed = {
			...cc({ "ctrl+y": "chat:submit" }),
			$docs: "https://example.test",
			future: {},
			"app.model.select": "ctrl+b",
		};
		expect(Compile(KeybindingsSchema).Check(mixed)).toBe(true);
		writeCcFile(mixed);
		const t = probe({});
		expect(t.manager.getImportDiagnostics()).toEqual([]);
		expect(t.manager.cc.getBindings().map((binding) => binding.keys)).toEqual([["ctrl+y"]]);
		expect(t.press("\x02").events).toEqual([]);
	});

	it.each([
		["control+k", "ctrl+k"],
		["cmd+k", "super+k"],
		["command+k", "super+k"],
		["win+k", "super+k"],
		["super+k", "super+k"],
		["del", "delete"],
		["↑", "up"],
		["↓", "down"],
		["←", "left"],
		["→", "right"],
	])("normalizes CC alias %s", (key, expected) => {
		expect(parseKeySequence(key)).toEqual([expected]);
	});

	it("normalizes aliases and validates each stroke", () => {
		expect(parseKeySequence(" Opt+K   CTRL+S ")).toEqual(["alt+k", "ctrl+s"]);
		expect(parseKeySequence("meta+PageUp")).toEqual(["alt+pageUp"]);
		expect(parseKeySequence(" ")).toEqual(["space"]);
		for (const invalid of ["", "ctrl+ctrl+k", "ctrl+unknown", "ctrl+k ctrl+unknown", "ctrl++k"]) {
			expect(parseKeySequence(invalid)).toBeUndefined();
		}
	});

	it.each([
		["chat:submit", "tui.input.submit"],
		["chat:newline", "tui.input.newLine"],
		["chat:undo", "tui.editor.undo"],
		["chat:imagePaste", "app.clipboard.pasteImage"],
		["history:previous", "tui.editor.cursorUp"],
		["history:next", "tui.editor.cursorDown"],
		["chat:cancel", "app.interrupt"],
		["chat:modelPicker", "app.model.select"],
		["chat:externalEditor", "app.editor.external"],
		["app:exit", "app.exit"],
	])("maps %s to %s", (action, expected) => {
		expect(importCcKeybindings(cc({ "ctrl+y": action }), new Set()).bindings[0]?.action).toBe(expected);
	});

	it.each(["chat:thinkingToggle", "app:interrupt"])("leaves %s unmapped with a warning", (action) => {
		const imported = importCcKeybindings(cc({ "meta+t": action }), new Set());
		expect(imported.bindings).toEqual([]);
		expect(imported.warnings).toEqual([`Unsupported keybinding action: ${action}`]);
	});

	it("reports unsupported actions and contexts without creating bindings", () => {
		const { bindings, warnings } = importCcKeybindings(
			{
				bindings: [
					{ context: "Unknown", bindings: { enter: "chat:submit" } },
					{ context: "Chat", bindings: { "ctrl+s": "chat:stash", "ctrl+unknown": "chat:submit" } },
				],
			},
			new Set(),
		);
		expect(bindings).toEqual([]);
		expect(warnings).toHaveLength(3);
	});

	it("does not treat object prototype properties as action aliases", () => {
		const imported = importCcKeybindings(cc({ "ctrl+k": "constructor", "ctrl+s": "__proto__" }), new Set());
		expect(imported.bindings).toEqual([]);
		expect(imported.warnings).toHaveLength(2);
	});

	it("takes the last declaration per sequence and drops nulls from the layer", () => {
		const imported = importCcKeybindings(
			{
				bindings: [
					{ context: "Global", bindings: { "ctrl+k": "chat:submit", "shift+ctrl+p": "chat:undo" } },
					{ context: "Chat", bindings: { "ctrl+k": "chat:newline", "ctrl+shift+p": null } },
				],
			},
			new Set(),
		);
		expect(resolveLayer(imported.bindings)).toEqual([{ keys: ["ctrl+k"], action: "tui.input.newLine" }]);
	});

	it("loads CC's file from CLAUDE_CONFIG_DIR, then layers a pi-dir envelope after it", () => {
		writeCcFile(cc({ "ctrl+y": "chat:submit", "ctrl+b": "chat:submit" }));
		const { manager } = load(cc({ "ctrl+b": "chat:modelPicker" }));
		expect(manager.cc.getBindings()).toEqual([
			{ keys: ["ctrl+y"], action: "tui.input.submit" },
			{ keys: ["ctrl+b"], action: "app.model.select" },
		]);
	});

	it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty", () => {
		const home = mkdtempSync(join(tmpdir(), "cc-keybindings-home-"));
		roots.push(home);
		vi.stubEnv("HOME", home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", "");
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".claude", "keybindings.json"), JSON.stringify(cc({ "ctrl+y": "chat:submit" })));
		expect(load({}).manager.cc.getBindings()).toEqual([{ keys: ["ctrl+y"], action: "tui.input.submit" }]);
	});

	it("provides source-qualified import diagnostics only for unreadable files, and logs entries", () => {
		const { path, root, manager } = load(cc({ "ctrl+y": "unknown:action" }));
		expect(manager.getImportDiagnostics()).toEqual([]);
		expect(readFileSync(join(root, "pi-debug.log"), "utf-8")).toContain(
			`${path}: Unsupported keybinding action: unknown:action`,
		);
		const broken = mkdtempSync(join(tmpdir(), "cc-keybindings-broken-"));
		roots.push(broken);
		vi.stubEnv("CLAUDE_CONFIG_DIR", broken);
		writeFileSync(join(broken, "keybindings.json"), "{oops");
		expect(load({}).manager.getImportDiagnostics()).toEqual([
			`${join(broken, "keybindings.json")}: CC keybindings file could not be read as JSON`,
		]);
	});

	it("publishes a schema for pi's action file and the CC envelope", () => {
		const schema = Compile(KeybindingsSchema);
		expect(schema.Check(cc({ "ctrl+k ctrl+s": "chat:submit", enter: null }))).toBe(true);
		expect(schema.Check({ "app.model.select": ["ctrl+l"] })).toBe(true);
		expect(schema.Check({ bindings: {} })).toBe(false);
		expect(schema.Check({ bindings: ["ctrl+k"] })).toBe(false);
	});
});

describe("pi behavior is unchanged by the CC layer", () => {
	it("leaves the layer inactive and the effective config equal to pi's without a CC file", () => {
		const { manager } = load({ "app.exit": "ctrl+d", "tui.input.newLine": "ctrl+c" });
		expect(manager.cc.active).toBe(false);
		expect(manager.getEffectiveConfig()).toEqual(manager.getResolvedBindings());
	});

	it("never alters pi's bindings when a CC file loads", () => {
		const piOnly = load({ "app.exit": "ctrl+d" }).manager.getResolvedBindings();
		const withCc = probe(
			{ "app.exit": "ctrl+d" },
			cc({ enter: null, "ctrl+c": "chat:newline", "ctrl+d": "app:exit" }),
		);
		expect(withCc.manager.getResolvedBindings()).toEqual(piOnly);
	});

	const script = ["a", "b", "\x01", "\x04", "\x03", "\x0c", "\r", "\x1f", "\x1b[A", "\x1b[B", "\x1b", "\x18"];
	it.each([
		["pi file reassigns newline onto Ctrl+C", { "tui.input.newLine": "ctrl+c" }],
		["pi file restates app.exit on Ctrl+D", { "app.exit": "ctrl+d" }],
		["pi file moves submit", { "tui.input.submit": "ctrl+y" }],
	])("behaves as the pi file alone when an unrelated CC file is present: %s", (_name, piFile) => {
		const alone = probe(piFile);
		const aloneOutcomes = script.map((key) => alone.press(key));
		const ccDir = process.env.CLAUDE_CONFIG_DIR!;
		writeFileSync(join(ccDir, "keybindings.json"), JSON.stringify(cc({ "ctrl+n": "chat:undo" })));
		const withCc = probe(piFile);
		expect(script.map((key) => withCc.press(key))).toEqual(aloneOutcomes);
	});

	it("behaves like no CC file under CC's full default table except for the chord prefix it adds", () => {
		const defaults = {
			bindings: [
				{ context: "Global", bindings: { "ctrl+c": "app:interrupt", "ctrl+d": "app:exit" } },
				{
					context: "Chat",
					bindings: {
						enter: "chat:submit",
						"ctrl+j": "chat:newline",
						"ctrl+-": "chat:undo",
						up: "history:previous",
						down: "history:next",
						escape: "chat:cancel",
						"ctrl+g": "chat:externalEditor",
						"ctrl+v": "chat:imagePaste",
						"ctrl+l": "chat:modelPicker",
						"ctrl+x ctrl+e": "chat:externalEditor",
					},
				},
			],
		};
		const keys = ["a", "b", "c", "\x01", "\x04", "\x03", "\x0c", "\x1f", "\x1b[A", "\x1b[B", "\x1b", "\r"];
		const base = probe({});
		const expected = keys.map((key) => base.press(key));
		const imported = probe({}, defaults);
		expect(keys.map((key) => imported.press(key))).toEqual(expected);
		expect(imported.manager.getEffectiveConfig()["app.editor.external"]).toContain("ctrl+x");
	});
});

describe("imported keys dispatch before pi handling", () => {
	it("runs the mapped pi action for an imported key and consumes it", () => {
		const t = probe({}, cc({ "ctrl+y": "chat:submit", "ctrl+l": "chat:modelPicker" }));
		t.editor.setText("draft");
		expect(t.press("\x19").events).toEqual(["submit:draft"]);
		expect(t.press("\x0c").events).toEqual(["submit:draft", "model"]);
	});

	it("takes precedence over pi's default binding of the same key", () => {
		const t = probe({}, cc({ "ctrl+c": "chat:newline" }));
		t.editor.setText("a");
		expect(t.press("\x03")).toEqual({ text: "a\n", events: [] });
	});

	it("yields to a key the pi keybindings file binds", () => {
		const t = probe({ "app.model.select": "ctrl+y" }, cc({ "ctrl+y": "chat:submit", "ctrl+l": "chat:undo" }));
		t.editor.setText("draft");
		expect(t.press("\x19")).toEqual({ text: "draft", events: ["model"] });
		expect(t.manager.cc.getBindings()).toEqual([{ keys: ["ctrl+l"], action: "tui.editor.undo" }]);
	});

	it("yields a whole chord whose first stroke the pi file binds", () => {
		const t = probe({ "app.model.select": "ctrl+k" }, cc({ "ctrl+k ctrl+s": "chat:submit" }));
		t.editor.setText("draft");
		expect(t.press("\x0b")).toEqual({ text: "draft", events: ["model"] });
		expect(t.press("\x13").events).toEqual(["model"]);
	});

	it("matches a CC alias spelling of the pi-bound key", () => {
		const t = probe({ "app.model.select": ["ctrl+y"] }, cc({ "control+y": "chat:submit" }));
		t.editor.setText("draft");
		expect(t.press("\x19").events).toEqual(["model"]);
	});

	it("lets a pi action name in a CC file dispatch without disturbing other keys", () => {
		const t = probe({}, cc({ "ctrl+c": "tui.input.newLine" }));
		t.editor.setText("a");
		expect(t.press("\x03")).toEqual({ text: "a\n", events: [] });
		expect(t.press("\x0c").events).toEqual(["model"]);
	});

	it("keeps Ctrl+C clearing when chat:newline is bound and then nulled on it", () => {
		const t = probe(
			{},
			{
				bindings: [
					{ context: "Chat", bindings: { "ctrl+c": "chat:newline" } },
					{ context: "Chat", bindings: { "ctrl+c": null } },
				],
			},
		);
		t.editor.setText("a");
		expect(t.press("\x03")).toEqual({ text: "a", events: ["clear"] });
	});

	it.each([
		["ctrl+c", "\x03"],
		["ctrl+d", "\x04"],
		["ctrl+l", "\x0c"],
	])("inserts a newline for chat:newline on %s", (key, data) => {
		const t = probe({}, cc({ [key]: "chat:newline" }));
		t.editor.setText("abc");
		t.press("\x01");
		expect(t.press(data)).toEqual({ text: "\nabc", events: [] });
	});

	it("leaves other input keys alone when chat:newline takes Ctrl+D", () => {
		const t = probe({}, cc({ "ctrl+d": "chat:newline" }));
		t.editor.setText("abc");
		expect(t.press("\x01", "\x1b[3~").text).toBe("bc");
		expect(t.press("\x03").events).toEqual(["clear"]);
	});

	it("runs undo and the history pair as the matching pi editor actions", () => {
		const t = probe({}, cc({ "ctrl+y": "chat:undo", "ctrl+n": "history:previous" }));
		t.press("a", "b");
		t.editor.setText("one\ntwo");
		expect(t.press("\x0e").text).toBe("one\ntwo");
	});
});

describe("declining actions fall through to pi", () => {
	it("deletes forward on a non-empty prompt and exits on an empty one with CC app:exit on Ctrl+D", () => {
		const t = probe({}, ccGlobal({ "ctrl+d": "app:exit" }));
		t.editor.setText("abc");
		expect(t.press("\x01", "\x04")).toEqual({ text: "bc", events: [] });
		const empty = probe({}, ccGlobal({ "ctrl+d": "app:exit" }));
		expect(empty.press("\x04").events).toEqual(["exit"]);
	});

	it("deletes forward when a pi file restates app.exit beside a CC file", () => {
		const t = probe({ "app.exit": "ctrl+d" }, cc({ "ctrl+y": "chat:submit" }));
		t.editor.setText("abc");
		expect(t.press("\x01", "\x04").text).toBe("bc");
	});

	it("keeps Ctrl+C clearing when CC imports app:exit on it, and exits only on an empty prompt", () => {
		const t = probe({}, cc({ "ctrl+c": "app:exit" }));
		t.editor.setText("abc");
		expect(t.press("\x03").events).toEqual(["clear"]);
		t.editor.setText("");
		expect(t.press("\x03").events).toEqual(["clear", "exit"]);
	});
});

describe("null removes only the CC layer's key", () => {
	it("keeps Return submitting under a lone null", () => {
		expect(probe({}, cc({ enter: null })).press("h", "\r").events).toEqual(["submit:h"]);
	});

	it("keeps Return submitting when a later null follows a restated submit", () => {
		const t = probe(
			{},
			{
				bindings: [
					{ context: "Chat", bindings: { enter: "chat:submit" } },
					{ context: "Chat", bindings: { enter: null } },
				],
			},
		);
		expect(t.press("h", "\r").events).toEqual(["submit:h"]);
	});

	it("keeps Ctrl+C, Ctrl+D and undo working under nulls on them", () => {
		const t = probe({}, cc({ "ctrl+c": null, "ctrl+d": null, "ctrl+-": null }));
		t.editor.setText("abc");
		expect(t.press("\x03").events).toEqual(["clear"]);
		expect(t.press("\x01", "\x04").text).toBe("bc");
	});

	it("removes an imported binding on the same sequence and not pi's key", () => {
		const t = probe(
			{},
			{
				bindings: [
					{ context: "Global", bindings: { "ctrl+y": "chat:submit" } },
					{ context: "Chat", bindings: { "ctrl+y": null } },
				],
			},
		);
		t.editor.setText("draft");
		expect(t.press("\x19").events).toEqual([]);
	});
});

describe("autocomplete keys win while the menu is open", () => {
	const items = ["/command-0", "/command-1", "/command-2"].map((value) => ({ value, label: value }));
	const openMenu = async (t: ReturnType<typeof probe>) => {
		t.editor.setAutocompleteProvider(slashProvider(items));
		t.editor.handleInput("/");
		await vi.waitFor(() => expect(t.editor.isShowingAutocomplete()).toBe(true));
	};

	it("confirms /mod with Enter after CC restates enter", async () => {
		const t = probe({}, cc({ enter: "chat:submit" }));
		t.editor.setAutocompleteProvider(slashProvider([{ value: "/model", label: "model" }]));
		t.press("/", "m", "o", "d");
		await vi.waitFor(() => expect(t.editor.isShowingAutocomplete()).toBe(true));
		expect(t.press("\r").events).toEqual(["submit:/model"]);
	});

	it("confirms with Enter when CC binds Ctrl+Y and the pi file restates submit", async () => {
		const t = probe({ "tui.input.submit": "enter" }, cc({ "ctrl+y": "chat:submit" }));
		await openMenu(t);
		expect(t.press("\r").events).toEqual(["submit:/command-0"]);
		t.editor.setText("draft");
		expect(t.press("\x19").events).toEqual(["submit:/command-0", "submit:draft"]);
	});

	it("navigates the menu with Up and Down despite CC's history pair", async () => {
		const t = probe({}, cc({ up: "history:previous", down: "history:next" }));
		await openMenu(t);
		t.press("\x1b[B", "\x1b[A", "\x1b[B");
		expect(t.press("\r").events).toEqual(["submit:/command-1"]);
	});

	it("dismisses the menu with Escape instead of running chat:cancel", async () => {
		const t = probe({}, cc({ escape: "chat:cancel" }));
		await openMenu(t);
		t.press("\x1b");
		expect(t.editor.isShowingAutocomplete()).toBe(false);
		expect(t.events).toEqual([]);
		expect(t.press("\x1b").events).toEqual(["escape"]);
	});

	it("moves the multiline cursor up with CC's history restate instead of browsing history", () => {
		const t = probe({}, cc({ up: "history:previous", down: "history:next" }));
		t.editor.addToHistory("queued entry");
		t.editor.setText("one\ntwo");
		expect(t.press("\x1b[A").text).toBe("one\ntwo");
	});
});

describe("prompt chords", () => {
	it("shows pending and timeout feedback in the prompt border", () => {
		vi.useFakeTimers();
		const { editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		editor.handleInput("\x0b");
		expect(editor.render(80).join("\n")).toContain("Waiting for next key");
		vi.advanceTimersByTime(3000);
		expect(editor.render(80).join("\n")).toContain("Chord cancelled");
		vi.advanceTimersByTime(3000);
		expect(editor.render(80).join("\n")).not.toContain("Chord cancelled");
	});

	it("consumes a prefix and submits only after its final stroke", () => {
		const t = probe({}, cc({ "ctrl+k ctrl+s": "chat:submit" }));
		t.editor.setText("draft");
		expect(t.press("\x0b")).toEqual({ text: "draft", events: [] });
		expect(t.press("\x13").events).toEqual(["submit:draft"]);
	});

	it("dispatches an app chord once", () => {
		const t = probe({}, cc({ "ctrl+k ctrl+m": "chat:modelPicker" }));
		expect(t.press("\x0b", "\r").events).toEqual(["model"]);
	});

	it("keeps an unbound chord's prefix and next keystroke working", () => {
		const t = probe({}, cc({ "ctrl+x ctrl+k": null }));
		expect(t.press("\x18").events).toEqual(["copy"]);
		expect(t.editor.render(80).join("\n")).not.toContain("Waiting for next key");
		expect(t.press("q").text).toBe("q");
	});

	it("hides the prefix key's pi action only while a longer binding exists", () => {
		const t = probe({}, cc({ "ctrl+x ctrl+e": "chat:externalEditor" }));
		expect(t.press("\x18").events).toEqual([]);
		expect(t.editor.render(80).join("\n")).toContain("Waiting for next key");
	});

	it("swallows a mismatching stroke and does not restart on a repeated prefix", () => {
		const t = probe({}, cc({ "ctrl+k ctrl+s": "chat:submit" }));
		t.editor.setText("draft");
		t.press("\x0b", "x", "\x0b", "\x0b", "\x13");
		expect(t.events).toEqual([]);
		expect(t.editor.getText()).toBe("draft");
	});

	it("swallows Escape after a prefix even if Escape is a configured suffix", () => {
		const t = probe({}, cc({ "ctrl+k escape": "chat:modelPicker" }));
		expect(t.press("\x0b", "\x1b").events).toEqual([]);
	});

	it("clears a pending chord when an extension consumes input", () => {
		const t = probe({}, cc({ "ctrl+k ctrl+s": "chat:modelPicker" }));
		t.editor.onExtensionShortcut = (data) => data === "x";
		expect(t.press("\x0b", "x", "\x13").events).toEqual([]);
	});

	it("shows chord status only on the editor that received the prefix", () => {
		const { manager, editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		const second = newEditor(manager);
		editor.handleInput("\x0b");
		expect(editor.render(80).join("\n")).toContain("Waiting for next key");
		expect(second.render(80).join("\n")).not.toContain("Waiting for next key");
		second.handleInput("\x13");
		expect(editor.render(80).join("\n")).not.toContain("Waiting for next key");
	});

	it("expires pending prefixes without treating a late suffix as completion", () => {
		const layer = new CcLayer();
		layer.setBindings([{ keys: ["ctrl+k", "ctrl+s"], action: "tui.input.submit" }]);
		expect(layer.dispatch("\x0b", undefined, 0)).toEqual({ kind: "pending" });
		expect(layer.dispatch("\x13", undefined, 2999)).toEqual({ kind: "action", action: "tui.input.submit" });
		layer.dispatch("\x0b", undefined, 4000);
		expect(layer.dispatch("\x13", undefined, 7000)).toEqual({ kind: "none" });
	});

	it("resets a pending chord on reload", () => {
		const { path, manager, editor } = load(cc({ "ctrl+k ctrl+s": "chat:modelPicker" }));
		let count = 0;
		editor.onAction("app.model.select", () => count++);
		editor.handleInput("\x0b");
		writeFileSync(path, JSON.stringify(cc({ "ctrl+k ctrl+s": "chat:modelPicker" })));
		manager.reload();
		editor.handleInput("\x13");
		expect(count).toBe(0);
	});

	it("logs when an imported chord prefix hides a pi single-key action", () => {
		const { root } = load(cc({ "ctrl+x ctrl+e": "chat:externalEditor" }));
		expect(readFileSync(join(root, "pi-debug.log"), "utf-8")).toContain(
			`imported chord prefix "ctrl+x" hides pi action "app.message.copy"`,
		);
	});
});

describe("extension shortcut conflicts", () => {
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
			expect(shortcuts.has("ctrl+l")).toBe(false);
			expect(shortcuts.has("ctrl+c")).toBe(false);
			expect(shortcuts.has("ctrl+f")).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("adds imported first strokes to the effective config without changing pi's own keys", () => {
		const { manager } = load(cc({ "ctrl+y": "chat:submit", "ctrl+b ctrl+s": "chat:modelPicker" }));
		const config = manager.getEffectiveConfig();
		expect(config["tui.input.submit"]).toEqual(["enter", "ctrl+y"]);
		expect(config["app.model.select"]).toEqual(["ctrl+l", "ctrl+b"]);
		expect(manager.getKeys("tui.input.submit")).toEqual(["enter"]);
	});
});
