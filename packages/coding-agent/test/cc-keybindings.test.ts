import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Keybinding, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { type Binding, ChordResolver } from "../src/core/keybindings/chords.ts";
import { importCcKeybindings, parseKeySequence, resolveBindings } from "../src/core/keybindings/import-cc.ts";
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

describe("CC keybinding file import", () => {
	it("validates the CC array envelope and rejects malformed blocks atomically", () => {
		expect(importCcKeybindings({ bindings: {} }, new Set()).diagnostics).toHaveLength(1);
		expect(
			importCcKeybindings({ bindings: [{ context: "Chat", bindings: { enter: 4 } }] }, new Set()).bindings,
		).toEqual([]);
	});

	it("rejects a malformed block on disk without applying an earlier valid block", () => {
		const { manager, editor } = load({
			bindings: [
				{ context: "Chat", bindings: { enter: null, "ctrl+y": "chat:submit" } },
				{ context: "Chat", bindings: { "ctrl+l": 4 } },
			],
		});
		expect(manager.getImportDiagnostics()).toHaveLength(1);
		expect(manager.getPromptKeys("tui.input.submit")).toEqual(["enter"]);
		expect(manager.getPromptKeys("app.model.select")).toEqual(["ctrl+l"]);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\r");
		expect(submitted).toEqual(["draft"]);
	});

	it("ignores unknown CC root fields including help metadata", () => {
		const mixed = {
			...cc({ "ctrl+y": "chat:submit" }),
			$docs: "https://example.test",
			future: {},
			"app.model.select": "ctrl+b",
		};
		expect(Compile(KeybindingsSchema).Check(mixed)).toBe(true);
		const { manager } = load(mixed);
		expect(manager.getImportDiagnostics()).toEqual([]);
		expect(manager.getPromptKeys("tui.input.submit")).toContain("ctrl+y");
		expect(manager.getPromptKeys("app.model.select")).not.toContain("ctrl+b");
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

	it("loads CC config separately and lets pi native assignments win conflicts", () => {
		const ccDir = mkdtempSync(join(tmpdir(), "cc-keybindings-"));
		roots.push(ccDir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", ccDir);
		writeFileSync(
			join(ccDir, "keybindings.json"),
			JSON.stringify(cc({ "ctrl+y": "chat:submit", "ctrl+b": "chat:submit" })),
		);
		const { manager } = load({ "app.model.select": "ctrl+b" });
		expect(manager.getPromptKeys("tui.input.submit")).toContain("ctrl+y");
		expect(manager.getPromptKeys("tui.input.submit")).not.toContain("ctrl+b");
		expect(manager.getPromptKeys("app.model.select")).toContain("ctrl+b");
	});

	it("falls back to ~/.claude and layers a pi CC envelope last", () => {
		const home = mkdtempSync(join(tmpdir(), "cc-keybindings-home-"));
		roots.push(home);
		vi.stubEnv("HOME", home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", "");
		mkdirSync(join(home, ".claude"));
		writeFileSync(
			join(home, ".claude", "keybindings.json"),
			JSON.stringify(cc({ "ctrl+y": "chat:submit", "ctrl+b": "chat:submit" })),
		);
		const { manager } = load(cc({ "ctrl+b": "chat:modelPicker" }));
		expect(manager.getPromptKeys("tui.input.submit")).toContain("ctrl+y");
		expect(manager.getPromptKeys("tui.input.submit")).not.toContain("ctrl+b");
		expect(manager.getPromptKeys("app.model.select")).toContain("ctrl+b");
	});

	it.each([
		["chat:newline", "tui.input.newLine"],
		["chat:undo", "tui.editor.undo"],
		["chat:imagePaste", "app.clipboard.pasteImage"],
		["history:previous", "tui.editor.cursorUp"],
		["history:next", "tui.editor.cursorDown"],
	])("maps %s to its pi action", (action, expected) => {
		expect(importCcKeybindings(cc({ "ctrl+y": action }), new Set()).bindings[0]?.action).toBe(expected);
	});

	it.each(["chat:thinkingToggle", "app:interrupt"])("leaves %s unmapped with a warning", (action) => {
		const imported = importCcKeybindings(cc({ "meta+t": action }), new Set());
		expect(imported.bindings).toEqual([]);
		expect(imported.warnings).toEqual([`Unsupported keybinding action: ${action}`]);
	});

	it("treats all CC root metadata as opaque and accepts CC's literal space spelling", () => {
		expect(importCcKeybindings({ ...cc({ "ctrl+y": "chat:submit" }), $schema: 42 }, new Set()).bindings).toHaveLength(
			1,
		);
		expect(parseKeySequence(" ")).toEqual(["space"]);
	});

	it("normalizes aliases and validates each stroke", () => {
		expect(parseKeySequence(" Opt+K   CTRL+S ")).toEqual(["alt+k", "ctrl+s"]);
		expect(parseKeySequence("meta+PageUp")).toEqual(["alt+pageUp"]);
		for (const invalid of ["", "ctrl+ctrl+k", "ctrl+unknown", "ctrl+k ctrl+unknown", "ctrl++k"]) {
			expect(parseKeySequence(invalid)).toBeUndefined();
		}
	});

	it("reports unsupported actions and contexts without enabling them globally", () => {
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

	it("keeps select actions bound when CC restates prompt defaults", () => {
		const { manager } = load(cc({ enter: "chat:submit", escape: "chat:cancel", up: "history:previous" }));
		const bound: string[] = [];
		const probes: [string, Keybinding[]][] = [
			["\r", ["tui.select.confirm", "tui.input.submit"]],
			["\u001b", ["tui.select.cancel", "app.interrupt"]],
			["\u001b[A", ["tui.select.up", "tui.editor.cursorUp"]],
		];
		for (const [data, actions] of probes) {
			manager.dispatchInput(data, "Chat", () => {
				for (const action of actions) if (manager.matches(data, action)) bound.push(action);
			});
		}
		expect(bound.sort()).toEqual([
			"app.interrupt",
			"tui.editor.cursorUp",
			"tui.input.submit",
			"tui.select.cancel",
			"tui.select.confirm",
			"tui.select.up",
		]);
	});

	it("keeps autocomplete confirm when a pi file reassigns submit alongside a CC file", () => {
		const ccDir = mkdtempSync(join(tmpdir(), "cc-keybindings-"));
		roots.push(ccDir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", ccDir);
		writeFileSync(join(ccDir, "keybindings.json"), JSON.stringify(cc({ "ctrl+y": "chat:submit" })));
		const { manager } = load({ "tui.input.submit": "enter" });
		const bound: string[] = [];
		manager.dispatchInput("\r", "Chat", () => {
			for (const action of ["tui.select.confirm", "tui.input.submit"] as Keybinding[]) {
				if (manager.matches("\r", action)) bound.push(action);
			}
		});
		expect(bound.sort()).toEqual(["tui.input.submit", "tui.select.confirm"]);
	});

	it("keeps native submit working under a CC unbinding of the same sequence", () => {
		const overrides = importCcKeybindings(cc({ enter: null }), new Set()).bindings;
		const resolved = resolveBindings(
			[{ context: "Global", keys: ["enter"], action: "tui.input.submit" }],
			overrides,
			"Chat",
		);
		expect(resolved).toContainEqual({ context: "Global", keys: ["enter"], action: "tui.input.submit" });
		expect(resolved.at(-1)).toMatchObject({ keys: ["enter"], action: null });
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

	it("provides source-qualified import diagnostics for startup warnings", () => {
		const { path, root, manager } = load(cc({ "ctrl+y": "unknown:action" }));
		expect(manager.getImportDiagnostics()).toEqual([]);
		expect(readFileSync(join(root, "pi-debug.log"), "utf-8")).toContain(
			`${path}: Unsupported keybinding action: unknown:action`,
		);
	});

	it("warns at startup only when the CC file cannot be loaded at all", () => {
		const broken = mkdtempSync(join(tmpdir(), "cc-keybindings-broken-"));
		roots.push(broken);
		vi.stubEnv("CLAUDE_CONFIG_DIR", broken);
		writeFileSync(join(broken, "keybindings.json"), "{oops");
		const { manager } = load(cc({ "ctrl+y": "chat:submit" }));
		expect(manager.getImportDiagnostics()).toEqual([
			`${join(broken, "keybindings.json")}: CC keybindings file could not be read as JSON`,
		]);
	});
	it("does not treat object prototype properties as action aliases", () => {
		const imported = importCcKeybindings(cc({ "ctrl+k": "constructor", "ctrl+s": "__proto__" }), new Set());
		expect(imported.bindings).toEqual([]);
		expect(imported.warnings).toHaveLength(2);
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

	it("honors sequence reassignment and keeps Return submitting after a CC enter unbinding", () => {
		const { editor } = load(cc({ enter: null, "ctrl+l": "chat:submit" }));
		let models = 0;
		const submitted: string[] = [];
		editor.onAction("app.model.select", () => models++);
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\r");
		expect(submitted).toEqual(["draft"]);
		editor.setText("again");
		editor.handleInput("\x0c");
		expect(submitted).toEqual(["draft", "again"]);
		expect(models).toBe(0);
	});

	it("keeps an unbound chord's prefix and next keystroke working", () => {
		const { editor } = load(cc({ "ctrl+x ctrl+k": null }));
		let copies = 0;
		editor.onAction("app.message.copy", () => copies++);
		editor.handleInput("\x18");
		expect(editor.render(80).join("\n")).not.toContain("Waiting for next key");
		expect(copies).toBe(1);
		editor.handleInput("q");
		expect(editor.getText()).toBe("q");
	});

	it("swallows a mismatching stroke and does not restart on a repeated prefix", () => {
		const { editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setText("draft");
		editor.handleInput("\x0b");
		editor.handleInput("x");
		expect(editor.getText()).toBe("draft");
		editor.handleInput("\x0b");
		editor.handleInput("\x0b");
		editor.handleInput("\x13");
		expect(submitted).toEqual([]);
	});

	it("swallows Escape after a prefix even if Escape is a configured suffix", () => {
		const { editor } = load(cc({ "ctrl+k escape": "chat:modelPicker" }));
		let count = 0;
		editor.onAction("app.model.select", () => count++);
		editor.onEscape = () => count++;
		editor.handleInput("\x0b");
		editor.handleInput("\x1b");
		expect(count).toBe(0);
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
		expect(resolver.resolve("\x13", bindings, 2999)).toEqual({
			kind: "input",
			actions: new Set(["tui.input.submit"]),
		});
		resolver.resolve("\x0b", bindings, 4000);
		expect(resolver.resolve("\x13", bindings, 7000)).toEqual({ kind: "input", actions: new Set() });
	});

	it("starts a chord only when a longer binding has an action", () => {
		const bindings: Binding[] = [
			{ context: "Chat", keys: ["ctrl+x", "ctrl+k"], action: null },
			{ context: "Chat", keys: ["ctrl+x", "ctrl+s"], action: "app.exit" },
		];
		expect(new ChordResolver().resolve("\x18", bindings, 0)).toEqual({ kind: "pending" });
		const nullOnly: Binding[] = [{ context: "Chat", keys: ["ctrl+x", "ctrl+k"], action: null }];
		expect(new ChordResolver().resolve("\x18", nullOnly, 0)).toEqual({ kind: "input", actions: new Set() });
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

describe("CC imports keep pi input behavior", () => {
	const slashProvider = (items: { value: string; label: string }[]) => ({
		getSuggestions: async () => ({ items, prefix: "/" }),
		applyCompletion: (lines: string[], cursorLine: number, _cursorCol: number, item: { value: string }) => ({
			lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
			cursorLine,
			cursorCol: item.value.length,
		}),
	});

	it("confirms an open autocomplete menu with Enter after CC restates submit", async () => {
		const { editor } = load(cc({ enter: "chat:submit" }));
		editor.setAutocompleteProvider(slashProvider([{ value: "/model", label: "model" }]));
		editor.handleInput("/mod");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.handleInput("\r");
		expect(submitted).toEqual(["/model"]);
	});

	it("moves the multiline cursor up with CC's history restate instead of browsing history", () => {
		const { editor } = load(cc({ up: "history:previous", down: "history:next" }));
		editor.addToHistory("queued entry");
		editor.setText("one\ntwo");
		editor.handleInput("\u001b[A");
		expect(editor.getText()).toBe("one\ntwo");
	});

	it("navigates an open autocomplete menu with Up after CC's history restate", async () => {
		const { editor } = load(cc({ up: "history:previous" }));
		editor.setAutocompleteProvider(
			slashProvider(["/command-0", "/command-1", "/command-2"].map((value) => ({ value, label: value }))),
		);
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\u001b[B");
		editor.handleInput("\u001b[A");
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.handleInput("\r");
		expect(submitted).toEqual(["/command-0"]);
	});
});

describe("CC imports keep the built-in input layer", () => {
	it("deletes forward when CC imports app:exit on ctrl+d, and exits on an empty prompt", () => {
		writeCcFile(ccGlobal({ "ctrl+d": "app:exit" }));
		const { manager, editor } = load({});
		editor.setText("abc");
		editor.handleInput("\x01");
		editor.handleInput("\x04");
		expect(editor.getText()).toBe("bc");
		const empty = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, manager);
		let exits = 0;
		empty.onCtrlD = () => exits++;
		empty.handleInput("\x04");
		expect(exits).toBe(1);
	});

	it("deletes forward when a pi file restates app.exit alongside any CC file", () => {
		writeCcFile(cc({ "ctrl+y": "chat:submit" }));
		const { editor } = load({ "app.exit": "ctrl+d" });
		editor.setText("abc");
		editor.handleInput("\x01");
		editor.handleInput("\x04");
		expect(editor.getText()).toBe("bc");
	});

	it("keeps the input layer when CC replaces an application action on the same key", () => {
		writeCcFile(cc({ "ctrl+c": "app:exit" }));
		const { manager } = load({});
		const bound: string[] = [];
		manager.dispatchInput("\x03", "Chat", () => {
			for (const action of ["tui.input.copy", "app.exit", "app.clear"] as Keybinding[]) {
				if (manager.matches("\x03", action)) bound.push(action);
			}
		});
		expect(bound.sort()).toEqual(["app.exit", "tui.input.copy"]);
	});

	it("keeps input actions bound under CC null unbindings", () => {
		writeCcFile(cc({ "ctrl+c": null, "ctrl+d": null, "ctrl+-": null }));
		const { manager } = load({});
		const bound: string[] = [];
		const probes: [string, Keybinding[]][] = [
			["\x03", ["tui.input.copy", "app.clear"]],
			["\x04", ["tui.editor.deleteCharForward", "app.exit"]],
			["\x1f", ["tui.editor.undo"]],
		];
		for (const [data, actions] of probes) {
			manager.dispatchInput(data, "Chat", () => {
				for (const action of actions) if (manager.matches(data, action)) bound.push(action);
			});
		}
		expect(bound).toEqual(["tui.input.copy", "tui.editor.deleteCharForward", "tui.editor.undo"]);
	});

	it("restating CC's default table changes no prompt keys except the chord prefixes it adds", () => {
		const { manager } = load({});
		const mapped = [
			"tui.input.submit",
			"tui.input.newLine",
			"tui.editor.undo",
			"tui.editor.cursorUp",
			"tui.editor.cursorDown",
			"app.interrupt",
			"app.clipboard.pasteImage",
			"app.model.select",
			"app.editor.external",
			"app.exit",
		] as const satisfies Keybinding[];
		const before = new Map(mapped.map((action) => [action, manager.getPromptKeys(action)]));
		writeCcFile({
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
		});
		manager.reload();
		for (const action of mapped) {
			const expected = before.get(action)!.concat(action === "app.editor.external" ? ["ctrl+x ctrl+e"] : []);
			expect(manager.getPromptKeys(action)).toEqual(expected);
		}
	});

	it("logs when an imported chord prefix hides a pi single-key action", () => {
		const { root } = load(cc({ "ctrl+x ctrl+e": "chat:externalEditor" }));
		expect(readFileSync(join(root, "pi-debug.log"), "utf-8")).toContain(
			`imported chord prefix "ctrl+x" hides pi action "app.message.copy"`,
		);
	});

	it("shows chord status only on the editor that received the prefix", () => {
		const { manager, editor } = load(cc({ "ctrl+k ctrl+s": "chat:submit" }));
		const second = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, manager);
		editor.handleInput("\x0b");
		expect(editor.render(80).join("\n")).toContain("Waiting for next key");
		expect(second.render(80).join("\n")).not.toContain("Waiting for next key");
		second.handleInput("\x13");
		expect(editor.render(80).join("\n")).not.toContain("Waiting for next key");
	});
});
