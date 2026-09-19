import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contextForPatchSize } from "./assemble-review-patches.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const RANGE = join(HERE, "review-range.mjs");
const ASSEMBLE = join(HERE, "assemble-review-patches.mjs");
const repo = mkdtempSync(join(tmpdir(), "review-patches-"));

const git = (...args) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

try {
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "core.autocrlf", "false");
	writeFileSync(join(repo, "base.txt"), "base\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	mkdirSync(join(repo, "src"));
	mkdirSync(join(repo, ".rpiv", "artifacts", "reviews"), { recursive: true });
	writeFileSync(
		join(repo, ".rpiv", "artifacts", "reviews", "self.md"),
		"generated review\n",
	);
	for (let i = 0; i < 61; i += 1) {
		writeFileSync(
			join(repo, "src", `file-${i}.ts`),
			`export const value${i} = ${i};\n`,
		);
	}
	git("add", ".");
	git("commit", "-q", "-m", "large change");
	const rangeOutput = execFileSync("node", [RANGE, "commit"], {
		cwd: repo,
		encoding: "utf8",
	});
	const manifestPath = rangeOutput.match(
		/^changed_files_manifest:\s+(.+)$/m,
	)?.[1];
	assert.ok(manifestPath, "range helper emits the manifest path");
	const assembled = JSON.parse(
		execFileSync("node", [ASSEMBLE, manifestPath], {
			cwd: repo,
			encoding: "utf8",
		}),
	);
	assert.ok(
		assembled.patches.length > 1,
		"large change creates multiple patch files",
	);
	for (const patch of assembled.patches) {
		assert.equal(patch.category, "source");
		assert.ok(
			existsSync(join(repo, patch.path)),
			`patch exists: ${patch.path}`,
		);
		assert.ok([10, 30].includes(patch.context), "patch context is explicit");
		const text = readFileSync(join(repo, patch.path), "utf8");
		for (const file of patch.files)
			assert.ok(text.includes(file), `${patch.id} contains ${file}`);
	}
	const manifest = JSON.parse(readFileSync(join(repo, manifestPath), "utf8"));
	assert.match(manifest.commitMessages, /large change/);
	assert.match(manifest.stat, /src\/file-0\.ts/);
	assert.match(manifest.stat, /src\/file-60\.ts/);
	assert.doesNotMatch(manifest.stat, /self\.md/);
	writeFileSync(
		join(repo, "src", "file-0.ts"),
		"export const value0 = 0;\nexport const workingEdit = true;\n",
	);
	const workingOutput = execFileSync("node", [RANGE, "working"], {
		cwd: repo,
		encoding: "utf8",
	});
	const workingManifestPath = workingOutput.match(
		/^changed_files_manifest:\s+(.+)$/m,
	)?.[1];
	assert.ok(workingManifestPath);
	const working = JSON.parse(
		execFileSync("node", [ASSEMBLE, workingManifestPath], {
			cwd: repo,
			encoding: "utf8",
		}),
	);
	assert.equal(working.patches.length, 1);
	assert.match(
		readFileSync(join(repo, working.patches[0].path), "utf8"),
		/workingEdit/,
	);
	const workingManifest = JSON.parse(
		readFileSync(join(repo, workingManifestPath), "utf8"),
	);
	assert.equal(workingManifest.commitMessages, "(n/a)");
	assert.match(workingManifest.stat, /src\/file-0\.ts/);
	git("reset", "--hard", "-q");
	writeFileSync(join(repo, "named-a.ts"), "export const namedA = true;\n");
	git("add", ".");
	git("commit", "-q", "-m", "named A");
	const namedA = git("rev-parse", "HEAD");
	writeFileSync(
		join(repo, "unnamed-middle.ts"),
		"export const middle = true;\n",
	);
	git("add", ".");
	git("commit", "-q", "-m", "unnamed middle");
	writeFileSync(join(repo, "named-c.ts"), "export const namedC = true;\n");
	git("add", ".");
	git("commit", "-q", "-m", "named C");
	const namedC = git("rev-parse", "HEAD");
	const namedOutput = execFileSync("node", [RANGE, `${namedA},${namedC}`], {
		cwd: repo,
		encoding: "utf8",
	});
	const namedManifestPath = namedOutput.match(
		/^changed_files_manifest:\s+(.+)$/m,
	)?.[1];
	assert.ok(namedManifestPath);
	const named = JSON.parse(
		execFileSync("node", [ASSEMBLE, namedManifestPath], {
			cwd: repo,
			encoding: "utf8",
		}),
	);
	const namedPatch = named.patches
		.map((patch) => readFileSync(join(repo, patch.path), "utf8"))
		.join("\n");
	assert.match(namedPatch, /named-a\.ts/);
	assert.match(namedPatch, /named-c\.ts/);
	assert.doesNotMatch(namedPatch, /unnamed-middle\.ts|unnamed middle/);
	writeFileSync(join(repo, "large-line.ts"), `${"a".repeat(600_000)}\n`);
	git("add", ".");
	git("commit", "-q", "-m", "large line baseline");
	writeFileSync(join(repo, "large-line.ts"), `${"b".repeat(600_000)}\n`);
	const largeOutput = execFileSync("node", [RANGE, "working"], {
		cwd: repo,
		encoding: "utf8",
	});
	const largeManifestPath = largeOutput.match(
		/^changed_files_manifest:\s+(.+)$/m,
	)?.[1];
	assert.ok(largeManifestPath);
	const large = JSON.parse(
		execFileSync("node", [ASSEMBLE, largeManifestPath], {
			cwd: repo,
			encoding: "utf8",
		}),
	);
	assert.equal(
		large.patches[0].context,
		10,
		"patches above 1 MB retry with bounded context",
	);
	assert.ok(
		large.patches[0].bytes > 1_000_000,
		"large patch is captured without spawn buffer failure",
	);
	assert.equal(contextForPatchSize(1_000_000), 30);
	assert.equal(contextForPatchSize(1_000_001), 10);
	console.log(
		"OK — review patches are assembled per manifest shard with bounded context.",
	);
} finally {
	rmSync(repo, { recursive: true, force: true });
}
