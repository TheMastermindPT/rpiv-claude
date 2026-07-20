// run-eval.test.mjs — focused unit test for the dual-file copy helper (Slice 7).
//
//   node evals/harness/run-eval.test.mjs   (prints OK, or throws)
//
// Importing run-eval.mjs is safe: its runner flow is guarded behind isMain, so only the
// exported copyArtifactOutputs helper loads here.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyArtifactOutputs } from "./run-eval.mjs";

// 1. a discovered .md with a sibling .json -> BOTH copied into outputs/.
{
	const tmp = mkdtempSync(join(tmpdir(), "run-eval-"));
	const src = join(tmp, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "x.md"), "# review\n");
	writeFileSync(join(src, "x.json"), '{"schema":1}\n');
	const out = join(tmp, "outputs");
	mkdirSync(out, { recursive: true });
	copyArtifactOutputs(join(src, "x.md"), out);
	assert.ok(existsSync(join(out, "artifact.md")), "artifact.md copied");
	assert.ok(existsSync(join(out, "artifact.json")), "sibling artifact.json copied");
	rmSync(tmp, { recursive: true, force: true });
	console.log("OK — copyArtifactOutputs: copies the .md AND its sibling .json.");
}

// 2. no sibling .json -> only .md is copied, no throw.
{
	const tmp = mkdtempSync(join(tmpdir(), "run-eval-"));
	const src = join(tmp, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "y.md"), "# review\n");
	const out = join(tmp, "outputs");
	mkdirSync(out, { recursive: true });
	copyArtifactOutputs(join(src, "y.md"), out);
	assert.ok(existsSync(join(out, "artifact.md")), "artifact.md copied");
	assert.ok(!existsSync(join(out, "artifact.json")), "no artifact.json when there is no sibling");
	rmSync(tmp, { recursive: true, force: true });
	console.log("OK — copyArtifactOutputs: no sibling -> only .md, no throw.");
}

console.log("OK");
