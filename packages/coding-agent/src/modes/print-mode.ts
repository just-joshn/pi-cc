/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 * - `pi --output-format json|stream-json` - Claude Code's SDK frames (see ./sdk)
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { budgetExhausted, budgetStopLine, gateBudget } from "../core/usage/budget.ts";
import { chargeFor, type PricingPolicy, type RatesContext } from "../core/usage/cost.ts";
import { costStateOf, restoredCostState } from "../core/usage/cost-state.ts";
import { collectUsage, formatUsageReport, type UsageReportInput } from "../core/usage/report.ts";
import { SessionClock } from "../core/usage/session-clock.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { compactFailureText } from "./compact-failure.ts";
import { toJsonEvent } from "./json-event.ts";
import { parseLocalUsageCommand } from "./local-usage.ts";
import { limitTurns } from "./max-turns.ts";
import { SdkHost, type SdkHostOptions, type SdkPrompt } from "./sdk/host.ts";

/**
 * Options for print mode.
 */
interface PrintModeBase {
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Claude Code's `--max-turns`, for the text mode. The SDK host takes it in `sdk`. */
	maxTurns?: number;
	/** Claude Code's `--max-budget-usd`, for the text mode. The SDK host takes it in `sdk`. */
	maxBudgetUsd?: number;
	/** The operator's `modelPricing` policy setting, for the text mode's budget. */
	pricing?: PricingPolicy;
	/** The operator cost rows, promotions and the session's selected model, for the price chain. */
	rates?: RatesContext;
}

export type PrintModeOptions =
	| (PrintModeBase & {
			/** Output mode: "text" for final response only, "json" for all events */
			mode: "text" | "json";
	  })
	| (PrintModeBase & {
			/** Claude Code SDK frames: one result, or stream-json frames with the control protocol. */
			mode: "sdk";
			sdk: Omit<SdkHostOptions, "write" | "fail">;
	  });

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	const sdkHost =
		options.mode === "sdk"
			? new SdkHost(() => runtimeHost.session, {
					...options.sdk,
					write: writeRawStdout,
					fail: (message) => console.error(message),
				})
			: undefined;
	let exitCode = 0;
	let spentUsd = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "text" ? "print" : "json",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message as AssistantMessage;
				if (message.stopReason !== "error" && message.stopReason !== "aborted") {
					spentUsd += chargeFor(message.model, message.usage, options.pricing, {
						...options.rates,
						selectedModel: session.model?.id,
					}).usd;
				}
			}
			if (sdkHost !== undefined) {
				sdkHost.onEvent(event);
			} else if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode !== "text"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (sdkHost !== undefined) {
			const prompts: SdkPrompt[] = [];
			if (initialMessage) {
				prompts.push({ content: initialMessage, text: initialMessage, images: initialImages ?? [] });
			}
			for (const message of messages) prompts.push({ content: message, text: message, images: [] });
			return await sdkHost.run(prompts);
		}

		const maxBudgetUsd = mode === "text" ? options.maxBudgetUsd : undefined;
		const clock = new SessionClock();
		const restored = restoredCostState(session.sessionManager.getEntries?.() ?? []);
		if (restored !== undefined) clock.restore(restored.totalDuration, restored.startTime);
		// The accumulator below counts this run's spend only, so the budget needs no restored-cost split here.
		const usageInput = (): UsageReportInput =>
			collectUsage(session.state.messages, clock.elapsed(), options.pricing, {
				...options.rates,
				selectedModel: session.model?.id,
			});
		const recordCostState = (): void => {
			session.sessionManager.appendCostState?.(costStateOf(usageInput(), clock));
		};
		let reachedMaxTurns = false;
		const localOutputs: string[] = [];
		let ranLocalCommand = false;
		let compactFailed = false;
		/** Runs one prompt; false when a local command answered it without a model call. */
		const promptWithinLimit = async (text: string, images?: ImageContent[]): Promise<boolean> => {
			// /usage, /cost and /stats are local commands in text print mode: answered from the session totals.
			if (mode === "text" && parseLocalUsageCommand(text) !== undefined) {
				ranLocalCommand = true;
				writeRawStdout(`${formatUsageReport(usageInput())}\n`);
				return false;
			}
			const limit = limitTurns(session.agent, mode === "text" ? options.maxTurns : undefined);
			const budget = gateBudget(session.agent, () => budgetExhausted(spentUsd, maxBudgetUsd));
			try {
				ranLocalCommand = false;
				if (session.compactionLimits && /^\/compact(?:\s|$)/.test(text)) {
					ranLocalCommand = true;
					try {
						await session.compact(text.slice(8).trim() || undefined);
						localOutputs.push("Compacted");
					} catch (error) {
						compactFailed = true;
						console.error(compactFailureText(error));
						exitCode = 1;
					}
					return false;
				} else if (session.compactionLimits && /^\/autocompact(?:\s|$)/.test(text)) {
					ranLocalCommand = true;
					localOutputs.push(session.configureAutoCompaction(text.slice(12)));
					return false;
				} else await session.prompt(text, { images });
			} finally {
				budget.release();
				limit.release();
			}
			reachedMaxTurns ||= limit.reached();
			return true;
		};

		if (initialMessage) {
			if (await promptWithinLimit(initialMessage, initialImages)) recordCostState();
		}

		for (const message of messages) {
			if (reachedMaxTurns || compactFailed || budgetExhausted(spentUsd, maxBudgetUsd)) break;
			if (await promptWithinLimit(message)) recordCostState();
		}

		if (maxBudgetUsd !== undefined && budgetExhausted(spentUsd, maxBudgetUsd)) {
			writeRawStdout(budgetStopLine(maxBudgetUsd));
			return 1;
		}

		if (reachedMaxTurns) {
			writeRawStdout(`Error: Reached max turns (${options.maxTurns})`);
			return 1;
		}

		if (mode === "text") for (const output of localOutputs) writeRawStdout(`${output}\n`);
		if (compactFailed) return 1;
		if (mode === "text" && !ranLocalCommand) {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
					if (assistantMsg.stopReason === "length") {
						console.error("Response was truncated: the model reached its output token limit.");
						exitCode = 1;
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
