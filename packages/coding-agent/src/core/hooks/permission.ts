/** PermissionRequest hooks as the permission gate's seam. */

import type { PermissionHooks } from "../permissions/gate.ts";
import { isPermissionMode } from "../permissions/mode.ts";
import {
	type PermissionAnswer,
	type PermissionUpdate,
	REJECTED_TOOL_TEXT,
	type Suggestion,
} from "../permissions/prompt.ts";
import { formatRule, parseRuleText } from "../permissions/rules.ts";
import type { PermissionCall } from "../permissions/tool-checks.ts";
import type { HookDispatcher } from "./dispatch.ts";
import { absolutePaths } from "./input.ts";
import type { RequestDecision } from "./outcome.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The shape a hook sees in `permission_suggestions` for one of the prompt's "don't ask again" choices. */
function suggestionForHook(suggestion: Suggestion): Json {
	const { update } = suggestion;
	if (update.type === "setMode") return { type: "setMode", mode: update.mode, destination: "session" };
	return {
		type: "addRules",
		rules: update.rules.map((rule) => {
			const parsed = parseRuleText(rule);
			return {
				toolName: parsed?.toolName ?? rule,
				...(parsed?.content === undefined ? {} : { ruleContent: parsed.content }),
			};
		}),
		behavior: update.behavior,
		destination: update.destination,
	};
}

/** An `updatedPermissions` entry a hook returned, when the gate can apply it. */
function updateFromHook(entry: unknown): PermissionUpdate | undefined {
	if (!isObject(entry)) return undefined;
	if (entry.type === "setMode" && isPermissionMode(entry.mode)) return { type: "setMode", mode: entry.mode };
	if (entry.type !== "addRules" || !Array.isArray(entry.rules)) return undefined;
	const behavior = entry.behavior;
	if (behavior !== "allow" && behavior !== "ask" && behavior !== "deny") return undefined;
	const rules = entry.rules.flatMap((rule): string[] => {
		if (typeof rule === "string") return [rule];
		if (!isObject(rule) || typeof rule.toolName !== "string") return [];
		return [
			formatRule({
				toolName: rule.toolName,
				...(typeof rule.ruleContent === "string" ? { content: rule.ruleContent } : {}),
			}),
		];
	});
	const destination = entry.destination === "localSettings" ? "localSettings" : "session";
	return rules.length === 0 ? undefined : { type: "addRules", rules, behavior, destination };
}

export function answerFromDecision(
	decision: RequestDecision,
): PermissionAnswer & { readonly updatedInput?: Readonly<Record<string, unknown>> } {
	if (decision.behavior === "deny") {
		return {
			behavior: "deny",
			message: decision.interrupt
				? REJECTED_TOOL_TEXT
				: (decision.message ?? "Permission denied by a PermissionRequest hook."),
			...(decision.interrupt ? { interrupt: true } : {}),
		};
	}
	const updates = (decision.updatedPermissions ?? []).flatMap((entry) => updateFromHook(entry) ?? []);
	return {
		behavior: "allow",
		...(updates.length > 0 ? { updates } : {}),
		...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
	};
}

export function permissionHooksFor(
	hooks: HookDispatcher,
	signal: () => AbortSignal | undefined,
	cwd: () => string = () => process.cwd(),
): PermissionHooks {
	return {
		async request(call: PermissionCall, _toolCallId, suggestions, heldByRule) {
			if (!hooks.active("PermissionRequest")) return undefined;
			const verdict = await hooks.run(
				"PermissionRequest",
				{
					tool_name: call.name,
					tool_input: absolutePaths(call.input, cwd()),
					...(heldByRule ? {} : { permission_suggestions: suggestions.map(suggestionForHook) }),
				},
				{ signal: signal() },
			);
			return verdict.requestDecision ? answerFromDecision(verdict.requestDecision) : undefined;
		},
	};
}
