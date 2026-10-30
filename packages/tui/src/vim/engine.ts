// Claude Code's vim mode as a pure state machine over the prompt text and cursor. The editor feeds it one key
// at a time with the current buffer, and applies the buffer it returns as one undo step.
import { displayMove } from "./display.ts";
import {
	applyEmpty,
	applyLines,
	applyRange,
	type Buffer,
	deleteChars,
	type Edit,
	indentLines,
	joinLines,
	type Operator,
	openLine,
	put,
	type Register,
	replaceChars,
	substitute,
	toggleCase,
} from "./edits.ts";
import {
	BACKSPACE,
	lastChar,
	lastLineStart,
	lineTarget,
	motionTarget,
	targetColumn,
	verticalTarget,
	type Wanted,
} from "./motions.ts";
import {
	clampNormal,
	findChar,
	firstNonBlank,
	isBlank,
	lineCount,
	lineEnd,
	lineIndex,
	lineStart,
	nextUnit,
	prevUnit,
	snapEnd,
	snapStart,
	textObject,
	wordEnd,
	wordForward,
} from "./text.ts";
import { enterVisual, MAX_COUNT, replayVisual, type VisualChange, type VisualState, visualKey } from "./visual.ts";

export type { Buffer } from "./edits.ts";

export type VimMode = "insert" | "normal" | "visual";

/** What the editor tells the engine about a key press. Printable keys arrive as their character. */
export type VimInput =
	| { readonly kind: "escape" }
	| { readonly kind: "key"; readonly key: string }
	| { readonly kind: "other" };

export interface Find {
	readonly kind: string;
	readonly char: string;
}

export interface Change {
	/** The command's keys, replayed by `.`; empty for plain typing in insert mode. */
	readonly keys: string;
	readonly inserted: string;
	/** A visual-mode change, replayed over the same amount of text at the cursor; its keys are empty. */
	readonly visual?: VisualChange;
}

interface InsertSession {
	readonly start: number;
	readonly before: string;
	readonly keys: string;
	/** The session follows a visual c: Escape records it as a visual change that retypes its text. */
	readonly visual?: Pick<VisualChange, "span" | "linewise">;
}

export interface VimState {
	readonly mode: VimMode;
	/** Keys typed so far for an unfinished command, such as "2d" or "ci". */
	readonly pending: string;
	readonly register?: Register;
	readonly lastFind?: Find;
	readonly lastChange?: Change;
	readonly insert?: InsertSession;
	readonly wanted?: Wanted;
	/** The selection; present exactly in visual mode. */
	readonly visual?: VisualState;
}

export interface VimStep {
	readonly state: VimState;
	/** The new text and cursor, when the key edited or moved. */
	readonly buffer?: Buffer;
	/** Run the editor's undo once. */
	readonly undo?: boolean;
	/** `k` on the first line and `j` on the last line walk the prompt history. */
	readonly history?: "up" | "down";
	/** The key is not vim's: give it to the editor unchanged. */
	readonly passThrough: boolean;
	/** Leave the cursor where it is, even past the last character (a chord that ends visual mode). */
	readonly keepCursor?: boolean;
}

export const INSERT_STATE: VimState = { mode: "insert", pending: "" };
export const NORMAL_STATE: VimState = { mode: "normal", pending: "" };

const COUNT = String.raw`[1-9]\d*`;
const MOTION = String.raw`[hl \x08jkwbeWBE0^$%G]|g[gjk]|[fFtT][\s\S]+`;
const OBJECT = String.raw`[ia][wW"'\x60()b[\]{}B<>]`;
const COMMAND = new RegExp(
	`^(${COUNT})?(?:([dcy])(${COUNT})?(${MOTION}|${OBJECT}|[dcy])|(>>|<<)|(${MOTION})|(r[\\s\\S]+|[iIaAoOxsSDCYpPuJ.~;,]))$`,
	"u",
);
const PARTIAL = new RegExp(`^(?:${COUNT}|(?:${COUNT})?(?:[dcy](?:${COUNT})?(?:[ia]|[fFtT]|g)?|[<>gr]|[fFtT]))$`, "u");
// A trailing count digit always continues the count: "10" is a count, not "1" then the 0 motion.
const COUNT_ENDING = new RegExp(`^(?:${COUNT}|(?:${COUNT})?[dcy]${COUNT})$`);
const TILL_END_ALIASES: Readonly<Record<string, Operator>> = { D: "d", C: "c" };
const LINE_ALIASES: Readonly<Record<string, Operator>> = { S: "c", Y: "y" };

