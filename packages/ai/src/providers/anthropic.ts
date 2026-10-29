import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import {
	ANTHROPIC_API_KEY_ENV,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderEnv } from "../types.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";
import { readAnthropicEnvironment } from "./anthropic-env.ts";

function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return {
					auth: { apiKey: credential.key },
					env: credential.env,
					source: "stored credential",
					sourceKind: "stored",
				};
			}

			// Claude Code sends the bearer and the key together when both variables are set, so the bearer
			// rides along with whichever key source answers. ANTHROPIC_OAUTH_TOKEN alone does not disable a
			// stored credential. The pinned 2.1.312 sends the stored one.
			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			const bearer = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
			const oauthToken = await ctx.env(ANTHROPIC_OAUTH_TOKEN_ENV);
			signal.throwIfAborted();
			const apiKey = await ctx.env(ANTHROPIC_API_KEY_ENV);
			signal.throwIfAborted();
			const key = oauthToken || apiKey;
			if (key) {
				const source = bearer
					? ANTHROPIC_AUTH_TOKEN_ENV
					: oauthToken
						? ANTHROPIC_OAUTH_TOKEN_ENV
						: ANTHROPIC_API_KEY_ENV;
				return {
					auth: { apiKey: key, ...(bearer ? { headers: bearer } : {}) },
					source,
					sourceKind: bearer || apiKey ? "environment" : "oauth-token",
				};
			}
			if (bearer) {
				return { auth: { headers: bearer }, source: ANTHROPIC_AUTH_TOKEN_ENV, sourceKind: "environment" };
			}

			// Workload identity federation: the Anthropic SDK exchanges the identity
			// token for a short-lived access token and refreshes it itself. Last in
			// line so keys and ANTHROPIC_AUTH_TOKEN keep winning, as in the SDK. The
			// ids are provider config rather than auth, so they travel in `env`.
			const federation: ProviderEnv = {};
			for (const envVar of [
				ANTHROPIC_FEDERATION_RULE_ID_ENV,
				ANTHROPIC_ORGANIZATION_ID_ENV,
				ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
			]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (!value) return undefined;
				federation[envVar] = value;
			}
			for (const envVar of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) federation[envVar] = value;
			}
			return {
				auth: {},
				env: federation,
				source: "workload identity federation",
				sourceKind: "environment",
			};
		},
	};
}

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: anthropicApiKeyAuth(),
			oauth: lazyOAuth({
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
				load: loadAnthropicOAuth,
			}),
			environment: readAnthropicEnvironment,
			// An auth token or an API key disables a stored credential. ANTHROPIC_OAUTH_TOKEN does not.
			environmentFirst: true,
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
