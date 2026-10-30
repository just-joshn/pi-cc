// Claude Code's vim visual mode: the key router and command table Bt and Sn, the span operators It, vt and Wt, and the
// replays `.` runs over a recorded span (chunk-hz2c9q6k.js:560-730, 1011-1046, 1259-1273, 1360-1385, 1537-1600).
import { applyRange, type Buffer, type Edit, joinLines, type Operator, shiftLine } from "./edits.ts";
import type { Change, VimInput, VimState, VimStep } from "./engine.ts";
import {
	clampNormal,
	firstNonBlank,
	indentEnd,
	lineEnd,
	lineIndex,
	lineOffset,
	lineStart,
	nextUnit,
	prevUnit,
	TEXT_OBJECTS,
	textObject,
	unitSegments,
} from "./text.ts";

export const MAX_COUNT = 10000;

export type VisualKind = "char" | "line";

/** The selection: from the anchor to the cursor, inclusive. The cursor is the buffer's offset. */
export interface VisualState {
	readonly kind: VisualKind;
	readonly anchor: number;
}

export type VisualAction =
	| { readonly kind: "delete" }
	| { readonly kind: "yank" }
	/** Without `text` the change opens insert mode; with it the change retypes what the session typed. */
	| { readonly kind: "change"; readonly text?: string }
	| { readonly kind: "replace"; readonly char: string }
	| { readonly kind: "case"; readonly mode: "toggle" | "lower" | "upper" }
	| { readonly kind: "paste"; readonly content: string }
	| { readonly kind: "indent"; readonly dir: ">" | "<"; readonly count: number };

/** A visual change as `.` replays it: the size of its span, not its place. Characters for v, lines for V. */
export interface VisualChange {
	readonly span: number;
	readonly linewise: boolean;
	readonly action: VisualAction;
}

type SpanAction = Exclude<VisualAction, { readonly kind: "indent" }>;

/** An edit that may leave text to retype and, for a put, the content that went in. */
interface Applied extends Edit {
	readonly typed?: string;
	readonly content?: string;
}

/** Moves the cursor like normal mode does. The engine owns every motion; visual mode only keeps the anchor. */
export type Motion = (state: VimState, target: string, count: number | undefined, buffer: Buffer) => VimStep;

const OPERATORS: Readonly<Record<string, { readonly op: Operator; readonly linewise: boolean }>> = {
	d: { op: "d", linewise: false },
	c: { op: "c", linewise: false },
	y: { op: "y", linewise: false },
	x: { op: "d", linewise: false },
	s: { op: "c", linewise: false },
	X: { op: "d", linewise: true },
	D: { op: "d", linewise: true },
	C: { op: "c", linewise: true },
	S: { op: "c", linewise: true },
	R: { op: "c", linewise: true },
	Y: { op: "y", linewise: true },
};
const CASES: Readonly<Record<string, "toggle" | "lower" | "upper">> = { "~": "toggle", u: "lower", U: "upper" };
const MOTIONS = new Set(["h", "l", " ", "\b", "j", "k", "w", "b", "e", "W", "B", "E", "0", "^", "%", "G", ";", ","]);
const PENDING = /^(\d*)([fFtTgria]?)$/;

const step = (state: VimState, buffer?: Buffer): VimStep => ({
	state,
	passThrough: false,
	...(buffer === undefined ? {} : { buffer }),
});

/** v or V from idle or a count in normal mode. */
export function enterVisual(state: VimState, kind: VisualKind, buffer: Buffer): VimStep {
	return step({ ...state, mode: "visual", pending: "", visual: { kind, anchor: buffer.offset } });
}

/** The characters the selection covers, whole lines when `linewise`. The anchor may trail an outside edit. */
export function visualBounds(visual: VisualState, text: string, cursor: number, linewise: boolean) {
	const anchor = Math.min(visual.anchor, text.length);
	const low = Math.min(anchor, cursor);
	const high = Math.max(anchor, cursor);
	if (!linewise) return { from: low, to: nextUnit(text, high) };
	const end = text.indexOf("\n", high);
	return { from: lineStart(text, low), to: end === -1 ? text.length : end + 1 };
}

function spanSize(slice: string, linewise: boolean): number {
	if (!linewise) return unitSegments(slice).length;
	const breaks = slice.split("\n").length - 1;
	return slice.endsWith("\n") ? breaks : breaks + 1;
}

