/**
 * One session's hooks: the dispatcher plus the state that spans events, such as what a PreToolUse
 * hook said before an Edit asks for permission, how many times Stop has blocked, and where the
 * stream of hook reports goes. The agent session calls these methods at its seams and nothing else.
 */

import { resolve } from "node:path";
import type { CustomMessage } from "../messages.ts";
import type { HookPreference } from "../permissions/gate.ts";
import { ccToolUseResult } from "../tools/cc-result.ts";
import type { HookConfig } from "./config.ts";
import { HookDispatcher } from "./dispatch.ts";
import { absolutePaths, type HookSessionInfo } from "./input.ts";
import {
	additionalContext,
	allowedTerminalSequence,
	blockingError,
	hookSuccess,
	promptBlocked,
	reminder,
	stopCapNotice,
	stopFeedback,
	stopHookCap,
} from "./messages.ts";
import type { HookStreamItem } from "./stream.ts";
import { postToolUse, preToolUse, replacementText } from "./tools.ts";

type Json = Record<string, unknown>;

/** What the agent session offers its hooks. */
export interface SessionHooksHost {
	info(): HookSessionInfo;
	cwd(): string;
	signal(): AbortSignal | undefined;
	/** Queue a message for the model before its next request of this run. */
	steer(message: CustomMessage): void;
	lastAssistantText(): string;
	/** Write a terminal sequence a hook asked for. Absent where there is no terminal. */
	writeTerminal?: (sequence: string) => void;
}

export interface SessionHooksOptions {
	readonly config: HookConfig;
	readonly projectDir: string;
	readonly env: () => Readonly<Record<string, string>>;
	readonly callMatches: (filter: string, fields: Readonly<Record<string, unknown>>) => boolean;
}

/** The text of a hook message block, as a hidden custom message the model reads as a user turn. */
export function hookMessage(blocks: readonly string[]): CustomMessage {
	return {
		role: "custom",
		customType: "hook",
		content: blocks.map((text) => ({ type: "text" as const, text })),
		display: false,
		timestamp: Date.now(),
	};
}

export interface PromptVerdict {
	/** Set when a hook dropped the prompt: what the user reads. */
	readonly blocked?: { readonly text: string; readonly reason: string };
	/** Messages that go in front of the prompt. */
	readonly context: readonly CustomMessage[];
}

export class SessionHooks {
	readonly dispatcher: HookDispatcher;
	private readonly host: SessionHooksHost;
	private sink: ((item: HookStreamItem) => void) | undefined;
	/** What a PreToolUse hook said about an Edit or Write, and the input it will run with, until the tool asks for permission. Keyed by tool and path. */
	private readonly mutationPreferences = new Map<string, HookPreference>();
	private readonly mutationInputs = new Map<string, Json>();
	/** Text that follows a tool result as its own block, keyed by tool call id. */
	private readonly toolBlocks = new Map<string, string[]>();
	private readonly toolStarted = new Map<string, number>();
	private stopBlocks = 0;
	private stopErrorShown = false;
	private sessionStartRan = false;

	constructor(host: SessionHooksHost, options: SessionHooksOptions) {
		this.host = host;
		this.dispatcher = new HookDispatcher({
			config: options.config,
			projectDir: options.projectDir,
			cwd: () => host.cwd(),
			session: () => host.info(),
			env: options.env,
			onRecord: (item) => this.report(item),
			callMatches: options.callMatches,
		});
	}

	setSink(sink: ((item: HookStreamItem) => void) | undefined): void {
		this.sink = sink;
	}

	private report(item: HookStreamItem): void {
		this.sink?.(item);
	}

	private terminal(sequences: readonly string[]): void {
		for (const sequence of sequences) {
			const allowed = allowedTerminalSequence(sequence);
			if (allowed !== undefined) this.host.writeTerminal?.(allowed);
		}
	}

	/** PreToolUse hooks: they may block the call, rewrite its input in place, and say how permission goes. */
	async preTool(
		toolCall: { readonly id: string; readonly name: string },
		args: Json,
		modelCall: { readonly name: string; readonly arguments: Json },
	): Promise<{ block?: { reason: string }; preference?: HookPreference } | undefined> {
		this.toolStarted.set(toolCall.id, Date.now());
		const cwd = this.host.cwd();
		if (!this.dispatcher.active("PreToolUse")) {
			this.keepMutationInput(toolCall.name, args, absolutePaths(modelCall.arguments, cwd));
			return undefined;
		}
		const result = await preToolUse(
			this.dispatcher,
			{ name: modelCall.name, input: absolutePaths(modelCall.arguments, cwd), toolUseId: toolCall.id },
			this.host.signal(),
		);
		if (result.kind === "block") return { block: { reason: result.reason } };
		if (result.rewrite) {
			for (const key of Object.keys(args)) delete args[key];
			Object.assign(args, result.rewrite);
		}
		if (result.context.length > 0) this.toolBlocks.set(toolCall.id, [...result.context]);
		if (toolCall.name === "edit" || toolCall.name === "write") {
			const key = this.keepMutationInput(toolCall.name, args, result.input);
			if (key && result.preference) this.mutationPreferences.set(key, result.preference);
			return undefined;
		}
		return result.preference ? { preference: result.preference } : undefined;
	}

