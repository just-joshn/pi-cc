/** Which hook groups a value selects. A plain list of names matches exactly; anything else is a regular expression. */

import type { HookGroup, HookHandler } from "./config.ts";
import { EVENT_TABLE, type HookEvent } from "./events.ts";

const TOOL_LIST = /^[a-zA-Z0-9_|, -]+$/;
const PLAIN_LIST = /^[a-zA-Z0-9_|]+$/;

export function matcherAccepts(matcher: string | undefined, value: string | undefined, toolEvent: boolean): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	if (value === undefined) return false;
	if ((toolEvent ? TOOL_LIST : PLAIN_LIST).test(matcher)) {
		return matcher
			.split(toolEvent ? /[|,]/ : "|")
			.map((name) => name.trim())
			.filter(Boolean)
			.includes(value);
	}
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return false;
	}
}

/** The handlers whose group matches `value`, each identical handler once, in configuration order. */
export function selectHandlers(
	groups: readonly HookGroup[],
	event: HookEvent,
	value: string | undefined,
): HookHandler[] {
	const toolEvent = EVENT_TABLE[event].toolMatcher;
	const hasMatcher = EVENT_TABLE[event].matches !== undefined;
	const seen = new Set<string>();
	const selected: HookHandler[] = [];
	for (const group of groups) {
		if (hasMatcher && !matcherAccepts(group.matcher, value, toolEvent)) continue;
		for (const handler of group.handlers) {
			const key = handlerKey(handler);
			if (seen.has(key)) continue;
			seen.add(key);
			selected.push(handler);
		}
	}
	return selected;
}

/** Two handlers with the same identity run once, however many tiers define them. */
export function handlerKey(handler: HookHandler): string {
	if (handler.type === "command") return `command:${handler.command}:${(handler.args ?? []).join("\0")}`;
	return `http:${handler.url}:${JSON.stringify(handler.headers)}:${handler.allowedEnvVars.join(",")}`;
}
