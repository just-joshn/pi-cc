/** The /usage command family Claude Code answers locally, without a model call. */

/** One parsed local usage command: the alias typed and its arguments. */
export interface LocalUsageCommand {
	/** The alias the user typed, normalized the way Claude Code reports command names. */
	command: string;
	args: string;
}

/** Parses a prompt that is exactly `/usage`, `/cost` or `/stats`; undefined for anything else. */
export function parseLocalUsageCommand(text: string): LocalUsageCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [name, ...rest] = trimmed.split(/\s+/);
	const alias = name.slice(1);
	if (alias !== "usage" && alias !== "cost" && alias !== "stats") return undefined;
	return { command: normalizeCommandName(alias), args: rest.join(" ") };
}

/** Claude Code's command-name normalization: lowercase, underscores for separators, sliced to 64. */
export function normalizeCommandName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.slice(0, 64);
}
