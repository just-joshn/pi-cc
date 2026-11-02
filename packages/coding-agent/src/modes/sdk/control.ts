/**
 * The control requests pi-cc answers, as a table keyed by subtype. Claude Code answers 98 subtypes; the
 * dossier measured `initialize` only, and `interrupt`, `set_permission_mode`, `end_session` and the
 * unsupported-subtype error were measured against the pinned binary by `conformance/cases/sdk`. Every
 * subtype not in the table gets the same typed error Claude Code writes for one it does not know.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { resolveModelReference } from "../../core/model-resolver.ts";
import { ccConfigDir } from "../../core/settings/cc/paths.ts";
import type { ControlRequestBody, ControlResponseFrame, Json, SdkFrame } from "./frames.ts";
import type { SessionFacts } from "./init.ts";

/** Claude Code's permission modes, in the order its error message lists them. */
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"] as const;

/** What a handler decided. `after` frames are written right after the response. */
export type ControlOutcome =
	| { ok: true; response?: Json; envelope?: Json; after?: SdkFrame[] }
	| { ok: false; error: string; code?: string; model?: string };

export interface ControlContext {
	session: AgentSession;
	facts: SessionFacts;
	env: NodeJS.ProcessEnv;
	home: string;
	/** The mode the host reports. Enforcement belongs to the permission system, not to this table. */
	permissionMode: { current: string };
	/** The model the session started with, which a `set_model` without a model returns to. */
	defaultModel: Model<Api> | undefined;
	/** An interrupt was requested, so the host can tell the tool results and aborted request that follow. */
	interrupted(): void;
	/** Ends the input loop after this response. */
	endSession(): void;
	uuid(): string;
}

type ControlHandler = (
	request: ControlRequestBody,
	context: ControlContext,
) => ControlOutcome | Promise<ControlOutcome>;

const HANDLERS: Readonly<Record<string, ControlHandler>> = {
	initialize: initialize,
	interrupt: interrupt,
	set_permission_mode: setPermissionMode,
	set_model: setModel,
	end_session: endSession,
	mcp_status: mcpStatus,
	get_context_usage: getContextUsage,
	set_max_thinking_tokens: setMaxThinkingTokens,
};

/** Answers one control request. The table lookup is the whole dispatch. */
export async function handleControlRequest(
	requestId: string | undefined,
	request: ControlRequestBody,
	context: ControlContext,
): Promise<SdkFrame[]> {
	const { subtype } = request;
	const handler = typeof subtype === "string" && Object.hasOwn(HANDLERS, subtype) ? HANDLERS[subtype] : undefined;
	const outcome: ControlOutcome =
		handler === undefined
			? { ok: false, error: `Unsupported control request subtype: ${String(subtype)}` }
			: await handler(request, context);
	return [controlResponse(requestId, outcome), ...(outcome.ok ? (outcome.after ?? []) : [])];
}

function controlResponse(requestId: string | undefined, outcome: ControlOutcome): ControlResponseFrame {
	const id = requestId === undefined ? {} : { request_id: requestId };
	if (!outcome.ok) {
		return {
			type: "control_response",
			response: {
				subtype: "error",
				...id,
				error: outcome.error,
				...(outcome.code ? { error_code: outcome.code } : {}),
				...(outcome.model === undefined ? {} : { model: outcome.model }),
			},
		};
	}
	return {
		type: "control_response",
		response: {
			subtype: "success",
			...id,
			...(outcome.response === undefined ? {} : { response: outcome.response }),
			...outcome.envelope,
		},
	};
}

function initialize(_request: ControlRequestBody, context: ControlContext): ControlOutcome {
	const { session, facts } = context;
	const levels = session.getAvailableThinkingLevels();
	return {
		ok: true,
		response: {
			commands: facts.slashCommands.map((command) => ({
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint,
				builtin: command.builtin,
			})),
			agents: [],
			output_style: "default",
			available_output_styles: ["default"],
			user_output_styles_dir: `${ccConfigDir(context.env, context.home)}/output-styles`,
			models: session.modelRuntime.getAvailableSnapshot().map((model) => ({
				value: model.id,
				resolvedModel: model.id,
				displayName: model.name,
				description: `${model.provider}/${model.id}`,
				supportsEffort: model.reasoning,
				supportedEffortLevels: model.reasoning ? levels : [],
				supportsAdaptiveThinking: false,
				supportsFastMode: false,
				supportsAutoMode: false,
				supportsThinkingOff: true,
			})),
			account: {
				tokenSource: facts.apiKeySource === "none" ? "none" : facts.apiKeySource,
				apiKeySource: facts.apiKeySource,
				apiProvider:
					session.model?.provider === "anthropic" ? "firstParty" : (session.model?.provider ?? "firstParty"),
			},
			pid: process.pid,
			claude_code_version: VERSION,
			current_permission_mode: context.permissionMode.current,
			feedback_mode: { kind: "disabled" },
			analytics_disabled: true,
			remote_control_auto_enable: false,
			remote_control_auto_connect_default: false,
			remote_control_available: false,
			remote_control_auto_on_by_default: false,
			ide_rc_auto_enable_gate: false,
			fast_mode_state: "off",
			fast_mode_disabled_reason: "sdk_opt_in_required",
			session_state: "idle",
			capabilities: [],
		},
		envelope: { pending_permission_requests: [], pending_user_dialog_requests: [] },
	};
}

