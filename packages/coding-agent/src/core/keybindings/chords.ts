import { type Keybinding, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export interface Binding {
	context: "Global" | "Chat";
	keys: readonly [KeyId, ...KeyId[]];
	action: Keybinding | null;
}

export type ChordState =
	| { kind: "idle" }
	| { kind: "pending"; candidates: readonly Binding[]; index: number; expires: number };
export type ChordResult = { kind: "pending" } | { kind: "input"; actions: ReadonlySet<Keybinding> };

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
			const hits = pending.candidates.filter((binding) => matchesKey(data, binding.keys[pending.index]!));
			if (hits.length > 0) return this.advance(hits, pending.index + 1, now);
		}
		const hits = bindings.filter((binding) => matchesKey(data, binding.keys[0]!));
		return this.advance(hits, 1, now);
	}

	private advance(hits: readonly Binding[], index: number, now: number): ChordResult {
		const longer = hits.filter((binding) => binding.keys.length > index);
		if (longer.length > 0) {
			this.state = { kind: "pending", candidates: longer, index, expires: now + 1000 };
			return { kind: "pending" };
		}
		return {
			kind: "input",
			actions: new Set(hits.flatMap((binding) => (binding.action === null ? [] : [binding.action]))),
		};
	}
}
