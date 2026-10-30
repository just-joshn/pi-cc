/**
 * The Claude Code terminal settings, resolved once per admitted directory into a plain value that
 * interactive mode reads. It holds no state: `main.ts` owns the admission and recomputes this from it.
 */

import { parseVimInsertRemaps, type VimConfig } from "@earendil-works/pi-tui";
import type { TuiMode } from "../../settings-manager.ts";
import { CC_DEFAULT_CLOCK, type CcClock, resolveCcClock } from "./clock.ts";
import type { CcSettings } from "./types.ts";

export interface CcTuiSettings {
	/** `tui`: `fullscreen` selects pi's alternate-screen renderer and `default` its main-screen one. */
	readonly tuiMode: TuiMode | undefined;
	readonly reducedMotion: boolean;
	/** Columns of the prose in a response, at least 40, or undefined for the full width. */
	readonly maxProseWidth: number | undefined;
	readonly clock: CcClock;
	/** Screen reader mode: flat text with no decorative borders or animation. */
	readonly screenReader: boolean;
	/** Vim editing in the prompt, or undefined for the normal editor. */
	readonly vim: VimConfig | undefined;
}

/** What a run with no Claude Code terminal settings resolves to, and what pi alone behaves as. */
export const NO_CC_TUI: CcTuiSettings = {
	tuiMode: undefined,
	reducedMotion: false,
	maxProseWidth: undefined,
	clock: CC_DEFAULT_CLOCK,
	screenReader: false,
	vim: undefined,
};

export interface CcTuiInputs {
	/** `--ax-screen-reader` as parsed on this invocation. */
	readonly axScreenReaderFlag: boolean;
	/** The environment after the settings `env` block was applied over it. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The order is CC's: the flag, then `CLAUDE_AX_SCREEN_READER`, then the `axScreenReader` setting. */
function screenReaderOn(settings: CcSettings, inputs: CcTuiInputs): boolean {
	if (inputs.axScreenReaderFlag) {
		return true;
	}
	const fromEnv = inputs.env.CLAUDE_AX_SCREEN_READER;
	if (fromEnv !== undefined) {
		return /^(1|true|yes|on)$/i.test(fromEnv.trim());
	}
	return settings.operatorTier.axScreenReader === true;
}

export function resolveCcTuiSettings(settings: CcSettings, inputs: CcTuiInputs): CcTuiSettings {
	const { values } = settings;
	const tui = values.tui;
	return {
		tuiMode: tui === "fullscreen" ? "fullscreen" : tui === "default" ? "regular" : undefined,
		reducedMotion: values.prefersReducedMotion === true,
		maxProseWidth: typeof values.maxProseWidth === "number" ? values.maxProseWidth : undefined,
		clock: resolveCcClock(values.timeFormat, values.timeZone),
		screenReader: screenReaderOn(settings, inputs),
		vim:
			values.editorMode === "vim"
				? { insertRemaps: parseVimInsertRemaps(settings.operatorTier.vimInsertModeRemaps) }
				: undefined,
	};
}
