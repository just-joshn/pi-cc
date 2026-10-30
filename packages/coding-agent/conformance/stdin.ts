import type { Writable } from "node:stream";
import type { StdinSpec } from "./case.ts";

/** Sends paced input to a side without sending script directives to its CLI. */
export async function writeStdin(stream: Writable, stdin: StdinSpec, stdoutSoFar: () => string): Promise<void> {
	if (stdin === null) return;
	if (stdin.kind === "text") {
		stream.write(stdin.data);
		return;
	}
	for (const line of stdin.lines) {
		if (line.startsWith("#sleep ")) {
			await new Promise((resolve) => setTimeout(resolve, Number(line.slice("#sleep ".length))));
		} else if (line.startsWith("#waitfor ")) {
			const pattern = new RegExp(line.slice("#waitfor ".length));
			const deadline = Date.now() + 30_000;
			while (!pattern.test(stdoutSoFar()) && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 50));
		} else {
			stream.write(`${line}\n`);
		}
	}
}
