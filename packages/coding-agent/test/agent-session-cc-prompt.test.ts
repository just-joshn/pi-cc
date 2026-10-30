import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getModel,
	type Model,
	type SystemMessage,
	type TranscriptMessages,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { buildCcPolicy } from "../src/core/cc-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function reply(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

interface Request {
	model: Model<any>;
	head: SystemMessage | undefined;
	messages: unknown[];
}

describe("AgentSession Claude Code prompt record", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function createSession(options: {
		flags?: Parameters<typeof buildCcPolicy>[0]["flags"];
		append: { current: string[] };
		failures?: number;
	}) {
		const requests: Request[] = [];
		const model = getModel("anthropic", "claude-opus-5-5")!;
		let failuresLeft = options.failures ?? 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "medium" },
			streamFn: (requestModel, context) => {
				requests.push({
					model: requestModel,
					head: getCurrentSystemMessage(context.messages as TranscriptMessages),
					messages: context.messages,
				});
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const failing = failuresLeft > 0;
					if (failing) failuresLeft--;
					const message = failing
						? reply("", { stopReason: "error", errorMessage: "overloaded_error" })
						: reply("ok");
					stream.push({ type: "start", partial: message });
					stream.push(
						failing
							? { type: "error", reason: "error", error: message }
							: { type: "done", reason: "stop", message },
					);
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 1000 },
		});
		const loader = {
			...createTestResourceLoader(),
			getAppendSystemPrompt: () => options.append.current,
		};
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: loader,
			ccPolicy: buildCcPolicy({ entrypoint: "sdk-cli", customPrompt: false, flags: options.flags ?? {} }),
		});
		return { session, requests };
	}

	it("records identity, working and context once, and replays them verbatim on every later turn", async () => {
		const append = { current: ["FIRST APPEND"] };
		const { requests } = await createSession({ append });

		await session.prompt("one");
		append.current = ["SECOND APPEND"];
		session.setActiveToolsByName(session.getActiveToolNames());
		await session.prompt("two");

		const [first, second] = requests;
		expect(first.head?.sections?.working).toContain("FIRST APPEND");
		expect(Object.keys(first.head?.sections ?? {}).sort()).toEqual(["dynamic", "identity", "working"]);
		expect(first.head?.context).toContain("# Environment");
		expect(second.head?.sections).toEqual(first.head?.sections);
		expect(second.head?.context).toBe(first.head?.context);
		expect(session.messages.filter((message) => message.role === "system" && message.sections)).toHaveLength(1);
	});

	it("renders the prompt fresh for each request when snapshots are off", async () => {
		const append = { current: ["FIRST APPEND"] };
		const { requests } = await createSession({ append, flags: { systemPromptSnapshot: "off" } });

		await session.prompt("one");
		append.current = ["SECOND APPEND"];
		session.setActiveToolsByName(session.getActiveToolNames());
		await session.prompt("two");

		expect(requests[0].head?.sections?.working).toContain("FIRST APPEND");
		expect(requests[1].head?.sections?.working).toContain("SECOND APPEND");
		const recorded = getCurrentSystemMessage(session.messages);
		expect(recorded?.sections?.working).toContain("FIRST APPEND");
	});

	it("moves the session-specific part into the first user message under exclude-dynamic", async () => {
		const { requests } = await createSession({
			append: { current: [] },
			flags: { excludeDynamicSystemPromptSections: true },
		});

		await session.prompt("one");

		const sent = requests[0];
		expect(sent.head?.sections?.dynamic).toBeUndefined();
		expect(sent.head?.context).toContain("# Environment");
		const user = sent.messages.find((message) => (message as { role: string }).role === "user") as {
			content: Array<{ text: string }>;
		};
		expect(user.content[0].text).toMatch(/^<system-reminder>\n# This session/);
		expect(user.content.at(-1)?.text).toBe("one");
		expect(getCurrentSystemMessage(session.messages)?.sections?.dynamic).toContain("# This session");
	});

	it("walks the fallback chain on each failed attempt and returns to the primary on the next turn", async () => {
		const { requests } = await createSession({
			append: { current: [] },
			flags: { fallbackModel: "claude-probe-fb-one,claude-probe-fb-two" },
			failures: 2,
		});

		await session.prompt("one");
		await session.prompt("two");

		expect(requests.map((request) => request.model.id)).toEqual([
			"claude-opus-5-5",
			"claude-probe-fb-one",
			"claude-probe-fb-two",
			"claude-opus-5-5",
		]);
	});

	it("carries a freshly assembled record in the compaction entry", async () => {
		const append = { current: ["FIRST APPEND"] };
		await createSession({ append });
		await session.prompt("one");
		append.current = ["AFTER COMPACTION"];
		session.setActiveToolsByName(session.getActiveToolNames());

		const record = (
			session as unknown as { _compactionPromptRecord(): SystemMessage | undefined }
		)._compactionPromptRecord();

		expect(record?.sections?.working).toContain("AFTER COMPACTION");
		expect(record?.sections?.dynamic).toBeDefined();
	});

	it("replays the record a compaction entry carries instead of the earlier prompt", () => {
		const manager = SessionManager.inMemory();
		const record = (text: string): SystemMessage => ({
			role: "system",
			content: "",
			sections: { identity: text, working: text },
			context: text,
			timestamp: Date.now(),
		});
		manager.appendMessage(record("before"));
		const kept = manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendCompaction("summary", kept, 100, undefined, false, undefined, record("after"));

		const head = getCurrentSystemMessage(manager.buildSessionProjection().messages);

		expect(head?.sections).toEqual({ identity: "after", working: "after" });
		expect(head?.context).toBe("after");
	});

	it("treats the thinking level as the operator's only once it changes", async () => {
		await createSession({ append: { current: [] } });
		expect(session.thinkingLevelChosen).toBe(false);

		session.setThinkingLevel(session.thinkingLevel);
		expect(session.thinkingLevelChosen).toBe(false);

		session.setThinkingLevel("low");
		expect(session.thinkingLevelChosen).toBe(true);
	});
});
