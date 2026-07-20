// likec4-conformance-gate.mjs — Level-3 gate: fail the AR review when the declared LikeC4
// model omits too many real code edges. Wraps the read-only likec4-conformance.mjs (which
// ALWAYS exits 0) with an undocumented-edge threshold + a non-zero exit, in the
// check-citations.mjs mold. Invoked in AR Step 11 BEFORE `store finalize`.
//
//   node likec4-conformance-gate.mjs --model <export.json> --graph <depcruise|madge.json> \
//     [--map <map.json>] [--target <prefix>] [--max-undocumented N] [--max-aspirational M]
//
// Exit 1 when undocumented (or aspirational) exceed the threshold; exit 0 on pass OR when
// conformance degrades (model/graph unavailable — the additive/non-blocking LikeC4 posture,
// SKILL.md:199). Exit 2 on usage error.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE = join(HERE, "likec4-conformance.mjs");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
if (!args.model || !args.graph) {
	process.stderr.write("usage: likec4-conformance-gate.mjs --model <export.json> --graph <depcruise|madge.json> [--map <map.json>] [--target <prefix>] [--max-undocumented N] [--max-aspirational M]\n");
	process.exit(2);
}
const maxUndoc = Number(args["max-undocumented"] ?? 0);
const maxAsp = args["max-aspirational"] != null ? Number(args["max-aspirational"]) : Infinity;

// Run the read-only conformance helper, forwarding the model/graph/map/target args.
const passthru = ["--model", args.model, "--graph", args.graph];
if (args.map) passthru.push("--map", args.map);
if (args.target) passthru.push("--target", args.target);
let out;
try {
	out = execFileSync("node", [CONFORMANCE, ...passthru], { encoding: "utf-8" });
} catch (e) {
	// The helper always exits 0; a spawn failure here is environmental → degrade (non-blocking).
	process.stderr.write(`likec4-conformance-gate: SKIP — conformance helper unavailable (${e.message.split("\n")[0]})\n`);
	process.exit(0);
}

const summary = out.split("\n").find((l) => /^undocumented=/.test(l)) ?? "";
const num = (key) => {
	const m = summary.match(new RegExp(`${key}=(\\d+)`));
	return m ? Number(m[1]) : null;
};
if (/status=degraded/.test(summary) || num("undocumented") == null) {
	process.stderr.write("likec4-conformance-gate: SKIP — conformance degraded (model/graph unparseable); additive/non-blocking\n");
	process.exit(0);
}
const undoc = num("undocumented");
const asp = num("aspirational") ?? 0;

if (undoc > maxUndoc || asp > maxAsp) {
	const parts = [];
	if (undoc > maxUndoc) parts.push(`${undoc} undocumented edge(s) (max ${maxUndoc})`);
	if (asp > maxAsp) parts.push(`${asp} aspirational (max ${maxAsp})`);
	process.stderr.write(`FAIL ${args.model}: ${parts.join(", ")} — document each in the .c4 model, or update the model to match the code, then re-run:\n`);
	const blockOf = (marker, next) => out.split(marker)[1]?.split(next)[0]?.trim() ?? "";
	// List the block(s) for the dimension(s) that actually breached (not the other).
	if (undoc > maxUndoc) for (const line of blockOf("---c4-undocumented---", "---c4-aspirational---").split("\n").slice(0, 15)) if (line.trim()) process.stderr.write(`  ${line}\n`);
	if (asp > maxAsp) for (const line of blockOf("---c4-aspirational---", "---c4-summary---").split("\n").slice(0, 15)) if (line.trim()) process.stderr.write(`  ${line}\n`);
	process.exit(1);
}
process.stderr.write(`likec4-conformance-gate: OK — undocumented ${undoc} <= ${maxUndoc}${maxAsp !== Infinity ? `, aspirational ${asp} <= ${maxAsp}` : ""}\n`);
// implicit exit 0
