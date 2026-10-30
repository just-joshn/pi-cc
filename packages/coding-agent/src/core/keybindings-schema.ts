import { type TSchema, Type } from "typebox";
import { KeybindingValueSchema, keybindingValueSchema } from "./key-id-schema.ts";
import { CcKeybindingsSchema } from "./keybindings/import-cc.ts";
import { KEYBINDINGS } from "./keybindings.ts";

export { KeybindingValueSchema } from "./key-id-schema.ts";

const properties: Record<string, TSchema> = {
	$schema: Type.Optional(Type.String()),
	bindings: Type.Optional(Type.Never()),
};

for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	properties[id] = Type.Optional(
		keybindingValueSchema({
			description: definition.description,
		}),
	);
}

export const KeybindingsSchema = Type.Union([
	Type.Object(properties, { additionalProperties: KeybindingValueSchema }),
	CcKeybindingsSchema,
]);
