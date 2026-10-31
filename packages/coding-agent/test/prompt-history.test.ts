import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptHistoryStore } from "../src/core/prompt-history.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const path = () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
	dirs.push(dir);
	return join(dir, "history.jsonl");
};

describe("native persistent prompt history", () => {
	it("skips consecutive plain duplicates only in the same session scope", () => {
		const file = path();
		let scope = "project-a/session-a";
		const store = new PromptHistoryStore(file, () => scope);
		const plain = { text: "same prompt", pastes: new Map<number, string>() };
		store.append(plain);
		store.append(plain);
		expect(store.read()).toHaveLength(1);
		scope = "project-b/session-b";
		store.append(plain);
		expect(store.read()).toHaveLength(2);
		const pasted = { text: "review [paste #1 4 chars]", pastes: new Map([[1, "data"]]) };
		store.append(pasted);
		store.append(pasted);
		expect(store.read()).toHaveLength(4);
		store.append(plain);
		expect(store.read()).toHaveLength(5);
	});

	it("keeps plain pasted prompts but drops pasted slash and bash prompts", () => {
		const store = new PromptHistoryStore(path());
		store.append({ text: "review [paste #1 4 chars]", pastes: new Map([[1, "data"]]) });
		for (const prefix of ["/command ", "!"])
			store.append({ text: `${prefix}[paste #1 4 chars]`, pastes: new Map([[1, "data"]]) });
		store.append({ text: "/command without pastes", pastes: new Map() });
		store.append({ text: "[paste #1 4 chars]", pastes: new Map([[1, "data"]]) });
		expect(store.read()).toEqual([
			{ text: "/command without pastes", pastes: new Map() },
			{ text: "review [paste #1 4 chars]", pastes: new Map([[1, "data"]]) },
		]);
	});

	it("honors the prompt-history privacy opt-out", () => {
		vi.stubEnv("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "true");
		const store = new PromptHistoryStore(path());
		store.append({ text: "private", pastes: new Map() });
		expect(store.read()).toEqual([]);
	});
	it("reads earlier runs newest first and retains pasted contents", () => {
		const file = path();
		new PromptHistoryStore(file).append({ text: "older", pastes: new Map() });
		new PromptHistoryStore(file).append({
			text: "summarize [paste #1 +12 lines]",
			pastes: new Map([[1, "line\n".repeat(12)]]),
		});
		expect(new PromptHistoryStore(file).read()).toEqual([
			{ text: "summarize [paste #1 +12 lines]", pastes: new Map([[1, "line\n".repeat(12)]]) },
			{ text: "older", pastes: new Map() },
		]);
	});

	it("keeps valid records around malformed lines and missing files are empty", () => {
		const file = path();
		expect(new PromptHistoryStore(file).read()).toEqual([]);
		writeFileSync(file, '{"text":"valid","pastes":[]}\nnot json\n{"text":2,"pastes":[]}\n');
		expect(new PromptHistoryStore(file).read()).toEqual([{ text: "valid", pastes: new Map() }]);
	});
});
