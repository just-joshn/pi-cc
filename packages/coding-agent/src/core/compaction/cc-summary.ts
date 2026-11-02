import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	contentText,
	isContextOverflow,
	type Model,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import { buildSessionProjection, type SessionEntry } from "../session-manager.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	completeSummarization,
	estimateProjectedContextTokens,
	estimateTokens,
	getSummarizationFailure,
} from "./compaction.ts";
import { createFileOps } from "./utils.ts";

export function prepareCcCompaction(
	entries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (entries.at(-1)?.type === "compaction") return undefined;
	const projection = buildSessionProjection(entries);
	const messages = projection.messages.filter((message) => message.role !== "system");
	if (messages.length === 0) return undefined;
	return {
		firstKeptEntryId: "",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: estimateProjectedContextTokens(projection, entries).tokens,
		fileOps: createFileOps(),
		settings,
	};
}

/** Drop complete API rounds so a summary retry never begins with an orphaned tool result. */
export function truncateCcSummaryHistory(messages: AgentMessage[], tokenGap?: number): AgentMessage[] | undefined {
	const head = messages.filter((message) => message.role === "system");
	const history = messages.filter(
		(message) =>
			message.role !== "system" &&
			!(message.role === "user" && message.content === "[earlier conversation truncated for compaction retry]"),
	);
	const groups: AgentMessage[][] = [];
	let responseId: string | undefined;
	for (const message of history) {
		if (
			groups.length === 0 ||
			(message.role === "assistant" && (message.responseId === undefined || message.responseId !== responseId))
		)
			groups.push([]);
		groups.at(-1)!.push(message);
		if (message.role === "assistant") responseId = message.responseId;
	}
	if (groups.length < 2) return undefined;
	let drop = Math.max(1, Math.floor(groups.length * 0.2));
	if (tokenGap !== undefined) {
		let freed = 0;
		drop = 0;
		while (drop < groups.length - 1 && freed < tokenGap) {
			freed += groups[drop++].reduce((tokens, message) => tokens + estimateTokens(message), 0);
		}
	}
	return [
		...head,
		{ role: "user", content: "[earlier conversation truncated for compaction retry]", timestamp: Date.now() },
		...groups.slice(drop).flat(),
	];
}

/** Summarize against the live request prefix, using pi's transport, auth and retry mechanisms. */
export async function summarizeCc(
	messages: AgentMessage[],
	preparation: CompactionPreparation,
	model: Model<Api>,
	options: SimpleStreamOptions,
	stream: StreamFn,
	instructions?: string,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	cold = false,
): Promise<CompactionResult> {
	const prompt = [
		"Write a continuation checkpoint for this conversation. Do not perform the task or call tools.",
		"Capture the user's goal, constraints, decisions, completed work, unresolved issues, and concrete next actions.",
		"Keep exact paths, identifiers and errors needed to resume. Distinguish verified facts from assumptions.",
		instructions ? `The user requests this emphasis for the checkpoint:\n${instructions}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	let history = cold
		? [
				{
					role: "system" as const,
					content: "Create a compact continuation checkpoint of the conversation.",
					timestamp: Date.now(),
				},
				...messages.filter((message) => message.role !== "system"),
			]
		: messages;
	for (let attempt = 0; ; attempt++) {
		const response = await completeSummarization(
			model,
			normalizeContext({
				messages: [...convertToLlm(history), { role: "user", content: prompt, timestamp: Date.now() }],
			}),
			options,
			stream,
			retry,
			callbacks,
		);
		const responseText = contentText(response.content);
		const overflow = isContextOverflow(response) || /^prompt is too long/i.test(responseText.trim());
		if (overflow && attempt < 3) {
			const gap = /([\d,]+) tokens?\s*>\s*([\d,]+)/i.exec(response.errorMessage ?? responseText);
			const tokenGap = gap ? Number(gap[1].replaceAll(",", "")) - Number(gap[2].replaceAll(",", "")) : undefined;
			const truncated = truncateCcSummaryHistory(history, tokenGap);
			if (truncated) {
				history = truncated;
				continue;
			}
		}
		if (overflow) throw new Error("Conversation remains too long to compact after bounded history retries");
		const failure = getSummarizationFailure(response, "Compaction");
		if (failure) throw new Error(failure);
		if (response.content.some((block) => block.type === "toolCall"))
			throw new Error("Compaction attempted to call a tool");
		const summary = contentText(response.content);
		if (!summary.trim()) throw new Error("Compaction returned no summary text");
		return {
			summary,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			usage: response.usage,
		};
	}
}
