import { type Keybinding, type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Where a binding was declared: pi's defaults or user action file, or a CC action name imported from a CC file. */
export type BindingOrigin = "pi-base" | "pi-file" | "cc-import";

export interface Binding {
	context: "Global" | "Chat";
	origin: BindingOrigin;
	keys: readonly [KeyId, ...KeyId[]];
	action: Keybinding | null;
}

export type ChordState =
	| { kind: "idle" }
	| { kind: "pending"; candidates: readonly Binding[]; index: number; expires: number };
export type ChordResult =
	| { kind: "pending" }
	| { kind: "cancelled" }
	| { kind: "input"; actions: ReadonlySet<Keybinding> };

/** Resolves an input event once, independently of the number of action checks that follow. */
export class ChordResolver {
	private state: ChordState = { kind: "idle" };

	reset(): void {
		this.state = { kind: "idle" };
	}

	resolve(data: string, bindings: readonly Binding[], now = Date.now()): ChordResult {
		const pending = this.state;
		this.reset();
		if (pending.kind === "pending" && now < pending.expires) {
			if (matchesKey(data, "escape")) return { kind: "cancelled" };
			const hits = pending.candidates.filter((binding) => matchesKey(data, binding.keys[pending.index]!));
			return hits.length > 0 ? this.advance(hits, pending.index + 1, now) : { kind: "cancelled" };
		}
		const hits = bindings.filter((binding) => matchesKey(data, binding.keys[0]!));
		return this.advance(hits, 1, now);
	}

	private advance(hits: readonly Binding[], index: number, now: number): ChordResult {
		// CC starts a chord only when a longer binding has a non-null action (jet, chunk-963y7jan.js);
		// a longer `null` unbinding leaves the prefix key free for its own single-key action.
		const longer = hits.filter((binding) => binding.keys.length > index && binding.action !== null);
		if (longer.length > 0) {
			this.state = { kind: "pending", candidates: longer, index, expires: now + 3000 };
			return { kind: "pending" };
		}
		return {
			kind: "input",
			actions: new Set(hits.flatMap((binding) => (binding.action === null ? [] : [binding.action]))),
		};
	}
}
