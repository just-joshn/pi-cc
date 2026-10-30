/**
 * The Claude Code SDK host. It adapts one pi session to the stream-json protocol: it reads user messages
 * and control requests, drives `session.prompt`, and writes the frames `FrameRenderer` and the result
 * ledger produce. pi's own `--mode json` and `--mode rpc` never reach this file.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { limitTurns } from "../max-turns.ts";
import { attachJsonlLineReader } from "../rpc/jsonl.ts";
import { encodeFrame, parseInputLine } from "./codec.ts";
import { handleControlRequest } from "./control.ts";
import type { Json, SdkFrame, UserReplayFrame } from "./frames.ts";
import { buildInitFrame, readSessionFacts } from "./init.ts";
import { FrameRenderer } from "./render.ts";
import { reportedOutputCap, SessionLedger, TurnTally } from "./result.ts";
import { syntheticApiErrorFrame } from "./synthetic.ts";

export interface SdkHostOptions {
	outputFormat: "json" | "stream-json";
	inputFormat: "text" | "stream-json";
	/** With `json` output, the full frame array replaces the single result. */
	verbose: boolean;
	includePartial: boolean;
	replayUser: boolean;
	permissionMode: string;
	/** `--max-turns`: model requests one user message may take before it ends with `error_max_turns`. */
	maxTurns?: number;
	/** Whether the provider has a credential, asked for the model selected now so a `set_model` shows. */
	hasAuth(provider: string): boolean;
	/** Where stream-json user messages and control requests arrive. */
	input: Readable;
	env: NodeJS.ProcessEnv;
	write(text: string): void;
	fail(message: string): void;
}

/** One user message to run. */
export interface SdkPrompt {
	content: string | Json[];
	text: string;
	images: ImageContent[];
}

const NOT_LOGGED_IN_TEXT = "Not logged in \u00b7 Please run /login";

export class SdkHost {
	private readonly getSession: () => AgentSession;
	private readonly options: SdkHostOptions;
	private readonly ledger = new SessionLedger();
	private readonly permissionMode: { current: string };
	private readonly collected: SdkFrame[] = [];
	private readonly renderer: FrameRenderer;
	private readonly defaultModel: AgentSession["model"];
	private exitCode = 0;
	private ended = false;

	constructor(getSession: () => AgentSession, options: SdkHostOptions) {
		this.getSession = getSession;
		this.options = options;
		this.permissionMode = { current: options.permissionMode };
		this.defaultModel = getSession().model;
		this.renderer = new FrameRenderer({
			sessionId: () => this.getSession().sessionId,
			includePartial: options.includePartial,
			emit: (frame) => this.emit(frame),
			now: () => Date.now(),
			limitsOf: (message) => {
				const model = this.getSession().modelRuntime.getModel(message.provider, message.model);
				return {
					contextWindow: model?.contextWindow ?? 0,
					maxOutputTokens: reportedOutputCap(message.model, model?.maxTokens ?? 0),
				};
			},
		});
	}

	private factsOf(session: AgentSession) {
		const authConfigured = session.model !== undefined && this.options.hasAuth(session.model.provider);
		return {
			authConfigured,
			facts: readSessionFacts(
				session,
				{ permissionMode: this.permissionMode.current, authConfigured },
				this.options.env,
			),
		};
	}

	/** The session event listener: renders every event as zero or more frames. */
	onEvent(event: AgentSessionEvent): void {
		this.renderer.onEvent(event);
	}

	/** Runs every user message, then writes the final document for `json` output. Resolves to the exit code. */
	async run(initial: SdkPrompt[]): Promise<number> {
		const inbox = this.options.inputFormat === "stream-json" ? this.readStdin() : closedInbox(initial);
		for (;;) {
			const next = await inbox.next();
			if (next === undefined || this.ended) break;
			await this.turn(next);
		}
		if (inbox.failure !== undefined) {
			this.options.fail(inbox.failure);
			return 1;
		}
		this.finish();
		return this.exitCode;
	}