	/** The input an Edit or Write will run with, kept until the tool asks for permission, so a PermissionRequest hook sees all of it. */
	private keepMutationInput(piName: string, args: Json, input: Json): string | undefined {
		if (piName !== "edit" && piName !== "write") return undefined;
		const path = args.path;
		if (typeof path !== "string") return undefined;
		const key = `${piName}:${resolve(this.host.cwd(), path)}`;
		this.mutationInputs.set(key, input);
		return key;
	}

	/** What a PreToolUse hook said about an Edit or Write on this path, and the input the call has, once. */
	takeMutation(piName: string, path: string): { preference?: HookPreference; input?: Json } {
		const key = `${piName}:${resolve(this.host.cwd(), path)}`;
		const preference = this.mutationPreferences.get(key);
		const input = this.mutationInputs.get(key);
		this.mutationPreferences.delete(key);
		this.mutationInputs.delete(key);
		return { ...(preference ? { preference } : {}), ...(input ? { input } : {}) };
	}

	/** PostToolUse and PostToolUseFailure hooks: feedback is appended to the result, and a stop ends the run. */
	async postTool(
		toolCall: { readonly id: string },
		modelCall: { readonly name: string; readonly arguments: Json },
		resultText: string,
		isError: boolean,
	): Promise<{ text: string; stop?: string }> {
		resultText = resultText.replace(/\n+$/, "");
		const queued = this.toolBlocks.get(toolCall.id) ?? [];
		this.toolBlocks.delete(toolCall.id);
		const started = this.toolStarted.get(toolCall.id);
		this.toolStarted.delete(toolCall.id);
		if (queued.length > 0) this.host.steer(hookMessage(queued));
		const cwd = this.host.cwd();
		const result = await postToolUse(
			this.dispatcher,
			{
				name: modelCall.name,
				input: absolutePaths(modelCall.arguments, cwd),
				toolUseId: toolCall.id,
				response: ccToolUseResult(modelCall.name, modelCall.arguments, resultText, isError),
				error: isError ? resultText : undefined,
				durationMs: started === undefined ? 0 : Date.now() - started,
			},
			this.host.signal(),
		);
		const replaced =
			(result.replacement === undefined ? undefined : replacementText(modelCall.name, result.replacement)) ??
			resultText;
		return { text: replaced + result.appended, ...(result.stop === undefined ? {} : { stop: result.stop }) };
	}

	/**
	 * PostToolBatch hooks, once every call of a model reply has a result. Context they add goes after the
	 * last result, and a block ends the run.
	 */
	async postBatch(
		calls: readonly {
			readonly name: string;
			readonly input: Json;
			readonly toolUseId: string;
			readonly response: string;
		}[],
	): Promise<{ readonly append: string; readonly stop: boolean }> {
		const none = { append: "", stop: false };
		if (calls.length === 0 || !this.dispatcher.active("PostToolBatch")) return none;
		const verdict = await this.dispatcher.run(
			"PostToolBatch",
			{
				tool_calls: calls.map((call) => ({
					tool_name: call.name,
					tool_input: call.input,
					tool_use_id: call.toolUseId,
					tool_response: call.response,
				})),
			},
			{ signal: this.host.signal() },
		);
		const note = additionalContext("PostToolBatch", verdict.context);
		return {
			append: note === undefined ? "" : `\n\n${reminder(note)}`,
			stop: verdict.blocks.length > 0 || verdict.stop !== undefined,
		};
	}

	/** UserPromptSubmit hooks: a block drops the prompt, and the context they add goes in front of it. */
	async submitPrompt(prompt: string): Promise<PromptVerdict> {
		if (!this.dispatcher.active("UserPromptSubmit")) return { context: [] };
		const verdict = await this.dispatcher.run("UserPromptSubmit", { prompt }, { signal: this.host.signal() });
		const blocks = [
			...verdict.outputs.map((output) => reminder(hookSuccess("UserPromptSubmit", output))),
			...contextBlocks("UserPromptSubmit", verdict.context),
		];
		const context = blocks.length === 0 ? [] : [hookMessage(blocks)];
		const reason = verdict.blocks.at(-1)?.reason ?? verdict.stop;
		if (reason === undefined) return { context };
		const shown = verdict.blocks.at(-1)?.text ?? reason;
		const text = promptBlocked(shown, prompt);
		this.report({
			subtype: "informational",
			content: text,
			level: "warning",
			extra: {
				prevent_continuation: true,
				prompt_submit_outcome: { kind: "blocked_by_hook", prompt_kept: false, reason },
			},
		});
		return { blocked: { text, reason }, context };
	}

