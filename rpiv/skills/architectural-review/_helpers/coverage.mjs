// coverage.mjs — parse an EXISTING coverage report into a per-file signal for the
// T (test-theater) lens. Read-only: it NEVER runs the test suite (gathering coverage
// is a Step-2 checkpoint). Supports Istanbul `coverage-summary.json` (preferred),
// `coverage-final.json`, `coverage/lcov.info`, and coverage.py's `coverage.lcov` at
// the project root (D37 of the Python-support design, S5-coverage). execFileSync-only;
// always exit 0.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/coverage.mjs" "<target>"...
//
// Output:
//   coverage_report:  <which file was parsed at the first project root | none>
//   coverage_overall: stmt=R% branch=R% fn=R%
//   also_coverage_report: <root> \t <report>   (one line per further project root, D39)
//   ---coverage---  path \t stmt=R% \t branch=R% \t fn=R%   (source files under target, worst branch% first)
//
// An lcov total that is missing or zero reads `n/a`, never 100%, and sorts after every
// number; a count that is not a whole number reads `n/a` and marks the report
// `(parse-error: …)` (D38). The T lens crosses this with the test-density (assert
// presence) signal: covered+unasserted or uncovered+asserted = theater; uncovered
// branches = missing tests. Reach is deterministic here; the agent still judges
// assertion meaningfulness.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveTargets, toPosix } from "./target-context.mjs";

// Target and file keys are emitted relative to the invocation cwd — the base the
// skill's T-lens agent and `store --root .` use. Identical to the git toplevel on a
// normal repo (cwd === toplevel); correct when the project is nested under the repo.
// Project root = nearest package.json or pyproject.toml at/above the target, bounded by
// the git toplevel: the report lives at the PROJECT root, which is not the git root
// when the project is nested under the repo (our rpiv/, a monorepo package).
const { projectRoots, relOf, underAny } = resolveTargets(process.argv.slice(2));
const pct = (covered, total) => (total > 0 ? Math.round((covered / total) * 100) : 100);

// Broken != absent: a report that EXISTS but cannot be parsed must emit a distinct
// parse-error diagnostic (mutation.mjs's stale-json precedent), never crash and
// never read as "none"/clean — the T lens trusts this signal.
const firstLine = (e) => String(e.message ?? e).split("\n")[0];
const readJson = (p, result) => {
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch (e) {
		result.parseError = firstLine(e);
		return null;
	}
};
const readText = (p, result) => {
	try {
		return readFileSync(p, "utf-8");
	} catch (e) {
		result.parseError = firstLine(e);
		return null;
	}
};

const pctsOf = (v) => ({
	stmt: v.statements?.pct ?? 0,
	branch: v.branches?.pct ?? 0,
	fn: v.functions?.pct ?? 0,
});

const readSummary = (path, _root, result) => {
	for (const [k, v] of Object.entries(readJson(path, result) ?? {})) {
		if (k === "total") {
			result.overall = pctsOf(v);
			continue;
		}
		const rp = relOf(k);
		if (underAny(rp)) result.files.push({ f: rp, ...pctsOf(v) });
	}
};

const readFinal = (path, _root, result) => {
	for (const [k, v] of Object.entries(readJson(path, result) ?? {})) {
		const rp = relOf(k);
		if (!underAny(rp)) continue;
		const s = Object.values(v.s ?? {});
		const b = Object.values(v.b ?? {}).flat();
		const fn = Object.values(v.f ?? {});
		result.files.push({
			f: rp,
			stmt: pct(s.filter((x) => x > 0).length, s.length),
			branch: pct(b.filter((x) => x > 0).length, b.length),
			fn: pct(fn.filter((x) => x > 0).length, fn.length),
		});
	}
};

// The lcov count lines and the record field each one fills.
const LCOV_COUNTS = { LF: "lf", LH: "lh", BRF: "bf", BRH: "bh", FNF: "ff", FNH: "fh" };

/** An lcov count: a whole number, else NaN with the report marked parse-error. */
const lcovCount = (value, result) => {
	if (/^\d+$/.test(value)) return Number(value);
	result.parseError ??= `lcov count is not a whole number: ${value}`;
	return Number.NaN;
};

/** hit/found as a rounded percent; `n/a` when the total is missing, zero or broken. */
const lcovPct = (hit, found) =>
	Number.isFinite(found) && found > 0 && Number.isFinite(hit)
		? Math.round((hit / found) * 100)
		: "n/a";

/** An lcov `SF:` path relative to the run folder: a relative one is read against its
    project root (coverage.py writes `src\demo\x.py`), with `\` turned into `/`. */
const lcovFile = (sf, root) => {
	const path = toPosix(sf);
	return relOf(toPosix(isAbsolute(path) ? path : join(root, path)));
};

const lcovRow = (cur) => ({
	f: cur.f,
	stmt: lcovPct(cur.lh, cur.lf),
	branch: lcovPct(cur.bh, cur.bf),
	fn: lcovPct(cur.fh, cur.ff),
});

const readLcov = (path, root, result) => {
	let cur = null;
	for (const line of (readText(path, result) ?? "").split(/\r?\n/)) {
		const split = line.indexOf(":");
		const key = split < 0 ? line : line.slice(0, split);
		const value = line.slice(split + 1);
		if (key === "SF" && split > 0) cur = { f: lcovFile(value, root) };
		else if (!cur) continue;
		else if (split > 0 && key in LCOV_COUNTS) cur[LCOV_COUNTS[key]] = lcovCount(value, result);
		else if (line === "end_of_record") {
			if (underAny(cur.f)) result.files.push(lcovRow(cur));
			cur = null;
		}
	}
};

// The reports a project root may hold, in the order they are tried (D37).
const REPORTS = [
	["coverage-summary.json", "coverage/coverage-summary.json", readSummary],
	["coverage-final.json", "coverage/coverage-final.json", readFinal],
	["lcov.info", "coverage/lcov.info", readLcov],
	["coverage.lcov", "coverage.lcov", readLcov],
];

/** One project root's report: its name, rows, overall line and parse error. */
const readRoot = (root) => {
	const result = { root, name: "none", files: [], overall: null, parseError: null };
	const found = REPORTS.find(([, rel]) => existsSync(join(root, rel)));
	if (!found) return result;
	const [name, rel, reader] = found;
	result.name = name;
	reader(join(root, rel), root, result);
	return result;
};

const results = projectRoots.map(readRoot);
const [first] = results;
const sortKey = (v) => (v === "n/a" ? Number.POSITIVE_INFINITY : v);
const files = results.flatMap((r) => r.files);
files.sort((a, b) => sortKey(a.branch) - sortKey(b.branch) || sortKey(a.stmt) - sortKey(b.stmt));

const reportLabel = (r) => `${r.name}${r.parseError ? ` (parse-error: ${r.parseError})` : ""}`;
const shown = (v) => (v === "n/a" ? "n/a" : `${v}%`);
const head = [`coverage_report:  ${reportLabel(first)}`];
if (first.overall) head.push(`coverage_overall: stmt=${first.overall.stmt}% branch=${first.overall.branch}% fn=${first.overall.fn}%`);
for (const r of results.slice(1)) head.push(`also_coverage_report: ${r.root}\t${reportLabel(r)}`);
process.stdout.write(`${head.join("\n")}\n---coverage---\n${files.map((r) => `${r.f}\tstmt=${shown(r.stmt)}\tbranch=${shown(r.branch)}\tfn=${shown(r.fn)}`).join("\n")}\n`);
process.exit(0);
