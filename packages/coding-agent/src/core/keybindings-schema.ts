import { type TSchema, type TSchemaOptions, Type } from "typebox";
import { keyIdPattern } from "./key-id-schema.ts";
import { CcKeybindingsSchema } from "./keybindings/import-cc.ts";
import { KEYBINDINGS } from "./keybindings.ts";

const sequenceSchema = Type.String({ pattern: `^(?:${keyIdPattern})(?: (?:${keyIdPattern}))*$` });
function sequenceValueSchema(options?: TSchemaOptions) {
	return Type.Union([sequenceSchema, Type.Array(sequenceSchema)], options);
}

export const KeybindingValueSchema = sequenceValueSchema();

const properties: Record<string, TSchema> = {
	$schema: Type.Optional(Type.String()),
	bindings: Type.Optional(Type.Never()),
};

for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	properties[id] = Type.Optional(sequenceValueSchema({ description: definition.description }));
}

export const KeybindingsSchema = Type.Union([
	Type.Object(properties, { additionalProperties: KeybindingValueSchema }),
	CcKeybindingsSchema,
]);
