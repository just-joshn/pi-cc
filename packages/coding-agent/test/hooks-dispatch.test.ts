import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { hookConfigFrom } from "../src/core/hooks/config.ts";
import { HookDispatcher } from "../src/core/hooks/dispatch.ts";
import type { HookStreamItem } from "../src/core/hooks/stream.ts";
import type { CcSettings } from "../src/core/settings/cc/types.ts";

const session = { sessionId: "s1", transcriptPath: "/t.jsonl", cwd: "/w", permissionMode: "default" };

function dispatcher(
	hooks: unknown,
	extra: Record<string, unknown> = {},
	cwd = tmpdir(),
	records: HookStreamItem[] = [],
) {
	const settings = {
		values: extra,
		hooksBySource: { user: hooks },
		policy: { allowManagedHooksOnly: false },
	} as unknown as CcSettings;
	return new HookDispatcher({
		config: hookConfigFrom({ settings }),
		projectDir: cwd,
		cwd: () => cwd,
		session: () => session,
		onRecord: (record) => records.push(record),
	});
}

const cmd = (command: string, extra: Record<string, unknown> = {}) => ({ type: "command", command, ...extra });
const pre = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" };

describe("command hooks", () => {
	const tmp = () => mkdtempSync(join(tmpdir(), "hooks-"));
	test("the payload arrives as one JSON line with the common fields first", async () => {
		const dir = tmp();
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd("cat > payload.json")] }] }, {}, dir);
		await d.run("PreToolUse", pre);
		const payload = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8"));
		expect(payload).toMatchObject({
			session_id: "s1",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "t1",
		});
		expect(Object.keys(payload).slice(0, 3)).toEqual(["session_id", "transcript_path", "cwd"]);
	});

	test("exit 2 blocks and carries stderr, and records start and response", async () => {
		const records: HookStreamItem[] = [];
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd("echo nope >&2; exit 2")] }] }, {}, tmpdir(), records);
		const verdict = await d.run("PreToolUse", pre);
		expect(verdict.blocks[0]).toMatchObject({ reason: "nope", viaExit: true });
		expect(records.map((record) => record.subtype)).toEqual(["hook_started", "hook_response"]);
		expect(records[1]).toMatchObject({ exit_code: 2, outcome: "error", hook_name: "PreToolUse:Bash" });
	});

	test("hooks run in parallel and merge: deny beats allow", async () => {
		const allow = `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })}'`;
		const deny = `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } })}'`;
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd(allow), cmd(deny)] }] });
		const verdict = await d.run("PreToolUse", pre);
		expect(verdict).toMatchObject({ permission: "deny", block: "no" });
	});

	test("equal decisions merge in completion order, not settings order", async () => {
		const deny = (reason: string) =>
			`printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}'`;
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd(`sleep 0.1; ${deny("slow")}`), cmd(deny("fast"))] }] });
		const verdict = await d.run("PreToolUse", pre);
		expect(verdict.permissionReason).toBe("slow");
		expect(verdict.blocks.map((block) => block.reason)).toEqual(["fast", "slow"]);
	});

	test("a hook that overruns its timeout is killed and reported without blocking", async () => {
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd("sleep 5", { timeout: 0.2 })] }] });
		const started = Date.now();
		const verdict = await d.run("PreToolUse", pre);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(verdict.block).toBeUndefined();
		expect(verdict.errors[0]).toContain("timed out");
	});

	test("background hooks do not delay a decision and are cancelled at session shutdown", async () => {
		const records: HookStreamItem[] = [];
		const d = dispatcher({ Stop: [{ hooks: [cmd("exec sleep 5", { async: true })] }] }, {}, tmpdir(), records);
		await d.run("Stop", { stop_hook_active: false });
		expect(records.map((record) => record.subtype)).toEqual(["hook_started"]);
		d.cancelBackground();
		await expect.poll(() => records.at(-1)).toMatchObject({ subtype: "hook_response", outcome: "cancelled" });
	});

	test("once is ignored for a settings hook: it runs every time", async () => {
		const dir = tmp();
		const d = dispatcher({ PreToolUse: [{ hooks: [cmd("echo x >> n.txt", { once: true })] }] }, {}, dir);
		await d.run("PreToolUse", pre);
		await d.run("PreToolUse", pre);
		expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("x\nx\n");
	});

	test("an if rule the call does not match skips the hook", async () => {
		const settings = {
			values: {},
			hooksBySource: { user: { PreToolUse: [{ hooks: [cmd("echo x >> n.txt", { if: "Bash(git *)" })] }] } },
			policy: { allowManagedHooksOnly: false },
		} as unknown as CcSettings;
		const dir = tmp();
		const d = new HookDispatcher({
			config: hookConfigFrom({ settings }),
			projectDir: dir,
			cwd: () => dir,
			session: () => session,
			callMatches: () => false,
		});
		await d.run("PreToolUse", pre);
		expect(() => readFileSync(join(dir, "n.txt"))).toThrow();
	});
});

describe("http hooks", () => {
	const received: { headers: IncomingHttpHeaders; body: string }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			received.push({ headers: request.headers, body });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "HTTP_NO",
					},
				}),
			);
		});
	});
	let url = "";
	const listening = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => {
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/h`;
	});
	afterEach(() => {
		received.length = 0;
	});
	afterAll(() => {
		server.close();
	});

	test("posts the payload, interpolates only allowed variables, and reads the JSON answer", async () => {
		await listening;
		process.env.PROBE_ALLOWED = "yes";
		process.env.PROBE_DENIED = "no";
		const d = dispatcher({
			PreToolUse: [
				{
					hooks: [
						{
							type: "http",
							url,
							headers: { "X-Probe": "$PROBE_ALLOWED-$PROBE_DENIED" },
							allowedEnvVars: ["PROBE_ALLOWED"],
						},
					],
				},
			],
		});
		const verdict = await d.run("PreToolUse", pre);
		expect(verdict.block).toBe("HTTP_NO");
		expect(received[0]?.headers["x-probe"]).toBe("yes-");
		expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({ tool_name: "Bash" });
	});

	test("httpHookAllowedEnvVars caps what a hook may interpolate", async () => {
		await listening;
		process.env.PROBE_OTHER = "other";
		const d = dispatcher(
			{
				PreToolUse: [
					{
						hooks: [
							{
								type: "http",
								url,
								headers: { "X-Probe": "$PROBE_ALLOWED-$PROBE_OTHER" },
								allowedEnvVars: ["PROBE_ALLOWED", "PROBE_OTHER"],
							},
						],
					},
				],
			},
			{ httpHookAllowedEnvVars: ["PROBE_ALLOWED"] },
		);
		await d.run("PreToolUse", pre);
		expect(received[0]?.headers["x-probe"]).toBe("yes-");
	});

	test("allowedHttpHookUrls refuses a URL that matches no pattern, without sending", async () => {
		await listening;
		const d = dispatcher(
			{ PreToolUse: [{ hooks: [{ type: "http", url }] }] },
			{ allowedHttpHookUrls: ["http://example.invalid/*"] },
		);
		const verdict = await d.run("PreToolUse", pre);
		expect(received).toHaveLength(0);
		expect(verdict.errors[0]).toContain("does not match any pattern in allowedHttpHookUrls");
	});
});
