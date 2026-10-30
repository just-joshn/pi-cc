// Text positions for the vim engine: line bounds, editing units, word motions, find, and text objects.
// Everything works on the prompt as one string. An editing unit is a grapheme, or a whole paste marker.
import { getGraphemeSegmenter, visibleWidth } from "../utils.ts";

export interface Range {
	readonly start: number;
	readonly end: number;
}

const segmenter = getGraphemeSegmenter();
const MARKER = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const MARKER_UNIT = /^\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/;
const WORD = /^[\p{L}\p{N}\p{M}_]+$/u;

export function lineStart(text: string, at: number): number {
	return at <= 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
}

export function lineEnd(text: string, at: number): number {
	const end = text.indexOf("\n", at);
	return end === -1 ? text.length : end;
}

export function lineIndex(text: string, at: number): number {
	let index = 0;
	for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) index += 1;
	return index;
}

export function lineCount(text: string): number {
	return text.split("\n").length;
}

/** Offset of the first character of line `line`, clamped to the last line. */
export function lineOffset(text: string, line: number): number {
	let offset = 0;
	for (let index = 0; index < line; index += 1) {
		const next = text.indexOf("\n", offset);
		if (next === -1) break;
		offset = next + 1;
	}
	return offset;
}

// One-entry memo: a key press asks about the same text many times.
let memo: { readonly text: string; readonly starts: readonly number[] } | undefined;

/** Start offsets of every editing unit, with text.length last. */
function unitStarts(text: string): readonly number[] {
	if (memo?.text === text) return memo.starts;
	const markers = [...text.matchAll(MARKER)].map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
	const starts: number[] = [];
	let marker = 0;
	for (const segment of segmenter.segment(text)) {
		while (marker < markers.length && (markers[marker]?.end ?? 0) <= segment.index) marker += 1;
		const current = markers[marker];
		if (current !== undefined && segment.index > current.start && segment.index < current.end) continue;
		starts.push(segment.index);
	}
	starts.push(text.length);
	memo = { text, starts };
	return starts;
}

function unitIndex(starts: readonly number[], at: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] ?? 0) <= at) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** Start of the unit after the one at `at`. */
export function nextUnit(text: string, at: number): number {
	if (at >= text.length) return text.length;
	const starts = unitStarts(text);
	return starts[unitIndex(starts, at) + 1] ?? text.length;
}

/** Start of the unit before `at`. */
export function prevUnit(text: string, at: number): number {
	if (at <= 0) return 0;
	const starts = unitStarts(text);
	return starts[unitIndex(starts, Math.min(at, text.length) - 1)] ?? 0;
}

/** Moves `at` to the start of the unit that contains it. */
export function snapStart(text: string, at: number): number {
	const starts = unitStarts(text);
	return starts[unitIndex(starts, Math.max(0, Math.min(at, text.length)))] ?? 0;
}

/** Moves `at` to the end of the unit that contains it, when it falls inside one. */
export function snapEnd(text: string, at: number): number {
	const safe = Math.max(0, Math.min(at, text.length));
	return snapStart(text, safe) === safe ? safe : nextUnit(text, safe);
}

/** The normal-mode cursor rests on a character: never past its line's last unit, never inside a marker. */
export function clampNormal(text: string, at: number): number {
	const safe = snapStart(text, at);
	const start = lineStart(text, safe);
	const end = lineEnd(text, safe);
	const last = end > start ? prevUnit(text, end) : start;
	return Math.min(safe, last);
}

/** Offset of the first non-blank character of the line, or the line start when it is all blank. */
export function firstNonBlank(text: string, at: number): number {
	const start = lineStart(text, at);
	const index = text.slice(start, lineEnd(text, at)).search(/\S/);
	return start + Math.max(0, index);
}

/** Where the cursor lands on an indented line: the first non-blank unit, or the last unit when all blank. */
export function indentEnd(line: string): number {
	let last = 0;
	for (let at = 0; at < line.length; at = nextUnit(line, at)) {
		last = at;
		if (!/[ \t]/.test(line[at] ?? "")) break;
	}
	return last;
}

export function isBlank(char: string | undefined): boolean {
	return char !== undefined && /\s/.test(char);
}

