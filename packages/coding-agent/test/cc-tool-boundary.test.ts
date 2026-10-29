/**
 * The six ways the internal rename broke ordinary pi use. Each one loads a pi example, or reads a
 * pi subsystem, through the built CLI and the mock model. They fail on the commit that put Claude
 * Code's names inside pi, and pass once those names stay at the model boundary.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMockServer } from "../conformance/mock/messages.ts";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(REPO, "packages/coding-agent/dist/bundle/cli.js");
const EXAMPLES = join(REPO, "packages/coding-agent/examples/extensions");

interface Probe {
	argv: string[];
	files?: Record<string, string>;
	agentFiles?: Record<string, string>;
	settings?: Record<string, unknown>;
	turns: Array<{ tool_use?: { name: string; input: Record<string, unknown> }; text?: string }>;
}

interface ProbeResult {
	workspace: string;
	agentDir: string;
	declared: Array<{ name: string; defer_loading?: boolean }>;
	system: string;
	results: Array<{ name: string; input: Record<string, unknown>; text: string; isError: boolean }>;
	stream: string;
}

async function probe(spec: Probe): Promise<ProbeResult> {
	const root = join(tmpdir(), `pi-cc-boundary-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const workspace = join(root, "ws");
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(join(root, "tmp"), { recursive: true });
	for (const [path, content] of Object.entries(spec.files ?? {})) {
		mkdirSync(join(workspace, path, ".."), { recursive: true });
		writeFileSync(join(workspace, path), content);
	}
	for (const [path, content] of Object.entries(spec.agentFiles ?? {})) {
		mkdirSync(join(agentDir, path, ".."), { recursive: true });
		writeFileSync(join(agentDir, path), content);
	}
	const out = join(root, "out");
	mkdirSync(out, { recursive: true });
	const mock = await startMockServer({
		turns: [...spec.turns, { text: "PROBE_DONE" }] as never,
		outDir: out,
	});
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: "x" } } }),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5", ...(spec.settings ?? {}) }),
	);
	const child = spawn(process.execPath, [CLI, ...spec.argv], {
		cwd: workspace,
		env: {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
			HOME: home,
			TMPDIR: join(root, "tmp"),
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: agentDir,
			NO_COLOR: "1",
			TERM: "dumb",
		},
	});
	child.stdin.end();
	let stream = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stream += chunk.toString("utf-8");
	});
	await new Promise((resolve) => child.on("close", resolve));
	await mock.close();
	const requests = mock.requests.filter(
		(request) => request.path.startsWith("/v1/messages") && !request.path.includes("count"),
	);
	const body = requests.at(-1)?.body as { messages?: Array<{ content?: unknown }>; system?: unknown } | undefined;
	const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
	const results: ProbeResult["results"] = [];
	for (const message of body?.messages ?? []) {
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks as Array<Record<string, unknown>>) {
			if (block.type === "tool_use")
				uses.set(String(block.id), { name: String(block.name), input: block.input as Record<string, unknown> });
			if (block.type === "tool_result") {
				const call = uses.get(String(block.tool_use_id));
				const content = block.content;
				const text = Array.isArray(content)
					? content
							.map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
							.join("")
					: String(content ?? "");
				results.push({ name: call?.name ?? "", input: call?.input ?? {}, text, isError: block.is_error === true });
			}
		}
	}
	const system = JSON.stringify((requests[0]?.body as { system?: unknown } | undefined)?.system ?? "");
	return {
		workspace,
		agentDir,
		declared: (requests[0]?.body as { tools?: ProbeResult["declared"] } | undefined)?.tools ?? [],
		system,
		results,
		stream,
	};
}

describe("pi tool identity stays inside the process", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	it("keeps name-keyed safety extensions matching the tool that ran", async () => {
		const result = await probe({
			argv: ["-p", "go", "-e", join(EXAMPLES, "permission-gate.ts"), "-e", join(EXAMPLES, "protected-paths.ts")],
			files: { "victim/a.txt": "a", ".env": "SECRET=1\n" },
			turns: [
				{ tool_use: { name: "Bash", input: { command: "rm -rf victim" } } },
				{ tool_use: { name: "Write", input: { file_path: ".env", content: "pwned\n" } } },
			],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.results[0]?.text).toContain("Dangerous command blocked");
		expect(result.results[1]?.text).toContain("is protected");
		expect(readFileSync(join(result.workspace, ".env"), "utf-8")).toBe("SECRET=1\n");
		expect(readFileSync(join(result.workspace, "victim/a.txt"), "utf-8")).toBe("a");
	});

	it("serves an extension override of read when the model calls Read", async () => {
		const result = await probe({
			argv: ["-p", "go", "-e", join(EXAMPLES, "tool-override.ts")],
			files: { ".env": "SECRET=1\n" },
			turns: [{ tool_use: { name: "Read", input: { file_path: ".env" } } }],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.results[0]?.text).toContain("Access denied");
		expect(readFileSync(join(result.agentDir, "read-access.log"), "utf-8")).toContain("BLOCKED");
	});

	it("projects defaultTools read and grep to Read, the placeholder, and grep", async () => {
		const result = await probe({
			argv: ["-p", "go"],
			settings: { defaultTools: ["read", "grep"] },
			turns: [],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.declared.map((tool) => tool.name)).toEqual(["Read", "DeferredToolPlaceholder", "grep"]);
		expect(result.declared.find((tool) => tool.name === "DeferredToolPlaceholder")?.defer_loading).toBe(true);
	});

	it("keeps skills in the system prompt, because read is still declared internally", async () => {
		const result = await probe({
			argv: ["-p", "go"],
			agentFiles: {
				"skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: Demo skill.\n---\n# Demo\n",
			},
			turns: [],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.system).toContain("available_skills");
		expect(result.system).toContain("demo-skill");
	});

	it("records a model Read under pi's name, so compaction still sees the file", async () => {
		const result = await probe({
			argv: ["-p", "go", "--output-format", "stream-json", "--verbose"],
			files: { "a.ts": "export const n = 1;\n" },
			turns: [{ tool_use: { name: "Read", input: { file_path: "a.ts" } } }],
		});
		roots.push(join(result.workspace, ".."));
		const recorded = result.stream
			.split("\n")
			.map((line) => {
				try {
					return JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				} catch {
					return undefined;
				}
			})
			.find((event) => event?.type === "message_end" && event.message?.role === "assistant");
		const call = (
			recorded?.message?.content as
				| Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>
				| undefined
		)?.find((block) => block.type === "toolCall");
		expect(call?.name).toBe("read");
		expect(call?.arguments).toMatchObject({ path: "a.ts" });
		const ops = createFileOps();
		extractFileOpsFromMessage({ role: "assistant", content: [call] } as never, ops);
		expect(computeFileLists(ops).readFiles).toEqual(["a.ts"]);
	});

	it("refuses a non-unique fuzzy edit instead of rewriting the first block", async () => {
		const result = await probe({
			argv: ["-p", "go"],
			files: { "fuzzy.txt": "foo  \nx\nfoo \nx\n" },
			turns: [
				{
					tool_use: {
						name: "Edit",
						input: { file_path: "fuzzy.txt", old_string: "foo\nx", new_string: "BAR\nx" },
					},
				},
			],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.results[0]?.text).toContain("String to replace not found");
		expect(readFileSync(join(result.workspace, "fuzzy.txt"), "utf-8")).toBe("foo  \nx\nfoo \nx\n");
	});

	it("returns every line of a 2500-line file, with no false truncation notice", async () => {
		const body = `${Array.from({ length: 2500 }, (_, index) => `line${index + 1}`).join("\n")}\n`;
		const result = await probe({
			argv: ["-p", "go"],
			files: { "big.txt": body },
			turns: [{ tool_use: { name: "Read", input: { file_path: "big.txt" } } }],
		});
		roots.push(join(result.workspace, ".."));
		expect(result.results[0]?.text.startsWith("1\tline1\n")).toBe(true);
		expect(result.results[0]?.text.endsWith("2500\tline2500\n2501\t")).toBe(true);
		expect(result.results[0]?.text).not.toContain("PARTIAL view");
	});
});