function interrupt(_request: ControlRequestBody, context: ControlContext): ControlOutcome {
	context.interrupted();
	void context.session.abort();
	return { ok: true, response: { still_queued: [] } };
}

function setPermissionMode(request: ControlRequestBody, context: ControlContext): ControlOutcome {
	const mode = request.mode;
	if (typeof mode !== "string" || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
		return {
			ok: false,
			error: `Cannot set permission mode: must be one of ${PERMISSION_MODES.join(", ")}`,
			code: "invalid_mode",
		};
	}
	context.permissionMode.current = mode;
	return {
		ok: true,
		response: { mode },
		after: [
			{
				type: "system",
				subtype: "status",
				status: null,
				permissionMode: mode,
				uuid: context.uuid(),
				session_id: context.session.sessionId,
			},
		],
	};
}

async function setModel(request: ControlRequestBody, context: ControlContext): Promise<ControlOutcome> {
	const { session } = context;
	const current = session.model?.id;
	if (request.model === undefined || request.model === null || request.model === "") {
		const fallback = context.defaultModel;
		if (fallback === undefined) return { ok: false, error: "No default model is available", code: "invalid_model" };
		return switchModel(session, fallback, current);
	}
	if (typeof request.model !== "string") {
		return { ok: false, error: `Unknown model: ${String(request.model)}`, code: "invalid_model", model: current };
	}
	const resolved = resolveModelReference(
		{ text: request.model, thinkingSuffix: "none", fuzzy: true },
		session.modelRuntime.getAvailableSnapshot(),
		(provider) => session.modelRuntime.hasConfiguredAuth(provider),
	);
	if (resolved.status !== "resolved") {
		return { ok: false, error: `Unknown model: ${request.model}`, code: "invalid_model", model: current };
	}
	return switchModel(session, resolved.model, current);
}

async function switchModel(
	session: AgentSession,
	model: Model<Api>,
	current: string | undefined,
): Promise<ControlOutcome> {
	try {
		await session.setModel(model);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			code: "set_model_failed",
			model: current,
		};
	}
	return { ok: true, response: { model: model.id } };
}

function mcpStatus(): ControlOutcome {
	return { ok: true, response: { mcpServers: [] } };
}

/** The smallest thinking budget at which each level applies. */
const THINKING_LEVEL_FLOORS: readonly (readonly [number, ThinkingLevel])[] = [
	[0, "off"],
	[1, "minimal"],
	[2048, "low"],
	[8192, "medium"],
	[16384, "high"],
	[32768, "xhigh"],
];

/** Zero turns thinking off, a positive budget picks the largest level it reaches, and null leaves the level alone. */
function setMaxThinkingTokens(request: ControlRequestBody, context: ControlContext): ControlOutcome {
	const budget = request.max_thinking_tokens;
	if (typeof budget === "number" && budget >= 0) {
		const floor = THINKING_LEVEL_FLOORS.findLast(([smallest]) => budget >= smallest);
		if (floor !== undefined) context.session.setThinkingLevel(floor[1]);
	}
	return { ok: true };
}

/** What fills the model's context window now. Pi has one measure, so every token counts as a message. */
function getContextUsage(_request: ControlRequestBody, context: ControlContext): ControlOutcome {
	const { session, facts } = context;
	const usage = session.getContextUsage();
	const maxTokens = usage?.contextWindow ?? 0;
	const used = usage?.tokens ?? 0;
	const free = Math.max(0, maxTokens - used);
	return {
		ok: true,
		response: {
			categories: [
				{ id: "messages", name: "Messages", tokens: used, color: "promptBorder", kind: "used" },
				{ id: "free_space", name: "Free space", tokens: free, color: "promptBorder", kind: "free" },
			],
			totalTokens: used,
			maxTokens,
			rawMaxTokens: maxTokens,
			autocompactSource: session.compactionLimits?.source ?? "model-default",
			percentage: usage?.percent === null || usage === undefined ? 0 : Math.round(usage.percent),
			gridRows: [],
			model: facts.model,
			memoryFiles: [],
			mcpTools: [],
			mcpInstructions: [],
			agents: [],
			slashCommands: {
				totalCommands: facts.slashCommands.length,
				includedCommands: facts.slashCommands.length,
				tokens: 0,
			},
			skills: {
				totalSkills: facts.skills.length,
				includedSkills: facts.skills.length,
				tokens: 0,
				skillFrontmatter: [],
			},
			autoCompactThreshold: session.compactionLimits?.threshold ?? maxTokens,
			isAutoCompactEnabled: session.autoCompactionEnabled,
			messageBreakdown: {
				toolCallTokens: 0,
				toolResultTokens: 0,
				attachmentTokens: 0,
				assistantMessageTokens: 0,
				userMessageTokens: 0,
				redirectedContextTokens: 0,
				unattributedTokens: used,
				toolCallsByType: [],
				attachmentsByType: [],
			},
			apiUsage: null,
		},
	};
}

function endSession(_request: ControlRequestBody, context: ControlContext): ControlOutcome {
	context.endSession();
	return { ok: true };
}
