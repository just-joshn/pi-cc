import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createCcEditToolDefinition } from "../src/core/tools/cc/edit.ts";
import { createCcReadToolDefinition } from "../src/core/tools/cc/read.ts";
import { createReadState } from "../src/core/tools/cc/read-state.ts";
import { CC_TOOL_ERRORS, toolUseError } from "../src/core/tools/cc/tool-error.ts";
import { createCcWriteToolDefinition } from "../src/core/tools/cc/write.ts";

const FILE_STATE = "(file state is current in your context — no need to Read it back)";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-cc-file-tools-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface ToolOptions {
	gated?: boolean;
	agentContext?: boolean;
}

function makeTools(options: ToolOptions = {}) {
	const readState = createReadState();
	const isReadGated = () => options.gated === true;
	return {
		readState,
		read: createCcReadToolDefinition(dir, { readState }),
		edit: createCcEditToolDefinition(dir, { readState, isReadGated }),
		write: createCcWriteToolDefinition(dir, { readState, isReadGated, agentContext: options.agentContext }),
	};
}

function callContext(): ExtensionToolContext {
	return { cwd: dir } as ExtensionToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the tool call to fail");
}

function envelope(inner: string): string {
	return `<tool_use_error>${inner}</tool_use_error>`;
}

function writeFixture(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

/** Moves a file's mtime past the recorded read, as another editor or a formatter would. */
function touchIntoFuture(path: string): void {
	const future = new Date(Date.now() + 60_000);
	utimesSync(path, future, future);
}

describe("cc Read", () => {
	it("numbers a single line and the trailing newline as an empty second line", async () => {
		writeFixture("probe.txt", "PROBE_TOOL_FIXTURE_CONTENT_7f3a\n");
		const tools = makeTools();

		const result = await tools.read.execute(
			"read-1",
			{ file_path: "probe.txt" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe("1\tPROBE_TOOL_FIXTURE_CONTENT_7f3a\n2\t");
	});

	it("leaves line numbers unpadded and a last line without a newline unnumbered", async () => {
		writeFixture("lines.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk");
		const tools = makeTools();

		const result = await tools.read.execute(
			"read-2",
			{ file_path: "lines.txt" },
			undefined,
			undefined,
			callContext(),
		);

		const numbered = Array.from({ length: 11 }, (_, index) => `${index + 1}\t${"abcdefghijk"[index]}`).join("\n");
		expect(textOf(result)).toBe(numbered);
	});

	it("starts the numbering at offset and stops after limit lines", async () => {
		writeFixture("paged.txt", "a\nb\nc\nd\n");
		const tools = makeTools();

		const result = await tools.read.execute(
			"read-3",
			{ file_path: "paged.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe("2\tb\n3\tc");
	});

	it("omits pi's remaining-lines notice when limit stops before the end", async () => {
		writeFixture("stopped.txt", "a\nb\nc\nd\n");
		const tools = makeTools();

		const result = await tools.read.execute(
			"read-3b",
			{ file_path: "stopped.txt", offset: 1, limit: 2 },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe("1\ta\n2\tb");
	});

	it("omits pi's continuation notice when the read is truncated", async () => {
		writeFixture("long.txt", `${Array.from({ length: 2100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
		const tools = makeTools();

		const result = await tools.read.execute("read-4", { file_path: "long.txt" }, undefined, undefined, callContext());

		const text = textOf(result);
		expect(text).not.toContain("Use offset=");
		const lines = text.split("\n");
		expect(lines).toHaveLength(2000);
		expect(lines[0]).toBe("1\tline 1");
		expect(lines[1999]).toBe("2000\tline 2000");
	});

	it("records the file so a later Edit does not need approval", async () => {
		const path = writeFixture("recorded.txt", "OLD\n");
		const tools = makeTools({ gated: true });

		await tools.read.execute("read-5", { file_path: "recorded.txt" }, undefined, undefined, callContext());
		expect(tools.readState.get(path)?.content).toBe("OLD\n");

		const result = await tools.edit.execute(
			"edit-5",
			{ file_path: "recorded.txt", old_string: "OLD", new_string: "NEW" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(`The file recorded.txt has been updated successfully. ${FILE_STATE}`);
		expect(readFileSync(path, "utf-8")).toBe("NEW\n");
	});

	it("reports a missing file in the tool_use_error envelope", async () => {
		const tools = makeTools();

		const message = await failureOf(
			tools.read.execute("read-6", { file_path: "absent.txt" }, undefined, undefined, callContext()),
		);

		expect(message).toBe(envelope(`File does not exist. Note: your current working directory is ${dir}.`));
	});

	it("reports a directory path in the tool_use_error envelope", async () => {
		mkdirSync(join(dir, "folder"));
		const tools = makeTools();

		const message = await failureOf(
			tools.read.execute("read-7", { file_path: "folder" }, undefined, undefined, callContext()),
		);

		expect(message).toBe(envelope(`EISDIR: illegal operation on a directory, read '${join(dir, "folder")}'`));
	});
});

describe("cc Edit", () => {
	it("reports the updated sentence", async () => {
		const path = writeFixture("edit_fixture.txt", "PROBE_EDIT_OLD\n");
		const tools = makeTools();

		const result = await tools.edit.execute(
			"edit-1",
			{ file_path: "edit_fixture.txt", old_string: "PROBE_EDIT_OLD", new_string: "PROBE_EDIT_NEW" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(`The file edit_fixture.txt has been updated successfully. ${FILE_STATE}`);
		expect(readFileSync(path, "utf-8")).toBe("PROBE_EDIT_NEW\n");
	});

	it("reports a string that is not in the file", async () => {
		writeFixture("missing.txt", "present\n");
		const tools = makeTools();

		const message = await failureOf(
			tools.edit.execute(
				"edit-2",
				{ file_path: "missing.txt", old_string: "absent", new_string: "x" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(envelope("String to replace not found in file.\nString: absent"));
	});

	it("reports every match of a duplicated string and refuses without replace_all", async () => {
		writeFixture("dup.txt", "dup\ndup\n");
		const tools = makeTools();

		const message = await failureOf(
			tools.edit.execute(
				"edit-3",
				{ file_path: "dup.txt", old_string: "dup", new_string: "x" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(toolUseError(CC_TOOL_ERRORS.multipleMatches(2, "dup")));
		expect(message).toBe(
			envelope(
				`Found 2 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: dup`,
			),
		);
	});

	it("reports an edit that changes nothing", async () => {
		writeFixture("same.txt", "same\n");
		const tools = makeTools();

		const message = await failureOf(
			tools.edit.execute(
				"edit-4",
				{ file_path: "same.txt", old_string: "same", new_string: "same" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(envelope("No changes to make: old_string and new_string are exactly the same."));
	});

	it("replaces every occurrence with replace_all", async () => {
		const path = writeFixture("all.txt", "dup one\ndup two\ndup three\n");
		const tools = makeTools();

		const result = await tools.edit.execute(
			"edit-5",
			{ file_path: "all.txt", old_string: "dup", new_string: "item", replace_all: true },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(
			`The file all.txt has been updated. All occurrences were successfully replaced. ${FILE_STATE}`,
		);
		expect(readFileSync(path, "utf-8")).toBe("item one\nitem two\nitem three\n");
	});

	it("creates a file with an empty old_string", async () => {
		const path = join(dir, "created.txt");
		const tools = makeTools();

		const result = await tools.edit.execute(
			"edit-6",
			{ file_path: "created.txt", old_string: "", new_string: "fresh\n" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(`The file created.txt has been updated successfully. ${FILE_STATE}`);
		expect(readFileSync(path, "utf-8")).toBe("fresh\n");
	});

	it("refuses to create a file over an existing non-empty one", async () => {
		writeFixture("taken.txt", "already here\n");
		const tools = makeTools();

		const message = await failureOf(
			tools.edit.execute(
				"edit-7",
				{ file_path: "taken.txt", old_string: "", new_string: "fresh\n" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(envelope("Cannot create new file - file already exists."));
	});

	it("refuses a gated file that was never read", async () => {
		writeFixture("gated.txt", "OLD\n");
		const tools = makeTools({ gated: true });

		const message = await failureOf(
			tools.edit.execute(
				"edit-8",
				{ file_path: "gated.txt", old_string: "OLD", new_string: "NEW" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(envelope("File has not been read yet. Read it first before writing to it."));
	});

	it("edits a file that was never read when its path is not gated", async () => {
		const path = writeFixture("ungated.txt", "OLD\n");
		const tools = makeTools();

		await tools.edit.execute(
			"edit-9",
			{ file_path: "ungated.txt", old_string: "OLD", new_string: "NEW" },
			undefined,
			undefined,
			callContext(),
		);

		expect(readFileSync(path, "utf-8")).toBe("NEW\n");
	});

	it("edits a file twice because the first edit refreshes the read state", async () => {
		const path = writeFixture("twice.txt", "one\n");
		const tools = makeTools({ gated: true });
		await tools.read.execute("edit-11-read", { file_path: "twice.txt" }, undefined, undefined, callContext());

		await tools.edit.execute(
			"edit-11a",
			{ file_path: "twice.txt", old_string: "one", new_string: "two" },
			undefined,
			undefined,
			callContext(),
		);
		await tools.edit.execute(
			"edit-11b",
			{ file_path: "twice.txt", old_string: "two", new_string: "three" },
			undefined,
			undefined,
			callContext(),
		);

		expect(readFileSync(path, "utf-8")).toBe("three\n");
	});

	it("refuses a file that changed after the read", async () => {
		const path = writeFixture("stale.txt", "OLD\n");
		const tools = makeTools({ gated: true });
		await tools.read.execute("edit-12-read", { file_path: "stale.txt" }, undefined, undefined, callContext());
		touchIntoFuture(path);

		const message = await failureOf(
			tools.edit.execute(
				"edit-12",
				{ file_path: "stale.txt", old_string: "OLD", new_string: "NEW" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(
			envelope(
				"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
			),
		);
	});
});

describe("cc Write", () => {
	it("reports a created file", async () => {
		const tools = makeTools();

		const result = await tools.write.execute(
			"write-1",
			{ file_path: "written.txt", content: "PROBE_WRITTEN_CONTENT_9c2e\n" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(`File created successfully at: written.txt ${FILE_STATE}`);
		expect(readFileSync(join(dir, "written.txt"), "utf-8")).toBe("PROBE_WRITTEN_CONTENT_9c2e\n");
	});

	it("reports an overwritten file", async () => {
		const path = writeFixture("existing.txt", "OLD\n");
		const tools = makeTools();

		const result = await tools.write.execute(
			"write-2",
			{ file_path: "existing.txt", content: "NEW\n" },
			undefined,
			undefined,
			callContext(),
		);

		expect(textOf(result)).toBe(`The file existing.txt has been updated successfully. ${FILE_STATE}`);
		expect(readFileSync(path, "utf-8")).toBe("NEW\n");
	});

	it("creates parent directories", async () => {
		const tools = makeTools();

		await tools.write.execute(
			"write-3",
			{ file_path: "nested/deep/file.txt", content: "nested\n" },
			undefined,
			undefined,
			callContext(),
		);

		expect(readFileSync(join(dir, "nested/deep/file.txt"), "utf-8")).toBe("nested\n");
	});

	it("refuses to write a report file from a subagent", async () => {
		const tools = makeTools({ agentContext: true });

		const message = await failureOf(
			tools.write.execute(
				"write-4",
				{ file_path: "REPORT-findings.md", content: "findings\n" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(
			envelope(
				"Subagents should return findings as text, not write report files. Include this content in your final response instead.",
			),
		);
	});

	it("writes a report file outside a subagent", async () => {
		const tools = makeTools();

		await tools.write.execute(
			"write-5",
			{ file_path: "SUMMARY-notes.md", content: "notes\n" },
			undefined,
			undefined,
			callContext(),
		);

		expect(readFileSync(join(dir, "SUMMARY-notes.md"), "utf-8")).toBe("notes\n");
	});

	it("refuses a gated file that was never read", async () => {
		writeFixture("gated.txt", "OLD\n");
		const tools = makeTools({ gated: true });

		const message = await failureOf(
			tools.write.execute(
				"write-6",
				{ file_path: "gated.txt", content: "NEW\n" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(envelope("File has not been read yet. Read it first before writing to it."));
	});

	it("refuses a file that changed after the read", async () => {
		const path = writeFixture("stale.txt", "OLD\n");
		const tools = makeTools({ gated: true });
		await tools.read.execute("write-7-read", { file_path: "stale.txt" }, undefined, undefined, callContext());
		touchIntoFuture(path);

		const message = await failureOf(
			tools.write.execute(
				"write-7",
				{ file_path: "stale.txt", content: "NEW\n" },
				undefined,
				undefined,
				callContext(),
			),
		);

		expect(message).toBe(
			envelope(
				"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
			),
		);
	});
});
