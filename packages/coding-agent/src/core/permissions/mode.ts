/**
 * Claude Code's permission modes and the strictness ladder between them.
 *
 * The ladder orders modes by how little they ask: `plan` asks the most, `bypassPermissions` the
 * least. Anything that can only tighten a mode, such as a settings floor or a per-call downgrade,
 * takes the lower rung.
 */

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The rung of each mode. `default` and `dontAsk` share one: they differ in what an ask turns into. */
const STRICTNESS: Readonly<Record<PermissionMode, number>> = {
	plan: 0,
	default: 1,
	dontAsk: 1,
	acceptEdits: 2,
	auto: 3,
	bypassPermissions: 4,
};

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** A mode spelling the CLI accepts. `manual` is Claude Code's other name for `default`. */
export function parsePermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "manual") return "default";
	return isPermissionMode(value) ? value : undefined;
}

/** The stricter of two modes. On a tie the first wins, so a caller's own mode survives. */
export function stricterMode(first: PermissionMode, second: PermissionMode): PermissionMode {
	return STRICTNESS[second] < STRICTNESS[first] ? second : first;
}
