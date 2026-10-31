import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PromptHistory, PromptHistoryEntry } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const record = Compile(
	Type.Object({
		text: Type.String(),
		pastes: Type.Array(Type.Tuple([Type.Integer({ minimum: 1 }), Type.String()])),
	}),
);

/** Pi-owned prompt history shared by interactive sessions, independent of transcript storage. */
export class PromptHistoryStore implements PromptHistory {
	private path: string;
	private scope: () => string;
	private previousPlain: { scope: string; text: string } | undefined;

	constructor(path: string, scope: () => string = () => "") {
		this.path = path;
		this.scope = scope;
	}

	read(): readonly PromptHistoryEntry[] {
		let contents: string;
		try {
			contents = readFileSync(this.path, "utf8");
		} catch {
			return [];
		}
		const entries: PromptHistoryEntry[] = [];
		for (const line of contents.split("\n")) {
			try {
				const value: unknown = JSON.parse(line);
				if (record.Check(value)) entries.push({ text: value.text, pastes: new Map(value.pastes) });
			} catch {}
		}
		return entries.reverse();
	}

	append(entry: PromptHistoryEntry): void {
		if (/^(1|true|yes|on)$/i.test(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY?.trim() ?? "")) return;
		const ids = new Set(
			[...entry.text.matchAll(/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g)].map((match) => Number(match[1])),
		);
		const pastes = [...entry.pastes].filter(([id]) => ids.has(id));
		if (pastes.length > 0) {
			const trimmed = entry.text.trimStart();
			// CC's addEntry keeps pasted content out of shell, slash, and markers-only prompts.
			const body = trimmed.replace(/\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g, "").trim();
			if (body === "" || trimmed.startsWith("/") || trimmed.startsWith("!")) return;
		}
		const scope = this.scope();
		if (pastes.length === 0 && this.previousPlain?.scope === scope && this.previousPlain.text === entry.text) return;
		let fd: number | undefined;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			fd = openSync(
				this.path,
				constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			appendFileSync(fd, `${JSON.stringify({ text: entry.text, pastes })}\n`);
			this.previousPlain = pastes.length === 0 ? { scope, text: entry.text } : undefined;
		} catch {
			// History storage must not prevent submitting the prompt.
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
}
