import type { Keybinding, KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { KeyIdSchema } from "../key-id-schema.ts";
import type { CcBinding } from "./cc-layer.ts";

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

/** One declared CC entry. A null action unbinds the sequence in the CC layer only. */
export interface CcDeclaration {
	keys: readonly [KeyId, ...KeyId[]];
	action: Keybinding | null;
}

export interface ImportedBindings {
	bindings: CcDeclaration[];
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
			result.bindings.push({ keys, action: mapped });
		}
	}
	return result;
}

/**
 * Applies declarations in order: the last declaration on a sequence wins, the way CC's dispatcher takes the last
 * binding across active contexts. A null removes the sequence from the CC layer and is not kept, because an
 * unbound sequence falls through to pi's own handling.
 */
export function resolveLayer(declarations: readonly CcDeclaration[]): CcBinding[] {
	const bySequence = new Map<string, CcBinding>();
	for (const { keys, action } of declarations) {
		const sequence = sequenceIdentity(keys);
		bySequence.delete(sequence);
		if (action !== null) bySequence.set(sequence, { keys, action });
	}
	return [...bySequence.values()];
}

/** Normalizes modifiers and modifier order so two spellings of one sequence compare equal. */
export function sequenceIdentity(keys: readonly KeyId[]): string {
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
