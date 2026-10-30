/** Projects a pi tool call onto the names and fields rules are written against. */

import { ccToolNameFor } from "../tools/cc-surface.ts";
import type { PermissionCall } from "./tool-checks.ts";

/**
 * pi runs tools under pi's names and fields; rules name tools as the model does. The permission
 * check therefore sees `Bash` with `command` and `Edit` with `file_path`, whatever pi calls them.
 */
export function permissionCallFor(piName: string, args: Readonly<Record<string, unknown>>): PermissionCall {
	const name = ccToolNameFor(piName);
	if (name === piName || !("path" in args)) return { name, input: args };
	const { path, ...rest } = args;
	return { name, input: { file_path: path, ...rest } };
}
