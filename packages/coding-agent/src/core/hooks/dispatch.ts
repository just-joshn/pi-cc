/**
 * The hook dispatcher: selects the handlers an event's matcher picks, runs them in parallel, reports
 * each through the record sink, and folds their outcomes into one verdict.
 */

import { randomUUID } from "node:crypto";
import { activeGroups, type HookConfig, type HookHandler, hasHooksFor } from "./config.ts";
import { EVENT_TABLE, type HookEvent } from "./events.ts";
import { runHttp } from "./http.ts";
import { buildInput, type EventFields, type HookSessionInfo } from "./input.ts";
import { selectHandlers } from "./matcher.ts";
import { EMPTY_VERDICT, interpret, mergeOutcomes, type Outcome, parseJsonOutput, type Verdict } from "./outcome.ts";
import { type RawResult, runCommand } from "./process.ts";
import type { HookStreamItem } from "./stream.ts";

export interface DispatcherOptions {
	readonly config: HookConfig;
	readonly projectDir: string;
	readonly cwd: () => string;
	readonly session: () => HookSessionInfo;
	readonly onRecord?: (record: HookStreamItem) => void;
	/** Environment added to command hooks (the variables a hook may use to persist state). */
	readonly env?: () => Readonly<Record<string, string>>;
	/** Whether a hook's `if` rule matches the tool call that fired the event. */
	readonly callMatches?: (filter: string, fields: Readonly<Record<string, unknown>>) => boolean;
}

export interface RunOptions {
	readonly signal?: AbortSignal;
}

export class HookDispatcher {
	private readonly options: DispatcherOptions;
	private readonly background = new Set<AbortController>();

	constructor(options: DispatcherOptions) {
		this.options = options;
	}

	/** Whether a hook is configured for the event, whether or not the switches would let it run. */
	configured(event: HookEvent): boolean {
		return hasHooksFor(this.options.config, event);
	}

	/** Whether a hook may run for the event under the switches. */
	active(event: HookEvent): boolean {
		return activeGroups(this.options.config, event).length > 0;
	}

	get warnings(): readonly string[] {
		return this.options.config.warnings;
	}

	async run<E extends HookEvent>(event: E, fields: EventFields[E], run: RunOptions = {}): Promise<Verdict> {
		const groups = activeGroups(this.options.config, event);
		if (groups.length === 0) return EMPTY_VERDICT;
		const field = EVENT_TABLE[event].matches;
		const value = field === undefined ? undefined : stringValue((fields as Readonly<Record<string, unknown>>)[field]);
		const handlers = selectHandlers(groups, event, value).filter((handler) => this.admits(handler, fields));
		if (handlers.length === 0) return EMPTY_VERDICT;
		const input = buildInput(this.options.session(), event, fields);
		const name = value ? `${event}:${value}` : event;
		for (const handler of handlers.filter((entry) => entry.type === "command" && entry.async)) {
			const controller = new AbortController();
			this.background.add(controller);
			const signal = run.signal ? AbortSignal.any([controller.signal, run.signal]) : controller.signal;
			void this.runOne(event, handler, input, name, { signal }).finally(() => this.background.delete(controller));
		}
		const waited = handlers.filter((handler) => !(handler.type === "command" && handler.async));
		const completed: Outcome[] = [];
		await Promise.all(
			waited.map(async (handler) => completed.push(await this.runOne(event, handler, input, name, run))),
		);
		return mergeOutcomes(completed);
	}

	cancelBackground(): void {
		for (const controller of this.background) controller.abort();
		this.background.clear();
	}

	private admits(handler: HookHandler, fields: Readonly<Record<string, unknown>>): boolean {
		return handler.filter === undefined || this.options.callMatches?.(handler.filter, fields) !== false;
	}

	private async runOne(
		event: HookEvent,
		handler: HookHandler,
		input: unknown,
		name: string,
		run: RunOptions,
	): Promise<Outcome> {
		const id = randomUUID();
		this.options.onRecord?.({ subtype: "hook_started", hook_id: id, hook_name: name, hook_event: event });
		const result = await this.execute(handler, input, run);
		const source = handler.type === "command" ? handler.command : handler.url;
		const exitCode = result.status ?? (result.failure === undefined ? result.code : 1);
		this.options.onRecord?.({
			subtype: "hook_response",
			hook_id: id,
			hook_name: name,
			hook_event: event,
			output: result.stdout + result.stderr,
			stdout: result.stdout,
			stderr: result.stderr,
			...(exitCode === null ? {} : { exit_code: exitCode }),
			outcome: hookOutcome(result),
		});
		const outcome = { ...interpret(event, result, { source, onFailure: handler.onFailure }), source };
		if (outcome.systemMessage !== undefined) {
			this.options.onRecord?.({
				subtype: "informational",
				content: `${name} says: ${outcome.systemMessage}`,
				level: "notice",
			});
		}
		return parseJsonOutput(result.stdout)?.suppressOutput === true ? { ...outcome, suppressOutput: true } : outcome;
	}

	private execute(handler: HookHandler, input: unknown, run: RunOptions): Promise<RawResult> {
		if (handler.type === "http") {
			return runHttp(handler, input, {
				switches: this.options.config.switches,
				...(run.signal ? { signal: run.signal } : {}),
			});
		}
		const env = this.options.env?.();
		return runCommand(handler, input, {
			cwd: this.options.cwd(),
			projectDir: this.options.projectDir,
			...(env ? { env } : {}),
			...(run.signal ? { signal: run.signal } : {}),
		});
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function hookOutcome(result: RawResult): "success" | "error" | "cancelled" {
	if (result.failure === "cancelled" || result.failure === "timed out") return "cancelled";
	if (result.status !== undefined)
		return result.status >= 200 && result.status < 300 && result.stderr === "" ? "success" : "error";
	return result.failure === undefined && result.code === 0 ? "success" : "error";
}