function replayBounds(text: string, cursor: number, span: number, linewise: boolean) {
	if (linewise) {
		const from = lineStart(text, cursor);
		let to = from;
		for (let line = 0; line < span; line += 1) {
			const end = text.indexOf("\n", to);
			if (end === -1) return { from, to: text.length };
			to = end + 1;
		}
		return { from, to };
	}
	let to = cursor;
	for (let unit = 0; unit < span && to < text.length; unit += 1) to = nextUnit(text, to);
	return { from: cursor, to };
}

/** One key in visual mode. */
export function visualKey(
	state: VimState,
	visual: VisualState,
	input: VimInput,
	buffer: Buffer,
	motion: Motion,
): VimStep {
	if (input.kind === "escape") {
		return state.pending === "" ? leave(state, buffer) : step({ ...state, pending: "" });
	}
	if (input.kind === "other") {
		return {
			...step({ ...state, mode: "normal", pending: "", visual: undefined, wanted: undefined }),
			keepCursor: true,
		};
	}
	const cancelled = { ...state, pending: "" };
	const [, digits = "", letter = ""] = PENDING.exec(state.pending) ?? [];
	const count = digits === "" ? undefined : Number(digits);
	const key = input.key;
	if (key === "") return step(cancelled);
	if (letter === "") return command(state, visual, key, digits, count, buffer, motion);
	if (letter === "f" || letter === "F" || letter === "t" || letter === "T") {
		return moved(state, motion({ ...state, pending: "" }, letter + key, count, buffer), buffer);
	}
	if (letter === "g") {
		if (key === "j" || key === "k" || key === "g") {
			return moved(state, motion({ ...state, pending: "" }, `g${key}`, count, buffer), buffer);
		}
		return step(cancelled);
	}
	if (letter === "r") return replace(state, visual, { kind: "replace", char: key }, buffer);
	return selectObject(state, visual, letter === "i" ? "i" : "a", key, buffer);
}

function command(
	state: VimState,
	visual: VisualState,
	key: string,
	digits: string,
	count: number | undefined,
	buffer: Buffer,
	motion: Motion,
): VimStep {
	const { text, offset } = buffer;
	const cleared = { ...state, pending: "" };
	if (/[0-9]/.test(key) && (digits !== "" || key !== "0")) {
		return step({ ...state, pending: String(Math.min(Number(digits + key), MAX_COUNT)) });
	}
	const operator = OPERATORS[key];
	if (operator !== undefined) return operate(state, visual, operator.op, operator.linewise, buffer);
	const caseMode = CASES[key];
	if (caseMode !== undefined) return replace(state, visual, { kind: "case", mode: caseMode }, buffer);
	switch (key) {
		case "r":
		case "f":
		case "F":
		case "t":
		case "T":
		case "g":
		case "i":
		case "a":
			return step({ ...state, pending: key === "r" ? key : digits + key });
		case "p":
		case "P":
			return paste(state, visual, buffer);
		case ">":
		case "<":
			return indent(state, visual, key, count ?? 1, buffer);
		case "v":
		case "V":
			return toggleKind(state, visual, key === "V" ? "line" : "char", buffer);
		case "o":
			return step(
				{ ...cleared, wanted: undefined, visual: { ...visual, anchor: offset } },
				{ text, offset: visual.anchor },
			);
		case "J":
			return join(state, visual, buffer);
		case "$": {
			const to = lineEnd(text, offset);
			return step(
				{ ...cleared, wanted: { column: Number.POSITIVE_INFINITY, offset: to, text } },
				{ text, offset: to },
			);
		}
		default:
			if (key === "%" && count !== undefined) return step(cleared);
			if (!MOTIONS.has(key)) return step(cleared);
			return moved(state, motion({ ...state, pending: "" }, key, count, buffer), buffer);
	}
}

/** Takes the cursor a normal-mode motion chose, and its remembered column, and stays in visual mode. */
function moved(state: VimState, ran: VimStep, buffer: Buffer): VimStep {
	const { wanted, lastFind } = ran.state;
	const offset = ran.buffer?.offset ?? buffer.offset;
	return step({ ...state, pending: "", wanted, lastFind }, { text: buffer.text, offset });
}

/** Escape: back to normal mode with the cursor on a character. */
function leave(state: VimState, buffer: Buffer, keepWanted = false): VimStep {
	const { text, offset } = buffer;
	const to = clampNormal(text, offset);
	const wanted =
		keepWanted && state.wanted?.offset === offset && state.wanted.text === text
			? { ...state.wanted, offset: to }
			: undefined;
	return step({ ...state, mode: "normal", pending: "", visual: undefined, wanted }, { text, offset: to });
}

function toggleKind(state: VimState, visual: VisualState, kind: VisualKind, buffer: Buffer): VimStep {
	if (kind === visual.kind) return leave(state, buffer, true);
	return step({ ...state, pending: "", visual: { ...visual, kind } });
}

