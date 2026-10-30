import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { StdinSpec } from "./case.ts";

/** Sends paced input to a side without sending script directives to its CLI. */
export async function writeStdin(
	stream: Writable,
	stdin: StdinSpec,
	stdoutSoFar: () => string,
	signal?: AbortSignal,
): Promise<void> {
	if (stdin === null) return;
	if (stdin.kind === "text") {
		stream.write(stdin.data);
		return;
	}
	for (const line of stdin.lines) {
		if (line.startsWith("#sleep ")) {
			await delay(Number(line.slice("#sleep ".length)), undefined, { signal });
		} else if (line.startsWith("#waitfor ")) {
			const pattern = new RegExp(line.slice("#waitfor ".length));
			const deadline = Date.now() + 30_000;
			while (!pattern.test(stdoutSoFar()) && Date.now() < deadline) await delay(50, undefined, { signal });
			if (!pattern.test(stdoutSoFar())) throw new Error(`stdin #waitfor timed out: ${pattern.source}`);
		} else {
			stream.write(`${line}\n`);
		}
	}
}
