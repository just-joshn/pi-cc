import { type Keybinding, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export interface CcBinding {
	keys: readonly [KeyId, ...KeyId[]];
	action: Keybinding;
}

export type CcDispatch =
	| { kind: "none" }
	| { kind: "pending" }
	| { kind: "cancelled" }
	| { kind: "action"; action: Keybinding };

type Pending = { candidates: readonly CcBinding[]; index: number; expires: number };

const CHORD_TIMEOUT_MS = 3000;

/**
 * Claude Code's keybinding dispatch as its own layer in front of pi's editor. It never touches pi's binding
 * table: a key either matches an imported binding (the caller runs the mapped action and consumes the key, unless
 * the action declines) or reports `none` so pi handles it exactly as it would without an import.
 */
export class CcLayer {
	private bindings: readonly CcBinding[] = [];
	private pending: Pending | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private statusTarget: ((message: string | undefined) => void) | undefined;

	get active(): boolean {
		return this.bindings.length > 0;
	}

	getBindings(): readonly CcBinding[] {
		return this.bindings;
	}

	setBindings(bindings: readonly CcBinding[]): void {
		this.cancel();
		this.bindings = bindings;
	}

	cancel(): void {
		this.pending = undefined;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.statusTarget?.(undefined);
			this.statusTarget = undefined;
		}
	}

	/** Resolves one keystroke. Chord feedback goes to the editor that received it. */
	dispatch(data: string, onStatus?: (message: string | undefined) => void, now = Date.now()): CcDispatch {
		const result = this.resolve(data, now);
		if (result.kind === "pending") {
			if (this.timer !== undefined) clearTimeout(this.timer);
			this.statusTarget = onStatus;
			this.statusTarget?.("Waiting for next key (3s)");
			this.timer = setTimeout(() => {
				this.pending = undefined;
				this.statusTarget?.("Chord cancelled. No next key within 3s");
				this.timer = setTimeout(() => this.cancel(), CHORD_TIMEOUT_MS);
				this.timer.unref();
			}, CHORD_TIMEOUT_MS);
			this.timer.unref();
			return result;
		}
		this.cancel();
		return result;
	}

	private resolve(data: string, now: number): CcDispatch {
		const pending = this.pending;
		this.pending = undefined;
		if (pending && now < pending.expires) {
			if (matchesKey(data, "escape")) return { kind: "cancelled" };
			const hits = pending.candidates.filter((binding) => matchesKey(data, binding.keys[pending.index]!));
			return hits.length > 0 ? this.advance(hits, pending.index + 1, now) : { kind: "cancelled" };
		}
		return this.advance(
			this.bindings.filter((binding) => matchesKey(data, binding.keys[0])),
			1,
			now,
		);
	}

	private advance(hits: readonly CcBinding[], index: number, now: number): CcDispatch {
		// A chord starts only when a longer binding exists (jet, chunk-963y7jan.js). Unbound sequences are not
		// stored, so a null chord never starts one and its prefix key keeps pi's own action.
		const longer = hits.filter((binding) => binding.keys.length > index);
		if (longer.length > 0) {
			this.pending = { candidates: longer, index, expires: now + CHORD_TIMEOUT_MS };
			return { kind: "pending" };
		}
		const exact = hits.at(-1);
		return exact ? { kind: "action", action: exact.action } : { kind: "none" };
	}
}