function selectObject(state: VimState, visual: VisualState, scope: "i" | "a", key: string, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const range = key.length === 1 && TEXT_OBJECTS.includes(key) ? textObject(text, offset, scope, key) : undefined;
	if (range === undefined) return step({ ...state, pending: "" });
	const cursor = range.end > range.start ? prevUnit(text, range.end) : range.start;
	return step({ ...state, pending: "", visual: { ...visual, anchor: range.start } }, { text, offset: cursor });
}

/** Applies an action to the selection and leaves visual mode; `record` is what `.` will replay. */
function exit(state: VimState, applied: Applied, record: Change | undefined, session?: VisualSessionOf): VimStep {
	const next: VimState = {
		...state,
		mode: "normal",
		pending: "",
		visual: undefined,
		wanted: undefined,
		register: applied.register ?? state.register,
	};
	if (applied.insert && session !== undefined) {
		const insert = { start: applied.buffer.offset, before: applied.buffer.text, keys: "", visual: session };
		return step({ ...next, mode: "insert", insert }, applied.buffer);
	}
	return step(record === undefined ? next : { ...next, lastChange: record }, applied.buffer);
}

type VisualSessionOf = Pick<VisualChange, "span" | "linewise">;

function recorded(span: number, linewise: boolean, action: VisualAction): Change {
	return { keys: "", inserted: "", visual: { span, linewise, action } };
}

function selection(visual: VisualState, buffer: Buffer, force: boolean) {
	const linewise = visual.kind === "line" || force;
	const { from, to } = visualBounds(visual, buffer.text, buffer.offset, linewise);
	return { from, to, linewise, span: spanSize(buffer.text.slice(from, to), linewise) };
}

function operate(state: VimState, visual: VisualState, op: Operator, force: boolean, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const { from, to, linewise, span } = selection(visual, buffer, force);
	if (op === "y") return exit(state, apply({ kind: "yank" }, text, from, to, linewise), undefined);
	const atEnd = linewise && text.endsWith("\n") && Math.max(visual.anchor, offset) >= text.length;
	if (op === "c")
		return exit(state, apply({ kind: "change" }, text, from, to, linewise, atEnd), undefined, { span, linewise });
	const applied = apply({ kind: "delete" }, text, from, to, linewise);
	return exit(state, applied, recorded(span, linewise, { kind: "delete" }));
}

function replace(state: VimState, visual: VisualState, action: SpanAction, buffer: Buffer): VimStep {
	const { from, to, linewise, span } = selection(visual, buffer, false);
	return exit(state, apply(action, buffer.text, from, to, linewise), recorded(span, linewise, action));
}

function paste(state: VimState, visual: VisualState, buffer: Buffer): VimStep {
	const register = state.register;
	if (register === undefined || register.text === "") return step({ ...state, pending: "" });
	const { from, to, linewise, span } = selection(visual, buffer, false);
	const applied = apply({ kind: "paste", content: register.text }, buffer.text, from, to, linewise);
	const action: SpanAction = { kind: "paste", content: applied.content ?? register.text };
	return exit(state, applied, recorded(span, linewise, action));
}

function indent(state: VimState, visual: VisualState, dir: ">" | "<", count: number, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const anchor = Math.min(visual.anchor, text.length);
	const low = Math.min(anchor, offset);
	const first = lineIndex(text, low);
	const last = first + text.slice(low, Math.max(anchor, offset)).split("\n").length - 1;
	const action: VisualAction = { kind: "indent", dir, count };
	return exit(state, shiftRows(text, first, last, dir, count), recorded(last - first + 1, true, action));
}

function shiftRows(text: string, first: number, last: number, dir: ">" | "<", count: number): Applied {
	const lines = text.split("\n");
	for (let pass = 0; pass < count; pass += 1) {
		for (let row = first; row <= last; row += 1) lines[row] = shiftLine(lines[row] ?? "", dir);
	}
	const next = lines.join("\n");
	return { buffer: { text: next, offset: lineOffset(next, first) + indentEnd(lines[first] ?? "") } };
}

/** J over the selected lines. Claude Code joins one fewer than the selected rows and records that many plus one
 * (chunk-hz2c9q6k.js:351-362, 573-584), so `.` joins the same number of lines. A selection on the last row joins nothing
 * and records two. */
