/**
 * The control requests pi-cc answers, as a table keyed by subtype. Claude Code answers 98 subtypes; the
 * dossier measured `initialize` only, and `interrupt`, `set_permission_mode`, `end_session` and the
 * unsupported-subtype error were measured against the pinned binary by `conformance/cases/sdk`. Every
 * subtype not in the table gets the same typed error Claude Code writes for one it does not know.
 */

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
	| { ok: false; error: string; code?: string };

export interface ControlContext {
	session: AgentSession;
	facts: SessionFacts;
	env: NodeJS.ProcessEnv;
	home: string;
	/** The mode the host reports. Enforcement belongs to the permission system, not to this table. */
	permissionMode: { current: string };
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
};

/** Answers one control request. The table lookup is the whole dispatch. */
export async function handleControlRequest(
	requestId: string | undefined,
	request: ControlRequestBody,
	context: ControlContext,
): Promise<SdkFrame[]> {
	const handler = Object.hasOwn(HANDLERS, request.subtype) ? HANDLERS[request.subtype] : undefined;
	const outcome: ControlOutcome =
		handler === undefined
			? { ok: false, error: `Unsupported control request subtype: ${request.subtype}` }
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
	if (typeof request.model !== "string" || request.model === "") {
		return { ok: false, error: "set_model needs a model", code: "invalid_model" };
	}
	const resolved = resolveModelReference(
		{ text: request.model, thinkingSuffix: "none", fuzzy: true },
		session.modelRuntime.getAvailableSnapshot(),
		(provider) => session.modelRuntime.hasConfiguredAuth(provider),
	);
	if (resolved.status !== "resolved") {
		return { ok: false, error: `Unknown model: ${request.model}`, code: "invalid_model" };
	}
	try {
		await session.setModel(resolved.model);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), code: "set_model_failed" };
	}
	return { ok: true, response: { model: resolved.model.id } };
}

function endSession(_request: ControlRequestBody, context: ControlContext): ControlOutcome {
	context.endSession();
	return { ok: true };
}
