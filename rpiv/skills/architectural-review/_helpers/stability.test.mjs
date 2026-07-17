// stability.test.mjs — folder Martin metrics, SDP violations, Tarjan cycles, and the
// churn x afferent volatile-hub composite, over BOTH graph flavors (depcruise + madge).
// No dependencies; prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const S = join(dirname(fileURLToPath(import.meta.url)), "stability.mjs");
const tmp = mkdtempSync(join(tmpdir(), "stability-"));
let seq = 0;

const write = (name, content) => {
	const p = join(tmp, `${seq += 1}-${name}`);
	writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
	return p;
};
const run = (args) => execFileSync("node", [S, ...args], { encoding: "utf-8" });
const blockOf = (out, label) => {
	const m = out.match(new RegExp(`---${label}---\\n([\\s\\S]*?)(?=---|$)`));
	return m ? m[1].split("\n").filter(Boolean) : null;
};

// Depcruise-shaped graph builder from a plain edge map.
const depcruiseJson = (edgeMap, extraDeps = []) => ({
	modules: Object.entries(edgeMap).map(([source, deps]) => ({
		source,
		dependencies: [
			...deps.map((resolved) => ({ resolved, coreModule: false, couldNotResolve: false })),
			...(source === Object.keys(edgeMap)[0] ? extraDeps : []),
		],
	})),
});

// ── Fixture: layered graph with one clear SDP violation + two cycles ─────────
// ui (I=1.00) -> core (I=0.33) -> flux (I=0.67): core -> flux is the violation
// (delta +0.33). cyc/p <-> cyc/q (2-cycle) and cyc2/r -> s -> t -> r (3-cycle).
const EDGES = {
	"ui/a.ts": ["core/x.ts", "core/y.ts"],
	"ui/b.ts": ["core/x.ts"],
	"core/x.ts": ["flux/f.ts"],
	"core/y.ts": [],
	"flux/f.ts": ["helpers/h1.ts", "helpers/h2.ts"],
	"helpers/h1.ts": [],
	"helpers/h2.ts": [],
	"cyc/p.ts": ["cyc/q.ts"],
	"cyc/q.ts": ["cyc/p.ts"],
	"cyc2/r.ts": ["cyc2/s.ts"],
	"cyc2/s.ts": ["cyc2/t.ts"],
	"cyc2/t.ts": ["cyc2/r.ts"],
};

// ── Case 1: depcruise flavor — metrics, SDP, cycles, hubs ────────────────────
{
	const graph = write("graph.json", depcruiseJson(EDGES));
	const churn = write("churn.txt", "core/x.ts\t5\nhelpers/h1.ts\t7\ncyc/p.ts\t1\n");
	const out = run([`--graph=${graph}`, `--churn=${churn}`]);

	assert.match(out, /flavor: {8}depcruise/);
	const folders = blockOf(out, "folder-instability");
	assert.ok(folders.includes("core\tCa=2\tCe=1\tI=0.33\tmodules=2"), `core row: ${folders}`);
	assert.ok(folders.includes("flux\tCa=1\tCe=2\tI=0.67\tmodules=1"), "flux row");
	assert.ok(folders.includes("ui\tCa=0\tCe=2\tI=1.00\tmodules=2"), "ui row (Ce counts DISTINCT outside modules: core/x + core/y = 2, core/x deduped)");

	const sdp = blockOf(out, "sdp-violations");
	assert.equal(sdp.length, 1, `exactly one SDP violation: ${sdp}`);
	assert.match(sdp[0], /^core -> flux\tI_from=0\.33\tI_to=0\.67\tdelta=\+0\.33\tedges=1\te\.g\. core\/x\.ts -> flux\/f\.ts$/);
	// ui -> core has delta -0.67 (toward stability) and must NOT flag.

	const cyc = blockOf(out, "cycles");
	assert.equal(cyc.length, 2, "two cycles");
	assert.match(cyc[0], /^c1\tsize=3\tcyc2\/r\.ts -> cyc2\/s\.ts -> cyc2\/t\.ts -> cyc2\/r\.ts$/, "3-cycle first (size desc), path reconstructed in edge order");
	assert.match(cyc[1], /^c2\tsize=2\tcyc\/p\.ts -> cyc\/q\.ts -> cyc\/p\.ts$/);

	const hubs = blockOf(out, "volatile-hubs");
	assert.deepEqual(hubs, ["core/x.ts\tchurn=5\tinbound=2\tscore=10"],
		"h1 (inbound=1) and cyc/p (churn=1) fall below the hub floors");
}

