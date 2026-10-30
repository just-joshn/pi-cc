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
			const isCcAction = action !== null && Object.hasOwn(actions, action);
			const mapped =
				action === null
					? null
					: isCcAction
						? actions[action]
						: nativeActions.has(action)
							? (action as Keybinding)
							: undefined;
			if (mapped === undefined) {
				result.warnings.push(`Unsupported keybinding action: ${action}`);
				continue;
			}
			// A pi action name written in a CC file is a pi declaration, not a CC-dispatched action.
			result.bindings.push({
				context: block.context,
				origin: isCcAction || action === null ? "cc-import" : "pi-file",
				keys,
				action: mapped,
			});
		}
	}
	return result;
}

/**
 * Pi actions split the way CC partitions its surfaces: `tui.select.*` models CC's separate Autocomplete context and
 * `tui.altScreen.*` the fullscreen viewport, so CC's Chat and Global overrides never shadow them.
 */
function actionGroup(action: Keybinding): "select" | "altScreen" | "prompt" {
	if (action.startsWith("tui.select.")) return "select";
	if (action.startsWith("tui.altScreen.")) return "altScreen";
	return "prompt";
}

/**
 * CC has two layers on one surface: dispatched app/chat actions, which may decline and fall through, and the
 * text input's built-in handling, which pi models as `tui.editor.*` and `tui.input.*`. Shadowing stays within a
 * layer: CC's `app:exit` returns false on a non-empty prompt (chunk-7ss0ryz6.js) and its dispatcher only consumes
 * when the handler does not (chunk-35yzp1xe.js), so an imported dispatched action must never remove an input action.
 */
function actionLayer(action: Keybinding): "input" | "dispatched" {
	return action.startsWith("tui.editor.") || action.startsWith("tui.input.") ? "input" : "dispatched";
}

/**
 * Applies later declarations to the same sequence, tracking each binding's origin instead of its object identity.
 * - Pi base bindings are never removed by a declaration that restates them. A restatement is dropped, so a later
 *   `null` cannot delete a base input action the file only repeated.
 * - A later import or file declaration replaces earlier non-base declarations on its sequence.
 * - Imported dispatched app/chat actions replace pi's dispatched prompt actions on the sequence, the way CC's
 *   dispatcher takes the last declaration. They leave pi's input layer (`tui.editor.*`, `tui.input.*`) alone because
 *   CC falls through to the text input when a handler declines (app:exit on a non-empty prompt).
 * - A CC action that pi models as an input action (chat:newline, chat:undo) is dispatched before the text input's
 *   own handling and always consumes, so it displaces the input actions pi had on that sequence until the
 *   declaration is replaced or nulled.
 * - A `null` removes non-base declarations and pi's dispatched prompt actions on the sequence, restores displaced
 *   input actions, and leaves the base input layer working (CC's dispatcher returns `unbound` without consuming).
 */
export function resolveBindings(
	base: readonly Binding[],
	overrides: readonly Binding[],
	context: Binding["context"],
): Binding[] {
	let resolved = base.filter((binding) => binding.context === "Global" || binding.context === context);
	let displaced: Binding[] = [];
	for (const binding of overrides) {
		if (binding.context !== "Global" && binding.context !== context) continue;
		const sequence = sequenceIdentity(binding.keys);
		const onSequence = (existing: Binding) => sequenceIdentity(existing.keys) === sequence;
		resolved.push(...displaced.filter(onSequence));
		displaced = displaced.filter((existing) => !onSequence(existing));
		resolved = resolved.filter((existing) => !onSequence(existing) || isKept(existing));
		if (binding.action !== null) {
			const restated = resolved.some(
				(existing) => onSequence(existing) && existing.origin === "pi-base" && existing.action === binding.action,
			);
			if (isCcInputAction(binding)) {
				displaced.push(...resolved.filter((existing) => onSequence(existing) && isDisplaceable(binding, existing)));
				resolved = resolved.filter((existing) => !displaced.includes(existing));
			}
			if (restated) continue;
		}
		resolved.push(binding);
	}
	return resolved;
}

function isKept(existing: Binding): boolean {
	if (existing.origin !== "pi-base") return false;
	if (existing.action === null) return true;
	return !(actionGroup(existing.action) === "prompt" && actionLayer(existing.action) === "dispatched");
}

function isCcInputAction(binding: Binding): boolean {
	return binding.origin === "cc-import" && binding.action !== null && actionLayer(binding.action) === "input";
}

function isDisplaceable(override: Binding, existing: Binding): boolean {
	return (
		existing.origin === "pi-base" &&
		existing.action !== null &&
		existing.action !== override.action &&
		actionGroup(existing.action) === "prompt" &&
		actionLayer(existing.action) === "input"
	);
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
