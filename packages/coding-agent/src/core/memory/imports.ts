/** `@path` imports inside memory files: which tokens are scanned, which paths count, and how they resolve. */

import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { Marked, type Token } from "@earendil-works/pi-tui";

/** File extensions a memory file or an import may have. A path with no extension is also allowed. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
	[
		"md",
		"mdx",
		"markdown",
		"txt",
		"text",
		"rst",
		"adoc",
		"asciidoc",
		"org",
		"tex",
		"json",
		"jsonc",
		"json5",
		"jsonl",
		"ndjson",
		"yaml",
		"yml",
		"toml",
		"ini",
		"cfg",
		"conf",
		"config",
		"properties",
		"env",
		"editorconfig",
		"gitignore",
		"gitattributes",
		"dockerignore",
		"npmrc",
		"nvmrc",
		"xml",
		"xsd",
		"xsl",
		"svg",
		"plist",
		"html",
		"htm",
		"xhtml",
		"css",
		"scss",
		"sass",
		"less",
		"styl",
		"js",
		"mjs",
		"cjs",
		"jsx",
		"ts",
		"mts",
		"cts",
		"tsx",
		"vue",
		"svelte",
		"astro",
		"py",
		"pyi",
		"rb",
		"erb",
		"go",
		"rs",
		"java",
		"kt",
		"kts",
		"scala",
		"groovy",
		"gradle",
		"clj",
		"cljs",
		"edn",
		"swift",
		"m",
		"mm",
		"c",
		"h",
		"cc",
		"cpp",
		"cxx",
		"hpp",
		"hh",
		"hxx",
		"cs",
		"fs",
		"fsx",
		"vb",
		"php",
		"pl",
		"pm",
		"lua",
		"r",
		"jl",
		"dart",
		"ex",
		"exs",
		"erl",
		"hrl",
		"hs",
		"elm",
		"ml",
		"mli",
		"nim",
		"zig",
		"v",
		"sol",
		"sh",
		"bash",
		"zsh",
		"fish",
		"ps1",
		"psm1",
		"bat",
		"cmd",
		"sql",
		"graphql",
		"gql",
		"proto",
		"thrift",
		"avsc",
		"prisma",
		"tf",
		"tfvars",
		"hcl",
		"nix",
		"csv",
		"tsv",
		"log",
		"patch",
		"diff",
		"dockerfile",
		"makefile",
		"mk",
		"cmake",
		"bazel",
		"bzl",
		"lock",
		"tmpl",
		"tpl",
		"j2",
		"hbs",
		"mustache",
		"liquid",
	].map((extension) => `.${extension}`),
);

/** Whether a memory file or import at `path` is read: its lowercased extension is empty or a text extension. */
export function isTextPath(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return extension === "" || TEXT_EXTENSIONS.has(extension);
}

/** The import paths `text` names, in order of appearance, unresolved. */
export function extractImportPaths(text: string): string[] {
	if (!text.includes("@")) {
		return [];
	}
	const paths: string[] = [];
	for (const scanned of scannedTexts(new Marked({ gfm: false }).lexer(text))) {
		for (const match of scanned.matchAll(IMPORT_PATTERN)) {
			const path = importPath(match[1]);
			if (path !== undefined) {
				paths.push(path);
			}
		}
	}
	return paths;
}

/** Resolve an import against the directory of the importing file. Undefined for a path that cannot name a file. */
export function resolveImportPath(path: string, baseDir: string, home: string): string | undefined {
	const trimmed = path.trim();
	if (trimmed.includes("\0")) {
		return undefined;
	}
	if (trimmed === "~") {
		return home;
	}
	if (trimmed.startsWith("~/")) {
		return join(home, trimmed.slice(2));
	}
	return isAbsolute(trimmed) ? normalize(trimmed) : resolve(baseDir, trimmed);
}

/** Remove the HTML comments of every block that is an HTML comment, keeping any text after them. */
export function stripCommentBlocks(text: string): string {
	if (!text.includes("<!--")) {
		return text;
	}
	return new Marked({ gfm: false })
		.lexer(text)
		.map((token) => (isCommentBlock(token) ? token.raw.replace(HTML_COMMENT, "") : token.raw))
		.join("");
}

const IMPORT_PATTERN = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// UNC paths and the macOS volfs-style paths that bypass ordinary file lookup.
const SPECIAL_PATH = /^(?:\/\/|\\\\|\/\.(?:vol|file|nofollow|resolve)(?:\/|$))/;

function* scannedTexts(tokens: readonly Token[]): Generator<string> {
	for (const token of tokens) {
		if (token.type === "code" || token.type === "codespan") {
			continue;
		}
		if (token.type === "html") {
			if (isCommentBlock(token)) {
				yield token.raw.replace(HTML_COMMENT, "");
			}
			continue;
		}
		if (token.type === "text") {
			yield token.text;
		}
		if ("tokens" in token && token.tokens) {
			yield* scannedTexts(token.tokens);
		}
		if (token.type === "list") {
			yield* scannedTexts(token.items);
		}
	}
}

function isCommentBlock(token: Token): boolean {
	if (token.type !== "html") {
		return false;
	}
	const raw = token.raw.trimStart();
	return raw.startsWith("<!--") && raw.includes("-->");
}

function importPath(matched: string): string | undefined {
	const fragment = matched.indexOf("#");
	const withoutFragment = fragment === -1 ? matched : matched.slice(0, fragment);
	if (withoutFragment.length === 0) {
		return undefined;
	}
	const path = withoutFragment.replace(/\\ /g, " ");
	return isImportablePath(path) ? path : undefined;
}

function isImportablePath(path: string): boolean {
	if (SPECIAL_PATH.test(path)) {
		return false;
	}
	if (path.startsWith("./") || path.startsWith("~/")) {
		return true;
	}
	if (path.startsWith("/")) {
		return path !== "/";
	}
	return /^[A-Za-z0-9._-]/.test(path);
}