interface Command {
	readonly count?: number;
	readonly op?: Operator;
	readonly opCount?: number;
	readonly target: string;
}

const cap = (digits: string | undefined) => (digits === undefined ? undefined : Math.min(Number(digits), MAX_COUNT));

function parse(keys: string): Command | "partial" | undefined {
	if (COUNT_ENDING.test(keys)) return "partial";
	const match = COMMAND.exec(keys);
	if (match === null) return PARTIAL.test(keys) ? "partial" : undefined;
	const [, count, op, opCount, opTarget, indent, motion, command] = match;
	let parsed: Command;
	if (op !== undefined) {
		const target = opTarget ?? "";
		if (target.length === 1 && "dcy".includes(target) && target !== op) return undefined;
		parsed = { count: cap(count), op: op as Operator, opCount: cap(opCount), target: target };
	} else if (indent !== undefined) {
		parsed = { count: cap(count), target: indent };
	} else {
		const target = motion ?? command ?? "";
		const lineOp = LINE_ALIASES[target];
		const tillEnd = TILL_END_ALIASES[target];
		if (lineOp !== undefined) parsed = { count: cap(count), op: lineOp, target: lineOp };
		else if (tillEnd !== undefined) parsed = { op: tillEnd, target: "$" };
		else parsed = { count: cap(count), target };
	}
	// % ignores counts, so a counted % is not a command.
	if (parsed.target === "%" && (parsed.count !== undefined || parsed.opCount !== undefined)) return undefined;
	return parsed;
}

const step = (state: VimState, buffer?: Buffer, extra: Partial<VimStep> = {}): VimStep => ({
	state,
	passThrough: false,
	...(buffer === undefined ? {} : { buffer }),
	...extra,
});

const cancel = (state: VimState): VimStep => step({ ...state, pending: "" });

const times = (a: number | undefined, b: number | undefined) =>
	a === undefined && b === undefined ? undefined : (a ?? 1) * (b ?? 1);

function startInsert(state: VimState, buffer: Buffer, keys: string): VimStep {
	const insert = { start: buffer.offset, before: buffer.text, keys };
	return step({ ...state, mode: "insert", pending: "", wanted: undefined, insert }, buffer);
}

/** Folds an edit into the state: its register, a change record for `.`, and insert mode when it opens one. */
function settle(state: VimState, edit: Edit | undefined, keys: string, records: boolean): VimStep {
	if (edit === undefined) return cancel(state);
	const next = { ...state, pending: "", wanted: undefined, register: edit.register ?? state.register };
	if (edit.insert) return startInsert(next, edit.buffer, keys);
	return step(records ? { ...next, lastChange: { keys, inserted: "" } } : next, edit.buffer);
}

function lineOperator(state: VimState, op: Operator, buffer: Buffer, count: number, keys: string): VimStep {
	if (count > 1 && !buffer.text.includes("\n", buffer.offset)) return cancel(state);
	const row = lineIndex(buffer.text, buffer.offset);
	return settle(state, applyLines(op, buffer, row, row + count - 1, buffer.offset), keys, op !== "y");
}

/** An operator over the lines from the cursor's to the one containing `target`. */
function linesToward(
	state: VimState,
	op: Operator,
	buffer: Buffer,
	target: number,
	keys: string,
	yankAt: number,
): VimStep {
	const from = lineIndex(buffer.text, buffer.offset);
	const to = lineIndex(buffer.text, target);
	const edit = applyLines(op, buffer, Math.min(from, to), Math.max(from, to), yankAt);
	return settle(state, edit, keys, op !== "y");
}

