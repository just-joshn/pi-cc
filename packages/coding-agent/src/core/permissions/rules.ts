/**
 * Permission rules: the string form (`Bash(npm run test:*)`), where a rule came from, and the
 * ordered set a lookup walks.
 *
 * A rule names a tool by the name the model sees (`Bash`, `Edit`, `mcp__server__tool`) and may carry
 * content the tool's own check interprets: a command prefix, a path glob, a domain. A rule without
 * content covers the whole tool.
 */

export type RuleBehavior = "allow" | "ask" | "deny";

/**
 * Where a rule came from, in the order lookups walk them. Settings tiers arrive already merged
 * into one `settings` source, because the merge drops which file a rule came from.
 */
export const RULE_SOURCES = ["settings", "cliArg", "command", "session"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export interface PermissionRule {
	readonly source: RuleSource;
	readonly behavior: RuleBehavior;
	readonly toolName: string;
	readonly content?: string;
}

/** Parses `Tool` or `Tool(content)`. `Tool()` and `Tool(*)` are whole-tool rules. Parentheses in content are escaped with a backslash. */
export function parseRuleText(text: string): { toolName: string; content?: string } | undefined {
	const trimmed = text.trim();
	const open = firstUnescaped(trimmed, "(");
	if (open === -1) return trimmed === "" ? undefined : { toolName: trimmed };
	if (!trimmed.endsWith(")") || open === 0) return undefined;
	const raw = trimmed.slice(open + 1, -1);
	const content = raw.replace(/\\([()\\])/g, "$1");
	const toolName = trimmed.slice(0, open);
	return content === "" || content === "*" ? { toolName } : { toolName, content };
}

function firstUnescaped(text: string, char: string): number {
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === char) return index;
	}
	return -1;
}

export function formatRule(rule: Pick<PermissionRule, "toolName" | "content">): string {
	if (rule.content === undefined) return rule.toolName;
	return `${rule.toolName}(${rule.content.replace(/([()\\])/g, "\\$1")})`;
}

export function rulesFromTexts(texts: readonly string[], behavior: RuleBehavior, source: RuleSource): PermissionRule[] {
	const rules: PermissionRule[] = [];
	for (const text of texts) {
		const parsed = parseRuleText(text);
		if (parsed) rules.push({ source, behavior, ...parsed });
	}
	return rules;
}

export class RuleSet {
	private readonly rules: readonly PermissionRule[];

	constructor(rules: readonly PermissionRule[]) {
		this.rules = [...rules].sort((a, b) => RULE_SOURCES.indexOf(a.source) - RULE_SOURCES.indexOf(b.source));
	}

	of(behavior: RuleBehavior): readonly PermissionRule[] {
		return this.rules.filter((rule) => rule.behavior === behavior);
	}

	wholeTool(behavior: RuleBehavior, toolName: string): PermissionRule | undefined {
		return this.of(behavior).find((rule) => rule.content === undefined && coversTool(rule.toolName, toolName));
	}

	withContent(behavior: RuleBehavior, toolName: string): PermissionRule[] {
		return this.of(behavior).filter((rule) => rule.content !== undefined && rule.toolName === toolName);
	}

	with(extra: readonly PermissionRule[]): RuleSet {
		return new RuleSet([...this.rules, ...extra]);
	}
}

const MCP_PREFIX = "mcp__";

/**
 * Whether a rule's tool name covers a tool. `mcp__server` covers every tool of that server and
 * `mcp__server__*` the same; any other name must match exactly.
 */
export function coversTool(ruleTool: string, toolName: string): boolean {
	if (ruleTool === toolName) return true;
	if (!ruleTool.startsWith(MCP_PREFIX) || !toolName.startsWith(MCP_PREFIX)) return false;
	const server = ruleTool.endsWith("__*") ? ruleTool.slice(0, -3) : ruleTool;
	return server.split("__").length === 2 && toolName.startsWith(`${server}__`);
}
