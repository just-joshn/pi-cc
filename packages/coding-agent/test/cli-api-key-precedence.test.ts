import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const CLI_KEY = "cli-key";
const ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
] as const;

describe("CLI --api-key and a quiet environment", () => {
	const roots: string[] = [];
	const saved = new Map<string, string | undefined>();

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function isolateEnv(extra: Record<string, string> = {}): void {
		for (const key of ENV_KEYS) {
			if (!saved.has(key)) saved.set(key, process.env[key]);
			delete process.env[key];
		}
		for (const [key, value] of Object.entries(extra)) process.env[key] = value;
	}

	async function runtime(files: { auth?: unknown; models?: unknown }): Promise<ModelRuntime> {
		const root = mkdtempSync(join(tmpdir(), "pi-cc-cli-key-"));
		roots.push(root);
		const auth = AuthStorage.create(join(root, "auth.json"));
		if (files.auth) await auth.modify("anthropic", async () => files.auth as never);
		if (files.models) {
			writeFileSync(join(root, "models.json"), `${JSON.stringify(files.models)}\n`);
		}
		const created = await ModelRuntime.create({
			credentials: auth,
			modelsPath: files.models ? join(root, "models.json") : null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		await created.setRuntimeApiKey("anthropic", CLI_KEY);
		return created;
	}

	it.each([
		["ANTHROPIC_AUTH_TOKEN", { ANTHROPIC_AUTH_TOKEN: "env-bearer" }],
		["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "env-key" }],
	])("sends the CLI key when %s is set", async (_name, env) => {
		isolateEnv(env);
		const modelRuntime = await runtime({});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe(CLI_KEY);
		expect(result?.auth.headers?.Authorization).toBeUndefined();
	});

	it("sends the CLI key when models.json has an apiKey", async () => {
		isolateEnv();
		const modelRuntime = await runtime({
			models: { providers: { anthropic: { apiKey: "models-json-key" } } },
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe(CLI_KEY);
	});

	it("lets an env token beat a stored OAuth token and a models.json key", async () => {
		isolateEnv({ ANTHROPIC_AUTH_TOKEN: "env-bearer" });
		const modelRuntime = await ModelRuntime.create({
			credentials: await stored("oauth"),
			modelsPath: modelsPath({ providers: { anthropic: { apiKey: "models-json-key" } } }),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBeUndefined();
		expect(result?.auth.headers?.Authorization).toBe("Bearer env-bearer");
	});

	it("sends ANTHROPIC_API_KEY rather than an OAuth token with a stored key and models.json endpoint", async () => {
		isolateEnv({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env" });
		const modelRuntime = await ModelRuntime.create({
			credentials: await stored("api_key"),
			modelsPath: modelsPath({ providers: { anthropic: { baseUrl: "https://gateway.example" } } }),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe("env-key");
		expect(result?.auth.headers?.Authorization).toBeUndefined();
	});

	it("sends a models.json key rather than a lone OAuth token", async () => {
		isolateEnv({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-env" });
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: modelsPath({ providers: { anthropic: { apiKey: "models-json-key" } } }),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe("models-json-key");
	});

	it("keeps a stored OAuth token over a models.json key when no Anthropic env credential is set", async () => {
		isolateEnv();
		const modelRuntime = await ModelRuntime.create({
			credentials: await stored("oauth"),
			modelsPath: modelsPath({ providers: { anthropic: { apiKey: "models-json-key" } } }),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe("stored-oauth");
	});

	it("keeps a stored api key over a models.json key when no Anthropic env credential is set", async () => {
		isolateEnv();
		const modelRuntime = await ModelRuntime.create({
			credentials: await stored("api_key"),
			modelsPath: modelsPath({ providers: { anthropic: { apiKey: "models-json-key" } } }),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		const result = await modelRuntime.getAuth("anthropic");

		expect(result?.auth.apiKey).toBe("stored-api-key");
	});

	function modelsPath(body: unknown): string {
		const root = mkdtempSync(join(tmpdir(), "pi-cc-cli-key-"));
		roots.push(root);
		const path = join(root, "models.json");
		writeFileSync(path, `${JSON.stringify(body)}\n`);
		return path;
	}

	async function stored(kind: "oauth" | "api_key"): Promise<AuthStorage> {
		const auth = AuthStorage.inMemory();
		await auth.modify("anthropic", async () =>
			kind === "oauth"
				? { type: "oauth", access: "stored-oauth", refresh: "refresh", expires: Date.now() + 3_600_000 }
				: { type: "api_key", key: "stored-api-key" },
		);
		return auth;
	}
});