function wordForwardTimes(text: string, at: number, big: boolean, count: number): number {
	let mark = at;
	for (let rep = 0; rep < count; rep += 1) mark = wordForward(text, mark, big, 1);
	return mark;
}

/** cw and cW: change to the end of the word, or over the blanks when the cursor is on blanks. */
function changeWordRange(text: string, cursor: number, to: number, big: boolean, count: number) {
	let from = Math.min(cursor, to);
	let end = Math.max(cursor, to);
	let linewise = false;
	if (isBlank(text[cursor]) && snapStart(text, cursor) === cursor) {
		let mark = cursor;
		for (let rep = 0; rep < count - 1; rep += 1) {
			const next = wordForward(text, mark, big, 1);
			if (next === mark) break;
			mark = next;
		}
		end = Math.min(end, lineEnd(text, mark));
		if (end > from && text[end - 1] === "\n") {
			end -= 1;
			const start = lineStart(text, cursor);
			if (/^[ \t]*$/.test(text.slice(start, from))) {
				from = start;
				linewise = true;
			}
		}
		return { from, to: end, linewise };
	}
	const mark = wordForwardTimes(text, cursor, big, count - 1);
	let last = wordEnd(text, mark, big, 1);
	const after = nextUnit(text, mark);
	const single = after >= text.length || isBlank(text[after]) || wordForward(text, mark, big, 1) === after;
	if (single && !isBlank(text[cursor]) && !isBlank(text[mark])) last = mark;
	return { from, to: nextUnit(text, last), linewise };
}

/** The characters an operator covers for a motion, following Claude Code's rules. */
function motionRange(text: string, cursor: number, target: number, motion: string, op: Operator, count: number) {
	let range = { from: Math.min(cursor, target), to: Math.max(cursor, target), linewise: false };
	if (op === "c" && (motion === "w" || motion === "W")) {
		range = changeWordRange(text, cursor, target, motion === "W", count);
	} else if ("eE$%".includes(motion) && (motion === "%" || cursor <= target) && text[range.to] !== "\n") {
		range = { ...range, to: nextUnit(text, range.to) };
	}
	if (motion === " " && range.to > range.from && text[range.to - 1] === "\n") {
		const start = lineStart(text, range.from);
		const linewise = /^[ \t]*$/.test(text.slice(start, range.from));
		range = {
			from: linewise ? start : range.from,
			to: linewise && op !== "c" ? range.to : range.to - 1,
			linewise,
		};
	}
	return { from: snapStart(text, range.from), to: snapEnd(text, range.to), linewise: range.linewise };
}

const STAYS_PUT = new Set(["h", "l", " ", BACKSPACE, "0", "^", "w", "W"]);

function verticalOperator(
	state: VimState,
	op: Operator,
	motion: string,
	count: number,
	buffer: Buffer,
	keys: string,
): VimStep {
	const { text, offset } = buffer;
	const column = targetColumn(text, offset, state.wanted);
	const target = verticalTarget(text, offset, motion === "j", count, column);
	if (target === undefined) return cancel(state);
	return linesToward(state, op, buffer, target, keys, motion === "k" ? target : Math.min(offset, target));
}

/** An operator over display rows. When the rows run out only the cursor moves, and nothing is recorded. */
function displayOperator(
	state: VimState,
	op: Operator,
	down: boolean,
	count: number,
	buffer: Buffer,
	keys: string,
): VimStep {
	const { text, offset, columns } = buffer;
	if (columns === undefined) return cancel(state);
	const move = displayMove(text, offset, down, count, columns, state.wanted);
	if (move.runOut) return placeCursor(state, move.offset, move.column, buffer);
	if (move.stepped === offset) return cancel(state);
	const edit = applyRange(op, text, Math.min(offset, move.stepped), Math.max(offset, move.stepped));
	return settle(state, edit, keys, op !== "y");
}

/** Moves the cursor to a gj or gk target and remembers its display column, if it keeps one. */
function placeCursor(state: VimState, target: number, column: number | undefined, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const to = clampNormal(text, target);
	if (to === offset) return cancel(state);
	const wanted = column === undefined ? undefined : { column, offset: to, text };
	return step({ ...state, pending: "", wanted }, { text, offset: to });
}

