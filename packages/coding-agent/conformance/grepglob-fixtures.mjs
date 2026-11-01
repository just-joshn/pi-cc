import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("cases/grepglob/", import.meta.url));
const checking = process.argv.includes("--check");
const base = ["-p", "Reply with exactly PROBE_OK", "--output-format", "stream-json", "--verbose"];
const opt = ["--allowedTools", "Grep,Glob,Bash"];
const rows = [];
const prerequisites = new Map([
	["t11-subagent-default", "P19"], ["t11b-subagent-allow-grep", "P19"],
	["t11c-subagent-disallow-grep", "P19"], ["t11d-subagent-bash-grep", "P19"],
	["toolsearch-not-an-exposure-route", "P34"],
]);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const encoded = (text) => escape(JSON.stringify(text).slice(1, -1));
const exact = (text) => `"${encoded(text)}"`;
const jsonChar = String.raw`(?:[^"\\]|\\.)`;
const flatFields = String.raw`(?:[^"{}]|"(?:[^"\\]|\\.)*")*`;
const prefix = `(?:[^"{}]|"${jsonChar}*"|\\{${flatFields}\\})*`;
const tool = (name, input) => ({ tool_use: { name, input } });
const bash = (command) => tool("Bash", { command, description: "Prepare isolated search fixtures" });
const grep = (input, expected, error = false) => ({ turn: tool("Grep", input), expected, error });
const glob = (input, expected, error = false) => ({ turn: tool("Glob", input), expected, error });

function emit(name, extra, files, turns, requests, stdout = [], env = {}, cwd) {
	const fixture = {
		id: `grepglob/${name}`,
		area: "grepglob",
		argv: [...base, ...extra],
		env: { CLAUDE_CODE_TMPDIR: "$TMP", ...env },
		stdin: null,
		files,
		...(cwd === undefined ? {} : { cwd }),
		model: { turns: [...turns, { text: "PROBE_OK" }] },
		timeout_ms: 180000,
		compare: {
			exit: 0,
			stdout: { kind: "text", match: ["PROBE_OK", ...stdout] },
			requests,
		},
		skip: prerequisites.has(name) ? ["spec-gap"] : [],
	};
	const path = `${dir}${name}.json`;
	const text = `${JSON.stringify(fixture, null, "\t")}\n`;
	if (checking) {
		if (readFileSync(path, "utf8") !== text) throw new Error(`${path} is stale`);
	} else {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, text);
	}
	rows.push(name);
}

const bareTools = ["Bash", "Edit", "Read"];
const explicitTools = {
	"t02-bare": bareTools,
	"t05-tools-glob-read": ["Glob", "DeferredToolPlaceholder", "Read"],
	"t06-tools-grep-glob-read": ["Glob", "Grep", "DeferredToolPlaceholder", "Read"],
	"t09-tools-read-edit": ["Edit", "DeferredToolPlaceholder", "Read"],
	"t12b-bare-allow-grep": bareTools,
	"t12e-tools-bash-read": ["Bash", "DeferredToolPlaceholder", "Read"],
	"t12h-tools-read": ["DeferredToolPlaceholder", "Read"],
};
function exposure(name, extra, present, absent, env = {}, files = {}) {
	const tools = {
		match: present.map(schemaPattern),
		notMatch: absent.map((name) => `"name":"${name}"`),
	};
	const names = explicitTools[name];
	const assertions = [];
	for (const name of present) {
		assertions.push(`^\\{(?=[^\\n]*"subtype":"init")[^\\n]*"tools":\\[(?=[^\\]]*"${name}")[^\\]]*\\]`);
	}
	for (const name of absent) {
		assertions.push(`^\\{(?=[^\\n]*"subtype":"init")[^\\n]*"tools":\\[(?![^\\]]*"${name}")[^\\]]*\\]`);
	}
	emit(name, extra, files, [], [{
		pathStartsWith: "/v1/messages", count: 1, index: 0, bodyAt: { tools },
		...(names === undefined ? {} : { bodyEquals: { tools: names.map((name) => ({ name })) } }),
	}], assertions, env);
}

