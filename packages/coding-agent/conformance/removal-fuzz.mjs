import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionState } from "../src/core/permissions/context.ts";
import { evaluatePermission } from "../src/core/permissions/evaluate.ts";

const directory = dirname(fileURLToPath(import.meta.url));
export const SEED = 0x50404;

export function corpus(seed = SEED) {
	if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error("Seed must be a nonzero uint32");
	let state = seed >>> 0;
	const pick = (items) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return items[(state >>> 0) % items.length];
	};
	const lines = new Set([
		"X=$HOME; rmdir $X",
		"X=~; rmdir $X",
		"X=/usr; rmdir '$X'",
		"X=/usr; rmdir \\$X",
		"true <<EOF\n$(rmdir /usr)\nEOF",
		"rmdir /tmp/p04-fuzz-does-not-exist/..",
	]);
	const values = [".", "..", "/usr", "/", "~", "$HOME", "${HOME}", "'$HOME'", '"$HOME"', "\\$HOME", "'*'", "\"*\"", "sub", "p04-fuzz-does-not-exist", "''"];
	const targets = [".", "..", "*", '"*"', "~", "/usr", "/", "$HOME", "sub", "sub/..", "p04-fuzz-does-not-exist", "p04-fuzz-does-not-exist/..", "$X", '"$X"', "'$X'", "\\$X", "${X}/", "$X/usr"];
	const keywords = ["", "export ", "local ", "readonly ", "declare ", "typeset "];
	const separators = ["; ", " && ", " || ", " | ", " & ", "\n"];
	for (let depth = 0; depth <= 8; depth++) {
		for (const count of [0, 63, 64, 65]) {
			let inner = `: ${Array(count).fill("$(:)").join(" ")}`;
			for (let level = 0; level < depth; level++) inner = `: $(${inner})`;
			lines.add(`true $(${inner})`);
		}
	}
	while (lines.size < 512) {
		const assignment = `${pick(keywords)}X=${pick(values)}`;
		const removal = `rmdir ${pick(targets)}`;
		const plain = `${assignment}${pick(separators)}${removal}`;
		const forms = [
			plain,
			`(${plain})`,
			`{ ${plain}; }`,
			`if true; then ${plain}; fi`,
			`for Y in one; do ${plain}; done`,
			`while true; do ${plain}; break; done`,
			`case one in one) ${plain};; esac`,
			`f() { ${plain}; }; true`,
			`true $(${plain})`,
			`true \`${plain}\``,
			`true <(${plain})`,
			`true >(${plain})`,
			`true \${ ${plain}; }`,
			`true <<EOF\n$(${plain})\nEOF`,
			`true <<'EOF'\n$(${plain})\nEOF`,
		];
		lines.add(pick(forms));
	}
	return [...lines];
}

export function evaluate(command, cwd, home) {
	const context = new PermissionState({ cwd, home, cliMode: "bypassPermissions" }).current();
	const { decision } = evaluatePermission({ name: "Bash", input: { command } }, context);
	return decision.behavior === "allow"
		? { behavior: "allow" }
		: { behavior: decision.behavior, message: decision.message };
}

const mode = process.argv[2];
if (mode === "generate") {
	const seed = Number(process.argv[3] ?? SEED);
	const lines = corpus(seed);
	writeFileSync(join(directory, "removal-fuzz-corpus.json"), `${JSON.stringify({ seed, lines }, null, "\t")}\n`);
	const cases = join(directory, "cases", "removal-fuzz");
	mkdirSync(cases, { recursive: true });
	for (let offset = 0; offset < lines.length; offset += 32) {
		const batch = lines.slice(offset, offset + 32);
		const id = `removal-fuzz/batch-${String(offset / 32).padStart(2, "0")}`;
		const testCase = {
			id, area: "removal-fuzz",
			argv: ["-p", "Run permission probes", "--model", "claude-opus-4-7", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
			env: { CLAUDE_CODE_TMPDIR: "$TMP" }, stdin: null,
			files: { "seed.txt": "SEED\n", "sub/seed.txt": "SUB\n" },
			model: { turns: [{ tool_uses: batch.map(command => ({ name: "Bash", input: { command } })) }, { text: "FUZZ_DONE" }] },
			timeout_ms: 120000,
			compare: { exit: 0, stdout: { kind: "text", match: ["FUZZ_DONE"] }, requests: [{ pathStartsWith: "/v1/messages", count: 2 }], files: [] }, skip: [],
		};
		writeFileSync(join(cases, `batch-${String(offset / 32).padStart(2, "0")}.json`), `${JSON.stringify(testCase, null, "\t")}\n`);
	}
	console.log(`seed ${seed}, ${lines.length} lines, ${Math.ceil(lines.length / 32)} harness sessions per side`);
}

if (mode === "record") {
	const report = JSON.parse(readFileSync(join(directory, ".out/report.json"), "utf8"));
	if (!report.claude?.frozen || report.aborted) throw new Error("Pinned oracle and isolation gate required");
	const generated = JSON.parse(readFileSync(join(directory, "removal-fuzz-corpus.json"), "utf8"));
	const fixtures = [];
	const differences = [];
	for (let batch = 0; batch < 16; batch++) {
		const id = `removal-fuzz/batch-${String(batch).padStart(2, "0")}`;
		if (report.cases.find(testCase => testCase.id === id)?.verdict !== "PASS") throw new Error(`Incomplete harness batch ${id}`);
		const root = realpathSync(join(report.run_root, id, "claude"));
		const requests = readFileSync(join(root, "out/requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		const response = requests.filter(request => request.path.split("?")[0] === "/v1/messages").at(-1);
		const blocks = response.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
		const results = blocks.filter(block => block.type === "tool_result");
		const uses = blocks.filter(block => block.type === "tool_use");
		for (let index = 0; index < 32; index++) {
			const command = generated.lines[batch * 32 + index];
			const toolId = `toolu_conformance_0_${index}`;
			if (uses.find(block => block.id === toolId)?.input.command !== command) throw new Error(`Corpus changed since oracle run ${id}/${index}`);
			const result = results.find(block => block.tool_use_id === toolId);
			if (!result) throw new Error(`Missing result ${id}/${index}`);
			const content = typeof result.content === "string" ? result.content : result.content.map(block => block.text ?? "").join("\n");
			const refusal = content.search(/^(?:Dangerous |This command (?:contains |could not be )|This Bash command contains |Permission to use )/m);
			const expected = refusal < 0 ? { behavior: "allow" } : { behavior: "ask", message: content.slice(refusal).split("<system-reminder>")[0].replace(/<\/tool_use_error>\s*$/, "").trim() };
			const actual = evaluate(command, join(root, "workspace"), join(root, "home"));
			const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(join(root, "workspace"), "$WORKSPACE").replaceAll(join(root, "home"), "$HOME").replaceAll(root, "$CASE"));
			const entry = normalize({ command, expected, toolResult: content });
			fixtures.push(entry);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push(normalize({ command, expected, actual }));
		}
	}
	writeFileSync(join(directory, "removal-fuzz-fixtures.json"), `${JSON.stringify({ seed: generated.seed, oracle: report.claude, run: report.run, entries: fixtures }, null, "\t")}\n`);
	writeFileSync(join(directory, ".out/removal-fuzz-differences.json"), `${JSON.stringify(differences, null, "\t")}\n`);
	console.log(`${fixtures.length} oracle observations, ${differences.length} differences`);
	process.exitCode = differences.length === 0 ? 0 : 1;
}
