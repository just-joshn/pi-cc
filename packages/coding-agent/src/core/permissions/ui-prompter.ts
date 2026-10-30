import type { ExtensionUIContext } from "../extensions/types.ts";
import {
	NO,
	type PermissionAnswer,
	type PermissionPrompter,
	type PermissionRequest,
	REJECTED_WITHOUT_REASON,
	YES,
} from "./prompt.ts";

function summary(request: PermissionRequest): string {
	const { input } = request.call;
	for (const field of ["command", "file_path", "path", "url"]) {
		const value = input[field];
		if (typeof value === "string") return value;
	}
	return JSON.stringify(input);
}

export function createUiPrompter(ui: ExtensionUIContext): PermissionPrompter {
	return async (request): Promise<PermissionAnswer> => {
		const labels = [YES, ...request.suggestions.map((suggestion) => suggestion.label), NO];
		const choice = await ui.select(`${request.call.name}: ${summary(request)}\n${request.message}`, labels);
		if (choice === YES) return { behavior: "allow" };
		const suggestion = request.suggestions.find((candidate) => candidate.label === choice);
		if (suggestion) return { behavior: "allow", updates: [suggestion.update] };
		return { behavior: "deny", message: REJECTED_WITHOUT_REASON };
	};
}