function displayMotion(state: VimState, down: boolean, count: number, buffer: Buffer): VimStep {
	const { text, offset, columns } = buffer;
	if (columns === undefined) return cancel(state);
	const move = displayMove(text, offset, down, count, columns, state.wanted);
	return placeCursor(state, move.offset, move.column, buffer);
}

function motionOperator(
	state: VimState,
	op: Operator,
	motion: string,
	count: number,
	buffer: Buffer,
	keys: string,
): VimStep {
	const { text, offset } = buffer;
	if (motion === "j" || motion === "k") return verticalOperator(state, op, motion, count, buffer, keys);
	if (motion === "gj" || motion === "gk") return displayOperator(state, op, motion === "gj", count, buffer, keys);
	const target = motionTarget(text, offset, motion, count);
	if (motion === "%" && target === offset) return cancel(state);
	if (target === offset && !"eE$%".includes(motion)) {
		if (STAYS_PUT.has(motion)) return settle(state, applyEmpty(op, buffer), keys, true);
		return cancel(state);
	}
	const range = motionRange(text, offset, target, motion, op, count);
	if (range.from === range.to && !(range.linewise && motion === " ")) {
		return settle(state, applyEmpty(op, { text, offset: range.from }), keys, true);
	}
	const edit = applyRange(op, text, range.from, range.to, range.linewise);
	const kept = op === "y" && range.linewise ? { ...edit, buffer: { text, offset } } : edit;
	return settle(state, kept, keys, op !== "y");
}

function objectOperator(
	state: VimState,
	op: Operator,
	target: string,
	count: number,
	buffer: Buffer,
	keys: string,
): VimStep {
	const { text, offset } = buffer;
	const scope = target[0] === "i" ? "i" : "a";
	const range = textObject(text, offset, scope, target.slice(1));
	if (range === undefined) return cancel(state);
	const edit = applyRange(op, text, range.start, range.end);
	const opensBlock =
		op === "y" &&
		scope === "i" &&
		count === 1 &&
		range.start > 0 &&
		"([{<".includes(text[range.start - 1] ?? " ") &&
		text[range.start] === "\n";
	const kept = opensBlock ? { ...edit, buffer: { text, offset: range.start + 1 } } : edit;
	return settle(state, kept, keys, op !== "y");
}

function findOperator(
	state: VimState,
	op: Operator,
	target: string,
	count: number,
	buffer: Buffer,
	keys: string,
): VimStep {
	const { text, offset } = buffer;
	const find = { kind: target[0] ?? "f", char: target.slice(1) };
	const remembered = { ...state, lastFind: find };
	const found = findChar(text, offset, find.kind, find.char, count);
	if (found === undefined) return cancel(remembered);
	const edit = applyRange(op, text, Math.min(offset, found), nextUnit(text, Math.max(offset, found)));
	return settle(remembered, edit, keys, op !== "y");
}

function runOperator(state: VimState, cmd: Command, op: Operator, buffer: Buffer, keys: string): VimStep {
	const count = times(cmd.count, cmd.opCount) ?? 1;
	const typed = cmd.count !== undefined || cmd.opCount !== undefined;
	const { text, offset } = buffer;
	const target = cmd.target;
	if (target === op) return lineOperator(state, op, buffer, count, keys);
	if (/^[ia]/.test(target)) return objectOperator(state, op, target, count, buffer, keys);
	if (/^[fFtT]/.test(target)) return findOperator(state, op, target, count, buffer, keys);
	if (target === "G" || target === "gg") {
		const first =
			target === "gg"
				? count > 1
					? lineTarget(text, count)
					: 0
				: typed
					? lineTarget(text, count)
					: lastLineStart(text);
		return linesToward(state, op, buffer, first, keys, Math.min(offset, firstNonBlank(text, first)));
	}
	return motionOperator(state, op, target, count, buffer, keys);
}

