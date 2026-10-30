// gj and gk: cursor motion over display rows, the lines of the prompt as it wraps on screen.
// Follows Claude Code's `le` and Cursor.down/up (chunk-hz2c9q6k.js:509-513, chunk-ybhw3dyg.js:698-727).
import { visibleWidth } from "../utils.ts";
import { targetColumn, type Wanted } from "./motions.ts";
import { offsetAtColumn, prevUnit, snapStart, unitSegments } from "./text.ts";
import { lineRows } from "./wrap.ts";

interface Row {
	readonly start: number;
	readonly end: number;
	/** The row opens its logical line. */
	readonly first: boolean;
	/** The line continues on the next row, so `end` is a wrap point and not a line end. */
	readonly soft: boolean;
}

export interface DisplayMove {
	/** Where plain gj or gk puts the cursor. */
	readonly offset: number;
	/** Where the same steps land without the remembered column: the target of an operator. */
	readonly stepped: number;
	/** The display column to remember, or undefined to forget it. */
	readonly column: number | undefined;
	/** The count asks for more rows than exist. */
	readonly runOut: boolean;
}

function displayRows(text: string, columns: number): Row[] {
	const rows: Row[] = [];
	let start = 0;
	for (const line of text.split("\n")) {
		const lineRowsHere = lineRows(line, columns, unitSegments);
		lineRowsHere.forEach((row, index) => {
			rows.push({
				start: start + row.start,
				end: start + row.end,
				first: index === 0,
				soft: index < lineRowsHere.length - 1,
			});
		});
		start += line.length + 1;
	}
	return rows;
}

function rowIndex(rows: readonly Row[], offset: number): number {
	const found = rows.findIndex((row) => row.start <= offset && (offset < row.end || (!row.soft && offset <= row.end)));
	return found === -1 ? rows.length - 1 : found;
}

/** The offset on `row` at display column `column`; a soft-wrapped row never ends on the next row's first cell. */
function offsetOnRow(text: string, row: Row, column: number): number {
	const at = snapStart(text, offsetAtColumn(text, row.start, row.end, column));
	return at === row.end && row.soft ? prevUnit(text, row.end) : at;
}

/** Moves `count` display rows up or down; undefined `columns` never reaches here. */
export function displayMove(
	text: string,
	offset: number,
	down: boolean,
	count: number,
	columns: number,
	wanted: Wanted | undefined,
): DisplayMove {
	const rows = displayRows(text, columns);
	const from = rowIndex(rows, offset);
	const runOut = (down ? rows.length - 1 - from : from) < count;
	let index = from;
	let stepped = offset;
	for (let step = 0; step < count; step += 1) {
		const next = rows[index + (down ? 1 : -1)];
		const current = rows[index];
		if (next === undefined || current === undefined) break;
		const column = Math.min(
			visibleWidth(text.slice(current.start, stepped)),
			visibleWidth(text.slice(next.start, next.end)),
		);
		stepped = offsetOnRow(text, next, column);
		index += down ? 1 : -1;
	}
	const source = rows[from];
	const target = rows[index];
	if (stepped === offset || source === undefined || target === undefined || !source.first || !target.first) {
		return { offset: stepped, stepped, column: undefined, runOut };
	}
	const column = targetColumn(text, offset, wanted);
	return { offset: offsetOnRow(text, target, column), stepped, column, runOut };
}
