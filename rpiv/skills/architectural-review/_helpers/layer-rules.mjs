// layer-rules.mjs — synthesize a dependency-cruiser config from the APPROVED layer model.
//
// LLM-invoked at Step 3 (Plan Layer Structure), AFTER the developer approves the layer
// proposal. Turns the review's layer model into an executable boundary check:
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/layer-rules.mjs" \
//     --layers=<scratchpad>/layers.json [--forbid="src/domain->src/infra"]... [--format=cjs|json]
//
// layers.json (ordered Layer 0 -> Layer N, exactly the approved Step-3 structure):
//
//   [ { "name": "Layer 0 — public surface", "paths": ["app", "pages/api"] },
//     { "name": "Layer 1 — services",       "paths": ["lib/services"] },
//     { "name": "Layer 2 — domain",         "paths": ["lib/domain"] } ]
//
// Direction convention (mirrors SKILL.md Step 3): Layer 0 is the entry point / public
// surface; higher indices are deeper. Dependencies may only point DOWNWARD (shallow ->
// deep). One forbidden rule is emitted per layer k >= 1 banning imports from layer k
// back up into any layer 0..k-1, plus a no-circular rule. `--forbid a->b` adds an
// entity/ownership boundary rule from the System Model (repeatable).
//
// Output:
//   --format=cjs  (default) — a complete, adoptable `.dependency-cruiser.cjs` on stdout.
//     The skill writes it to the scratchpad, validates the code against it via
//     `depcruise . --config <generated> --output-type json`, and offers it as a
//     polish-plan deliverable (the review's layer model becomes a permanent CI ratchet).
//   --format=json — `{ forbidden: [...] }` only (inspection / tests).
//
// Design constraints (mirror metrics.mjs):
//   - No shelling out; ALWAYS exit 0 — failures collapse to a `note:` line, no config.
//   - Deterministic: same layers in, same config out (except the dated header comment).
//   - Generated rules check PATHS only — the judgment-level residue (semantic leaks,
//     vocabulary erosion) stays with the L lens; type-only back-references that the
//     layer model tolerates should be downgraded by hand after adoption.

import { readFileSync } from "node:fs";

// ---- arg parsing (warrant.mjs style) ----------------------------------------------
const args = { forbid: [] };
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		let key;
		let val;
		if (eq > 0) {
			key = a.slice(2, eq);
			val = a.slice(eq + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
			key = a.slice(2);
			val = argv[(i += 1)];
		} else {
			key = a.slice(2);
			val = "true";
		}
		if (key === "forbid") args.forbid.push(val);
		else args[key] = val;
	}
}

const fail = (reason) => {
	process.stdout.write(`note: ${reason}\n`);
	process.exit(0);
};

const toPosix = (p) => p.replaceAll("\\", "/");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A layer path is a directory prefix; modules live UNDER it.
const prefixRe = (paths) => `^(${paths.map((p) => escapeRe(toPosix(p).replace(/\/+$/, ""))).join("|")})/`;

// ---- load + validate the layer model ------------------------------------------------
let layers = [];
if (args.layers) {
	let raw;
	try {
		raw = readFileSync(args.layers, "utf-8");
	} catch {
		fail(`layers file unreadable: ${args.layers}`);
	}
	try {
		layers = JSON.parse(raw);
	} catch {
		fail(`layers file is not valid JSON: ${args.layers}`);
	}
	if (!Array.isArray(layers)) fail("layers JSON must be an ordered array (Layer 0 first)");
	for (const [i, l] of layers.entries()) {
		if (!l || typeof l.name !== "string" || !Array.isArray(l.paths) || l.paths.length === 0 ||
			l.paths.some((p) => typeof p !== "string" || !p.trim())) {
			fail(`layer ${i} malformed: need { name: string, paths: [non-empty string, ...] }`);
		}
	}
}
if (layers.length < 2 && args.forbid.length === 0) {
	fail("need >= 2 layers (or at least one --forbid pair) to derive direction rules");
}

const forbidPairs = args.forbid.map((f, i) => {
	const m = String(f).split("->");
	if (m.length !== 2 || !m[0].trim() || !m[1].trim()) {
		fail(`--forbid ${i} malformed: expected "from/path->to/path", got "${f}"`);
	}
	return { from: m[0].trim(), to: m[1].trim() };
});

// ---- synthesize rules ----------------------------------------------------------------
const forbidden = [];
for (let k = 1; k < layers.length; k += 1) {
	const shallower = layers.slice(0, k).flatMap((l) => l.paths);
	forbidden.push({
		name: `no-upward-l${k}`,
		severity: "error",
		comment: `${layers[k].name} must not import ${layers.slice(0, k).map((l) => l.name).join(" / ")} — dependencies point downward only (approved layer model)`,
		from: { path: prefixRe(layers[k].paths) },
		to: { path: prefixRe(shallower) },
	});
}
for (const [i, p] of forbidPairs.entries()) {
	forbidden.push({
		name: `boundary-${i + 1}`,
		severity: "error",
		comment: `entity/ownership boundary from the System Model: ${p.from} must not reach ${p.to}`,
		from: { path: prefixRe([p.from]) },
		to: { path: prefixRe([p.to]) },
	});
}
forbidden.push({
	name: "no-circular",
	severity: "error",
	comment: "cycles are direction violations by definition",
	from: {},
	to: { circular: true },
});

// ---- emit ------------------------------------------------------------------------------
if (args.format === "json") {
	process.stdout.write(`${JSON.stringify({ forbidden }, null, 2)}\n`);
	process.exit(0);
}

const header = [
	`// .dependency-cruiser.cjs — GENERATED by rpiv architectural-review (layer-rules.mjs)`,
	`// on ${new Date().toISOString().slice(0, 10)} from the review's APPROVED layer model.`,
	`// Layer order (dependencies point downward only):`,
	...layers.map((l, i) => `//   L${i}: ${l.name} — ${l.paths.join(", ")}`),
	`// Adopt: no existing dependency-cruiser config -> place this file at the repo root.`,
	`// Config already exists -> MERGE: append these forbidden rules to it (names are`,
	`// namespaced no-upward-l*/boundary-*; drop this no-circular if one exists already).`,
	`// Never replace an existing config. Tune severities / add type-only exceptions as needed.`,
].join("\n");

const config = {
	forbidden,
	options: {
		doNotFollow: { path: "node_modules" },
		// Test files legitimately import across layers; boundary rules target production code.
		exclude: { path: "\\.(test|spec)\\.[a-z]+$|(^|/)__tests__/" },
		tsPreCompilationDeps: true,
	},
};

process.stdout.write(`${header}\nmodule.exports = ${JSON.stringify(config, null, 2)};\n`);
process.exit(0);
