/** How memory files are shown to the model: the startup reminder, the per-file reminder, and the prompt section. */

import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
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
 * A text block `renderNestedReminder` made. The session marks it when it injects the reminder,
 * so a block is a reminder because of where it came from, never because its text looks like one.
 * The mark lives on the block, not in tool result details, whose shape belongs to the tool and
 * its extensions. Providers read only `text`, and JSON persistence keeps the whole block.
 */
export type InjectedReminderBlock = TextContent & { ccMemoryReminder: true };

/** The text block that carries the nested reminder for `file`. */
export function injectedReminderBlock(file: MemoryFile): InjectedReminderBlock {
	return { type: "text", text: renderNestedReminder(file), ccMemoryReminder: true };
}

/** Whether a tool result content block is a reminder the session injected. */
export function isInjectedReminder(block: ToolResultMessage["content"][number]): block is InjectedReminderBlock {
	return block.type === "text" && (block as Partial<InjectedReminderBlock>).ccMemoryReminder === true;
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
