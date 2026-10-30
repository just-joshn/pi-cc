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
 * Applies later declarations to the same sequence. Imports are dispatched declarations in CC's sense: a later one
 * replaces earlier imports and the sequence's dispatched pi bindings, the way CC's dispatcher takes the last
 * declaration across active contexts. Pi's built-in input actions (`tui.editor.*`/`tui.input.*`) are the layer CC's
 * dispatched actions decline and fall through to, so an import never removes them; an identical (sequence, action)
 * restatement collapses to one binding. A `null` action removes bindings the import introduced and the sequence's
 * dispatched pi bindings, matching CC's fall-through on an unbound key (jet returns "unbound" without consuming
 * outside a chord).
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
	if (fromImport) return true;
	if (override.action === null) {
		return (
			existing.action !== null &&
			actionGroup(existing.action) === "prompt" &&
			actionLayer(existing.action) === "dispatched"
		);
	}
	if (existing.action === null) return false;
	return (
		existing.action === override.action ||
		(actionGroup(existing.action) === "prompt" && actionLayer(existing.action) === "dispatched")
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