function horizontalMotion(state: VimState, motion: string, count: number, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const to = clampNormal(text, motionTarget(text, offset, motion, count));
	if (to === offset && "hl \b%".includes(motion)) return cancel(state);
	return step({ ...state, pending: "", wanted: undefined }, { text, offset: to });
}

function verticalMotion(state: VimState, down: boolean, count: number, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const column = targetColumn(text, offset, state.wanted);
	const target = verticalTarget(text, offset, down, count, column);
	if (target === undefined) return step({ ...state, pending: "", wanted: { column, offset, text } });
	const to = clampNormal(text, target);
	return step({ ...state, pending: "", wanted: { column, offset: to, text } }, { text, offset: to });
}

function findMotion(state: VimState, find: Find, count: number, buffer: Buffer): VimStep {
	const remembered = { ...state, pending: "", lastFind: find, wanted: undefined };
	const found = findChar(buffer.text, buffer.offset, find.kind, find.char, count);
	return found === undefined ? step(remembered) : step(remembered, { text: buffer.text, offset: found });
}

const REVERSED: Readonly<Record<string, string>> = { f: "F", F: "f", t: "T", T: "t" };

function repeatFind(state: VimState, reverse: boolean, count: number, buffer: Buffer): VimStep {
	const last = state.lastFind;
	if (last === undefined) return cancel(state);
	const kind = reverse ? (REVERSED[last.kind] ?? last.kind) : last.kind;
	const found = findChar(buffer.text, buffer.offset, kind, last.char, count);
	const cleared = { ...state, pending: "", wanted: undefined };
	return found === undefined ? step(cleared) : step(cleared, { text: buffer.text, offset: found });
}

function plainMotion(state: VimState, cmd: Command, buffer: Buffer): VimStep | undefined {
	const { text } = buffer;
	const target = cmd.target;
	const count = cmd.count ?? 1;
	const cleared = { ...state, pending: "", wanted: undefined };
	if (/^[fFtT]/.test(target))
		return findMotion(state, { kind: target[0] ?? "f", char: target.slice(1) }, count, buffer);
	switch (target) {
		case "G":
			return step(cleared, {
				text,
				offset: cmd.count === undefined ? lastLineStart(text) : lineTarget(text, count),
			});
		case "gg":
			return step(cleared, { text, offset: count > 1 ? lineTarget(text, count) : 0 });
		case "j":
		case "k":
			return verticalMotion(state, target === "j", count, buffer);
		case "gj":
		case "gk":
			return displayMotion(state, target === "gj", count, buffer);
		case "$": {
			const to = lastChar(text, buffer.offset);
			return step(
				{ ...state, pending: "", wanted: { column: Number.POSITIVE_INFINITY, offset: to, text } },
				{ text, offset: to },
			);
		}
		case "h":
		case "l":
		case " ":
		case BACKSPACE:
		case "w":
		case "W":
		case "b":
		case "B":
		case "e":
		case "E":
		case "0":
		case "^":
		case "%":
			return horizontalMotion(state, target, count, buffer);
		default:
			return undefined;
	}
}

function insertCommand(state: VimState, command: string, buffer: Buffer, keys: string): VimStep {
	const { text, offset } = buffer;
	if (command === "o" || command === "O") return settle(state, openLine(buffer, command === "o"), keys, true);
	const starts: Record<string, number> = {
		i: offset,
		I: firstNonBlank(text, offset),
		a: offset >= text.length || text[offset] === "\n" ? offset : nextUnit(text, offset),
		A: lineEnd(text, offset),
	};
	return startInsert({ ...state, pending: "" }, { text, offset: starts[command] ?? offset }, keys);
}