const EMPTY = 0;
const WORD_CLASS = 1;
const PUNCT = 2;
const MARKER_CLASS = 3;

interface Runs {
	readonly starts: readonly number[];
	readonly classes: readonly number[];
}

function runs(text: string, big: boolean): Runs {
	const starts = unitStarts(text);
	const classes = starts.slice(0, -1).map((start, index) => {
		const unit = text.slice(start, starts[index + 1]);
		if (MARKER_UNIT.test(unit)) return big ? WORD_CLASS : MARKER_CLASS;
		if (/\s/.test(unit)) return EMPTY;
		if (big) return WORD_CLASS;
		return WORD.test(unit) ? WORD_CLASS : PUNCT;
	});
	return { starts, classes };
}

/** w and W: the start of the word `count` words on. */
export function wordForward(text: string, at: number, big: boolean, count: number): number {
	const { starts, classes } = runs(text, big);
	let index = unitIndex(starts, at);
	for (let step = 0; step < count && index < classes.length; step += 1) {
		const from = classes[index];
		let next = index;
		if (from !== EMPTY) while (next < classes.length && classes[next] === from) next += 1;
		while (next < classes.length && classes[next] === EMPTY) next += 1;
		if (next === index) break;
		index = next;
	}
	return starts[index] ?? text.length;
}

/** e and E: the last unit of the word `count` words on. Past the end this is text.length. */
export function wordEnd(text: string, at: number, big: boolean, count: number): number {
	const { starts, classes } = runs(text, big);
	let index = unitIndex(starts, at);
	for (let step = 0; step < count && index < classes.length; step += 1) {
		let next = index + 1;
		while (next < classes.length && classes[next] === EMPTY) next += 1;
		if (next >= classes.length) {
			index = classes.length;
			break;
		}
		const from = classes[next];
		while (next + 1 < classes.length && classes[next + 1] === from) next += 1;
		index = next;
	}
	return starts[index] ?? text.length;
}

/** b and B: the start of the word `count` words back. */
export function wordBackward(text: string, at: number, big: boolean, count: number): number {
	const { starts, classes } = runs(text, big);
	let index = unitIndex(starts, at);
	for (let step = 0; step < count && index > 0; step += 1) {
		let next = index - 1;
		while (next > 0 && classes[next] === EMPTY) next -= 1;
		if (next === 0 && classes[0] === EMPTY) {
			index = 0;
			break;
		}
		const from = classes[next];
		while (next > 0 && classes[next - 1] === from) next -= 1;
		index = next;
	}
	return starts[index] ?? 0;
}

/** f F t T within the current line, matching Claude Code: undefined when the nth match does not exist. */
export function findChar(text: string, at: number, kind: string, char: string, count: number): number | undefined {
	const forward = kind === "f" || kind === "t";
	const till = kind === "t" || kind === "T";
	let seen = 0;
	if (forward) {
		const end = lineEnd(text, at);
		for (let from = nextUnit(text, at); from < end; from = nextUnit(text, from)) {
			if (text.slice(from, nextUnit(text, from)) !== char) continue;
			seen += 1;
			if (seen === count) return till ? Math.max(at, prevUnit(text, from)) : from;
		}
		return undefined;
	}
	const start = lineStart(text, at);
	if (at <= start) return undefined;
	for (let from = prevUnit(text, at); from >= start; from = prevUnit(text, from)) {
		if (text.slice(from, nextUnit(text, from)) === char) {
			seen += 1;
			if (seen === count) return till ? Math.min(at, nextUnit(text, from)) : from;
		}
		if (from === start) break;
	}
	return undefined;
}

/** Column in display cells of `at` within its line. */
export function columnOf(text: string, at: number): number {
	return visibleWidth(text.slice(lineStart(text, at), at));
}

/** The unit on the line [start, end) that covers display column `column`, or `end` when the line is shorter. */
export function offsetAtColumn(text: string, start: number, end: number, column: number): number {
	let width = 0;
	for (let at = start; at < end; at = nextUnit(text, at)) {
		width += visibleWidth(text.slice(at, nextUnit(text, at)));
		if (width > column) return at;
	}
	return end;
}

