// coverage.mjs — parse an EXISTING coverage report into a per-file signal for the
// T (test-theater) lens. Read-only: it NEVER runs the test suite (gathering coverage
// is a Step-2 checkpoint). Supports Istanbul `coverage-summary.json` (preferred),
// `coverage-final.json`, and `lcov.info`. execFileSync-only; always exit 0.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/coverage.mjs" "<target>"
//
// Output:
//   coverage_report:  <which file was parsed | none>
//   coverage_overall: stmt=R% branch=R% fn=R%
//   ---coverage---  path \t stmt=R% \t branch=R% \t fn=R%   (source files under target, worst branch% first)
//
// The T lens crosses this with the test-density (assert presence) signal: covered+unasserted
// or uncovered+asserted = theater; uncovered branches = missing tests. Reach is deterministic
// here; the agent still judges assertion meaningfulness.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return fb;
	}
};
const toPosix = (p) => p.replaceAll("\\", "/");
const root = toPosix(safe(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
const target = toPosix((process.argv[2] ?? ".").replace(/^['"]|['"]$/g, "")) || ".";
const pct = (covered, total) => (total > 0 ? Math.round((covered / total) * 100) : 100);
const relOf = (k) => {
	const p = toPosix(k);
	return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
};
const underTarget = (rp) => target === "." || rp === target || rp.startsWith(`${target}/`);

const summaryPath = join(root, "coverage/coverage-summary.json");
const finalPath = join(root, "coverage/coverage-final.json");
const lcovPath = join(root, "coverage/lcov.info");

const files = [];
let overall = null;
let reportName = "none";

if (existsSync(summaryPath)) {
	reportName = "coverage-summary.json";
	const j = JSON.parse(readFileSync(summaryPath, "utf-8"));
	for (const [k, v] of Object.entries(j)) {
		if (k === "total") {
			overall = { stmt: v.statements?.pct ?? 0, branch: v.branches?.pct ?? 0, fn: v.functions?.pct ?? 0 };
			continue;
		}
		const rp = relOf(k);
		if (!underTarget(rp)) continue;
		files.push({ f: rp, stmt: v.statements?.pct ?? 0, branch: v.branches?.pct ?? 0, fn: v.functions?.pct ?? 0 });
	}
} else if (existsSync(finalPath)) {
	reportName = "coverage-final.json";
	const j = JSON.parse(readFileSync(finalPath, "utf-8"));
	for (const [k, v] of Object.entries(j)) {
		const rp = relOf(k);
		if (!underTarget(rp)) continue;
		const s = Object.values(v.s ?? {});
		const b = Object.values(v.b ?? {}).flat();
		const fn = Object.values(v.f ?? {});
		files.push({
			f: rp,
			stmt: pct(s.filter((x) => x > 0).length, s.length),
			branch: pct(b.filter((x) => x > 0).length, b.length),
			fn: pct(fn.filter((x) => x > 0).length, fn.length),
		});
	}
} else if (existsSync(lcovPath)) {
	reportName = "lcov.info";
	let cur = null;
	for (const line of readFileSync(lcovPath, "utf-8").split(/\r?\n/)) {
		if (line.startsWith("SF:")) cur = { f: relOf(line.slice(3)), lf: 0, lh: 0, bf: 0, bh: 0, ff: 0, fh: 0 };
		else if (!cur) continue;
		else if (line.startsWith("LF:")) cur.lf = Number(line.slice(3));
		else if (line.startsWith("LH:")) cur.lh = Number(line.slice(3));
		else if (line.startsWith("BRF:")) cur.bf = Number(line.slice(4));
		else if (line.startsWith("BRH:")) cur.bh = Number(line.slice(4));
		else if (line.startsWith("FNF:")) cur.ff = Number(line.slice(4));
		else if (line.startsWith("FNH:")) cur.fh = Number(line.slice(4));
		else if (line === "end_of_record") {
			if (underTarget(cur.f)) files.push({ f: cur.f, stmt: pct(cur.lh, cur.lf), branch: pct(cur.bh, cur.bf), fn: pct(cur.fh, cur.ff) });
			cur = null;
		}
	}
}

files.sort((a, b) => a.branch - b.branch || a.stmt - b.stmt);
const head = [`coverage_report:  ${reportName}`];
if (overall) head.push(`coverage_overall: stmt=${overall.stmt}% branch=${overall.branch}% fn=${overall.fn}%`);
process.stdout.write(`${head.join("\n")}\n---coverage---\n${files.map((r) => `${r.f}\tstmt=${r.stmt}%\tbranch=${r.branch}%\tfn=${r.fn}%`).join("\n")}\n`);
process.exit(0);
