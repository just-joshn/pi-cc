import { homedir } from "node:os";
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { Compile } from "typebox/compile";
import { getAgentDir, getDebugLogPath } from "../config.ts";
import { stripBom } from "../utils/text.ts";
import { KeybindingValueSchema } from "./key-id-schema.ts";
import { type Binding, ChordResolver } from "./keybindings/chords.ts";
import {
	type ImportedBindings,
	importCcKeybindings,
	parseKeySequence,
	resolveBindings,
	sequenceIdentity,
} from "./keybindings/import-cc.ts";
import { userSettingsPath } from "./settings/cc/paths.ts";

export function useWindowsKeybindings(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

const windowsKeybindings = useWindowsKeybindings();

const APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.save": {
		defaultKeys: "ctrl+s",
		description: "Save thinking level",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: windowsKeybindings ? "alt+p" : "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: "Copy selection or last assistant message",
	},
	"app.message.followUp": {
		defaultKeys: windowsKeybindings ? "ctrl+q" : "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.dequeue": {
		defaultKeys: windowsKeybindings ? "alt+q" : "alt+up",
		description: "Restore queued messages",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: windowsKeybindings ? "alt+v" : "ctrl+v",
		description: "Paste files on macOS, images, or text from clipboard",
	},
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

export type AppKeybinding = keyof typeof APP_KEYBINDINGS;
export type AppKeybindings = { [K in AppKeybinding]: true };

declare module "@earendil-works/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.editor.undo": {
		...TUI_KEYBINDINGS["tui.editor.undo"],
		defaultKeys: process.platform === "win32" ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
	},
	"tui.altScreen.previousPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
	},
	"tui.altScreen.nextPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
	},
	"tui.altScreen.search": {
		...TUI_KEYBINDINGS["tui.altScreen.search"],
		defaultKeys: windowsKeybindings ? "ctrl+f" : "ctrl+shift+f",
	},
	...APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

const KEYBINDING_NAME_MIGRATIONS = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

const validateKeybindingValue = Compile(KeybindingValueSchema);

function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (key === "$schema") continue;
		if (validateKeybindingValue.Check(binding)) config[key] = binding;
	}
	return config;
}

export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		config[nextKey] = value;
	}

	return { config: orderKeybindingsConfig(config), migrated };
}

function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const keybinding of Object.keys(KEYBINDINGS)) {
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}

	const extras = Object.keys(config)
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}

	return ordered;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Appends an import warning to pi's debug log; write errors are ignored, logging must not break startup. */
function appendImportWarning(line: string): void {
	try {
		const path = getDebugLogPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Best effort: the log is diagnostic only.
	}
}