function runCommand(state: VimState, cmd: Command, buffer: Buffer, keys: string): VimStep {
	const target = cmd.target;
	const count = cmd.count ?? 1;
	if (target === ">>" || target === "<<")
		return settle(state, indentLines(buffer, target[0] === ">" ? ">" : "<", count), keys, true);
	if (target.length > 1 && target[0] === "r")
		return settle(state, replaceChars(buffer, target.slice(1), count), keys, true);
	switch (target) {
		case "x":
			return settle(state, deleteChars(buffer, count), keys, true);
		case "s":
			return settle(state, substitute(buffer, count), keys, true);
		case "~":
			return settle(state, toggleCase(buffer, count), keys, true);
		case "J":
			return settle(state, joinLines(buffer, count), keys, true);
		case "p":
		case "P":
			return settle(state, put(buffer, state.register, target === "p", count), keys, true);
		case "u":
			return step({ ...state, pending: "" }, undefined, { undo: true });
		case ".":
			return repeatChange(state, buffer, cmd.count);
		case ";":
		case ",":
			return repeatFind(state, target === ",", count, buffer);
		case "i":
		case "I":
		case "a":
		case "A":
		case "o":
		case "O":
			return insertCommand(state, target, buffer, keys);
		default:
			return plainMotion(state, cmd, buffer) ?? cancel(state);
	}
}

// Without a wrap width every logical line is one display row, so gj and gk are j and k.
function withoutWrap(cmd: Command, buffer: Buffer): Command {
	if (buffer.columns !== undefined || (cmd.target !== "gj" && cmd.target !== "gk")) return cmd;
	return { ...cmd, target: cmd.target === "gj" ? "j" : "k" };
}

function execute(state: VimState, cmd: Command, buffer: Buffer, keys: string): VimStep {
	const command = withoutWrap(cmd, buffer);
	if (command.op !== undefined) return runOperator(state, command, command.op, buffer, keys);
	return runCommand(state, command, buffer, keys);
}

// `.` with a count replaces the count of commands where a count means "how many", not "how far".
const COUNTED_PLAIN = new Set(["x", "s", "p", "P"]);
const FIXED_MOTIONS = new Set(["h", "l", " ", BACKSPACE, "%"]);

function countable(cmd: Command): boolean {
	if (cmd.op === undefined) return COUNTED_PLAIN.has(cmd.target);
	return !/^[fFtT]/.test(cmd.target) && !FIXED_MOTIONS.has(cmd.target);
}

/** `.`: runs the last change again at the cursor, retyping what its insert session typed. */
function repeatChange(state: VimState, buffer: Buffer, count: number | undefined): VimStep {
	const change = state.lastChange;
	if (change === undefined) return cancel(state);
	if (change.visual !== undefined) return repeatVisual(state, buffer, change, change.visual);
	let working = { ...state, pending: "" };
	let after = buffer;
	if (change.keys !== "") {
		const parsed = parse(change.keys);
		if (parsed === undefined || parsed === "partial") return cancel(state);
		// Claude Code's i/I/a/A records carry no text, so . skips an empty one. Its o/O record an openLine whose
		// replay inserts through the buffer without entering insert mode (chunk-hz2c9q6k.js:403, 1299-1312), so
		// . ends in normal mode like those four. s, S and the change operators rerun and do stay in insert.
		if (/^[iIaA]$/.test(change.keys) && change.inserted === "") return cancel(state);
		const cmd = count !== undefined && countable(parsed) ? { ...parsed, count, opCount: undefined } : parsed;
		const ran = execute(working, cmd, buffer, change.keys);
		if (ran.state.mode !== "insert") return step({ ...ran.state, lastChange: change }, ran.buffer);
		working = ran.state;
		after = ran.buffer ?? buffer;
		const typed = applyInserted(after, change.inserted);
		if (/^[iIaAoO]$/.test(change.keys)) {
			return step({ ...working, mode: "normal", insert: undefined, lastChange: change }, typed);
		}
		// A rerun that opened insert stays there, like Claude Code's replay; Escape then records only
		// what is typed next.
		return step(
			{ ...working, insert: { start: typed.offset, before: typed.text, keys: "" }, lastChange: change },
			typed,
		);
	}
	return step(
		{ ...working, mode: "normal", insert: undefined, lastChange: change },
		applyInserted(after, change.inserted),
	);
}

