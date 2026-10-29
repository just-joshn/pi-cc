/**
 * The closed alias table between legacy pi tool names and the names Claude Code declares.
 *
 * Nothing here touches a tool implementation. The table is consulted where a name becomes part of
 * the active set and where a model-emitted call name is resolved, so one spelling reaches one tool.
 */

export type CcToolName = "Bash" | "Edit" | "Read" | "Write" | "DeferredToolPlaceholder";

/** The declared order Claude Code 2.1.312 uses once every unowned tool is disallowed (measured). */
export const CC_DECLARED_ORDER: readonly CcToolName[] = ["Bash", "Edit", "Read", "DeferredToolPlaceholder", "Write"];

/**
 * Canonical spelling per lowercased legacy name. `task` is the init-frame name of the tool the
 * request declares as `Agent`; `powershell` has no Claude Code twin and keeps pi's spelling.
 */
const CANONICAL_NAMES: Readonly<Record<string, string>> = {
	bash: "Bash",
	edit: "Edit",
	powershell: "powershell",
	read: "Read",
	task: "Agent",
	write: "Write",
};

/** The pi definition a Claude Code tool replaces. */
const PI_TWINS: Readonly<Record<string, string>> = {
	Bash: "bash",
	Edit: "edit",
	Read: "read",
	Write: "write",
};

/** Canonical name for a legacy or canonical spelling; an unknown name comes back unchanged. */
export function canonicalToolName(name: string): string {
	return CANONICAL_NAMES[name.toLowerCase()] ?? name;
}

/** The pi definition a Claude Code tool replaces, for example `Read` maps to `read`. */
export function piTwinName(ccName: string): string | undefined {
	return PI_TWINS[canonicalToolName(ccName)];
}
