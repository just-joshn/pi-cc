/**
 * Claude Code's safety-check breakers: the named reasons a check stands behind an ask.
 *
 * Every breaker holds an ask against allow rules in every mode but `bypassPermissions`. Under bypass
 * only a `bypassImmune` breaker still holds, and a `waivableInBypass` one lets go when the operator
 * sets `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` and no rule could have narrowed the run.
 * The table is Claude Code's own (dossier `chunk-tbcewt4x.js:88`, the `bUe` table).
 *
 * `produced` says whether this build can raise the breaker. A breaker it cannot raise has no producer
 * because the tool or flag it belongs to does not exist here, and its row stays so the table matches.
 */

export const BREAKERS = {
	dangerousRemoval: { bypassImmune: true, waivableInBypass: true, produced: true },
	backgroundOperator: { bypassImmune: false, waivableInBypass: false, produced: true },
	suspiciousWindowsPath: { bypassImmune: false, waivableInBypass: false, produced: false },
	isolatePeerMachines: { bypassImmune: true, waivableInBypass: false, produced: false },
	restrictedMode: { bypassImmune: true, waivableInBypass: false, produced: false },
	outsideReadsBlocked: { bypassImmune: true, waivableInBypass: false, produced: true },
	claudeSettingsFile: { bypassImmune: false, waivableInBypass: false, produced: true },
	internalHardDeny: { bypassImmune: false, waivableInBypass: false, produced: false },
	unfinishedCheck: { bypassImmune: true, waivableInBypass: false, produced: true },
} as const;

export type Breaker = keyof typeof BREAKERS;

export function isBypassImmune(breaker: Breaker | undefined): boolean {
	return breaker !== undefined && BREAKERS[breaker].bypassImmune;
}

/** Whether a breaker still holds an ask under `bypassPermissions`. */
export function holdsUnderBypass(breaker: Breaker | undefined, removalWaived: boolean): boolean {
	if (breaker === undefined || !BREAKERS[breaker].bypassImmune) return false;
	return !(BREAKERS[breaker].waivableInBypass && removalWaived);
}

export const READ_BLOCK_MESSAGE =
	"Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.";

export const UNFINISHED_CHECK_MESSAGE =
	"The permission check for this command did not finish, so its safety checks did not run.";

/** What a command the parser cannot analyze asks under the read block, wrapped as Claude Code words it. */
export function unanalyzableUnderReadBlock(message: string): string {
	return `${message}; under the read block (permissions.blockReadsOutsideWorkingDirectories) a command the shell parser cannot analyze asks the person`;
}
