import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Runs the real request path against a fake fetch to check how often the
// workload identity federation token exchange happens.
// https://github.com/earendil-works/pi/issues/10177

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RecordedRequest {
	path: string;
	authorization: string | null;
}

function createFetch(requests: RecordedRequest[]): typeof globalThis.fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		requests.push({ path, authorization: request.headers.get("authorization") });
		if (path === "/v1/oauth/token") {
			return new Response(JSON.stringify({ access_token: "federated-token", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return sseResponse();
	};
}

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

function tokenGrant(expiresIn: number, token: number): Response {
	return Response.json({ access_token: `federated-token-${token}`, token_type: "Bearer", expires_in: expiresIn });
}

/** Records the bearer each message request carried and how many token exchanges it took. */
function createExchangeFetch(respond: (exchange: number) => Response, tokenDelayMs = 0) {
	const log = { exchanges: 0, bearers: [] as (string | null)[] };
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).pathname === "/v1/oauth/token") {
			log.exchanges += 1;
			if (tokenDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
			return respond(log.exchanges);
		}
		log.bearers.push(request.headers.get("authorization"));
		return sseResponse();
	};
	return { fetch, log };
}

function modelAt(host: string): Model<"anthropic-messages"> {
	return { ...anthropicModel, baseUrl: `https://${host}.example` };
}

/** Lets a background exchange settle, so the next request starts a fresh window instead of joining it. */
function settleBackgroundRefresh(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

let tempDir: string;
let federationEnv: Record<string, string>;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-anthropic-federation-"));
	const identityTokenFile = join(tempDir, "identity.jwt");
	writeFileSync(identityTokenFile, "header.payload.signature");
	federationEnv = {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
		ANTHROPIC_ORGANIZATION_ID: "org-test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
	};
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Anthropic workload identity federation token exchange", () => {
	it("exchanges the identity token once across requests", async () => {
		const requests: RecordedRequest[] = [];
		const fetch = createFetch(requests);

		for (let i = 0; i < 3; i++) {
			const message = await streamAnthropic(anthropicModel, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
		}

		expect(requests.filter((request) => request.path === "/v1/oauth/token")).toHaveLength(1);
		const messageRequests = requests.filter((request) => request.path === "/v1/messages");
		expect(messageRequests).toHaveLength(3);
		for (const request of messageRequests) {
			expect(request.authorization).toBe("Bearer federated-token");
		}
	});

	it("does not exchange a federation token for header-owned auth", async () => {
		for (const [name, value] of Object.entries(federationEnv)) vi.stubEnv(name, value);
		const requests: RecordedRequest[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			headers: { Authorization: "Bearer auth-token" },
			fetch: createFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toEqual([{ path: "/v1/messages", authorization: "Bearer auth-token" }]);
	});

	it("serves the cached token and refreshes it in the background inside the advisory window", async () => {
		const { fetch, log } = createExchangeFetch((exchange) => tokenGrant(60, exchange));
		const model = modelAt("federation-advisory");

		for (let i = 0; i < 3; i++) {
			const message = await streamAnthropic(model, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
			await settleBackgroundRefresh();
		}

		expect(log.exchanges).toBe(3);
		// Each request is served the token minted one window earlier, never the one it waits for.
		expect(log.bearers).toEqual(["Bearer federated-token-1", "Bearer federated-token-1", "Bearer federated-token-2"]);
	});

	it("blocks and mints a new token when less than 30 seconds remain", async () => {
		const { fetch, log } = createExchangeFetch((exchange) => tokenGrant(10, exchange));
		const model = modelAt("federation-mandatory");

		for (let i = 0; i < 2; i++) {
			const message = await streamAnthropic(model, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
		}

		expect(log.exchanges).toBe(2);
		expect(log.bearers).toEqual(["Bearer federated-token-1", "Bearer federated-token-2"]);
	});

	it("shares one exchange between concurrent requests", async () => {
		const { fetch, log } = createExchangeFetch((exchange) => tokenGrant(60, exchange), 20);
		const model = modelAt("federation-concurrent");
		const requests = () =>
			Promise.all(Array.from({ length: 5 }, () => streamAnthropic(model, context, { env: federationEnv, fetch }).result()));

		for (const message of await requests()) expect(message.stopReason).toBe("stop");
		expect(log.exchanges).toBe(1);

		// A second batch inside the advisory window coalesces into one background refresh.
		for (const message of await requests()) expect(message.stopReason).toBe("stop");
		expect(log.exchanges).toBe(2);
	});

	it("backs off a failing background refresh inside the advisory window", async () => {
		const { fetch, log } = createExchangeFetch((exchange) =>
			exchange === 1 ? tokenGrant(60, 1) : Response.json({ error: "server_error" }, { status: 500 }),
		);
		const model = modelAt("federation-advisory-failure");

		for (let i = 0; i < 3; i++) {
			const message = await streamAnthropic(model, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
			await settleBackgroundRefresh();
		}

		expect(log.exchanges).toBe(2);
		expect(log.bearers).toEqual(["Bearer federated-token-1", "Bearer federated-token-1", "Bearer federated-token-1"]);
	});
});