/** `.` over a visual change: the same amount of text at the cursor, then the typed text of a visual c. */
function repeatVisual(state: VimState, buffer: Buffer, change: Change, visual: VisualChange): VimStep {
	const ran = replayVisual(visual, buffer);
	if (ran === undefined) return cancel(state);
	const landed = ran.typed === undefined ? ran.buffer : applyInserted(ran.buffer, ran.typed);
	const next = {
		...state,
		pending: "",
		wanted: undefined,
		register: ran.register ?? state.register,
		lastChange: change,
	};
	return step(next, landed);
}

/** Inserts the recorded typing at the insert point; the cursor rests before its last character. */
function applyInserted(after: Buffer, inserted: string): Buffer {
	const text = after.text.slice(0, after.offset) + inserted + after.text.slice(after.offset);
	const end = after.offset + inserted.length;
	const offset = inserted !== "" && end > lineStart(text, end) ? prevUnit(text, end) : end;
	return { text, offset };
}

/** Escape in insert mode: back to normal, one character left, and the typed text saved for `.`. */
function leaveInsert(state: VimState, buffer: Buffer): VimStep {
	const { text, offset } = buffer;
	const session = state.insert;
	let lastChange = state.lastChange;
	if (session !== undefined) {
		const typed = offset < session.start ? "" : text.slice(session.start, offset);
		const plain = session.before.slice(0, session.start) + typed + session.before.slice(session.start) === text;
		if (session.visual !== undefined) {
			const action = { kind: "change" as const, text: plain ? typed : "" };
			lastChange = { keys: "", inserted: "", visual: { ...session.visual, action } };
		} else if (session.keys !== "" || (plain && typed !== "")) {
			lastChange = { keys: session.keys, inserted: plain ? typed : "" };
		}
	}
	const left = offset > lineStart(text, offset) ? prevUnit(text, offset) : offset;
	const next = { ...state, mode: "normal" as const, pending: "", insert: undefined, wanted: undefined, lastChange };
	return step(next, { text, offset: left });
}

function insertKey(state: VimState, input: VimInput, buffer: Buffer): VimStep {
	if (input.kind === "escape") return leaveInsert(state, buffer);
	if (input.kind !== "key" || state.insert !== undefined) return { state, passThrough: true };
	const insert = { start: buffer.offset, before: buffer.text, keys: "" };
	return { state: { ...state, insert }, passThrough: true };
}

function historyStep(state: VimState, key: string, text: string, offset: number): VimStep | undefined {
	if (state.pending !== "") return undefined;
	if (key === "k" && lineIndex(text, offset) === 0) return step(state, undefined, { history: "up" });
	if (key === "j" && lineIndex(text, offset) === lineCount(text) - 1)
		return step(state, undefined, { history: "down" });
	return undefined;
}

// Visual mode moves with the same motions as normal mode, plus ; and , for the last find.
function visualMotion(state: VimState, target: string, count: number | undefined, buffer: Buffer): VimStep {
	if (target === ";" || target === ",") return repeatFind(state, target === ",", count ?? 1, buffer);
	return plainMotion(state, withoutWrap({ count, target }, buffer), buffer) ?? cancel(state);
}

/** One key press in vim mode. */
export function vimKey(state: VimState, input: VimInput, buffer: Buffer): VimStep {
	if (state.mode === "insert") return insertKey(state, input, buffer);
	if (state.visual !== undefined) return visualKey(state, state.visual, input, buffer, visualMotion);
	if (input.kind === "escape") return { state: { ...state, pending: "" }, passThrough: state.pending === "" };
	if (input.kind === "other") return { state, passThrough: true };
	const here = { ...buffer, offset: clampNormal(buffer.text, buffer.offset) };
	const history = historyStep(state, input.key, here.text, here.offset);
	if (history !== undefined) return history;
	if ((input.key === "v" || input.key === "V") && /^(?:[1-9]\d*)?$/.test(state.pending)) {
		return enterVisual(state, input.key === "V" ? "line" : "char", here);
	}
	const keys = state.pending + input.key;
	const cmd = parse(keys);
	if (cmd === "partial") return step({ ...state, pending: keys });
	if (cmd === undefined) return cancel(state);
	return execute({ ...state, pending: "" }, cmd, here, keys);
}
