import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const plain = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");

describe("Markdown maxProseWidth", () => {
	it("leaves rendering unchanged when unset", () => {
		const base = new Markdown(words, 0, 0, defaultMarkdownTheme).render(100);
		const unset = new Markdown(words, 0, 0, { ...defaultMarkdownTheme, maxProseWidth: undefined }).render(100);
		assert.deepStrictEqual(unset, base);
	});

	it("wraps a paragraph at the cap in a wider terminal", () => {
		const lines = plain(new Markdown(words, 0, 0, { ...defaultMarkdownTheme, maxProseWidth: 40 }).render(100));
		assert.ok(lines.length > 1);
		for (const line of lines) assert.ok(line.length <= 40, `line wider than 40: ${line.length}`);
	});

	it("does not widen prose past a narrower terminal", () => {
		const lines = plain(new Markdown(words, 0, 0, { ...defaultMarkdownTheme, maxProseWidth: 200 }).render(30));
		for (const line of lines) assert.ok(line.length <= 30);
	});

	it("wraps headings, list items and blockquotes at the cap", () => {
		const source = `# ${words}\n\n- ${words}\n\n> ${words}`;
		const lines = plain(new Markdown(source, 0, 0, { ...defaultMarkdownTheme, maxProseWidth: 40 }).render(100));
		for (const line of lines) assert.ok(line.length <= 40, `line wider than 40: ${line}`);
	});

	it("keeps code blocks and tables at the full width", () => {
		const code = `\`\`\`\n${"x".repeat(80)}\n\`\`\``;
		const table = `| ${"a".repeat(30)} | ${"b".repeat(30)} |\n| --- | --- |\n| 1 | 2 |`;
		const themed = { ...defaultMarkdownTheme, maxProseWidth: 40 };
		assert.ok(plain(new Markdown(code, 0, 0, themed).render(100)).some((line) => line.length > 40));
		assert.ok(plain(new Markdown(table, 0, 0, themed).render(100)).some((line) => line.length > 40));
	});

	it("does not insert line breaks into the source", () => {
		const markdown = new Markdown(words, 0, 0, { ...defaultMarkdownTheme, maxProseWidth: 40 });
		markdown.render(100);
		assert.strictEqual(markdown.render(100).join(" ").replace(/\s+/g, " ").trim().includes("word29"), true);
	});
});
