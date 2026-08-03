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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTargets } from "./target-context.mjs";

// Target and file keys are emitted relative to the invocation cwd — the base the
// skill's T-lens agent and `store --root .` use. Identical to the git toplevel on a
// normal repo (cwd === toplevel); correct when the project is nested under the repo.
// Project root = nearest package.json at/above the target, bounded by the git
// toplevel: the coverage/ dir lives at the PROJECT root, which is not the git
// root when the project is nested under the repo (our rpiv/, a monorepo package).
const { projectRoots, projectRoot, relOf, underAny } = resolveTargets(process.argv.slice(2));
const pct = (covered, total) => (total > 0 ? Math.round((covered / total) * 100) : 100);

// Multi-project visibility (M2 — never silently anchor): the report is read from the
// FIRST target's project root; say so whenever the targets span more than one.
if (projectRoots.length > 1) {
	process.stdout.write(`note: targets span ${projectRoots.length} project roots — coverage read from the first\n`);
}

const summaryPath = join(projectRoot, "coverage/coverage-summary.json");
const finalPath = join(projectRoot, "coverage/coverage-final.json");
const lcovPath = join(projectRoot, "coverage/lcov.info");

const files = [];
let overall = null;
let reportName = "none";
// Broken != absent: a report that EXISTS but cannot be parsed must emit a distinct
// parse-error diagnostic (mutation.mjs's stale-json precedent), never crash and
// never read as "none"/clean — the T lens trusts this signal.
let parseError = null;
const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch (e) {
		parseError = String(e.message ?? e).split("\n")[0];
		return null;
	}
};
const readText = (p) => {
	try {
		return readFileSync(p, "utf-8");
	} catch (e) {
		parseError = String(e.message ?? e).split("\n")[0];
		return null;
	}
};

if (existsSync(summaryPath)) {
	reportName = "coverage-summary.json";
	const j = readJson(summaryPath) ?? {};
	for (const [k, v] of Object.entries(j)) {
		if (k === "total") {
			overall = { stmt: v.statements?.pct ?? 0, branch: v.branches?.pct ?? 0, fn: v.functions?.pct ?? 0 };
			continue;
		}
		const rp = relOf(k);
		if (!underAny(rp)) continue;
		files.push({ f: rp, stmt: v.statements?.pct ?? 0, branch: v.branches?.pct ?? 0, fn: v.functions?.pct ?? 0 });
	}
} else if (existsSync(finalPath)) {
	reportName = "coverage-final.json";
	const j = readJson(finalPath) ?? {};
	for (const [k, v] of Object.entries(j)) {
		const rp = relOf(k);
		if (!underAny(rp)) continue;
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
	for (const line of (readText(lcovPath) ?? "").split(/\r?\n/)) {
		if (line.startsWith("SF:")) cur = { f: relOf(line.slice(3)), lf: 0, lh: 0, bf: 0, bh: 0, ff: 0, fh: 0 };
		else if (!cur) continue;
		else if (line.startsWith("LF:")) cur.lf = Number(line.slice(3));
		else if (line.startsWith("LH:")) cur.lh = Number(line.slice(3));
		else if (line.startsWith("BRF:")) cur.bf = Number(line.slice(4));
		else if (line.startsWith("BRH:")) cur.bh = Number(line.slice(4));
		else if (line.startsWith("FNF:")) cur.ff = Number(line.slice(4));
		else if (line.startsWith("FNH:")) cur.fh = Number(line.slice(4));
		else if (line === "end_of_record") {
			if (underAny(cur.f)) files.push({ f: cur.f, stmt: pct(cur.lh, cur.lf), branch: pct(cur.bh, cur.bf), fn: pct(cur.fh, cur.ff) });
			cur = null;
		}
	}
}

files.sort((a, b) => a.branch - b.branch || a.stmt - b.stmt);
const head = [`coverage_report:  ${reportName}${parseError ? ` (parse-error: ${parseError})` : ""}`];
if (overall) head.push(`coverage_overall: stmt=${overall.stmt}% branch=${overall.branch}% fn=${overall.fn}%`);
process.stdout.write(`${head.join("\n")}\n---coverage---\n${files.map((r) => `${r.f}\tstmt=${r.stmt}%\tbranch=${r.branch}%\tfn=${r.fn}%`).join("\n")}\n`);
process.exit(0);