const exposureRows = [
	["t01-default", [], [], ["Grep", "Glob"]],
	["t02-bare", ["--bare"], [], ["Grep", "Glob"]],
	["t03-allow-grep", ["--allowedTools", "Grep"], ["Grep", "Glob"], []],
	["t04-allow-glob", ["--allowedTools", "Glob"], ["Grep", "Glob"], []],
	["t05-tools-glob-read", ["--tools", "Glob,Read"], ["Glob"], ["Grep"]],
	["t06-tools-grep-glob-read", ["--tools", "Grep,Glob,Read"], ["Grep", "Glob"], []],
	["t07-local-agent", [], ["Grep", "Glob"], [], { CLAUDE_CODE_ENTRYPOINT: "local-agent" }],
	["t08-disallow-bash", ["--disallowedTools", "Bash"], ["Grep", "Glob"], ["Bash"]],
	["t09-tools-read-edit", ["--tools", "Read,Edit"], [], ["Grep", "Glob", "Bash"]],
	["t10-settings-deny-bash", [], ["Grep", "Glob"], ["Bash"], {}, {
		"$AGENT/trust.json": '{"$WORKSPACE":true}\n',
		".claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash"] } }),
	}],
	["t12a-local_agent", [], ["Grep", "Glob"], [], { CLAUDE_CODE_ENTRYPOINT: "local_agent" }],
	["t12b-bare-allow-grep", ["--bare", "--allowedTools", "Grep"], [], ["Grep", "Glob"]],
	["t12c-disallow-bash-grep", ["--disallowedTools", "Bash,Grep"], ["Glob"], ["Grep", "Bash"]],
	["t12d-disallow-grep", ["--disallowedTools", "Grep"], [], ["Grep", "Glob"]],
	["t12e-tools-bash-read", ["--tools", "Bash,Read"], [], ["Grep", "Glob"]],
	["t12f-allow-scoped-grep", ["--allowedTools", "Grep(src/**)"], ["Grep", "Glob"], []],
	["t12g-tools-default", ["--tools", "default"], [], ["Grep", "Glob"]],
	["t12h-tools-read", ["--tools", "Read"], [], ["Grep", "Glob", "Bash"]],
];
const schemaProperties = {
	Glob: [["pattern", "string"], ["path", "string"]],
	Grep: [
		["pattern", "string"], ["path", "string"], ["glob", "string"],
		["output_mode", "string", ["content", "files_with_matches", "count"]],
		["-B", "number"], ["-A", "number"], ["-C", "number"], ["context", "number"],
		["-n", "boolean"], ["-i", "boolean"], ["-o", "boolean"], ["type", "string"],
		["head_limit", "number"], ["offset", "number"], ["multiline", "boolean"],
	],
};
function schemaPattern(name) {
	const variants = ["captured", "typebox"].map((order) => {
		const properties = schemaProperties[name].map(([key, type, values]) => {
			const fields = {
				description: `"description":"${jsonChar}*"`,
				type: `"type":${escape(JSON.stringify(type))}`,
			};
			const keys = order === "captured" ? ["description", "type"] : ["type", "description"];
			return `${escape(JSON.stringify(key))}:\\{${keys.map((key) => fields[key]).join(",")}${values ? `,"enum":${escape(JSON.stringify(values))}` : ""}\\}`;
		}).join(",");
		const fields = {
			$schema: escape('"$schema":"https://json-schema.org/draft/2020-12/schema"'),
			type: '"type":"object"',
			properties: `"properties":\\{${properties}\\}`,
			required: escape('"required":["pattern"]'),
			additionalProperties: '"additionalProperties":false',
		};
		const keys = order === "captured" ? ["$schema", "type", "properties", "required", "additionalProperties"] : ["type", "required", "properties", "additionalProperties", "$schema"];
		return `\\{${keys.map((key) => fields[key]).join(",")}\\}`;
	});
	return `\\{"name":"${name}","description":"${jsonChar}{${name === "Glob" ? 140 : 477}}","input_schema":(?:${variants.join("|")})\\}`;
}
for (const row of exposureRows) exposure(...row);
for (const [name, extra, names] of [
	["schema-joint-opt-in", ["--allowedTools", "Grep"], ["Glob", "Grep"]],
	["schema-explicit-glob", ["--tools", "Glob,Read"], ["Glob"]],
]) {
	emit(name, extra, {}, [], [{ pathStartsWith: "/v1/messages", count: 1, bodyAt: {
		tools: { match: names.map(schemaPattern) },
	} }]);
}

const agentFile = (tools) => `---\nname: searcher\ndescription: Search fixture files\ntools: ${tools}\n---\nSearch the local fixtures.\n`;
for (const [name, extra, agentTools, main, sub] of [
	["t11-subagent-default", [], "Grep, Glob", [], ["Grep", "Glob"]],
	["t11b-subagent-allow-grep", ["--allowedTools", "Grep"], "Grep, Glob", ["Grep", "Glob"], ["Grep", "Glob"]],
	["t11c-subagent-disallow-grep", ["--disallowedTools", "Grep"], "Grep, Glob", [], ["Grep", "Glob"]],
	["t11d-subagent-bash-grep", [], "Bash, Grep, Glob", [], ["Bash"]],
]) {
	const absent = ["Grep", "Glob"].filter((name) => !main.includes(name));
	emit(name, extra, { ".claude/agents/searcher.md": agentFile(agentTools) }, [
		tool("Task", { description: "Search fixtures", subagent_type: "searcher", prompt: "Find fixture files", run_in_background: false }),
		{ text: "SUB_DONE" },
	], [
		{ pathStartsWith: "/v1/messages", index: 0, bodyAt: { tools: {
			match: main.map((name) => `"name":"${name}"`),
			notMatch: absent.map((name) => `"name":"${name}"`),
		} } },
		{ pathStartsWith: "/v1/messages", bodyEquals: { tools: sub.map((name) => ({ name })) } },
		...(sub.includes("Grep") ? [{ pathStartsWith: "/v1/messages", index: 1, bodyAt: {
			tools: { match: sub.map(schemaPattern) },
		} }] : []),
	]);
}