// ── Case 2: madge flavor autodetect + no churn -> empty hubs ─────────────────
{
	const graph = write("madge.json", { "a/x.ts": ["b/y.ts"], "b/y.ts": ["a/x.ts"] });
	const out = run([`--graph=${graph}`]);
	assert.match(out, /flavor: {8}madge/);
	assert.equal(blockOf(out, "cycles").length, 1, "cross-folder 2-cycle found");
	assert.deepEqual(blockOf(out, "volatile-hubs"), [], "no churn input -> empty hubs block");
}

// ── Case 3: churn block extracted from a full metrics.mjs output ─────────────
{
	const graph = write("graph.json", depcruiseJson({ "m/a.ts": ["m/b.ts"], "m/b.ts": [], "n/c.ts": ["m/b.ts"] }));
	const metricsOut = write("metrics_out.txt",
		"target: .\nfile_count: 3\n---size-outliers---\nm/a.ts\t900\t9.0x\n---churn-hotspots---\nm/b.ts\t6\n---test-density---\n");
	const out = run([`--graph=${graph}`, `--churn=${metricsOut}`]);
	assert.deepEqual(blockOf(out, "volatile-hubs"), ["m/b.ts\tchurn=6\tinbound=2\tscore=12"],
		"churn parsed from the ---churn-hotspots--- block, not the surrounding blocks");
}

// ── Case 4: --target filters reporting but metrics stay global ───────────────
{
	const graph = write("graph.json", depcruiseJson(EDGES));
	const out = run([`--graph=${graph}`, "--target=core"]);
	const folders = blockOf(out, "folder-instability");
	assert.deepEqual(folders, ["core\tCa=2\tCe=1\tI=0.33\tmodules=2"],
		"only core folder reported, but Ca/Ce computed against the full graph");
	assert.equal(blockOf(out, "sdp-violations").length, 1, "core -> flux kept (from side under target)");
	assert.deepEqual(blockOf(out, "cycles"), [], "cycles outside target dropped");
}

// ── Case 5: threshold override — util->svc style +0.17 edge flags at 0.1 ─────
{
	const graph = write("graph.json", depcruiseJson({
		"app/m.ts": ["svc/s.ts", "util/h.ts"],
		"svc/s.ts": ["util/h.ts", "domain/d.ts"],
		"util/h.ts": ["svc/s.ts"],
		"domain/d.ts": [],
	}));
	assert.equal(blockOf(run([`--graph=${graph}`]), "sdp-violations").length, 0, "+0.17 below default 0.25");
	const sdp = blockOf(run([`--graph=${graph}`, "--sdp-min-delta=0.1"]), "sdp-violations");
	assert.equal(sdp.length, 1, "+0.17 flags at 0.1");
	assert.match(sdp[0], /^util -> svc\t/);
}

// ── Case 6: node_modules / unresolved / core-module deps excluded ────────────
{
	const graph = write("graph.json", depcruiseJson(
		{ "a/x.ts": ["b/y.ts"], "b/y.ts": [] },
		[
			{ resolved: "node_modules/lodash/index.js", coreModule: false, couldNotResolve: false },
			{ resolved: "fs", coreModule: true, couldNotResolve: false },
			{ resolved: "missing", coreModule: false, couldNotResolve: true },
		],
	));
	const out = run([`--graph=${graph}`]);
	assert.match(out, /modules: {7}2\nedges: {9}1/, "only the internal edge survives");
}

// ── Case 7: degradation — missing / invalid graph exits 0 with note ──────────
{
	const out = run(["--graph=" + join(tmp, "nope.json")]);
	assert.match(out, /note: {10}graph file unreadable/);
	assert.deepEqual(blockOf(out, "sdp-violations"), [], "empty blocks still emitted");
	const bad = write("bad.json", "{not json");
	assert.match(run([`--graph=${bad}`]), /note: {10}graph file is not valid JSON/);
	assert.match(run([]), /note: {10}graph file unreadable: \(missing --graph\)/);
}

console.log("OK (stability) — Martin folder metrics + SDP threshold + Tarjan cycles (2- and 3-cycles, path order) + churn x afferent hubs + both flavors + target filter + degradation.");