	/** Called when a new user prompt starts, so the Stop count starts over. */
	beginRun(): void {
		this.stopBlocks = 0;
	}

	/**
	 * Stop hooks: a block feeds its reason back and keeps the run going, up to the cap. `stop` is set
	 * when a hook asked the agent to end for good.
	 */
	async stop(): Promise<{ readonly continue: boolean; readonly stopped?: boolean }> {
		if (!this.dispatcher.active("Stop")) return { continue: false };
		const verdict = await this.dispatcher.run(
			"Stop",
			{
				stop_hook_active: this.stopBlocks > 0,
				last_assistant_message: this.host.lastAssistantText(),
				background_tasks: [],
				session_crons: [],
			},
			{ signal: this.host.signal() },
		);
		if (verdict.stop !== undefined) {
			this.stopBlocks = 0;
			return { continue: false, stopped: true };
		}
		if (verdict.blocks.length === 0) {
			this.stopBlocks = 0;
			return { continue: false };
		}
		this.stopBlocks += 1;
		for (const block of verdict.blocks) this.report({ subtype: "synthetic_user", text: stopFeedback(block.reason) });
		if (!this.stopErrorShown) {
			this.stopErrorShown = true;
			this.report({
				subtype: "notification",
				key: "stop-hook-error",
				text: "Stop hook error occurred \u00b7 ctrl+o to see",
				priority: "immediate",
			});
		}
		const cap = stopHookCap();
		if (cap > 0 && this.stopBlocks > cap) {
			const notice = stopCapNotice(this.stopBlocks);
			this.report({ subtype: "informational", content: notice, level: "warning" });
			this.report({
				subtype: "notification",
				key: "stop-hook-block-cap",
				text: notice,
				priority: "high",
				color: "warning",
			});
			this.stopBlocks = 0;
			return { continue: false };
		}
		const messages = verdict.blocks.map((block) => {
			const feedback = stopFeedback(block.viaExit ? block.text : block.reason);
			return block.viaExit
				? [feedback]
				: [`${reminder(blockingError("Stop", block.source, block.reason))}\n`, feedback];
		});
		this.host.steer(hookMessage(messages.flat()));
		return { continue: true };
	}

	/** SessionStart hooks, once per session: what they print is context in front of the first prompt. */
	async sessionStart(source: string): Promise<readonly CustomMessage[]> {
		if (this.sessionStartRan || !this.dispatcher.active("SessionStart")) return [];
		this.sessionStartRan = true;
		const verdict = await this.dispatcher.run("SessionStart", { source });
		this.terminal(verdict.terminalSequences);
		const blocks = [
			...verdict.outputs.map((output) => reminder(hookSuccess(`SessionStart:${source}`, output))),
			...contextBlocks("SessionStart", verdict.context),
		];
		return blocks.length === 0 ? [] : [hookMessage(blocks)];
	}

	/** SessionEnd hooks run after the result is out, and Claude reports them nowhere in the stream. */
	async sessionEnd(reason: string): Promise<void> {
		this.dispatcher.cancelBackground();
		if (!this.dispatcher.active("SessionEnd")) return;
		const sink = this.sink;
		this.sink = undefined;
		try {
			await this.dispatcher.run("SessionEnd", { reason });
		} finally {
			this.dispatcher.cancelBackground();
			this.sink = sink;
		}
	}

	/** PreCompact hooks: a block cancels the compaction. */
	async compactionBlocked(trigger: "manual" | "auto", customInstructions: string | undefined): Promise<boolean> {
		if (!this.dispatcher.active("PreCompact")) return false;
		const verdict = await this.dispatcher.run(
			"PreCompact",
			{ trigger, custom_instructions: customInstructions ?? null },
			{},
		);
		return verdict.block !== undefined || verdict.stop !== undefined;
	}

	async notify(message: string, type: string): Promise<void> {
		if (!this.dispatcher.active("Notification")) return;
		const verdict = await this.dispatcher.run("Notification", { message, notification_type: type });
		this.terminal(verdict.terminalSequences);
	}
}

function contextBlocks(event: string, context: readonly string[]): string[] {
	const text = additionalContext(event, context);
	return text === undefined ? [] : [reminder(text)];
}
