import type { Keybinding, KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { KeyIdSchema } from "../key-id-schema.ts";
import type { Binding } from "./chords.ts";

export const CcKeybindingsSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	bindings: Type.Array(
		Type.Object({
			context: Type.String(),
			bindings: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
		}),
	),
});

const validateFile = Compile(CcKeybindingsSchema);
const validateKey = Compile(KeyIdSchema);
const aliases: Readonly<Record<string, string>> = {
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
	"chat:cancel": "app.interrupt",
	"chat:modelPicker": "app.model.select",
	"chat:externalEditor": "app.editor.external",
	"app:exit": "app.exit",
};

export interface ImportedBindings {
	bindings: Binding[];
	diagnostics: string[];
}

/** Parses a CC spelling into pi strokes, rejecting malformed sequences at the file boundary. */
export function parseKeySequence(value: string): [KeyId, ...KeyId[]] | undefined {
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
	const result: ImportedBindings = { bindings: [], diagnostics: [] };
	if (!validateFile.Check(value)) {
		result.diagnostics.push("CC keybindings must contain a bindings array of context and bindings records");
		return result;
	}
	for (const block of value.bindings) {
		if (block.context !== "Global" && block.context !== "Chat") {
			result.diagnostics.push(`Unsupported keybinding context: ${block.context}`);
			continue;
		}
		for (const [key, action] of Object.entries(block.bindings)) {
			const keys = parseKeySequence(key);
			if (!keys) {
				result.diagnostics.push(`Invalid key sequence: ${key}`);
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
				result.diagnostics.push(`Unsupported keybinding action: ${action}`);
				continue;
			}
			result.bindings.push({ context: block.context, keys, action: mapped });
		}
	}
	return result;
}

/** Applies later declarations to the same sequence in active contexts, including null unbindings. */
export function resolveBindings(
	base: readonly Binding[],
	overrides: readonly Binding[],
	context: Binding["context"],
): Binding[] {
	let resolved = base.filter((binding) => binding.context === "Global" || binding.context === context);
	for (const binding of overrides) {
		if (binding.context !== "Global" && binding.context !== context) continue;
		const sequence = sequenceIdentity(binding.keys);
		resolved = resolved.filter((existing) => sequenceIdentity(existing.keys) !== sequence);
		resolved.push(binding);
	}
	return resolved;
}

function sequenceIdentity(keys: readonly KeyId[]): string {
	return keys.map((key) => key.split("+").sort().join("+")).join(" ");
}
