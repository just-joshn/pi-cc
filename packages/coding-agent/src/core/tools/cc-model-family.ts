/**
 * The model identity Claude Code's legacy prior-read gate tests, one lookup the session's
 * Edit and Write tools share.
 */

/** Claude Code's ten legacy model ids whose unread Edit and Write calls are refused. */
const READ_BEFORE_MUTATION_MODELS = new Set([
	"claude-opus-4-6",
	"claude-haiku-4-5",
	"claude-opus-4-5",
	"claude-opus-4-1",
	"claude-opus-4-0",
	"claude-sonnet-4-5",
	"claude-sonnet-4-0",
	"claude-3-7-sonnet",
	"claude-3-5-sonnet",
	"claude-3-5-haiku",
]);

/** The model id form the gate compares against the set. */
export function claudeModelFamily(id: string): string {
	return id.replace(/\[1m\]$/i, "");
}

/** Whether Claude Code refuses unread mutations by this model, before permission checks. */
export function isCcLegacyMutationModel(id: string): boolean {
	return READ_BEFORE_MUTATION_MODELS.has(claudeModelFamily(id));
}
