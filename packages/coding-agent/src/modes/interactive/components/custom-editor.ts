import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type Keybinding,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	promptShortcuts?: boolean;
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Keys Claude Code lets reach a history search parked under the help sheet,
 * in match order; every other key stays swallowed by the sheet (captures in
 * store/vimnav/fix-round-2). Ctrl+C cancels the search and keeps the sheet,
 * Escape closes only the sheet, and the search actions fall through.
 */
const PARKED_SEARCH_KEYS: ReadonlyArray<{ action: Keybinding; dismissesSheet?: boolean }> = [
	{ action: "tui.historySearch.cancel" },
	{ action: "app.interrupt", dismissesSheet: true },
	{ action: "tui.historySearch.execute" },
	{ action: "tui.historySearch.accept" },
];

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private chordStatus: string | undefined;
	public readonly embedWorkingStatus: boolean;
	private promptShortcuts: boolean;
	private flat = false;
	private help: { kind: "closed" } | { kind: "open" } = { kind: "closed" };
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.promptShortcuts = options?.promptShortcuts ?? false;
		this.onToggleHelp = () => {
			if (!this.promptShortcuts) return;
			this.help = { kind: this.help.kind === "closed" ? "open" : "closed" };
			this.tui.requestRender();
		};
		this.helpOpen = () => this.help.kind === "open";
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.help.kind === "closed") return lines;
		if (lines.at(-1)?.trim().startsWith("-- ")) lines.pop();
		const userBindings = this.keybindings.getUserBindings();
		const shortcut = (action: Keybinding, fallback: string): string => {
			const imported = this.keybindings.cc.getBindings().findLast((binding) => binding.action === action)?.keys;
			const sequence =
				imported ?? (userBindings[action] === undefined ? undefined : this.keybindings.getKeys(action).slice(0, 1));
			return sequence === undefined
				? fallback
				: sequence.length === 0
					? "unbound"
					: sequence
							.map((stroke) =>
								stroke
									.split("+")
									.map((key) => (key === "alt" && process.platform === "darwin" ? "opt" : key))
									.join(" + "),
							)
							.join(" ");
		};
		const columns = [
			["! for shell mode", "/ for commands", "@ for file paths", "/btw for side question"],
			[
				"double tap esc to clear input",
				"shift + tab to auto-accept edits",
				`${shortcut("app.tools.expand", "ctrl + o")} for verbose output`,
				`${shortcut("app.thinking.toggle", "ctrl + t")} to toggle tasks`,
				"backslash (\\) + return (⏎) for newline",
			],
			[
				`${shortcut("tui.editor.undo", "ctrl + shift + _")} to undo`,
				"ctrl + z to suspend",
				`${shortcut("app.clipboard.pasteImage", "ctrl + v")} to paste images`,
				`${shortcut("app.model.select", "opt + p")} to switch model`,
				"ctrl + s to stash prompt",
				`${shortcut("app.editor.external", "ctrl + g")} to edit in $EDITOR`,
				"/keybindings to customize",
			],
		];
		const available = Math.max(3, width - 4);
		const thirdWidth = Math.max(...columns[2]!.map(visibleWidth));
		const scale = Math.min(1, available / (59 + thirdWidth));
		const widths = [Math.max(1, Math.round(24 * scale)), Math.max(1, Math.round(35 * scale))];
		widths.push(Math.max(1, Math.min(thirdWidth, available - widths[0]! - widths[1]!)));
		const wrapped = columns.map((column, index) =>
			column.flatMap((text) => wrapTextWithAnsi(text, widths[index]!).map((line) => line.trimEnd())),
		);
		for (let row = 0; row < Math.max(...wrapped.map((column) => column.length)); row++) {
			const text = wrapped.map((column, index) => (column[row] ?? "").padEnd(widths[index]!)).join("");
			lines.push(this.borderColor(truncateToWidth(`  ${text}`, width, "")));
		}
		return lines;
	}

	setPromptShortcuts(enabled: boolean): void {
		this.promptShortcuts = enabled;
		if (!enabled) this.help = { kind: "closed" };
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	/** Flat mode drops the decorative rule above and below the prompt; status text keeps its line. */
	setFlat(flat: boolean): void {
		this.flat = flat;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		return this.flat && hiddenLineCount === 0 ? "" : super.renderBottomBorder(width, hiddenLineCount);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (this.isBrowsingHistory) return super.renderTopBorder(width, hiddenLineCount);
		if (this.chordStatus) return this.borderColor(truncateToWidth(`── ${this.chordStatus} `, width, ""));
		if (this.flat && hiddenLineCount === 0 && !this.workingStatusIndicator) return "";
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		if (
			this.help.kind === "closed" &&
			this.isHistorySearchActive &&
			!(
				[
					"tui.historySearch.cancel",
					"tui.historySearch.accept",
					"tui.historySearch.execute",
					"tui.historySearch.next",
				] as const
			).some((action) => this.keybindings.matches(data, action))
		) {
			const global = this.keybindings.cc.dispatch(
				data,
				(message) => {
					this.chordStatus = message;
					this.tui.requestRender();
				},
				Date.now(),
				true,
			);
			if (global.kind === "pending" || global.kind === "cancelled") return;
			const action =
				global.kind === "action"
					? global.action
					: (["app.tools.expand", "app.thinking.toggle"] as const).find(
							(key) => this.actionHandlers.has(key) && this.keybindings.matches(data, key),
						);
			if (action === "app.tools.expand") this.cancelHistorySearch();
			if (action && this.runCcAction(action, data)) return;
		}
		if (this.help.kind === "closed" && this.handleHistorySearchInput(data)) {
			this.keybindings.cc.cancel();
			this.help = { kind: "closed" };
			return;
		}
		if (
			this.promptShortcuts &&
			!this.isHistorySearchActive &&
			this.getText() === "" &&
			this.keybindings.matches(data, "app.help.toggle") &&
			this.getVimMode() !== "normal" &&
			this.getVimMode() !== "visual"
		) {
			this.onToggleHelp?.();
			return;
		}
		if (this.help.kind === "open" && this.isHistorySearchActive) {
			// Must sit above the sheet's interrupt branch so a parked search keeps
			// Backspace from closing the sheet; dispositions come from the table.
			const parked = PARKED_SEARCH_KEYS.find((entry) => this.keybindings.matches(data, entry.action));
			if (!parked) return;
			if (parked.dismissesSheet) {
				this.help = { kind: "closed" };
				this.tui.requestRender();
				return;
			}
			this.handleHistorySearchInput(data);
			this.keybindings.cc.cancel();
			return;
		}
		if (
			this.help.kind === "open" &&
			(this.keybindings.matches(data, "app.interrupt") ||
				(this.getCursorOffset() === 0 &&
					(
						[
							"tui.editor.deleteCharBackward",
							"tui.editor.deleteCharForward",
							"tui.editor.deleteToLineStart",
						] as const
					).some((action) => this.keybindings.matches(data, action))))
		) {
			this.help = { kind: "closed" };
			this.tui.requestRender();
			return;
		}
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			this.keybindings.cc.cancel();
			return;
		}

		if (!this.keybindings.cc.active) {
			this.handleBoundInput(data);
			return;
		}

		// An open autocomplete menu owns its keys, like CC's Autocomplete context declared after Chat.
		const menuKey =
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.input.tab") ||
				(
					[
						"tui.select.cancel",
						"tui.select.up",
						"tui.select.down",
						"tui.select.pageUp",
						"tui.select.pageDown",
						"tui.select.confirm",
					] as const
				).some((action) => this.keybindings.matches(data, action)));
		const result = menuKey
			? ({ kind: "none" } as const)
			: this.keybindings.cc.dispatch(data, (message) => {
					this.chordStatus = message;
					this.tui.requestRender();
				});
		if (result.kind === "pending" || result.kind === "cancelled") return;
		if (result.kind === "action" && this.runCcAction(result.action, data)) return;
		this.handleBoundInput(data);
	}

	/** Runs an imported action and consumes the key, or returns false when the action declines (app.exit on a non-empty prompt). */
	private runCcAction(action: Keybinding, data: string): boolean {
		if (action === "app.exit" && this.getText().length > 0) return false;
		this.keybindings.runAs(data, action, () => this.handleBoundInput(data));
		return true;
	}

	private handleBoundInput(data: string): void {
		const text = this.getText();
		this.dispatchBoundInput(data);
		if (this.getText() !== text) this.help = { kind: "closed" };
	}

	private dispatchBoundInput(data: string): void {
		if (this.keybindings.matches(data, "tui.editor.historySearch")) {
			super.handleInput(data);
			return;
		}
		// Vim mode sees keys before app actions. It consumes Escape in insert mode and Escape with a command pending;
		// otherwise Escape falls through to the interrupt handling below.
		const interrupt = this.keybindings.matches(data, "app.interrupt");
		if (!(interrupt && this.isShowingAutocomplete()) && this.handleVimInput(data, interrupt)) return;

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
