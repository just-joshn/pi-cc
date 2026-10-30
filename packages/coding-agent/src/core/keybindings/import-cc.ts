import type { Keybinding, KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { KeyIdSchema } from "../key-id-schema.ts";
import type { Binding } from "./chords.ts";

export const CcKeybindingsSchema = Type.Object(
	{
		bindings: Type.Array(
			Type.Object({
				context: Type.String(),
				bindings: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
			}),
		),
	},
	{ additionalProperties: true },
);

const validateFile = Compile(CcKeybindingsSchema);
const validateKey = Compile(KeyIdSchema);
const aliases: Readonly<Record<string, string>> = {
	control: "ctrl",
	cmd: "super",
	command: "super",
	win: "super",
	del: "delete",
	"↑": "up",
	"↓": "down",
	"←": "left",
	"→": "right",
	meta: "alt",
	opt: "alt",
	option: "alt",
	esc: "escape",
	return: "enter",
	pageup: "pageUp",
	pagedown: "pageDown",
};
const actions: Readonly<Record<string, Keybinding>> = {
	"chat:submit": "tui.input.submit",
	"chat:newline": "tui.input.newLine",
	"chat:undo": "tui.editor.undo",
	"chat:imagePaste": "app.clipboard.pasteImage",
	"history:previous": "tui.editor.cursorUp",
	"history:next": "tui.editor.cursorDown",
	"chat:cancel": "app.interrupt",
	"chat:modelPicker": "app.model.select",
	"chat:externalEditor": "app.editor.external",
	"app:exit": "app.exit",
};

export interface ImportedBindings {
	bindings: Binding[];
	/** Failures that leave the whole file unusable, shown as startup warnings. */
	diagnostics: string[];
	/** Per-entry problems, logged to pi's debug log the way CC logs validation issues. */
	warnings: string[];
}

/** Parses a CC spelling into pi strokes, rejecting malformed sequences at the file boundary. */
export function parseKeySequence(value: string): [KeyId, ...KeyId[]] | undefined {
	if (value === " ") return ["space"];
	if (!value.trim()) return undefined;
	const keys = value
		.trim()
		.split(/\s+/)
		.map((stroke) =>
			stroke
				.toLowerCase()
				.split("+")
				.map((part) => aliases[part] ?? part)
				.join("+"),
		);
	if (!keys.every((key): key is KeyId => validateKey.Check(key))) return undefined;
	return [keys[0]!, ...keys.slice(1)];
}

/** Imports supported CC contexts without inventing equivalents for unknown actions. */
export function importCcKeybindings(value: unknown, nativeActions: ReadonlySet<string>): ImportedBindings {
	const result: ImportedBindings = { bindings: [], diagnostics: [], warnings: [] };
	if (!validateFile.Check(value)) {
		result.diagnostics.push("CC keybindings must contain a bindings array of context and bindings records");
		return result;
	}
	for (const block of value.bindings) {
		if (block.context !== "Global" && block.context !== "Chat") {
			result.warnings.push(`Unsupported keybinding context: ${block.context}`);
			continue;
		}
		for (const [key, action] of Object.entries(block.bindings)) {
			const keys = parseKeySequence(key);
			if (!keys) {
				result.warnings.push(`Invalid key sequence: ${key}`);
				continue;
			}
			const mapped =
				action === null
					? null
					: Object.hasOwn(actions, action)
						? actions[action]
						: nativeActions.has(action)
							? (action as Keybinding)
							: undefined;
			if (mapped === undefined) {
				result.warnings.push(`Unsupported keybinding action: ${action}`);
				continue;
			}
			result.bindings.push({ context: block.context, keys, action: mapped });
		}
	}
	return result;
}

/**
 * Pi actions that mirror CC's built-in text-input handling: Return submits (`or` calls `onSubmit` directly), Up and
 * Down move the cursor or browse history (`At`/`Ot` in chunk-ybhw3dyg.js), and the editing keys run inside the
 * input. CC's dispatcher lets an unbound key fall through to them, so a CC `null` unbinding never removes these.
 */
const INPUT_NATIVE_ACTIONS: ReadonlySet<string> = new Set([
	"tui.input.submit",
	"tui.input.newLine",
	"tui.editor.cursorUp",
	"tui.editor.cursorDown",
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.pageUp",
	"tui.editor.pageDown",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.yank",
	"tui.editor.yankPop",
]);

/**
 * Groups pi actions the way CC partitions its surfaces: `tui.select.*` models CC's separate Autocomplete context and
 * `tui.altScreen.*` the fullscreen viewport, so CC's Chat and Global overrides never shadow them.
 */
function actionGroup(action: Keybinding): "select" | "altScreen" | "prompt" {
	if (action.startsWith("tui.select.")) return "select";
	if (action.startsWith("tui.altScreen.")) return "altScreen";
	return "prompt";
}

/**
 * Applies later declarations to the same sequence. A binding shadows only same-sequence bindings in its action's
 * group, the way CC's dispatched action consumes the key while its Autocomplete context keeps its own, and
 * restating a pi default is a no-op. A `null` action removes bindings the import introduced and the sequence's
 * application-level pi bindings, but leaves pi's base input actions working, matching CC's fall-through on an
 * unbound key (jet returns "unbound" without consuming outside a chord).
 */
export function resolveBindings(
	base: readonly Binding[],
	overrides: readonly Binding[],
	context: Binding["context"],
): Binding[] {
	let resolved = base.filter((binding) => binding.context === "Global" || binding.context === context);
	const introduced = new Set<Binding>();
	for (const binding of overrides) {
		if (binding.context !== "Global" && binding.context !== context) continue;
		const sequence = sequenceIdentity(binding.keys);
		resolved = resolved.filter((existing) => {
			if (sequenceIdentity(existing.keys) !== sequence) return true;
			return !isShadowed(binding, existing, introduced.has(existing));
		});
		resolved.push(binding);
		introduced.add(binding);
	}
	return resolved;
}

function isShadowed(override: Binding, existing: Binding, fromImport: boolean): boolean {
	if (override.action === null) {
		if (fromImport || existing.action === null) return true;
		return actionGroup(existing.action) === "prompt" && !INPUT_NATIVE_ACTIONS.has(existing.action);
	}
	return existing.action !== null && actionGroup(existing.action) === actionGroup(override.action);
}

function sequenceIdentity(keys: readonly KeyId[]): string {
	return keys
		.map((key) =>
			key
				.toLowerCase()
				.split("+")
				.map((part) => aliases[part] ?? part)
				.sort()
				.join("+"),
		)
		.join(" ");
}
