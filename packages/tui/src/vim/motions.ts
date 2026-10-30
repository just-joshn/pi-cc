// Cursor motions that need no operator: where each key sends the cursor, following Claude Code.
import {
	columnOf,
	firstNonBlank,
	lineEnd,
	lineOffset,
	lineStart,
	matchingBracket,
	nextUnit,
	offsetAtColumn,
	prevUnit,
	snapStart,
	wordBackward,
	wordEnd,
	wordForward,
} from "./text.ts";

/** A remembered column for j and k, valid while the cursor stays where the motion left it. */
export interface Wanted {
	readonly column: number;
	readonly offset: number;
	readonly text: string;
}

export const BACKSPACE = "\b";

export function lastChar(text: string, at: number): number {
	const start = lineStart(text, at);
	const end = lineEnd(text, at);
	return end > start ? prevUnit(text, end) : start;
}

function stepOnce(text: string, at: number, motion: string): number {
	switch (motion) {
		case "h":
			return at === lineStart(text, at) ? at : prevUnit(text, at);
		case "l":
			return at === lineEnd(text, at) ? at : nextUnit(text, at);
		case "0":
			return lineStart(text, at);
		case "^":
			return firstNonBlank(text, at);
		case "$":
			return lastChar(text, at);
		default:
			return at;
	}
}

// Space and backspace cross line breaks but never rest on one.
function crossingStep(text: string, at: number, motion: string): number {
	let next = motion === BACKSPACE ? prevUnit(text, at) : nextUnit(text, at);
	if (text[next] === "\n" && next > 0 && text[next - 1] !== "\n") {
		next = motion === BACKSPACE ? prevUnit(text, next) : nextUnit(text, next);
	}
	return next;
}

/** Where a horizontal or word motion sends the cursor `count` times. */
export function motionTarget(text: string, at: number, motion: string, count: number): number {
	switch (motion) {
		case "%":
			return count === 1 ? (matchingBracket(text, at) ?? at) : at;
		case "w":
		case "W":
			return wordForward(text, at, motion === "W", count);
		case "e":
		case "E":
			return wordEnd(text, at, motion === "E", count);
		case "b":
		case "B":
			return wordBackward(text, at, motion === "B", count);
		case " ":
		case BACKSPACE: {
			let cursor = at;
			for (let step = 0; step < count; step += 1) {
				const next = crossingStep(text, cursor, motion);
				if (next === cursor) break;
				cursor = next;
			}
			return cursor;
		}
		default: {
			let cursor = at;
			for (let step = 0; step < count; step += 1) {
				const next = stepOnce(text, cursor, motion);
				if (next === cursor) break;
				cursor = next;
			}
			return cursor;
		}
	}
}

/** The column j and k aim for: the remembered one while the cursor has not moved, else the current one. */
export function targetColumn(text: string, at: number, wanted: Wanted | undefined): number {
	if (wanted?.offset === at && wanted.text === text) return wanted.column;
	return columnOf(text, at);
}

/** j or k over logical lines. Undefined when the cursor cannot move that way. */
export function verticalTarget(
	text: string,
	at: number,
	down: boolean,
	count: number,
	column: number,
): number | undefined {
	const origin = lineStart(text, at);
	let line = origin;
	for (let step = 0; step < count; step += 1) {
		if (down) {
			const next = text.indexOf("\n", line);
			if (next === -1) break;
			line = next + 1;
		} else {
			if (line === 0) break;
			line = line === 1 ? 0 : text.lastIndexOf("\n", line - 2) + 1;
		}
	}
	if (line === origin) return undefined;
	return snapStart(text, offsetAtColumn(text, line, lineEnd(text, line), column));
}

/** G with a count goes to that line, without one to the last line; gg and Ngg likewise. Always column 0. */
export function lineTarget(text: string, line: number): number {
	return lineOffset(text, Math.max(0, line - 1));
}

export function lastLineStart(text: string): number {
	return text.lastIndexOf("\n") + 1;
}
