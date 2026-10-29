import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A manifest at any depth counts, except inside these: node_modules holds third-party
// manifests, .git and dist hold copies.
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const manifestNames = new Set(["package.json", "package-lock.json"]);
const anthropicPackage = /@anthropic-ai\/[A-Za-z0-9._-]+/;
const manifests = [];

function collectManifests(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectManifests(join(directory, entry.name));
			continue;
		}

		if (entry.isFile() && manifestNames.has(entry.name)) {
			manifests.push(join(directory, entry.name));
		}
	}
}

const failures = [];

collectManifests(".");

for (const file of manifests.sort()) {
	const lines = readFileSync(file, "utf8").split("\n");
	for (const [index, line] of lines.entries()) {
		const match = anthropicPackage.exec(line);
		if (match) failures.push(`${file}:${index + 1}: ${match[0]}`);
	}
}

if (failures.length > 0) {
	console.error("Manifests must not name Anthropic packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	console.error("A pi-native replacement belongs in its own change.");
	process.exit(1);
}
console.log("No manifest names an Anthropic package.");