const BRACKETS: Readonly<Record<string, readonly [string, string]>> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
	'"': ['"', '"'],
	"'": ["'", "'"],
	"`": ["`", "`"],
};

export const TEXT_OBJECTS = "wW\"'`()b[]{}B<>";

function wordObject(text: string, at: number, big: boolean, inner: boolean): Range | undefined {
	const { starts, classes } = runs(text, big);
	if (classes.length === 0) return undefined;
	let index = classes.length - 1;
	if (at < text.length) index = unitIndex(starts, at);
	const at0 = (i: number) => starts[i] ?? text.length;
	const from = classes[index];
	let low = index;
	let high = index;
	if (from === EMPTY) {
		while (low > 0 && classes[low - 1] === EMPTY) low -= 1;
		while (high < classes.length && classes[high] === EMPTY) high += 1;
		return { start: at0(low), end: at0(high) };
	}
	const same = (i: number) => (from === WORD_CLASS ? classes[i] === WORD_CLASS : (classes[i] ?? 0) >= PUNCT);
	while (low > 0 && same(low - 1)) low -= 1;
	while (high < classes.length && same(high)) high += 1;
	if (!inner) {
		if (high < classes.length && classes[high] === EMPTY)
			while (high < classes.length && classes[high] === EMPTY) high += 1;
		else if (low > 0 && classes[low - 1] === EMPTY) while (low > 0 && classes[low - 1] === EMPTY) low -= 1;
	}
	return { start: at0(low), end: at0(high) };
}

function quoteObject(text: string, at: number, quote: string, inner: boolean): Range | undefined {
	const start = lineStart(text, at);
	const line = text.slice(start, lineEnd(text, at));
	const quotes: number[] = [];
	for (let i = 0; i < line.length; i += 1) if (line[i] === quote) quotes.push(i);
	const cursor = at - start;
	for (let i = 0; i + 1 < quotes.length; i += 2) {
		const open = quotes[i] ?? 0;
		const close = quotes[i + 1] ?? 0;
		if (open <= cursor && cursor <= close) {
			return inner
				? { start: start + open + 1, end: start + close }
				: { start: start + open, end: start + close + 1 };
		}
	}
	return undefined;
}

function bracketObject(text: string, at: number, open: string, close: string, inner: boolean): Range | undefined {
	let depth = 0;
	let left = -1;
	for (let i = at; i >= 0; i -= 1) {
		if (text[i] === close && i !== at) depth += 1;
		else if (text[i] === open) {
			if (depth === 0) {
				left = i;
				break;
			}
			depth -= 1;
		}
	}
	if (left === -1) return undefined;
	depth = 0;
	let right = -1;
	for (let i = left + 1; i < text.length; i += 1) {
		if (text[i] === open) depth += 1;
		else if (text[i] === close) {
			if (depth === 0) {
				right = i;
				break;
			}
			depth -= 1;
		}
	}
	if (right === -1) return undefined;
	return inner ? { start: left + 1, end: right } : { start: left, end: right + 1 };
}

/** iw aw iW aW and the quote and bracket objects, with Claude Code's rules. */
export function textObject(text: string, at: number, scope: "i" | "a", object: string): Range | undefined {
	const inner = scope === "i";
	if (object === "w") return wordObject(text, at, false, inner);
	if (object === "W") return wordObject(text, at, true, inner);
	const pair = BRACKETS[object];
	if (pair === undefined) return undefined;
	return pair[0] === pair[1]
		? quoteObject(text, at, pair[0], inner)
		: bracketObject(text, at, pair[0], pair[1], inner);
}

/** % : the bracket matching the first bracket at or after `at` on its line. */
export function matchingBracket(text: string, at: number): number | undefined {
	const found = text.slice(at, lineEnd(text, at)).search(/[()[\]{}]/);
	if (found === -1) return undefined;
	const bracket = at + found;
	const pair = BRACKETS[text[bracket] ?? ""];
	if (pair === undefined) return undefined;
	const range = bracketObject(text, bracket, pair[0], pair[1], false);
	if (range === undefined) return undefined;
	return range.start === bracket ? range.end - 1 : range.start;
}