	private async turn(prompt: SdkPrompt): Promise<void> {
		const session = this.getSession();
		const startedAt = Date.now();
		const { facts, authConfigured } = this.factsOf(session);
		this.emit(buildInitFrame(facts));
		if (!authConfigured) {
			this.emit(
				syntheticApiErrorFrame({
					sessionId: facts.sessionId,
					text: NOT_LOGGED_IN_TEXT,
					error: "authentication_failed",
				}),
			);
			this.emit(this.ledger.notLoggedInResult(facts.sessionId, Date.now(), startedAt, NOT_LOGGED_IN_TEXT));
			this.exitCode = 1;
			return;
		}
		if (this.options.includePartial) this.renderer.status();
		if (this.options.replayUser) this.emit(replayFrame(facts.sessionId, prompt));
		const tally = new TurnTally(startedAt);
		this.renderer.beginTurn(tally);
		const limit = limitTurns(session.agent, this.options.maxTurns);
		try {
			await session.prompt(prompt.text, { images: prompt.images.length > 0 ? prompt.images : undefined });
			await session.waitForIdle();
		} finally {
			limit.release();
		}
		if (limit.reached() && this.options.maxTurns !== undefined) {
			tally.outcome = { kind: "max_turns", limit: this.options.maxTurns };
		}
		const result = this.ledger.result(tally, session.sessionId, Date.now());
		this.emit(result);
		this.exitCode = result.is_error ? 1 : 0;
	}

	private readStdin(): Inbox {
		const inbox = new Inbox();
		let control: Promise<void> = Promise.resolve();
		attachJsonlLineReader(this.options.input, (line) => {
			if (line.trim() === "") return;
			const input = parseInputLine(line);
			if (input.kind === "invalid") {
				inbox.fail(input.message);
			} else if (input.kind === "user") {
				// Behind earlier control requests, so their responses leave before the turn's init frame.
				control = control.then(() =>
					inbox.push({ content: input.content, text: input.text, images: input.images }),
				);
			} else if (input.kind === "control") {
				// Chained so responses leave in the order the requests arrived, even while a turn runs.
				control = control.then(async () => {
					const session = this.getSession();
					const frames = await handleControlRequest(input.requestId, input.request, {
						session,
						facts: this.factsOf(session).facts,
						env: this.options.env,
						home: homedir(),
						permissionMode: this.permissionMode,
						defaultModel: this.defaultModel,
						interrupted: () => this.renderer.markInterrupted(),
						endSession: () => {
							this.ended = true;
							inbox.close();
						},
						uuid: randomUUID,
					});
					for (const frame of frames) this.emit(frame);
				});
			}
		});
		this.options.input.once("end", () => {
			void control.then(() => inbox.close());
		});
		return inbox;
	}

	private emit(frame: SdkFrame): void {
		if (this.options.outputFormat === "stream-json") {
			this.options.write(encodeFrame(frame));
		} else if (frame.type === "result") {
			// The single-document formats omit the per-result delta that stream-json carries (measured).
			const { model_usage_since_last_result: _delta, ...document } = frame;
			this.collected.push(document as SdkFrame);
		} else {
			this.collected.push(frame);
		}
	}

	private finish(): void {
		if (this.options.outputFormat === "stream-json") return;
		const results = this.collected.filter((frame) => frame.type === "result");
		const document = this.options.verbose ? this.collected : results.at(-1);
		if (document !== undefined) this.options.write(`${JSON.stringify(document)}\n`);
	}
}

/** The prompts waiting to run. `next` resolves once one arrives, or to undefined when the input is done. */
class Inbox {
	failure: string | undefined;
	private readonly queue: SdkPrompt[] = [];
	private waiting: (() => void) | undefined;
	private closed = false;

	push(prompt: SdkPrompt): void {
		this.queue.push(prompt);
		this.wake();
	}

	close(): void {
		this.closed = true;
		this.wake();
	}

	fail(message: string): void {
		this.failure ??= message;
		this.close();
	}

	async next(): Promise<SdkPrompt | undefined> {
		for (;;) {
			if (this.failure !== undefined) return undefined;
			const prompt = this.queue.shift();
			if (prompt !== undefined) return prompt;
			if (this.closed) return undefined;
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
			});
		}
	}

	private wake(): void {
		this.waiting?.();
		this.waiting = undefined;
	}
}

function closedInbox(prompts: SdkPrompt[]): Inbox {
	const inbox = new Inbox();
	for (const prompt of prompts) inbox.push(prompt);
	inbox.close();
	return inbox;
}

function replayFrame(sessionId: string, prompt: SdkPrompt): UserReplayFrame {
	return {
		type: "user",
		message: { role: "user", content: prompt.content },
		session_id: sessionId,
		parent_tool_use_id: null,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		isReplay: true,
	};
}
