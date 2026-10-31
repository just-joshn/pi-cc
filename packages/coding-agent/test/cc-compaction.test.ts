import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getModel,
	type TranscriptMessages,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { buildCcPolicy } from "../src/core/cc-policy.ts";
import { ccCompactionLimits, ccCompactionPolicy } from "../src/core/compaction/cc-policy.ts";
import { truncateCcSummaryHistory } from "../src/core/compaction/cc-summary.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { SdkHost } from "../src/modes/sdk/host.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

async function createSession(
	settings: Record<string, unknown> = {},
	turns: Array<{ text?: string; tokens?: number; error?: string; hang?: boolean }> = [],
	env: NodeJS.ProcessEnv = {},
	flags: Parameters<typeof buildCcPolicy>[0]["flags"] = {},
	extensionsResult?: LoadExtensionsResult,
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cc-compact-"));
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 200_000, maxTokens: 20_000 };
	const requests: TranscriptMessages[] = [];
	const events: AgentSessionEvent[] = [];
	const append = { current: ["BEFORE"] };
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		initialState: { model, tools: [], thinkingLevel: "off" },
		streamFn: (_model, context) => {
			requests.push(context.messages);
			const turn = turns.shift() ?? { text: "CHECKPOINT" };
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: turn.text ?? "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: turn.error ? "error" : "stop",
				errorMessage: turn.error,
				usage: {
					input: turn.tokens ?? 12,
					output: 8,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: (turn.tokens ?? 12) + 8,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() + requests.length,
			};
			const stream = createAssistantMessageEventStream();
			if (turn.hang) return stream;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push(
					turn.error
						? { type: "error", reason: "error", error: message }
						: { type: "done", reason: "stop", message },
				);
			});
			return stream;
		},
	});
	const auth = AuthStorage.create(join(cwd, "auth.json"));
	const registry = await createModelRegistry(auth, cwd);
	await auth.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const manager = SessionManager.inMemory(cwd);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: SettingsManager.create(cwd, cwd),
		cwd,
		modelRuntime: getModelRuntime(registry),
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult }),
			getAppendSystemPrompt: () => append.current,
		},
		ccPolicy: buildCcPolicy({ flags, customPrompt: false, entrypoint: "sdk-cli", settings, env }),
	});
	session.subscribe((event) => events.push(event));
	disposals.push(() => {
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { session, requests, manager, events, append };
}

type Frame = Record<string, any>;

async function runSdk(session: AgentSession, prompts: string[]) {
	const written: string[] = [];
	const host = new SdkHost(() => session, {
		outputFormat: "stream-json",
		inputFormat: "text",
		verbose: true,
		includePartial: false,
		replayUser: false,
		permissionMode: "default",
		hasAuth: () => true,
		input: new PassThrough(),
		env: {},
		write: (line) => written.push(line),
		fail: () => {},
	});
	session.subscribe((event) => host.onEvent(event));
	const exitCode = await host.run(prompts.map((prompt) => ({ content: prompt, text: prompt, images: [] })));
	const frames = written.flatMap((line) =>
		line
			.split("\n")
			.filter(Boolean)
			.map((entry) => JSON.parse(entry) as Frame),
	);
	return { exitCode, frames, results: frames.filter((frame) => frame.type === "result") };
}

async function runText(session: AgentSession, messages: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: () => void) => {
		stdout.push(String(chunk));
		callback?.();
		return true;
	}) as typeof process.stdout.write);
	vi.spyOn(console, "error").mockImplementation((message: unknown) => {
		stderr.push(String(message));
	});
	const runtime = {
		session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as Parameters<typeof runPrintMode>[0];
	const exitCode = await runPrintMode(runtime, { mode: "text", messages });
	return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function text(messages: TranscriptMessages): string {
	return JSON.stringify(messages);
}

describe("Claude Code compaction policy", () => {
	it("reserves output and summary headroom, and clamps percentage overrides", () => {
		const model = { id: "model", contextWindow: 200_000, maxTokens: 64_000 };
		expect(ccCompactionLimits(ccCompactionPolicy({}, {}), model)).toMatchObject({
			effectiveWindow: 180_000,
			threshold: 167_000,
			precompute: 144_000,
			warn: 147_000,
			block: 177_000,
		});
		expect(
			ccCompactionLimits(ccCompactionPolicy({}, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" }), model).threshold,
		).toBe(90_000);
		expect(
			ccCompactionLimits(ccCompactionPolicy({}, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100" }), model).threshold,
		).toBe(167_000);
	});
	it("resolves environment, per-model, global and session windows", () => {
		const model = { id: "model", contextWindow: 200_000, maxTokens: 20_000 };
		const settings = { autoCompactWindow: 150_000, modelSettings: { model: { autoCompactWindow: 120_000 } } };
		expect(ccCompactionLimits(ccCompactionPolicy(settings, {}), model)).toMatchObject({
			window: 120_000,
			source: "settings_per_model",
		});
		expect(
			ccCompactionLimits(ccCompactionPolicy(settings, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "130000" }), model).window,
		).toBe(130_000);
		expect(ccCompactionLimits(ccCompactionPolicy(settings, {}, 300_000), model).window).toBe(200_000);
		expect(
			ccCompactionLimits(ccCompactionPolicy(settings, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "130k" }, 180_000), model),
		).toMatchObject({ window: 130_000, source: "environment" });
		expect(ccCompactionLimits(ccCompactionPolicy({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200" }), model).window).toBe(
			100_000,
		);
		expect(
			ccCompactionLimits(ccCompactionPolicy({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "garbage" }), model).window,
		).toBe(200_000);
	});
});

describe("Claude Code session compaction", () => {
	it("summarizes the live system/tools/history prefix with instructions and replaces all old history", async () => {
		const { session, requests, manager, append } = await createSession();
		await session.prompt("ORIGINAL TASK");
		const first = getCurrentSystemMessage(requests[0]);
		append.current = ["AFTER"];
		session.setActiveToolsByName(session.getActiveToolNames());
		await session.compact("retain the failing tests");
		expect(getCurrentSystemMessage(requests[1])?.sections).toEqual(first?.sections);
		expect(text(requests[1])).toContain("ORIGINAL TASK");
		expect(text(requests[1])).toContain("retain the failing tests");
		expect(session.messages.filter((message) => message.role !== "system").map((message) => message.role)).toEqual([
			"compactionSummary",
		]);
		const entry = manager.getBranch().findLast((entry) => entry.type === "compaction");
		expect(entry?.type === "compaction" && entry.systemMessage?.sections?.working).toContain("AFTER");
		await session.prompt("CONTINUE");
		expect(text(requests[2])).not.toContain("ORIGINAL TASK");
		expect(text(requests[2])).toContain("CHECKPOINT");
	});
	it("compacts before the next request at the token threshold", async () => {
		const { session, requests, events } = await createSession({}, [
			{ tokens: 170_000 },
			{ text: "SMALL CHECKPOINT" },
			{ text: "done" },
		]);
		await session.prompt("large history");
		await session.prompt("next task");
		expect(requests).toHaveLength(3);
		expect(events.filter((event) => event.type === "compaction_start")).toEqual([
			{ type: "compaction_start", reason: "threshold" },
		]);
		expect(text(requests[2])).toContain("SMALL CHECKPOINT");
		expect(text(requests[2])).not.toContain("large history");
	});
	it("reacts to prompt-too-long with one compact-and-retry", async () => {
		const { session, requests, events } = await createSession({}, [
			{ error: "prompt is too long: 210000 tokens > 200000 maximum" },
			{ text: "RECOVERY" },
			{ text: "done" },
		]);
		await session.prompt("oversized task");
		expect(requests).toHaveLength(3);
		expect(
			events.some((event) => event.type === "compaction_end" && event.reason === "overflow" && event.willRetry),
		).toBe(true);
		expect(text(requests[2])).toContain("RECOVERY");
	});
	it("disabled auto leaves manual compaction available", async () => {
		const { session, requests } = await createSession({ autoCompactEnabled: false }, [
			{ tokens: 170_000 },
			{ text: "done" },
			{ text: "MANUAL" },
		]);
		await session.prompt("one");
		await session.prompt("two");
		expect(requests).toHaveLength(2);
		expect(session.autoCompactionEnabled).toBe(false);
		await session.compact();
		expect(requests).toHaveLength(3);
	});
	it("precomputes ahead of the threshold and reuses the checkpoint without losing subsequent messages", async () => {
		const { session, requests, manager } = await createSession({ precomputeCompactionEnabled: true }, [
			{ tokens: 150_000 },
			{ text: "PRECOMPUTED" },
			{ tokens: 170_000 },
			{ text: "done" },
		]);
		await session.prompt("old history");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toHaveLength(2);
		expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		await session.prompt("new tail");
		await session.prompt("continue");
		expect(requests).toHaveLength(4);
		expect(text(requests[3])).toContain("PRECOMPUTED");
		expect(text(requests[3])).toContain("new tail");
		expect(text(requests[3])).not.toContain("old history");
	});
	it("drops a precomputed checkpoint once an extension-supplied compaction replaces the history it summarized", async () => {
		let supplied = false;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_before_compact", (event) => {
					if (supplied) return undefined;
					supplied = true;
					return {
						compaction: {
							summary: "EXTENSION CHECKPOINT",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		]);
		const { session, requests } = await createSession(
			{ precomputeCompactionEnabled: true },
			[
				{ tokens: 150_000 },
				{ text: "STALE PRECOMPUTE" },
				{ tokens: 170_000 },
				{ tokens: 170_000 },
				{ text: "SECOND PRECOMPUTE" },
				{ text: "done" },
			],
			{},
			{},
			extensionsResult,
		);
		await session.prompt("one");
		await tick();
		await session.prompt("two");
		await session.prompt("three");
		await tick();
		await session.prompt("four");
		expect(requests).toHaveLength(6);
		expect(text(requests[5])).toContain("SECOND PRECOMPUTE");
		expect(text(requests[5])).not.toContain("STALE PRECOMPUTE");
	});
	it("drops a precomputed checkpoint whose leaf left the branch and precomputes the new branch", async () => {
		const { session, requests, manager } = await createSession({ precomputeCompactionEnabled: true }, [
			{ tokens: 150_000 },
			{ text: "ABANDONED BRANCH" },
			{ tokens: 150_000 },
			{ text: "NEW BRANCH" },
		]);
		await session.prompt("first branch");
		await tick();
		const first = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		await session.navigateTree(first!.id);
		await session.prompt("second branch");
		await tick();
		expect(requests).toHaveLength(4);
		expect(text(requests[3])).toContain("second branch");
		expect(text(requests[3])).not.toContain("first branch");
	});
	it("lets an aborted compaction stop waiting on a precompute that never finishes", async () => {
		const { session } = await createSession({ precomputeCompactionEnabled: true }, [
			{ tokens: 150_000 },
			{ hang: true },
			{ tokens: 170_000 },
		]);
		await session.prompt("one");
		await session.prompt("two");
		const compacting = session.prompt("three");
		await tick();
		session.abortCompaction();
		const outcome = await Promise.race([
			compacting.then(
				() => "settled",
				() => "settled",
			),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
		]);
		expect(outcome).toBe("settled");
	});
	it("stops speculative summaries after repeated failures until a compaction succeeds", async () => {
		const failures = Array.from({ length: 3 }, () => [{ tokens: 150_000 }, { error: "checkpoint rejected" }]).flat();
		const { session, requests } = await createSession({ precomputeCompactionEnabled: true }, [
			...failures,
			{ tokens: 150_000 },
			{ tokens: 150_000 },
			{ text: "MANUAL" },
			{ tokens: 150_000 },
			{ text: "PRECOMPUTE AGAIN" },
		]);
		for (let i = 0; i < 5; i++) {
			await session.prompt(`task ${i}`);
			await tick();
		}
		expect(requests).toHaveLength(8);
		await session.compact();
		await session.prompt("after compaction");
		await tick();
		expect(requests).toHaveLength(11);
		expect(text(requests[10])).toContain("after compaction");
	});
	it("returns /autocompact reset, unset and default to the configured window without storing auto", async () => {
		const { session } = await createSession({}, [], {}, { autocompact: "150k" });
		expect(session.compactionLimits?.window).toBe(150_000);
		session.configureAutoCompaction("120k");
		expect(session.compactionLimits?.window).toBe(120_000);
		for (const word of ["reset", "unset", "default"]) {
			session.configureAutoCompaction("120k");
			session.configureAutoCompaction(word);
			expect(session.compactionLimits?.window).toBe(150_000);
		}
		session.configureAutoCompaction("auto");
		expect(session.compactionLimits?.window).toBe(200_000);
		session.configureAutoCompaction("reset");
		expect(session.compactionLimits?.window).toBe(150_000);
	});
	it("keeps a per-model setting after /autocompact reset", async () => {
		const { session } = await createSession({
			autoCompactWindow: 180_000,
			modelSettings: { "claude-sonnet-4-5": { autoCompactWindow: 130_000 } },
		});
		session.configureAutoCompaction("120k");
		session.configureAutoCompaction("reset");
		expect(session.compactionLimits?.window).toBe(130_000);
	});
	it("configures auto-compaction windows without treating the command as an enable toggle", async () => {
		const { session } = await createSession();
		expect(session.configureAutoCompaction()).toContain("200000");
		expect(session.configureAutoCompaction("120k")).toContain("120000");
		expect(session.compactionLimits?.window).toBe(120_000);
		expect(session.configureAutoCompaction("auto")).toContain("auto");
		expect(session.compactionLimits?.window).toBe(200_000);
		expect(session.configureAutoCompaction("on")).toContain("Expected");
		expect(session.autoCompactionEnabled).toBe(true);
	});
	it("does not let a session toggle bypass operator environment disables", async () => {
		const { session } = await createSession({}, [], { DISABLE_AUTO_COMPACT: "1" });
		session.setAutoCompactionEnabled(true);
		expect(session.autoCompactionEnabled).toBe(false);
		await session.prompt("manual is allowed");
		await session.compact();
	});
	it("retries a summary overflow after dropping an API round", async () => {
		const { session, requests } = await createSession({}, [
			{ text: "one reply" },
			{ text: "two reply" },
			{ error: "prompt is too long: 210000 tokens > 200000 maximum" },
			{ text: "recovered checkpoint" },
		]);
		await session.prompt("oldest task");
		await session.prompt("recent task");
		const result = await session.compact();
		expect(result.summary).toBe("recovered checkpoint");
		expect(text(requests[3])).toContain("[earlier conversation truncated for compaction retry]");
		expect(text(requests[3])).not.toContain("oldest task");
	});
	it("uses a separate cold summary request without live system sections or tools", async () => {
		const { session, requests } = await createSession({}, [], { CLAUDE_CODE_COLD_COMPACT: "1" });
		await session.prompt("cold history");
		await session.compact();
		expect(getCurrentSystemMessage(requests[1])?.sections).toBeUndefined();
		expect(getCurrentSystemMessage(requests[1])?.toolsAdded).toBeUndefined();
		expect(text(requests[1])).toContain("cold history");
	});
	it("stops after three failed summaries but leaves manual recovery available", async () => {
		const { session, events } = await createSession({}, [
			{ tokens: 170_000 },
			...Array.from({ length: 3 }, () => [{ error: "checkpoint rejected" }, { tokens: 170_000 }]).flat(),
		]);
		for (let i = 0; i < 5; i++) await session.prompt(`task ${i}`);
		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(3);
		expect(session.autoCompactionEnabled).toBe(false);
		await session.compact();
		expect(session.autoCompactionEnabled).toBe(true);
	});
	it("stops after three rapid refills without blocking a manual compact", async () => {
		const { session, events } = await createSession({}, [
			{ tokens: 170_000 },
			...Array.from({ length: 3 }, () => [{ text: "checkpoint" }, { tokens: 170_000 }]).flat(),
		]);
		for (let i = 0; i < 5; i++) await session.prompt(`task ${i}`);
		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(3);
		expect(session.autoCompactionEnabled).toBe(false);
		await session.compact();
		expect(session.autoCompactionEnabled).toBe(true);
	});
	it("truncates complete API rounds for a prompt-too-long summary retry", async () => {
		const { session } = await createSession();
		await session.prompt("one");
		await session.prompt("two");
		await session.prompt("three");
		const truncated = truncateCcSummaryHistory(session.messages);
		expect(JSON.stringify(truncated)).not.toContain('"one"');
		expect(JSON.stringify(truncated)).toContain("[earlier conversation truncated for compaction retry]");
		expect(JSON.stringify(truncated)).toContain('"two"');
	});
});

describe("Claude Code local compaction commands", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("ends a failed /compact with an error result frame and a non-zero exit in the SDK host", async () => {
		const { session } = await createSession();
		const { exitCode, results } = await runSdk(session, ["/compact"]);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			subtype: "error_during_execution",
			is_error: true,
			errors: ["Not enough messages to compact."],
			local_command: "compact",
		});
		expect(exitCode).toBe(1);
	});
	it("names a provider failure during /compact and keeps the failed status frame", async () => {
		const { session } = await createSession({}, [{ text: "reply" }, { error: "checkpoint rejected" }]);
		await session.prompt("history");
		const { exitCode, frames, results } = await runSdk(session, ["/compact"]);
		expect(results[0]).toMatchObject({ is_error: true });
		expect(results[0].errors[0]).toContain("Error during compaction:");
		expect(frames.some((frame) => frame.subtype === "status" && frame.compact_result === "failed")).toBe(true);
		expect(exitCode).toBe(1);
	});
	it("reports DISABLE_COMPACT as an error result", async () => {
		const { session } = await createSession({}, [], { DISABLE_COMPACT: "1" });
		const { exitCode, results } = await runSdk(session, ["/compact"]);
		expect(results[0]).toMatchObject({ is_error: true, errors: ["Compaction is disabled by DISABLE_COMPACT"] });
		expect(exitCode).toBe(1);
	});
	it("fails a repeat /compact as not enough messages and still runs the next prompt", async () => {
		const { session } = await createSession({}, [{ text: "reply" }, { text: "CHECKPOINT" }, { text: "after" }]);
		await session.prompt("history");
		const { exitCode, results } = await runSdk(session, ["/compact", "/compact", "continue"]);
		expect(results.map((result) => result.is_error)).toEqual([false, true, false]);
		expect(results[1].errors).toEqual(["Not enough messages to compact."]);
		expect(results[2].result).toBe("after");
		expect(exitCode).toBe(0);
	});
	it("writes a failed /compact to stderr and exits non-zero in text print mode", async () => {
		const { session } = await createSession();
		const { exitCode, stdout, stderr } = await runText(session, ["/compact"]);
		expect(stderr).toBe("Not enough messages to compact.");
		expect(stdout).toBe("");
		expect(exitCode).toBe(1);
	});
	it("prints both local outputs when /compact is followed by /autocompact in text print mode", async () => {
		const { session } = await createSession({}, [{ text: "reply" }, { text: "CHECKPOINT" }]);
		await session.prompt("history");
		const { exitCode, stdout } = await runText(session, ["/compact", "/autocompact 150k"]);
		expect(stdout).toBe("Compacted\nAuto-compact window set to 150000 tokens.\n");
		expect(exitCode).toBe(0);
	});
	it("treats /compact as an ordinary prompt in the SDK host when the session has no CC policy", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("plain reply")]);
			const { results } = await runSdk(harness.session, ["/compact"]);
			expect(results[0]).toMatchObject({ is_error: false, result: "plain reply" });
			expect(results[0].local_command).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
