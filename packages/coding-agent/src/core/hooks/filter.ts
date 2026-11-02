/** A hook's `if` rule: a permission rule the tool call must match for the hook to run. */

import { homedir } from "node:os";
import { matchRule } from "../permissions/bash.ts";
import { pathRuleMatches } from "../permissions/paths.ts";
import { coversTool, parseRuleText } from "../permissions/rules.ts";
import { targetOf, toolTraits } from "../permissions/tool-checks.ts";

type Json = Readonly<Record<string, unknown>>;

/** Whether the tool call in a PreToolUse, PostToolUse or PermissionRequest payload matches the rule text. Other events never match a rule. */
export function callMatchesRule(filter: string, fields: Json, cwd: string, home: string = homedir()): boolean {
	const rule = parseRuleText(filter);
	const name = fields.tool_name;
	const input = fields.tool_input;
	if (rule === undefined || typeof name !== "string" || typeof input !== "object" || input === null) return false;
	if (!coversTool(rule.toolName, name)) return false;
	if (rule.content === undefined) return true;
	const call = { name, input: input as Json };
	const { kind } = toolTraits(name);
	if (kind === "shell") {
		const command = call.input.command;
		return (
			typeof command === "string" &&
			matchRule([{ source: "settings", behavior: "allow", ...rule }], command) !== undefined
		);
	}
	const target = targetOf(call, cwd);
	return target !== undefined && pathRuleMatches(rule.content, target, { cwd, home });
}
