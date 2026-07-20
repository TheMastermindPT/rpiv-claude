// likec4-conformance-gate.test.mjs — tests for the Level-3 conformance gate.
//
//   node skills/architectural-review/_helpers/likec4-conformance-gate.test.mjs   (prints OK, or throws)
//
// Builds model + graph fixtures that drive the wrapped likec4-conformance.mjs to specific
// undocumented/aspirational/status outputs, then asserts the gate's exit code + listing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "likec4-conformance-gate.mjs");
const tmp = mkdtempSync(join(tmpdir(), "c4gate-"));

const writeJson = (name, obj) => {
	const p = join(tmp, name);
	writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
	return p;
};
const runGate = (argv) => spawnSync("node", [GATE, ...argv], { encoding: "utf-8" });

// A covered model: svc(dir a) -> db(dir b) declared; the code edge a/x.ts -> b/y.ts is covered.
const modelCovered = writeJson("m-covered.json", { elements: { svc: { kind: "container", title: "svc", metadata: { dir: "a" } }, db: { kind: "container", title: "db", metadata: { dir: "b" } } }, relations: { r1: { source: "svc", target: "db", title: "reads" } } });
const graphCovered = writeJson("g-covered.json", { "a/x.ts": ["b/y.ts"] });
// Undocumented: three mapped elements, NO declared rels; two cross-element code edges.
const modelUndoc = writeJson("m-undoc.json", { elements: { svc: { metadata: { dir: "a" } }, db: { metadata: { dir: "b" } }, api: { metadata: { dir: "c" } } }, relations: {} });
const graphUndoc = writeJson("g-undoc.json", { "a/x.ts": ["b/y.ts", "c/z.ts"] });
// Aspirational: svc -> db declared but the only code edge is intra-svc (no covering edge).
const modelAsp = writeJson("m-asp.json", { elements: { svc: { metadata: { dir: "a" } }, db: { metadata: { dir: "b" } } }, relations: { r1: { source: "svc", target: "db", title: "reads" } } });
const graphAsp = writeJson("g-asp.json", { "a/x.ts": ["a/y.ts"] });

// 1. gate exits 0 when undocumented <= threshold ("OK").
{
	const ok = runGate(["--model", modelCovered, "--graph", graphCovered, "--max-undocumented", "0"]);
	assert.equal(ok.status, 0, `pass under threshold exits 0 (stderr: ${ok.stderr})`);
	assert.match(ok.stderr, /likec4-conformance-gate: OK/, "OK message");
	assert.match(ok.stderr, /undocumented 0 <= 0/, "reports the count");
	console.log("OK — gate passes under threshold.");
}

// 2. gate exits 1 when undocumented > threshold, listing the offending edges.
{
	const fail = runGate(["--model", modelUndoc, "--graph", graphUndoc, "--max-undocumented", "0"]);
	assert.equal(fail.status, 1, "over threshold exits 1");
	assert.match(fail.stderr, /^FAIL/m, "starts with FAIL");
	assert.match(fail.stderr, /2 undocumented edge\(s\) \(max 0\)/, "names the count");
	assert.match(fail.stderr, /\n {2}\S+ -> \S+/, "lists an offending edge indented");
	assert.equal(runGate(["--model", modelUndoc, "--graph", graphUndoc, "--max-undocumented", "2"]).status, 0, "same fixture at --max-undocumented 2 exits 0");
	console.log("OK — gate fails over threshold, passes at the raised threshold.");
}

// 3. gate degrades to exit 0 (SKIP) when conformance can't compute.
{
	const bogus = writeJson("m-bogus.json", "not json");
	const deg = runGate(["--model", bogus, "--graph", graphCovered]);
	assert.equal(deg.status, 0, "degraded exits 0 (SKIP, never a failure)");
	assert.match(deg.stderr, /SKIP/, "SKIP message");
	assert.match(deg.stderr, /degraded/, "names degraded");
	console.log("OK — gate skips on degraded conformance.");
}

// 4. optional aspirational threshold — the FAIL listing shows the aspirational block.
{
	assert.equal(runGate(["--model", modelAsp, "--graph", graphAsp, "--max-undocumented", "0"]).status, 0, "aspirational default Infinity -> exit 0");
	const failAsp = runGate(["--model", modelAsp, "--graph", graphAsp, "--max-undocumented", "0", "--max-aspirational", "0"]);
	assert.equal(failAsp.status, 1, "aspirational over threshold -> exit 1");
	assert.match(failAsp.stderr, /1 aspirational \(max 0\)/, "names the aspirational count");
	assert.match(failAsp.stderr, /\n {2}svc -> db/, "lists the aspirational edge (not the undocumented placeholder)");
	console.log("OK — gate aspirational threshold.");
}

// 5. usage error on missing required args.
{
	const usage = runGate(["--graph", graphCovered]);
	assert.equal(usage.status, 2, "missing --model exits 2");
	assert.match(usage.stderr, /^usage:/, "usage on stderr");
	console.log("OK — gate usage error on missing args.");
}

rmSync(tmp, { recursive: true, force: true });
console.log("OK");
