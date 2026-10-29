import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-no-anthropic-deps.mjs", import.meta.url));

async function check(t, files) {
	const root = await mkdtemp(join(tmpdir(), "pi-no-anthropic-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, contents] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("rejects an Anthropic package in any workspace manifest", async (t) => {
	const result = await check(t, {
		"package.json": { dependencies: { "@anthropic-ai/sdk": "0.129.0" } },
		"packages/example/package.json": { devDependencies: { "@anthropic-ai/sandbox-runtime": "0.0.26" } },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json:\d+: @anthropic-ai\/sdk/);
	assert.match(result.stderr, /packages\/example\/package\.json:\d+: @anthropic-ai\/sandbox-runtime/);
});

test("rejects an Anthropic package carried only by a lockfile", async (t) => {
	const result = await check(t, {
		"package-lock.json": {
			packages: { "node_modules/@anthropic-ai/sdk": { version: "0.129.0" } },
		},
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /package-lock\.json:\d+: @anthropic-ai\/sdk/);
});

test("accepts manifests without Anthropic packages and ignores installed copies", async (t) => {
	const result = await check(t, {
		"package.json": { dependencies: { "@earendil-works/pi-ai": "1.0.0", "@anthropic-fork/sdk": "1.0.0" } },
		"packages/example/package.json": { name: "example" },
		"node_modules/@anthropic-ai/sdk/package.json": { name: "@anthropic-ai/sdk" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /No manifest names an Anthropic package\./);
});
