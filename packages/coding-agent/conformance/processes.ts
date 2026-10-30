/** Placeholder so the repro tests can run against the code as it is; the inventory lands in the next commit. */
export type Baseline = ReadonlySet<string>;

export async function takeBaseline(): Promise<Baseline | null> {
	return new Set();
}
