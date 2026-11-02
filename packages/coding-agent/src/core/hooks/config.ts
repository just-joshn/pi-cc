/**
 * Hook configuration: the `hooks` settings value of every tier parsed into typed handlers, and the
 * switches that decide which of them may run.
 */

import type { CcSettings, CcSettingsSource } from "../settings/cc/types.ts";
import { type HookEvent, isHookEvent } from "./events.ts";

/** Claude Code's default hook timeout, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000;
/** setTimeout fires at once beyond 2^31-1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type FailureMode = "continue" | "block";

interface HandlerCommon {
	readonly timeoutMs: number;
	readonly statusMessage?: string;
	readonly onFailure: FailureMode;
	/** A permission rule such as `Bash(git *)` the tool call must match for the hook to run. */
	readonly filter?: string;
}

export interface CommandHandler extends HandlerCommon {
	readonly type: "command";
	readonly command: string;
	/** Exec form: `command` is the program and these are its arguments, with no shell. */
	readonly args?: readonly string[];
	readonly async: boolean;
}

export interface HttpHandler extends HandlerCommon {
	readonly type: "http";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly allowedEnvVars: readonly string[];
}

export type HookHandler = CommandHandler | HttpHandler;

export interface HookGroup {
	readonly matcher: string | undefined;
	readonly handlers: readonly HookHandler[];
	readonly source: CcSettingsSource;
}

export interface HookSwitches {
	/** `disableAllHooks`, or `--bare`. */
	readonly disabled: boolean;
	/** `allowManagedHooksOnly`: only the policy tier's hooks run. */
	readonly managedOnly: boolean;
	/** `allowedHttpHookUrls`: when set, an http hook runs only against a matching URL. */
	readonly allowedHttpUrls: readonly string[] | undefined;
	/** `httpHookAllowedEnvVars`: when set, caps the variables an http hook may interpolate. */
	readonly httpEnvVarCap: readonly string[] | undefined;
}

export interface HookConfig {
	readonly groups: Readonly<Partial<Record<HookEvent, readonly HookGroup[]>>>;
	readonly switches: HookSwitches;
	/** Why entries were skipped, in the words the loader reports. */
	readonly warnings: readonly string[];
}

export const NO_HOOKS: HookConfig = {
	groups: {},
	switches: { disabled: false, managedOnly: false, allowedHttpUrls: undefined, httpEnvVarCap: undefined },
	warnings: [],
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;

function timeoutMs(raw: Json): number {
	const seconds = raw.timeout;
	return typeof seconds === "number" && seconds > 0
		? Math.min(seconds * 1000, MAX_TIMEOUT_MS)
		: DEFAULT_HOOK_TIMEOUT_MS;
}

function common(raw: Json): HandlerCommon {
	return {
		timeoutMs: timeoutMs(raw),
		onFailure: raw.onFailure === "block" ? "block" : "continue",
		...(nonEmpty(raw.statusMessage) ? { statusMessage: raw.statusMessage } : {}),
		...(nonEmpty(raw.if) ? { filter: raw.if } : {}),
	};
}

function parseHandler(raw: unknown): HookHandler | string {
	if (!isObject(raw)) return "Hook entry must be an object";
	const type = raw.type;
	if (type === "command" && nonEmpty(raw.command)) {
		const args = strings(raw.args);
		return { type, command: raw.command, ...(args ? { args } : {}), async: raw.async === true, ...common(raw) };
	}
	if (type === "http" && nonEmpty(raw.url)) {
		const headers = isObject(raw.headers)
			? Object.fromEntries(
					Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				)
			: {};
		return { type, url: raw.url, headers, allowedEnvVars: strings(raw.allowedEnvVars) ?? [], ...common(raw) };
	}
	if (typeof type !== "string") return 'Hook entry has no "type"';
	return `Unsupported hook type "${type}"`;
}

function parseGroups(raw: unknown, source: CcSettingsSource, where: string, warnings: string[]): HookGroup[] {
	if (!Array.isArray(raw)) {
		warnings.push(`${where}: expected an array of matcher groups`);
		return [];
	}
	return raw.flatMap((group, index): HookGroup[] => {
		const at = `${where}[${index}]`;
		if (!isObject(group) || !Array.isArray(group.hooks)) {
			warnings.push(`${at}: expected { matcher, hooks: [] }`);
			return [];
		}
		const handlers = group.hooks.flatMap((entry): HookHandler[] => {
			const parsed = parseHandler(entry);
			if (typeof parsed === "string") {
				warnings.push(`${at}: ${parsed}`);
				return [];
			}
			return [parsed];
		});
		if (handlers.length === 0) return [];
		return [{ matcher: typeof group.matcher === "string" ? group.matcher : undefined, handlers, source }];
	});
}

/** The tiers in the order their hooks run: the merged value concatenates arrays tier by tier. */
const TIER_ORDER: readonly CcSettingsSource[] = ["user", "project", "local", "flag", "policy"];

export interface HookConfigInput {
	readonly settings: CcSettings;
	/** `--bare` runs without hooks. */
	readonly bare?: boolean;
}

export function hookConfigFrom(input: HookConfigInput): HookConfig {
	const { settings } = input;
	const values = settings.values;
	const warnings: string[] = [];
	const groups: Partial<Record<HookEvent, HookGroup[]>> = {};
	for (const source of TIER_ORDER) {
		const tier = settings.hooksBySource[source];
		if (!isObject(tier)) continue;
		for (const [name, raw] of Object.entries(tier)) {
			if (!isHookEvent(name)) {
				warnings.push(`hooks.${name}: unknown hook event`);
				continue;
			}
			const parsed = parseGroups(raw, source, `hooks.${name}`, warnings);
			if (parsed.length > 0) groups[name] = [...(groups[name] ?? []), ...parsed];
		}
	}
	return {
		groups,
		warnings,
		switches: {
			disabled: input.bare === true || values.disableAllHooks === true,
			managedOnly: settings.policy.allowManagedHooksOnly,
			allowedHttpUrls: strings(values.allowedHttpHookUrls),
			httpEnvVarCap: strings(values.httpHookAllowedEnvVars),
		},
	};
}

/** The groups that may run for an event under the switches. */
export function activeGroups(config: HookConfig, event: HookEvent): readonly HookGroup[] {
	if (config.switches.disabled) return [];
	const groups = config.groups[event] ?? [];
	return config.switches.managedOnly ? groups.filter((group) => group.source === "policy") : groups;
}

/** Whether any hook is configured for the event, whatever the switches say about running it. */
export function hasHooksFor(config: HookConfig, event: HookEvent): boolean {
	return (config.groups[event] ?? []).length > 0;
}