function join(state: VimState, visual: VisualState, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const anchor = Math.min(visual.anchor, text.length);
	const low = Math.min(anchor, offset);
	const rows = text.slice(low, Math.max(anchor, offset)).split("\n").length;
	const joined = joinLines({ text, offset: low }, rows);
	const stay = visual.kind === "line" ? lineStart(text, low) : clampNormal(text, low);
	const below = text.split("\n").length - 1 - lineIndex(text, low);
	const count = below === 0 ? 2 : Math.max(1, Math.min(rows - 1, below)) + 1;
	return exit(state, joined ?? { buffer: { text, offset: stay } }, { keys: `${count}J`, inserted: "" });
}

/** `.` over a recorded span, at the cursor. Undefined when the span is empty, so nothing is replayed. */
export function replayVisual(change: VisualChange, buffer: Buffer): Applied | undefined {
	const { text, offset } = buffer;
	const { span, linewise, action } = change;
	if (action.kind === "indent") {
		const first = lineIndex(text, offset);
		const last = Math.min(first + span - 1, text.split("\n").length - 1);
		return shiftRows(text, first, last, action.dir, action.count);
	}
	const { from, to } = replayBounds(text, offset, span, linewise);
	if (action.kind !== "change" && from === to && !(linewise && text.length > 0)) return undefined;
	return apply(action, text, from, to, linewise);
}

function apply(action: SpanAction, text: string, from: number, to: number, linewise: boolean, atEnd = false): Applied {
	switch (action.kind) {
		case "yank":
			return applyRange("y", text, from, to, linewise);
		case "delete":
			return linewise ? deleteLines(text, from, to) : applyRange("d", text, from, to);
		case "change": {
			const edit = linewise ? changeLines(text, from, to, atEnd) : applyRange("c", text, from, to);
			return action.text === undefined ? edit : { buffer: edit.buffer, register: edit.register, typed: action.text };
		}
		case "replace":
			return remap(text, from, to, (unit) => (unit === "\n" ? unit : action.char));
		case "case":
			return remap(text, from, to, (unit) => recase(unit, action.mode));
		case "paste":
			return putOver(text, from, to, action.content, linewise);
	}
}

function recase(unit: string, mode: "toggle" | "lower" | "upper"): string {
	if (mode === "upper") return unit.toUpperCase();
	if (mode === "lower") return unit.toLowerCase();
	return unit === unit.toUpperCase() ? unit.toLowerCase() : unit.toUpperCase();
}

function remap(text: string, from: number, to: number, change: (unit: string) => string): Applied {
	const mapped = unitSegments(text.slice(from, to))
		.map((unit) => change(unit.segment))
		.join("");
	const next = text.slice(0, from) + mapped + text.slice(to);
	return { buffer: { text: next, offset: clampNormal(next, from) } };
}

/** Linewise d: the lines go to the register, and a last line takes the break before it along. */
function deleteLines(text: string, from: number, to: number): Applied {
	const slice = text.slice(from, to);
	const register = { text: slice.endsWith("\n") ? slice : `${slice}\n`, linewise: true };
	const cut = to === text.length && from > 0 && text[from - 1] === "\n" ? from - 1 : from;
	const next = text.slice(0, cut) + text.slice(to);
	const at = to < text.length ? from : lineStart(next, next.length);
	return { buffer: { text: next, offset: clampNormal(next, firstNonBlank(next, at)) }, register };
}

/** Linewise c: the lines go to the register and one empty line is left to type on. */
function changeLines(text: string, from: number, to: number, atEnd: boolean): Edit {
	const slice = text.slice(from, to);
	const register = { text: slice.endsWith("\n") ? slice : `${slice}\n`, linewise: true };
	const after = text.slice(to);
	const keepBreak = after !== "" || (slice.endsWith("\n") && !atEnd);
	const next = text.slice(0, from) + (keepBreak ? "\n" : "") + after;
	return { buffer: { text: next, offset: from }, register, insert: true };
}

/** p and P over the selection: the replaced text goes to the register, the register's text takes its place. */
function putOver(text: string, from: number, to: number, content: string, linewise: boolean): Applied {
	const replaced = text.slice(from, to);
	let put = content.endsWith("\n") ? content.slice(0, -1) : content;
	if (replaced.endsWith("\n") && !put.endsWith("\n")) put += "\n";
	const next = text.slice(0, from) + put + text.slice(to);
	let offset = from;
	if (linewise) offset = firstNonBlank(next, from);
	else if (!put.endsWith("\n")) offset = from + prevUnit(put, put.length);
	return {
		buffer: { text: next, offset: clampNormal(next, offset) },
		register: { text: linewise && !replaced.endsWith("\n") ? `${replaced}\n` : replaced, linewise },
		content: put,
	};
}
