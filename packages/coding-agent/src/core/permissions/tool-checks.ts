/**
 * Each tool's own permission check, the stage Claude Code calls `checkPermissions`.
 *
 * A check sees the call as the model made it (Claude Code's tool name and input fields) and the
 * context, and answers allow, deny, ask or no opinion. Rules that carry content (a command prefix,
 * a path pattern) are interpreted here, because only the tool knows what its content means.
 */

import { resolve } from "node:path";
import { type BashCheck, checkBash } from "./bash.ts";
import { READ_BLOCK_MESSAGE, UNFINISHED_CHECK_MESSAGE } from "./breakers.ts";
import type { PermissionContext } from "./context.ts";
import { type CheckResult, defaultAskMessage, FILE_DENIED_BY_RULE, fileCoveredByReadDeny } from "./decision.ts";
import { canonicalPath, editSafetyMessage, insideDirectories, isLeafSymlink, pathRuleMatches } from "./paths.ts";
import type { PermissionRule } from "./rules.ts";

export interface PermissionCall {
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolTraits {
	readonly kind: "shell" | "read" | "edit" | "other";
	/** The tool never takes the `bypassPermissions` allow: it asks as in `default`. */
	readonly excludedFromModeBypass?: boolean;
}

const TOOL_KINDS: Readonly<Record<string, ToolTraits["kind"]>> = {
	Bash: "shell",
	PowerShell: "shell",
	Read: "read",
	Grep: "read",
	Glob: "read",
	grep: "read",
	find: "read",
	ls: "read",
	Edit: "edit",
	Write: "edit",
	NotebookEdit: "edit",
};

export function toolTraits(name: string): ToolTraits {
	return { kind: TOOL_KINDS[name] ?? "other" };
}

export function checkTool(call: PermissionCall, ctx: PermissionContext): CheckResult {
	switch (toolTraits(call.name).kind) {
		case "shell":
			return checkShell(call, ctx);
		case "read":
			return checkReadPath(call, ctx);
		case "edit":
			return checkEditPath(call, ctx);
		case "other":
			return { behavior: "passthrough", message: defaultAskMessage(call.name) };
	}
}

function checkShell(call: PermissionCall, ctx: PermissionContext): CheckResult {
	const command = call.input.command;
	if (typeof command !== "string") return { behavior: "passthrough", message: defaultAskMessage(call.name) };
	const rules = (behavior: "allow" | "ask" | "deny") => ctx.rules.withContent(behavior, call.name);
	let result: BashCheck;
	try {
		result = checkBash({
			command,
			deny: rules("deny"),
			ask: rules("ask"),
			allow: rules("allow"),
			acceptEdits: ctx.mode === "acceptEdits",
			directories: ctx.directories,
			cwd: ctx.cwd,
			home: ctx.home,
			blockReads: ctx.blockReadsOutsideWorkingDirectories,
		});
	} catch {
		return {
			behavior: "ask",
			message: UNFINISHED_CHECK_MESSAGE,
			reason: { type: "safetyCheck", reason: UNFINISHED_CHECK_MESSAGE, breaker: "unfinishedCheck" },
		};
	}
	const verdict = shellVerdict(call, result);
	if (ctx.mode !== "plan" || !ctx.autoModeDuringPlan || verdict.behavior === "deny") return verdict;
	if (verdict.behavior === "allow" && result.behavior === "allow" && result.readOnly) return verdict;
	if (verdict.behavior === "ask" && verdict.reason?.type === "rule") return verdict;
	return {
		behavior: "ask",
		message: `Cannot call ${call.name} while in plan mode.`,
		reason: { type: "mode", mode: "plan" },
	};
}

function shellVerdict(call: PermissionCall, result: BashCheck): CheckResult {
	switch (result.behavior) {
		case "deny":
			return {
				behavior: "deny",
				message: result.message,
				reason: result.rule ? { type: "rule", rule: result.rule } : { type: "safetyCheck", reason: result.message },
			};
		case "ask": {
			const message = result.message ?? defaultAskMessage(call.name);
			if (result.rule) return { behavior: "ask", message, reason: { type: "rule", rule: result.rule } };
			const reason = result.safety
				? { type: "safetyCheck" as const, reason: message, ...(result.breaker ? { breaker: result.breaker } : {}) }
				: { type: "other" as const, reason: message };
			return { behavior: "ask", message, reason };
		}
		case "allow":
			return { behavior: "allow", ...(result.rule ? { reason: { type: "rule", rule: result.rule } } : {}) };
	}
}

/** The path a file tool call targets, as an absolute path in the spelling the model wrote. */
export function targetOf(call: PermissionCall, cwd: string): string | undefined {
	const path = call.input.file_path ?? call.input.path;
	if (path === undefined && toolTraits(call.name).kind === "read" && call.name !== "Read") return cwd;
	return typeof path === "string" ? resolve(cwd, path) : undefined;
}

function pathRule(rules: readonly PermissionRule[], path: string, ctx: PermissionContext): PermissionRule | undefined {
	return rules.find((rule) => rule.content !== undefined && pathRuleMatches(rule.content, path, ctx));
}

/** Rules of the Read family apply to every reading tool, and rules of the Edit family to every writing tool. */
function familyRules(
	ctx: PermissionContext,
	behavior: "allow" | "ask" | "deny",
	family: "Read" | "Edit",
): PermissionRule[] {
	return ctx.rules.withContent(behavior, family);
}

function checkReadPath(call: PermissionCall, ctx: PermissionContext): CheckResult {
	const path = targetOf(call, ctx.cwd);
	if (path === undefined) return { behavior: "passthrough", message: defaultAskMessage(call.name) };
	const denied = pathRule(familyRules(ctx, "deny", "Read"), path, ctx);
	if (denied) {
		const message = call.name === "Read" ? FILE_DENIED_BY_RULE : `Permission to read ${path} has been denied.`;
		return { behavior: "deny", message, reason: { type: "rule", rule: denied } };
	}
	const grantMessage = `Claude requested permissions to read from ${path}, but you haven't granted it yet.`;
	const asked = pathRule(familyRules(ctx, "ask", "Read"), path, ctx);
	if (asked) return { behavior: "ask", message: grantMessage, reason: { type: "rule", rule: asked } };
	const inside = insideDirectories(ctx.directories, canonicalPath(path, ctx.cwd));
	if (ctx.blockReadsOutsideWorkingDirectories && !inside) {
		return {
			behavior: "deny",
			message: `${path} is outside ${ctx.directories.join(", ")}; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`,
			reason: { type: "other", reason: READ_BLOCK_MESSAGE },
		};
	}
	if (inside) return { behavior: "allow", reason: { type: "mode", mode: "default" } };
	const allowed = pathRule(familyRules(ctx, "allow", "Read"), path, ctx);
	if (allowed) return { behavior: "allow", reason: { type: "rule", rule: allowed } };
	return {
		behavior: "ask",
		message: grantMessage,
		reason: { type: "other", reason: "outside the working directories" },
	};
}

/** A write through a symbolic link is refused, whatever the rules and mode say about the link's own path. */
function checkEditPath(call: PermissionCall, ctx: PermissionContext): CheckResult {
	const verdict = checkEditPathRules(call, ctx);
	const path = targetOf(call, ctx.cwd);
	if (verdict.behavior === "deny" || path === undefined || !isLeafSymlink(path, ctx.cwd)) return verdict;
	return {
		behavior: "deny",
		message: `Refusing to write ${path}: it is a symbolic link. Write to the link's target path instead: ${canonicalPath(path, ctx.cwd)}.`,
		reason: { type: "other", reason: "Write target is a symbolic link" },
	};
}

function checkEditPathRules(call: PermissionCall, ctx: PermissionContext): CheckResult {
	const path = targetOf(call, ctx.cwd);
	if (path === undefined) return { behavior: "passthrough", message: defaultAskMessage(call.name) };
	const denied = pathRule(familyRules(ctx, "deny", "Edit"), path, ctx);
	if (denied) return { behavior: "deny", message: FILE_DENIED_BY_RULE, reason: { type: "rule", rule: denied } };
	const readDenied = ctx.rules.wholeTool("deny", "Read") ?? pathRule(familyRules(ctx, "deny", "Read"), path, ctx);
	if (readDenied && (call.name === "Edit" || call.name === "Write")) {
		return {
			behavior: "deny",
			message: fileCoveredByReadDeny(call.name),
			reason: { type: "rule", rule: readDenied },
		};
	}
	const grantMessage = `Claude requested permissions to write to ${path}, but you haven't granted it yet.`;
	const asked = pathRule(familyRules(ctx, "ask", "Edit"), path, ctx);
	if (asked) return { behavior: "ask", message: grantMessage, reason: { type: "rule", rule: asked } };
	const unsafe = editSafetyMessage(path);
	if (unsafe) return { behavior: "ask", message: unsafe, reason: { type: "safetyCheck", reason: unsafe } };
	if (ctx.mode === "plan") {
		return {
			behavior: "ask",
			message: `Cannot write to ${path} while in plan mode.`,
			reason: { type: "mode", mode: "plan" },
		};
	}
	const inside = insideDirectories(ctx.directories, canonicalPath(path, ctx.cwd));
	if (ctx.mode === "acceptEdits" && inside)
		return { behavior: "allow", reason: { type: "mode", mode: "acceptEdits" } };
	const allowed = pathRule(familyRules(ctx, "allow", "Edit"), path, ctx);
	if (allowed) return { behavior: "allow", reason: { type: "rule", rule: allowed } };
	return {
		behavior: "ask",
		message: grantMessage,
		reason: { type: "other", reason: inside ? "inside the working directories" : "outside the working directories" },
	};
}
