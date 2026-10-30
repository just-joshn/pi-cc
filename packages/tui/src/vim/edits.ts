// Vim edits as pure functions over {text, offset}: each returns the new buffer, and the register it filled.
import {
	clampNormal,
	indentEnd,
	lineIndex,
	lineOffset,
	lineStart,
	nextUnit,
	prevUnit,
	snapEnd,
	snapStart,
} from "./text.ts";

export interface Buffer {
	readonly text: string;
	readonly offset: number;
	/** The width the prompt wraps at; gj and gk need it, and without it they move like j and k. */
	readonly columns?: number;
}

export interface Register {
	readonly text: string;
	readonly linewise: boolean;
}

export type Operator = "d" | "c" | "y";

export interface Edit {
	readonly buffer: Buffer;
	/** The register after the edit; absent when the edit leaves it alone. */
	readonly register?: Register;
	/** The edit leaves the cursor where typing starts: the engine enters insert mode. */
	readonly insert?: boolean;
}

const EMPTY_REGISTER: Register = { text: "", linewise: false };

/** Applies d, c, or y to the characters [from, to). `linewise` only marks the register. */
export function applyRange(op: Operator, text: string, from: number, to: number, linewise = false): Edit {
	const start = snapStart(text, from);
	const end = snapEnd(text, to);
	let yanked = text.slice(start, end);
	if (linewise && !yanked.endsWith("\n")) yanked += "\n";
	const register = { text: yanked, linewise };
	if (op === "y") return { buffer: { text, offset: clampNormal(text, start) }, register };
	const next = text.slice(0, start) + text.slice(end);
	if (op === "d") return { buffer: { text: next, offset: clampNormal(next, start) }, register };
	return { buffer: { text: next, offset: start }, register, insert: true };
}

/** A motion that did not move: y empties the register, c starts typing in place, d does nothing. */
export function applyEmpty(op: Operator, buffer: Buffer): Edit | undefined {
	if (op === "d") return undefined;
	if (op === "y") return { buffer, register: EMPTY_REGISTER };
	return { buffer, register: EMPTY_REGISTER, insert: true };
}

/** d, c, or y over whole lines first..last. `yankOffset` is where a yank leaves the cursor. */
export function applyLines(op: Operator, buffer: Buffer, first: number, last: number, yankOffset: number): Edit {
	const lines = buffer.text.split("\n");
	const end = Math.min(last + 1, lines.length);
	const register = {
		text: lines
			.slice(first, end)
			.map((line) => `${line}\n`)
			.join(""),
		linewise: true,
	};
	if (op === "y") return { buffer: { text: buffer.text, offset: clampNormal(buffer.text, yankOffset) }, register };
	const before = lines.slice(0, first);
	const after = lines.slice(end);
	if (op === "c") {
		const text = [...before, "", ...after].join("\n");
		return { buffer: { text, offset: lineOffset(text, first) }, register, insert: true };
	}
	const remaining = [...before, ...after];
	const text = remaining.join("\n");
	const line = Math.max(0, Math.min(first, remaining.length - 1));
	const offset = lineOffset(text, line) + indentEnd(remaining[line] ?? "");
	return { buffer: { text, offset: clampNormal(text, offset) }, register };
}

/** The end of the `count` units from the cursor, stopping at a line break. */
function unitsEnd(text: string, offset: number, count: number): number {
	let end = offset;
	for (let step = 0; step < count && end < text.length && text[end] !== "\n"; step += 1) end = nextUnit(text, end);
	return end;
}

/** x: deletes `count` characters under and after the cursor. */
export function deleteChars(buffer: Buffer, count: number): Edit | undefined {
	const { text, offset } = buffer;
	const end = unitsEnd(text, offset, count);
	if (end === offset) return undefined;
	const next = text.slice(0, offset) + text.slice(end);
	return {
		buffer: { text: next, offset: clampNormal(next, offset) },
		register: { text: text.slice(offset, end), linewise: false },
	};
}

/** s: like x, then types in place. */
export function substitute(buffer: Buffer, count: number): Edit {
	const { text, offset } = buffer;
	const end = unitsEnd(text, offset, count);
	if (end === offset) return { buffer, insert: true };
	return {
		buffer: { text: text.slice(0, offset) + text.slice(end), offset },
		register: { text: text.slice(offset, end), linewise: false },
		insert: true,
	};
}

/** r{char}: replaces `count` characters, only when the line has that many. */
export function replaceChars(buffer: Buffer, char: string, count: number): Edit | undefined {
	const { text, offset } = buffer;
	const end = unitsEnd(text, offset, count);
	let units = 0;
	for (let at = offset; at < end; at = nextUnit(text, at)) units += 1;
	if (units < count) return undefined;
	return {
		buffer: {
			text: text.slice(0, offset) + char.repeat(count) + text.slice(end),
			offset: offset + char.length * (count - 1),
		},
	};
}