export class KeybindingsManager extends TuiKeybindingsManager {
	private configPath: string | undefined;
	private ccConfigPath: string | undefined;
	private importedBindings: Binding[] = [];
	private chordResolver = new ChordResolver();
	private input: { data: string; actions: ReadonlySet<Keybinding> } | undefined;
	private resolvedContexts = new Map<Binding["context"], readonly Binding[]>();
	private diagnostics: string[] = [];
	private chordTimer: ReturnType<typeof setTimeout> | undefined;
	private chordStatusTarget: ((message: string | undefined) => void) | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const manager = new KeybindingsManager({}, configPath);
		manager.ccConfigPath = join(dirname(userSettingsPath(process.env, homedir())), "keybindings.json");
		manager.reload();
		return manager;
	}

	/** Load failures become startup warnings; per-entry warnings go to the debug log like CC's validation log. */
	private recordImport(imported: ImportedBindings, source: string): void {
		this.diagnostics.push(...imported.diagnostics.map((message) => `${source}: ${message}`));
		for (const warning of imported.warnings) appendImportWarning(`${source}: ${warning}`);
	}

	reload(): void {
		this.loadConfigFiles();
		this.warnHiddenSingleKeyActions();
	}

	private loadConfigFiles(): void {
		if (!this.configPath) return;
		this.cancelChord();
		this.importedBindings = [];
		this.diagnostics = [];
		if (this.ccConfigPath && this.ccConfigPath !== this.configPath) {
			const ccRaw = loadRawConfig(this.ccConfigPath);
			if (ccRaw) {
				const imported = importCcKeybindings(ccRaw, new Set(Object.keys(KEYBINDINGS)));
				this.importedBindings = imported.bindings;
				this.recordImport(imported, this.ccConfigPath);
			} else if (existsSync(this.ccConfigPath)) {
				this.diagnostics.push(`${this.ccConfigPath}: CC keybindings file could not be read as JSON`);
			}
		}
		const raw = loadRawConfig(this.configPath);
		if (!raw) {
			this.setUserBindings({});
			return;
		}
		if (Object.hasOwn(raw, "bindings")) {
			const imported = importCcKeybindings(raw, new Set(Object.keys(KEYBINDINGS)));
			this.importedBindings.push(...imported.bindings);
			this.recordImport(imported, this.configPath);
			this.setUserBindings({});
			return;
		}
		const migrated = migrateKeybindingsConfig(raw).config;
		const singles = toKeybindingsConfig(migrated);
		for (const [action, value] of Object.entries(migrated)) {
			if (!Object.hasOwn(KEYBINDINGS, action)) continue;
			const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
			const sequences = values.flatMap((key) => {
				const keys = typeof key === "string" ? parseKeySequence(key) : undefined;
				return keys ? [keys] : [];
			});
			if (this.importedBindings.length > 0 || sequences.some((keys) => keys.length > 1)) {
				singles[action] = sequences.flatMap((keys) => (keys.length === 1 ? [keys[0]!] : []));
				this.importedBindings.push(
					...[
						...sequences.filter((keys) => keys.length === 1),
						...sequences.filter((keys) => keys.length > 1),
					].map(
						(keys): Binding => ({
							context: "Global",
							origin: "pi-file",
							keys,
							action: action as Keybinding,
						}),
					),
				);
			}
		}
		this.setUserBindings(singles);
	}

	/** Returns prompt conflict keys, reserving the first stroke of imported chords for their action. */
	getEffectiveConfig(): KeybindingsConfig {
		const native = this.getResolvedBindings();
		if (this.importedBindings.length === 0) return native;
		const config: Record<string, KeyId[]> = Object.fromEntries(Object.keys(native).map((action) => [action, []]));
		for (const binding of this.getContextBindings("Chat")) {
			if (binding.action !== null) config[binding.action].push(binding.keys[0]);
		}
		return config;
	}

	getImportDiagnostics(): readonly string[] {
		return this.diagnostics;
	}

	override setUserBindings(userBindings: KeybindingsConfig): void {
		super.setUserBindings(userBindings);
		this.resolvedContexts.clear();
		this.cancelChord();
	}

	/** A chord's first stroke is consumed as pending, so pi actions on the prefix key stop firing; CC hides them the same way. */
	private warnHiddenSingleKeyActions(): void {
		if (this.importedBindings.length === 0) return;
		const singleKeyActions = new Map<string, string[]>();
		for (const [action, value] of Object.entries(this.getResolvedBindings())) {
			const keys = typeof value === "string" ? [value] : (value ?? []);
			for (const key of keys) {
				const sequence = sequenceIdentity([key]);
				singleKeyActions.set(sequence, [...(singleKeyActions.get(sequence) ?? []), action]);
			}
		}
		const reported = new Set<string>();
		for (const binding of this.importedBindings) {
			if (binding.action === null || binding.keys.length < 2) continue;
			for (let index = 1; index < binding.keys.length; index++) {
				const prefix = sequenceIdentity(binding.keys.slice(0, index));
				for (const action of singleKeyActions.get(prefix) ?? []) {
					const line = `imported chord prefix "${binding.keys.slice(0, index).join(" ")}" hides pi action "${action}"`;
					if (!reported.has(line)) {
						reported.add(line);
						appendImportWarning(line);
					}
				}
			}
		}
	}

	cancelChord(): void {
		this.chordResolver.reset();
		if (this.chordTimer !== undefined) {
			clearTimeout(this.chordTimer);
			this.chordTimer = undefined;
			this.chordStatusTarget?.(undefined);
			this.chordStatusTarget = undefined;
		}
	}

	/** Runs all checks for one editor event against a single chord resolution. Chord feedback goes to the editor that received the keystroke. */
	dispatchInput(
		data: string,
		context: Binding["context"],
		handle: () => void,
		onChordStatus?: (message: string | undefined) => void,
	): void {
		if (this.importedBindings.length === 0) {
			handle();
			return;
		}
		const result = this.chordResolver.resolve(data, this.getContextBindings(context));
		if (result.kind === "pending") {
			if (this.chordTimer !== undefined) {
				clearTimeout(this.chordTimer);
				this.chordTimer = undefined;
			}
			this.chordStatusTarget = onChordStatus;
			this.chordStatusTarget?.("Waiting for next key (3s)");
			this.chordTimer = setTimeout(() => {
				this.chordResolver.reset();
				this.chordStatusTarget?.("Chord cancelled. No next key within 3s");
				this.chordTimer = setTimeout(() => this.cancelChord(), 3000);
				this.chordTimer.unref();
			}, 3000);
			this.chordTimer.unref();
			return;
		}
		this.cancelChord();
		if (result.kind === "cancelled") return;
		const previous = this.input;
		this.input = { data, actions: result.actions };
		try {
			handle();
		} finally {
			this.input = previous;
		}
	}

	/** Returns prompt shortcuts, including imported chords, for display without narrowing them to single keys. */
	getPromptKeys(action: Keybinding): string[] {
		return this.getContextBindings("Chat")
			.filter((binding) => binding.action === action)
			.map((binding) => binding.keys.join(" "));
	}

	private getContextBindings(context: Binding["context"]): readonly Binding[] {
		let bindings = this.resolvedContexts.get(context);
		if (!bindings) {
			const base = Object.entries(this.getResolvedBindings()).flatMap(([action, value]) => {
				const keys = typeof value === "string" ? [value] : (value ?? []);
				return keys.map(
					(key): Binding => ({ context: "Global", origin: "pi-base", keys: [key], action: action as Keybinding }),
				);
			});
			bindings = resolveBindings(base, this.importedBindings, context);
			this.resolvedContexts.set(context, bindings);
		}
		return bindings;
	}

	override matches(data: string, keybinding: Keybinding): boolean {
		return this.input?.data === data ? this.input.actions.has(keybinding) : super.matches(data, keybinding);
	}
}

export type { Keybinding, KeyId, KeybindingsConfig };
