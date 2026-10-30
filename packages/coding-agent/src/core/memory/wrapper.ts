/** How memory files are shown to the model: the startup reminder, the per-file reminder, and the prompt section. */

import type { MemoryFile, MemoryType } from "./discover.ts";

/** The label each memory type carries in the startup reminder. */
export const LABELS: Readonly<Record<MemoryType, string>> = {
	managed: "managed memory, set by the organization",
	user: "user memory, applies to every project",
	project: "project memory, shared through the repository",
	local: "local project memory, private to this user",
	auto: "auto memory, kept across sessions",
};

/** The startup reminder holding every memory file, or "" when there are none. */
export function renderMemoryReminder(files: readonly MemoryFile[]): string {
	if (files.length === 0) {
		return "";
	}
	const sections = files.map((file) => `Contents of ${file.path} (${LABELS[file.type]}):\n\n${file.content.trim()}`);
	return `<system-reminder>\n${PREAMBLE}\n\n${sections.join("\n\n")}\n</system-reminder>`;
}

/** The reminder for one memory file found when a file below the working directory is accessed. */
export function renderNestedReminder(file: MemoryFile): string {
	return `${NESTED_PREFIX}${file.path}:\n\n${file.content}\n</system-reminder>`;
}

/** The path a reminder made by `renderNestedReminder` names, or undefined for any other text. */
export function nestedReminderPath(text: string): string | undefined {
	if (!text.startsWith(NESTED_PREFIX)) {
		return undefined;
	}
	const end = text.indexOf(":\n\n", NESTED_PREFIX.length);
	return end === -1 ? undefined : text.slice(NESTED_PREFIX.length, end);
}

/**
 * Tool result details that name which content blocks `renderNestedReminder` made. The session
 * records it when it injects a reminder, so a block is a reminder because of where it came from,
 * never because its text looks like one.
 */
export function withInjectedReminders(details: unknown, indexes: readonly number[]): unknown {
	if (indexes.length === 0) return details;
	if (details === undefined || details === null) return { ccMemoryReminders: indexes };
	if (typeof details !== "object" || Array.isArray(details)) return details;
	return { ...details, ccMemoryReminders: indexes };
}

/** The content block indexes of a tool result's injected reminders, as {@link withInjectedReminders} recorded them. */
export function injectedReminderIndexes(details: unknown): ReadonlySet<number> {
	const indexes = (details as { ccMemoryReminders?: unknown } | null | undefined)?.ccMemoryReminders;
	return new Set(Array.isArray(indexes) ? indexes.filter((index) => Number.isInteger(index)) : []);
}

/** Whether a reminder made by `renderNestedReminder` is for an AGENTS.md file. */
export function isAgentsReminder(text: string): boolean {
	const path = nestedReminderPath(text);
	return path !== undefined && path.replace(/^.*[\\/]/, "") === "AGENTS.md";
}

/** The system prompt section that tells the model where auto memory lives. `dir` ends with a separator. */
export function autoMemoryPromptSection(dir: string): string {
	return [
		`Auto memory directory: ${dir}`,
		"The directory exists. To remember something for future sessions, write one fact per `.md` file there.",
		"`MEMORY.md` in that directory is the index: one line per entry, pointing at its file. It is loaded into context at the start of every session, so keep it short and current.",
	].join("\n");
}

const PREAMBLE =
	"The memory files below carry instructions from the organization, the user, and the project. Follow them; they take precedence over your default behavior.";
const NESTED_PREFIX = "<system-reminder>\nContents of ";
