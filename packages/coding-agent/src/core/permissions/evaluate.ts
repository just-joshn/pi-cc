/**
 * The permission pipeline: a fixed list of named stages, run in order until one answers.
 *
 *   denyRule        a whole-tool deny rule refuses the call
 *   askRule         a whole-tool ask rule asks (the tool's own check may still deny, or say why)
 *   toolCheck       the tool's own check; a deny ends here, an allow or ask is held for the stages below
 *   modeHold        an ask a rule, plan mode or a safety check stands behind is final (a safety check yields to bypass
 *                   unless its breaker is bypass-immune, see breakers.ts)
 *   bypassMode      `bypassPermissions` allows what is left
 *   allowRule       a whole-tool allow rule allows what is left
 *   toolResult      the tool's own allow, ask or no opinion (which asks)
 *
 * Deny beats ask beats allow because each stage only ever runs when the ones before it did not
 * answer. A later stage never turns an earlier ask into an allow, except that `bypassMode` and
 * `allowRule` allow an ask nothing holds in place.
 */

import { holdsUnderBypass } from "./breakers.ts";
import type { PermissionContext } from "./context.ts";
import { type CheckResult, type Decision, defaultAskMessage, dontAskMessage } from "./decision.ts";
import { stricterMode } from "./mode.ts";
import { checkTool, type PermissionCall, toolTraits } from "./tool-checks.ts";

export const STAGE_NAMES = [
	"denyRule",
	"askRule",
	"toolCheck",
	"modeHold",
	"bypassMode",
	"allowRule",
	"toolResult",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface Evaluation {
	readonly decision: Decision;
	readonly stage: StageName;
}

interface Pipeline {
	readonly call: PermissionCall;
	readonly ctx: PermissionContext;
	check?: CheckResult;
}

type Stage = (pipeline: Pipeline) => Decision | undefined;

const STAGES: Readonly<Record<StageName, Stage>> = {
	denyRule({ call, ctx }) {
		const rule = ctx.rules.wholeTool("deny", call.name);
		if (!rule) return undefined;
		return {
			behavior: "deny",
			message: `Permission to use ${call.name} has been denied.`,
			reason: { type: "rule", rule },
		};
	},

	askRule(pipeline) {
		const rule = pipeline.ctx.rules.wholeTool("ask", pipeline.call.name);
		if (!rule) return undefined;
		const check = checkTool(pipeline.call, pipeline.ctx);
		if (check.behavior === "deny") return check;
		const message = check.behavior === "ask" ? check.message : defaultAskMessage(pipeline.call.name);
		return { behavior: "ask", message, reason: { type: "rule", rule } };
	},

	toolCheck(pipeline) {
		const check = checkTool(pipeline.call, pipeline.ctx);
		pipeline.check = check;
		return check.behavior === "deny" ? check : undefined;
	},

	modeHold({ call, ctx, check }) {
		if (check?.behavior !== "ask") return undefined;
		const reason = check.reason;
		const bypassing = effectiveMode(call, ctx) === "bypassPermissions";
		const held =
			reason?.type === "rule" ||
			(reason?.type === "mode" && reason.mode === "plan") ||
			(reason?.type === "safetyCheck" && (!bypassing || holdsUnderBypass(reason.breaker, ctx.removalWaived)));
		return held ? check : undefined;
	},

	bypassMode({ call, ctx }) {
		if (effectiveMode(call, ctx) !== "bypassPermissions") return undefined;
		return { behavior: "allow", reason: { type: "mode", mode: "bypassPermissions" } };
	},

	allowRule({ call, ctx }) {
		const rule = ctx.rules.wholeTool("allow", call.name);
		return rule ? { behavior: "allow", reason: { type: "rule", rule } } : undefined;
	},

	toolResult({ call, check }) {
		if (check === undefined || check.behavior === "passthrough") {
			return { behavior: "ask", message: check?.message ?? defaultAskMessage(call.name) };
		}
		return check;
	},
};

/** The mode a tool is judged under: a tool that opts out of bypass is judged as in `default`. */
function effectiveMode(call: PermissionCall, ctx: PermissionContext): PermissionContext["mode"] {
	return ctx.mode === "bypassPermissions" && toolTraits(call.name).excludedFromModeBypass
		? stricterMode(ctx.mode, "default")
		: ctx.mode;
}

export function evaluatePermission(call: PermissionCall, ctx: PermissionContext): Evaluation {
	const pipeline: Pipeline = { call, ctx };
	for (const name of STAGE_NAMES) {
		const decision = STAGES[name](pipeline);
		if (decision) return { decision, stage: name };
	}
	throw new Error("The permission pipeline ended without a decision: its last stage always answers.");
}

export function applyDontAsk(decision: Decision, call: PermissionCall, ctx: PermissionContext): Decision {
	if (decision.behavior !== "ask" || ctx.mode !== "dontAsk") return decision;
	return { behavior: "deny", message: dontAskMessage(call.name), reason: { type: "mode", mode: "dontAsk" } };
}