function resultPattern(index, expected, error) {
	const content = `(?:${expected}|\\[(?:\\{"type":"text","text":${expected}\\}|\\{"text":${expected},"type":"text"\\})\\])`;
	return `\\{(?=${prefix}"type":"tool_result")(?=${prefix}"tool_use_id":"toolu_conformance_${index}_0")` +
		`(?=${prefix}"content":${content})${error ? `(?=${prefix}"is_error":true)` : `(?!${prefix}"is_error":true)`}`;
}
function behavior(name, files, steps, prep, extra = opt, env = {}, cwd) {
	const turns = prep === undefined ? [] : [bash(`${prep} && printf SEARCH_FIXTURE_PREPARED`)];
	const requests = prep === undefined ? [] : [{ pathStartsWith: "/v1/messages", index: 1, bodyAt: {
		messages: { match: [resultPattern(0, exact("SEARCH_FIXTURE_PREPARED"), false)] },
	} }];
	for (const step of steps) {
		const index = turns.length;
		turns.push(step.turn);
		requests.push({ pathStartsWith: "/v1/messages", index: index + 1, bodyAt: {
			messages: { match: [resultPattern(index, step.expected, step.error)] },
		} });
	}
	requests.unshift({ pathStartsWith: "/v1/messages", count: turns.length + 1 });
	emit(name, extra, files, turns, requests, [], env, cwd);
}
function unordered(lines, header = "", footer = "") {
	const alternatives = lines.map(encoded).join("|");
	return `"${lines.map((line) => `(?=[^"]*${encoded(line)})`).join("")}${encoded(header)}` +
		`(?:${alternatives})(?:${encoded("\n")}(?:${alternatives})){${lines.length - 1}}${encoded(footer)}"`;
}

emit("t11e-subagent-bare", ["--bare"], { ".claude/agents/searcher.md": agentFile("Grep, Glob") }, [
	tool("Task", { description: "Search fixtures", subagent_type: "searcher", prompt: "Find fixture files" }),
], [
	{ pathStartsWith: "/v1/messages", count: 2, bodyEquals: { tools: bareTools.map((name) => ({ name })) }, bodyAt: {
		tools: { notMatch: ['"name":"Grep"', '"name":"Glob"'] },
		messages: { match: [resultPattern(0, `"${encoded("<tool_use_error>Error: No such tool available: Task")}(?:${encoded(".")}${jsonChar}*)?${encoded("</tool_use_error>")}"`, true)] },
	} },
], ['^\\{(?=[^\\n]*"subtype":"init")[^\\n]*"tools":\\["Bash","Edit","Read"\\]']);

emit("toolsearch-not-an-exposure-route", [], {}, [
	tool("ToolSearch", { query: "select:Grep,Glob", max_results: 5 }),
	tool("ToolSearch", { query: "grep search files", max_results: 5 }),
], [
	{ pathStartsWith: "/v1/messages", count: 3, bodyAt: {
		tools: { notMatch: ['"name":"Grep"', '"name":"Glob"'] },
		messages: { match: [resultPattern(0, exact("No matching deferred tools found"), false)],
			notMatch: ['"tool_name":"Grep"', '"tool_name":"Glob"'] },
	} },
]);

const tree = {
	"src/a.ts": "export const alpha = 1;\nconst Needle = 2;\n",
	"src/b.ts": "export const alpha = 2;\n// needle here\n",
	"src/sub/c.ts": "alpha in c\n",
	"src/sub/deep/d.ts": "alpha in d\n",
	"docs/readme.md": "# Readme\nalpha docs\nneedle docs\n",
	".hidden/h.txt": "alpha hidden\n",
	".secret.ts": "alpha secret\n",
	"ignored/x.ts": "alpha ignored\n",
	"app.log": "alpha log\n",
	"node_modules/m.js": "alpha module\n",
	".gitignore": "ignored/\n*.log\n",
	".git/HEAD": "ref: refs/heads/main\n",
	".git/config": "alpha gitconfig\n",
};
const touch = [
	["202001010000", "src/a.ts"], ["202101010000", "src/sub/c.ts"],
	["202201010000", "src/sub/deep/d.ts"], ["202301010000", "src/b.ts"],
	["202401010000", "docs/readme.md"], ["202501010000", ".hidden/h.txt"],
	["202601010000", ".secret.ts"], ["202701010000", "node_modules/m.js"],
].map(([time, path]) => `touch -t ${time} '${path}'`).join(" && ");
const tsOrder = ["src/a.ts", "src/sub/c.ts", "src/sub/deep/d.ts", "src/b.ts"];
const alphaOrder = ["node_modules/m.js", ".secret.ts", ".hidden/h.txt", "docs/readme.md", ...tsOrder.toReversed()];
const noFiles = exact("No files found");
const noMatches = exact("No matches found");

behavior("glob-order-and-patterns", tree, [
	glob({ pattern: "src/**/*.ts" }, exact(tsOrder.join("\n"))),
	glob({ pattern: "*.ts", path: "src" }, exact(tsOrder.join("\n"))),
	glob({ pattern: "**/*.ts" }, unordered([...tsOrder, ".secret.ts", "ignored/x.ts"])),
	glob({ pattern: "**/*.{ts,md}" }, unordered([...tsOrder, ".secret.ts", "ignored/x.ts", "docs/readme.md"])),
	glob({ pattern: "*.TS" }, noFiles),
	glob({ pattern: "**/*.nomatch" }, noFiles),
	glob({ pattern: "docs/../src/*.ts" }, noFiles),
], touch);
behavior("glob-hidden-ignored-vcs-modules", tree, [
	glob({ pattern: "*", path: ".hidden" }, exact(".hidden/h.txt")),
	glob({ pattern: "**/*", path: "ignored" }, exact("ignored/x.ts")),
	glob({ pattern: "**/*.log" }, exact("app.log")),
	glob({ pattern: "**/*.js" }, exact("node_modules/m.js")),
	glob({ pattern: "**/.git/*" }, unordered([".git/HEAD", ".git/config"])),
]);
behavior("glob-empty-and-absolute-pattern", { "src/a.ts": "alpha\n", "docs/a.md": "alpha\n" }, [
	glob({ pattern: "" }, unordered(["src/a.ts", "docs/a.md"])),
	glob({ pattern: "/etc/hosts" }, exact("/etc/hosts")),
]);
behavior("glob-path-errors", tree, [
	glob({ pattern: "*", path: "nonexistent" }, `"${encoded("Directory does not exist: nonexistent. Note: your current working directory is ")}[^"]+${encoded(".")}"`, true),
	glob({ pattern: "*", path: "src/a.ts" }, exact("Path is not a directory: src/a.ts"), true),
]);
behavior("glob-external-paths-absolute", { "inside/seed.txt": "inside\n", "outside/only.txt": "outside\n" }, [
	glob({ pattern: "*.txt", path: "../outside" }, `"/[^"]+/workspace/outside/only\\.txt"`),
], undefined, opt, {}, "inside");

const many = {};
const manyTouches = [];
for (let i = 1; i <= 120; i++) {
	const path = `many/f${String(i).padStart(3, "0")}.txt`;
	many[path] = `needle ${i}\n`;
	const seconds = 120 - i;
	manyTouches.push(`touch -t 2025010100${String(Math.floor(seconds / 60)).padStart(2, "0")}.${String(seconds % 60).padStart(2, "0")} '${path}'`);
}
const manyTouch = manyTouches.join(" && ");
const manyPaths = Object.keys(many);
const globCap = manyPaths.toReversed().slice(0, 100).join("\n");
behavior("glob-cap-oldest-100", many, [
	glob({ pattern: "many/*.txt" }, exact(`${globCap}\n(Showing 100 of 120 matching files; 20 more are not listed. Narrow the pattern or path to see the rest.)`)),
	glob({ pattern: "**/*.txt", path: "many" }, exact(`${globCap}\n(Showing 100 of 120 matching files; 20 more are not listed. Narrow the pattern or path to see the rest.)`)),
], manyTouch);
const ties = { "tie/t1.txt": "tie\n", "tie/t2.txt": "tie\n", "tie/t3.txt": "tie\n" };
const tieTouch = "touch -t 202501010000 tie/t1.txt tie/t2.txt tie/t3.txt";
behavior("glob-ties-membership-grep-ties-alpha", ties, [
	glob({ pattern: "tie/*.txt" }, unordered(Object.keys(ties))),
	grep({ pattern: "tie", path: "tie" }, exact(`Found 3 files\n${Object.keys(ties).join("\n")}`)),
], tieTouch);
const denied = { ...many, ...ties, "$AGENT/trust.json": '{"$WORKSPACE":true}\n', ".claude/settings.json": JSON.stringify({ permissions: {
	deny: ["Read(many/f00*)", "Read(tie/t2.txt)"],
} }) };
behavior("permission-deny-filter-and-cap", denied, [
	glob({ pattern: "many/*.txt" }, exact(`${globCap}\n(Showing the first 100 files; there are more than 100 matches. Narrow the pattern or path to see the rest.)`)),
	glob({ pattern: "tie/*.txt" }, unordered(["tie/t1.txt", "tie/t3.txt"])),
	grep({ pattern: "needle", path: "many" }, exact(`Found 111 files\n${manyPaths.slice(9).join("\n")}`)),
	grep({ pattern: "tie", path: "tie", output_mode: "count" }, unordered(["tie/t1.txt:1", "tie/t3.txt:1"], "", "\n\nFound 2 total occurrences across 2 files.")),
	grep({ pattern: "tie", path: "tie", output_mode: "content" }, unordered(["tie/t1.txt:1:tie", "tie/t3.txt:1:tie"])),
	grep({ pattern: "needle", path: "many/f001.txt" }, `"${encoded("Permission to read ")}[^"]+/many/f001\\.txt${encoded(" has been denied.")}"`, true),
], `${manyTouch} && ${tieTouch}`);

behavior("grep-files-default-newest-and-singular", tree, [
	grep({ pattern: "alpha" }, exact(`Found 8 files\n${alphaOrder.join("\n")}`)),
	grep({ pattern: "alpha", output_mode: "files_with_matches" }, exact(`Found 8 files\n${alphaOrder.join("\n")}`)),
	grep({ pattern: "alpha", path: "src/a.ts" }, exact("Found 1 file\nsrc/a.ts")),
	grep({ pattern: "zzznomatch" }, noFiles),
], touch);
behavior("grep-content-rendering", tree, [
	grep({ pattern: "needle", output_mode: "content", path: "src" }, exact("src/b.ts:2:// needle here")),
	grep({ pattern: "needle", output_mode: "content", path: "src", "-n": false }, exact("src/b.ts:// needle here")),
	grep({ pattern: "needle", output_mode: "content", path: "src", "-n": true }, exact("src/b.ts:2:// needle here")),
	grep({ pattern: "alpha", output_mode: "content", path: "src/a.ts" }, exact("1:export const alpha = 1;")),
	grep({ pattern: "alpha", output_mode: "content", path: "src/a.ts", "-n": false }, exact("export const alpha = 1;")),
	grep({ pattern: "alpha", output_mode: "content", path: "src" }, unordered([
		"src/a.ts:1:export const alpha = 1;", "src/b.ts:1:export const alpha = 2;", "src/sub/c.ts:1:alpha in c", "src/sub/deep/d.ts:1:alpha in d",
	])),
	grep({ pattern: "zzznomatch", output_mode: "content" }, noMatches),
]);
const ctx = { "ctx.txt": Array.from({ length: 12 }, (_, i) => `line${i + 1}${i === 5 ? " MATCH" : ""}`).join("\n") + "\n" };
behavior("grep-context-and-only-matches", ctx, [
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", "-C": 2 }, exact("4-line4\n5-line5\n6:line6 MATCH\n7-line7\n8-line8")),
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", "-B": 1 }, exact("5-line5\n6:line6 MATCH")),
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", "-A": 1 }, exact("6:line6 MATCH\n7-line7")),
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", context: 1 }, exact("5-line5\n6:line6 MATCH\n7-line7")),
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", "-C": 1, "-A": 3 }, exact("5-line5\n6:line6 MATCH\n7-line7")),
	grep({ pattern: "MATCH", path: "ctx.txt", "-C": 2 }, exact("Found 1 file\nctx.txt")),
	grep({ pattern: "MATCH", path: "ctx.txt", output_mode: "content", "-o": true }, exact("6:MATCH")),
]);
behavior("grep-long-line-omission", { "long.txt": `${"x".repeat(300)}MATCH${"y".repeat(300)}\n` }, [
	grep({ pattern: "MATCH", output_mode: "content", path: "long.txt" }, exact("1:[Omitted long matching line]")),
]);
behavior("grep-count-format", tree, [
	grep({ pattern: "alpha", output_mode: "count", path: "src/a.ts" }, exact("src/a.ts:1\n\nFound 1 total occurrence across 1 file.")),
	grep({ pattern: "alpha|Needle", output_mode: "count", path: "src/a.ts" }, exact("src/a.ts:2\n\nFound 2 total occurrences across 1 file.")),
	grep({ pattern: "alpha", output_mode: "count", path: "src" }, unordered(tsOrder.map((p) => `${p}:1`), "", "\n\nFound 4 total occurrences across 4 files.")),
	grep({ pattern: "zzznomatch", output_mode: "count" }, exact("No matches found\n\nFound 0 total occurrences across 0 files.")),
]);
behavior("grep-files-pagination", many, [
	grep({ pattern: "needle", path: "many", head_limit: 5 }, exact(`Found 5 files limit: 5\n${manyPaths.slice(0, 5).join("\n")}`)),
	grep({ pattern: "needle", path: "many", head_limit: 5, offset: 3 }, exact(`Found 5 files limit: 5, offset: 3\n${manyPaths.slice(3, 8).join("\n")}`)),
	grep({ pattern: "needle", path: "many", head_limit: 0 }, exact(`Found 120 files\n${manyPaths.join("\n")}`)),
	grep({ pattern: "needle", path: "many", offset: 118 }, exact(`Found 2 files offset: 118\n${manyPaths.slice(118).join("\n")}`)),
	grep({ pattern: "needle", path: "many", offset: 500 }, exact("No entries at this offset. [Showing results with pagination = offset: 500]")),
	grep({ pattern: "needle", path: "many", head_limit: "3" }, exact(`Found 3 files limit: 3\n${manyPaths.slice(0, 3).join("\n")}`)),
], manyTouch);
const pages = { "pages.txt": Array.from({ length: 300 }, (_, i) => `needle ${i + 1}\n`).join("") };
const pageLines = Array.from({ length: 300 }, (_, i) => `${i + 1}:needle ${i + 1}`);
behavior("grep-content-pagination", pages, [
	grep({ pattern: "needle", path: "pages.txt", output_mode: "content" }, exact(`${pageLines.slice(0, 250).join("\n")}\n\n[Showing results with pagination = limit: 250]`)),
	grep({ pattern: "needle", path: "pages.txt", output_mode: "content", head_limit: 3 }, exact(`${pageLines.slice(0, 3).join("\n")}\n\n[Showing results with pagination = limit: 3]`)),
	grep({ pattern: "needle", path: "pages.txt", output_mode: "content", head_limit: 3, offset: 2 }, exact(`${pageLines.slice(2, 5).join("\n")}\n\n[Showing results with pagination = limit: 3, offset: 2]`)),
	grep({ pattern: "needle", path: "pages.txt", output_mode: "content", offset: 500 }, exact("No entries at this offset\n\n[Showing results with pagination = offset: 500]")),
	grep({ pattern: "needle", path: "pages.txt", output_mode: "content", head_limit: 0 }, exact(pageLines.join("\n"))),
]);
const countChoices = manyPaths.map((p) => encoded(`${p}:1`)).join("|");
behavior("grep-count-pagination", many, [
	grep({ pattern: "needle", path: "many", output_mode: "count", head_limit: 3 }, `"(?:${countChoices})(?:${encoded("\n")}(?:${countChoices})){2}${encoded("\n\nFound 120 total occurrences across 120 files. with pagination = limit: 3")}"`),
	grep({ pattern: "needle", path: "many", output_mode: "count", head_limit: 3, offset: 1 }, `"(?:${countChoices})(?:${encoded("\n")}(?:${countChoices})){2}${encoded("\n\nFound 120 total occurrences across 120 files. with pagination = limit: 3, offset: 1")}"`),
]);
behavior("grep-case-type-and-glob", tree, [
	grep({ pattern: "NEEDLE", path: "src" }, noFiles),
	grep({ pattern: "NEEDLE", path: "src", "-i": true }, unordered(["src/a.ts", "src/b.ts"], "Found 2 files\n")),
	grep({ pattern: "needle", path: "src", "-i": true, output_mode: "content", "-o": true }, unordered(["src/a.ts:2:Needle", "src/b.ts:2:needle"])),
	grep({ pattern: "alpha", type: "ts" }, unordered([".secret.ts", ...tsOrder], "Found 5 files\n")),
	grep({ pattern: "alpha", type: "md" }, exact("Found 1 file\ndocs/readme.md")),
	grep({ pattern: "alpha", type: "ts", glob: "*.ts" }, unordered([".secret.ts", ...tsOrder], "Found 5 files\n")),
	grep({ pattern: "alpha", glob: "*.md" }, exact("Found 1 file\ndocs/readme.md")),
	grep({ pattern: "alpha", glob: "*.{md,txt}" }, unordered(["docs/readme.md", ".hidden/h.txt"], "Found 2 files\n")),
	grep({ pattern: "alpha", glob: "!*.ts" }, unordered(["node_modules/m.js", "docs/readme.md", ".hidden/h.txt"], "Found 3 files\n")),
]);
behavior("grep-multiline", { "multi.txt": "foo\nbar\nbaz\n" }, [
	grep({ pattern: "foo\\nbar", path: "multi.txt", output_mode: "content", multiline: false }, noMatches),
	grep({ pattern: "foo\\nbar", path: "multi.txt", output_mode: "content", multiline: true }, exact("1:foo\n2:bar")),
	grep({ pattern: "foo.bar", path: "multi.txt", output_mode: "content", multiline: true }, exact("1:foo\n2:bar")),
]);
const vcs = Object.fromEntries([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"].map((d) => [`${d}/config`, "needle vcs\n"]));
behavior("grep-vcs-hidden-ignore-modules", { ...vcs, ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "ignored/\n*.log\n", "ignored/x.ts": "needle ignored\n", "app.log": "needle log\n", ".hidden/h.txt": "needle hidden\n", "node_modules/m.js": "needle module\n", "Library/Containers/c.txt": "needle container\n" }, [
	grep({ pattern: "needle" }, unordered([".hidden/h.txt", "node_modules/m.js", "Library/Containers/c.txt"], "Found 3 files\n")),
]);
behavior("grep-ignore-without-git", { ".gitignore": "ignored/\n*.log\n", "ignored/x.ts": "alpha ignored\n", "app.log": "alpha log\n" }, [
	grep({ pattern: "alpha" }, unordered(["ignored/x.ts", "app.log"], "Found 2 files\n")),
]);

const searchError = "Search failed \u2014 ripgrep rejected the pattern, glob, or file type without searching:\n";
behavior("grep-validation-and-search-errors", { "a.txt": "alpha\n" }, [
	grep({ pattern: "alpha", output_mode: "bogus" }, exact(`<tool_use_error>InputValidationError: ${JSON.stringify([{
		code: "invalid_value", values: ["content", "files_with_matches", "count"], path: ["output_mode"],
		message: 'Invalid option: expected one of "content"|"files_with_matches"|"count"',
	}], null, 2)}</tool_use_error>`), true),
	grep({ pattern: "alpha", head_limit: -1 }, exact("<tool_use_error>head_limit must be a whole number of 0 or more, got -1. Pass 0 for unlimited.</tool_use_error>"), true),
	grep({ pattern: "alpha", offset: -1 }, exact("<tool_use_error>offset must be a whole number of 0 or more, got -1.</tool_use_error>"), true),
	grep({}, exact("<tool_use_error>InputValidationError: Grep failed due to the following issue:\nThe required parameter `pattern` is missing</tool_use_error>"), true),
	grep({ pattern: "alpha", type: "nope" }, exact(`${searchError}rg: unrecognized file type: nope`), true),
	grep({ pattern: "(foo" }, exact(`${searchError}rg: regex parse error:\n    (?:(foo)\n    ^\nerror: unclosed group`), true),
	grep({ pattern: "alpha", path: "nonexistent" }, `"${encoded("Path does not exist: nonexistent. Note: your current working directory is ")}[^"]+${encoded(".")}"`, true),
]);

const refusing = `"${encoded("Refusing to search ")}[^"]+/locked${encoded(": it could not be opened (EACCES) \u2014 it is unreadable, or is being replaced concurrently.")}"`;
behavior("unreadable-targets-and-partial-search", { "locked/z.txt": "needle\n", "ok.txt": "needle\n" }, [
	glob({ pattern: "*", path: "locked" }, refusing, true),
	grep({ pattern: "needle", path: "locked" }, refusing, true),
	grep({ pattern: "needle", path: "locked/z.txt" }, `"${encoded("EACCES: permission denied, stat '")}[^"]+/locked/z\\.txt'"`, true),
	grep({ pattern: "needle" }, exact("Found 1 file\nok.txt")),
	grep({ pattern: "zzznomatch" }, noFiles),
	grep({ pattern: "zzznomatch", output_mode: "content" }, noMatches),
	grep({ pattern: "zzznomatch", output_mode: "count" }, exact("No matches found\n\nFound 0 total occurrences across 0 files.")),
	grep({ pattern: "needle", output_mode: "content" }, exact("ok.txt:1:needle")),
	grep({ pattern: "needle", output_mode: "count" }, exact("ok.txt:1\n\nFound 1 total occurrence across 1 file.")),
	{ turn: bash("chmod 755 locked && printf SEARCH_FIXTURE_RESTORED"), expected: exact("SEARCH_FIXTURE_RESTORED"), error: false },
], "chmod 000 locked");
behavior("grep-fifo-timeout", {}, [
	grep({ pattern: "needle", path: "search-fifo" }, exact("Ripgrep search timed out after 20 seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern."), true),
	{ turn: bash("unlink search-fifo && printf SEARCH_FIFO_REMOVED"), expected: exact("SEARCH_FIFO_REMOVED"), error: false },
], "mkfifo search-fifo");
const wide = { "wide.txt": Array.from({ length: 400 }, (_, i) => `needle ${i} ${"z".repeat(100)}\n`).join("") };
const persisted = (size, first) => `"${encoded(`<persisted-output>\nOutput too large (${size}KB). Full output saved to: `)}[^"]+/tool-results/toolu_conformance_0_0\\.txt${encoded(`\n\nPreview (first 2KB):\n${first}`)}${jsonChar}*${encoded("\n...\n</persisted-output>")}"`;
const persistedFileCheck = (numbered) => ({
	turn: bash(`file=$(find "$HOME/.." -type f -path '*/tool-results/toolu_conformance_0_0.txt' -print -quit); if [ -n "$file" ] && grep -q '^${numbered ? "250:" : ""}needle 249 ' "$file" && ! grep -q '^${numbered ? "251:" : ""}needle 250 ' "$file"; then printf PERSISTED_SEARCH_OK; else printf PERSISTED_SEARCH_MISSING; fi`),
	expected: exact("PERSISTED_SEARCH_OK"), error: false,
});
behavior("grep-persisted-output-numbered", wide, [
	grep({ pattern: "needle", path: "wide.txt", output_mode: "content" }, persisted("28.2", `1:needle 0 ${"z".repeat(100)}\n`)),
	persistedFileCheck(true),
], undefined, opt, { CLAUDE_CODE_TMPDIR: "$TMP" });
behavior("grep-persisted-output-unnumbered", wide, [
	grep({ pattern: "needle", path: "wide.txt", output_mode: "content", "-n": false }, persisted("27.3", `needle 0 ${"z".repeat(100)}\n`)),
	persistedFileCheck(false),
], undefined, opt, { CLAUDE_CODE_TMPDIR: "$TMP" });

if (checking) {
	for (const name of ["Glob", "Grep"]) {
		const pattern = new RegExp(schemaPattern(name));
		const description = "x".repeat(name === "Glob" ? 140 : 477);
		for (const order of ["captured", "typebox"]) {
			const properties = Object.fromEntries(schemaProperties[name].map(([key, type, values]) => [key, {
				...(order === "captured" ? { description: "Fixture description", type } : { type, description: "Fixture description" }),
				...(values ? { enum: values } : {}),
			}]));
			const schema = order === "captured" ? {
				$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required: ["pattern"], additionalProperties: false,
			} : {
				type: "object", required: ["pattern"], properties, additionalProperties: false, $schema: "https://json-schema.org/draft/2020-12/schema",
			};
			const declaration = { name, description, input_schema: schema };
			assert(pattern.test(JSON.stringify(declaration)), "Both schema key orders retain identical structure");
			assert(!pattern.test(JSON.stringify({ ...declaration, strict: false })), "Extra eager-tool keys must not match");
			assert(!pattern.test(JSON.stringify({ ...declaration, description: `${description}x` })), "Tool description length must match");
			for (const key of ["$schema", "required", "additionalProperties"]) {
				const incomplete = { ...schema };
				delete incomplete[key];
				assert(!pattern.test(JSON.stringify({ ...declaration, input_schema: incomplete })), `Missing ${key} must not match`);
			}
			assert(!pattern.test(JSON.stringify({ ...declaration, input_schema: { ...schema, properties: Object.fromEntries(Object.entries(properties).reverse()) } })), "Property declaration order must match");
			assert(!pattern.test(JSON.stringify({ ...declaration, input_schema: { ...schema, required: [] } })), "Required parameters must match");
			assert(!pattern.test(JSON.stringify({ ...declaration, input_schema: { ...schema, additionalProperties: true } })), "Additional properties must remain forbidden");
		}
	}
	const text = 'needle "quoted" {braces}\nsecond line';
	for (const error of [false, true]) {
		const pattern = new RegExp(resultPattern(0, exact(text), error));
		for (const content of [text, [{ type: "text", text }], [{ text, type: "text" }]]) {
			const result = { type: "tool_result", tool_use_id: "toolu_conformance_0_0", content, is_error: error };
			assert(pattern.test(JSON.stringify(result)), "Exact tool text accepts both wire encodings");
			assert(!pattern.test(JSON.stringify({ ...result, tool_use_id: "wrong_id" })), "Tool-use ID must match");
			assert(!pattern.test(JSON.stringify({ ...result, is_error: !error })), "Error status must match");
			assert(!pattern.test(JSON.stringify({ ...result, content: "wrong text" })), "Tool text must match");
			assert(!pattern.test(JSON.stringify({ ...result, content: [{ type: "text", text: "wrong text" }] })), "Block text must match");
			assert(!pattern.test(JSON.stringify({ ...result, content: [{ type: "text", text }, { type: "text", text: "extra" }] })), "Extra blocks must not match");
		}
	}
}
console.log(`${checking ? "Checked" : "Generated"} ${rows.length} two-sided Grep/Glob fixtures.`);