/** ~: swaps the case of `count` characters and moves past them. */
export function toggleCase(buffer: Buffer, count: number): Edit | undefined {
	let { text } = buffer;
	let at = buffer.offset;
	let done = 0;
	while (at < text.length && text[at] !== "\n" && done < count) {
		const unit = text.slice(at, nextUnit(text, at));
		const flipped = (unit === unit.toUpperCase() ? unit.toLowerCase() : unit.toUpperCase()).normalize("NFC");
		text = text.slice(0, at) + flipped + text.slice(at + unit.length);
		at += flipped.length;
		done += 1;
	}
	if (done === 0) return undefined;
	return { buffer: { text, offset: clampNormal(text, at) } };
}

/** p and P, for a character or a line register. */
export function put(buffer: Buffer, register: Register | undefined, after: boolean, count: number): Edit | undefined {
	if (register === undefined || register.text === "") return undefined;
	const { text, offset } = buffer;
	const body = register.linewise && register.text.endsWith("\n") ? register.text.slice(0, -1) : register.text;
	if (register.linewise) {
		const lines = text.split("\n");
		const at = lineIndex(text, offset) + (after ? 1 : 0);
		const chunk = body.split("\n");
		const inserted = Array.from({ length: count }, () => chunk).flat();
		const next = [...lines.slice(0, at), ...inserted, ...lines.slice(at)].join("\n");
		return { buffer: { text: next, offset: lineOffset(next, at) + indentEnd(chunk[0] ?? "") } };
	}
	const chunk = body.repeat(count);
	const onEmptyLine = text[offset] === "\n" && (offset === 0 || text[offset - 1] === "\n");
	const at = after && offset < text.length && !onEmptyLine ? nextUnit(text, offset) : offset;
	const next = text.slice(0, at) + chunk + text.slice(at);
	const landing = chunk.includes("\n") ? clampNormal(next, at) : at + prevUnit(chunk, chunk.length);
	return { buffer: { text: next, offset: landing } };
}

/** J: joins `count` lines (at least two) into the current one. */
export function joinLines(buffer: Buffer, count: number): Edit | undefined {
	const { text, offset } = buffer;
	const lines = text.split("\n");
	const row = lineIndex(text, offset);
	if (row >= lines.length - 1) {
		if (count < 3) return undefined;
		return { buffer: { text, offset: lineStart(text, offset) } };
	}
	const joins = Math.min(Math.max(count, 2) - 1, lines.length - row - 1);
	let joined = lines[row] ?? "";
	let previous = joined;
	let seam = joined.length;
	for (let step = 1; step <= joins; step += 1) {
		seam = joined.length;
		const next = (lines[row + step] ?? "").replace(/^[ \t\r]+/, "");
		if (next.length > 0 && joined.length > 0 && !next.startsWith(")") && !/[ \t]$/.test(previous)) joined += " ";
		joined += next;
		previous = next;
	}
	const merged = [...lines.slice(0, row), joined, ...lines.slice(row + joins + 1)].join("\n");
	return { buffer: { text: merged, offset: clampNormal(merged, lineOffset(merged, row) + seam) } };
}

function shiftLine(line: string, dir: ">" | "<"): string {
	if (line === "") return line;
	if (dir === ">") return `  ${line}`;
	if (line.startsWith("  ")) return line.slice(2);
	if (line.startsWith("\t")) return line.slice(1);
	const lead = /^\s{1,2}/.exec(line)?.[0].length ?? 0;
	return line.slice(lead);
}

/** >> and <<: shifts `count` lines by two spaces. */
export function indentLines(buffer: Buffer, dir: ">" | "<", count: number): Edit | undefined {
	const { text, offset } = buffer;
	const lines = text.split("\n");
	const row = lineIndex(text, offset);
	if (count > 1 && row === lines.length - 1) return undefined;
	const last = row + Math.min(count, lines.length - row) - 1;
	const shifted = lines.map((line, index) => (index >= row && index <= last ? shiftLine(line, dir) : line));
	const next = shifted.join("\n");
	return { buffer: { text: next, offset: lineOffset(next, row) + indentEnd(shifted[row] ?? "") } };
}

/** o and O: opens an empty line below or above and starts typing on it. */
export function openLine(buffer: Buffer, below: boolean): Edit {
	const lines = buffer.text.split("\n");
	const at = lineIndex(buffer.text, buffer.offset) + (below ? 1 : 0);
	const next = [...lines.slice(0, at), "", ...lines.slice(at)].join("\n");
	return { buffer: { text: next, offset: lineOffset(next, at) }, insert: true };
}
