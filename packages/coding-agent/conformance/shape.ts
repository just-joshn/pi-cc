/**
 * The structural matcher a case uses to pin a JSON document: exact key sets, value types, and array
 * order. Both sides are held to the same shape, so a key one side adds or drops fails that side.
 *
 * A shape is JSON. A string starting with `$` is a type token, any other literal must be equal, an
 * array is a tuple, and an object lists every key the value must have. A key written `?name` may be
 * absent. A single-key object whose key starts with `$` is a combinator:
 *
 * - `{"$each": shape}` an array whose every element matches
 * - `{"$map": shape}` an object with any keys whose every value matches
 * - `{"$oneOf": [shape, ...]}` a value matching at least one shape
 * - `{"$includes": [literal, ...]}` an array holding each literal, in any order, with any extras
 * - `{"$match": "regex"}` a string the pattern matches
 * - `{"$ref": "name", "set": {"a.b": shape}}` the shape in `shapes/name.json`, with the shape at each
 *   dotted path replaced, so the frames every case repeats are written once
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Diff } from "./compare.ts";

export type Shape = unknown;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const TOKENS: Record<string, (value: unknown) => boolean> = {
	$any: () => true,
	$string: (value) => typeof value === "string",
	$number: (value) => typeof value === "number",
	$int: (value) => Number.isInteger(value),
	$boolean: (value) => typeof value === "boolean",
	$null: (value) => value === null,
	$object: isObject,
	$array: Array.isArray,
	$uuid: (value) => typeof value === "string" && UUID.test(value),
	$iso8601: (value) => typeof value === "string" && ISO_8601.test(value),
};

const COMBINATORS = ["$each", "$map", "$oneOf", "$includes", "$match"];

/** The problems where `value` departs from `shape`, each naming a path. An empty list is a match. */
export function shapeProblems(shape: Shape, value: unknown, path = "$"): string[] {
	if (isObject(shape) && "$ref" in shape) return shapeProblems(resolveRef(shape), value, path);
	if (typeof shape === "string" && shape.startsWith("$")) {
		const token = TOKENS[shape];
		if (token === undefined) return [`${path}: unknown shape token ${shape}`];
		return token(value) ? [] : [`${path}: expected ${shape.slice(1)}, got ${describe(value)}`];
	}
	if (Array.isArray(shape)) return tupleProblems(shape, value, path);
	if (isObject(shape)) return objectProblems(shape, value, path);
	return Object.is(shape, value) ? [] : [`${path}: expected ${JSON.stringify(shape)}, got ${describe(value)}`];
}

function resolveRef(reference: Record<string, unknown>): Shape {
	const name = String(reference.$ref);
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`shape reference "${name}" is not a plain name`);
	const base = JSON.parse(readFileSync(fileURLToPath(new URL(`shapes/${name}.json`, import.meta.url)), "utf8"));
	for (const [dotted, replacement] of Object.entries((reference.set ?? {}) as Record<string, unknown>)) {
		const steps = dotted.split(".");
		const last = steps.pop() as string;
		let target = base;
		for (const step of steps) target = target[step];
		target[last] = replacement;
	}
	return base;
}

function tupleProblems(shape: unknown[], value: unknown, path: string): string[] {
	if (!Array.isArray(value)) return [`${path}: expected array, got ${describe(value)}`];
	if (value.length !== shape.length) return [`${path}: expected ${shape.length} elements, got ${value.length}`];
	return shape.flatMap((element, index) => shapeProblems(element, value[index], `${path}[${index}]`));
}

function objectProblems(shape: Record<string, unknown>, value: unknown, path: string): string[] {
	const keys = Object.keys(shape);
	if (keys.length === 1 && keys[0].startsWith("$")) return combinatorProblems(keys[0], shape[keys[0]], value, path);
	if (!isObject(value)) return [`${path}: expected object, got ${describe(value)}`];
	const problems: string[] = [];
	const known = new Set<string>();
	for (const key of keys) {
		const optional = key.startsWith("?");
		const name = optional ? key.slice(1) : key;
		known.add(name);
		if (!(name in value)) {
			if (!optional) problems.push(`${path}.${name}: missing`);
			continue;
		}
		problems.push(...shapeProblems(shape[key], value[name], `${path}.${name}`));
	}
	for (const name of Object.keys(value)) {
		if (!known.has(name)) problems.push(`${path}.${name}: unexpected key`);
	}
	return problems;
}

function combinatorProblems(name: string, argument: unknown, value: unknown, path: string): string[] {
	if (!COMBINATORS.includes(name)) return [`${path}: unknown shape combinator ${name}`];
	switch (name) {
		case "$each":
			if (!Array.isArray(value)) return [`${path}: expected array, got ${describe(value)}`];
			return value.flatMap((element, index) => shapeProblems(argument, element, `${path}[${index}]`));
		case "$map":
			if (!isObject(value)) return [`${path}: expected object, got ${describe(value)}`];
			return Object.entries(value).flatMap(([key, entry]) => shapeProblems(argument, entry, `${path}.${key}`));
		case "$oneOf": {
			const alternatives = argument as unknown[];
			const attempts = alternatives.map((alternative) => shapeProblems(alternative, value, path));
			return attempts.some((attempt) => attempt.length === 0)
				? []
				: [
						`${path}: matched none of ${alternatives.length} alternatives (${attempts.map((a) => a[0]).join("; ")})`,
					];
		}
		case "$includes": {
			if (!Array.isArray(value)) return [`${path}: expected array, got ${describe(value)}`];
			const missing = (argument as unknown[]).filter((literal) => !value.includes(literal));
			return missing.length === 0 ? [] : [`${path}: missing ${missing.map((m) => JSON.stringify(m)).join(", ")}`];
		}
		default:
			return typeof value === "string" && new RegExp(argument as string).test(value)
				? []
				: [`${path}: expected a string matching /${String(argument)}/, got ${describe(value)}`];
	}
}

/** Checks stdout lines against one shape per line, in order, with the same count. */
export function frameDiffs(shapes: Shape[], stdout: string, check: string): Diff[] {
	const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
	const diffs: Diff[] = [];
	const types = (items: string[]) => items.map((item) => frameLabel(item)).join(",");
	if (lines.length !== shapes.length) {
		diffs.push({
			check,
			expected: `${shapes.length} frames [${types(shapes.map((shape) => JSON.stringify(shape)))}]`,
			actual: `${lines.length} frames [${types(lines)}]`,
		});
	}
	for (const [index, line] of lines.slice(0, shapes.length).entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			diffs.push({ check, expected: `frame ${index} parses`, actual: String(error) });
			continue;
		}
		const problems = shapeProblems(shapes[index], parsed, `frame[${index}]`);
		if (problems.length > 0)
			diffs.push({ check, expected: `frame ${index} matches its shape`, actual: problems.join("; ") });
	}
	return diffs;
}

/** The `type/subtype` of a frame line or serialized shape, to make a count mismatch readable. */
function frameLabel(text: string): string {
	const type = /"type":\s*"([a-z_]+)"/.exec(text)?.[1] ?? "?";
	const subtype = /"subtype":\s*"([a-z_]+)"/.exec(text)?.[1];
	return subtype === undefined ? type : `${type}/${subtype}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "string")
		return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)}`;
	return typeof value === "object" ? "object" : `${typeof value} ${String(value)}`;
}
