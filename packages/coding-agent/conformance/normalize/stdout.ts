/** Rewrites the volatile parts of captured text so two clients that print their own version and paths still compare. */

import type { NormalizeRule } from "../case.ts";

export interface NormalizeContext {
	sideRoot: string;
	realHome: string;
}

const SEMVER = /\b\d+\.\d+\.\d+\b/g;
const VERSION_LINE = /^\S+ \([^)]+\)$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function normalizeText(text: string, rules: NormalizeRule[], context: NormalizeContext): string {
	let out = text;
	for (const rule of rules) out = applyRule(out, rule, context);
	return normalizeWhitespace(out);
}

export function normalizeWhitespace(text: string): string {
	const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function applyRule(text: string, rule: NormalizeRule, context: NormalizeContext): string {
	switch (rule) {
		case "paths": {
			// Longest first so the side root wins over the real home it may live under.
			const replacements = [context.sideRoot, context.realHome].sort((left, right) => right.length - left.length);
			let out = text;
			for (const path of replacements)
				out = out.split(path).join(path === context.sideRoot ? "$SIDE" : "$REAL_HOME");
			return out;
		}
		case "whitespace":
			return normalizeWhitespace(text);
		case "version":
			return text
				.split("\n")
				.map((line) => (VERSION_LINE.test(line.trim()) ? "<version>" : line.replace(SEMVER, "<version>")))
				.join("\n");
		case "session-id":
			return text.replace(UUID, "<session-id>");
	}
}
