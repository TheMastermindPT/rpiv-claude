// run-implement-eval.mjs — implement CAPABILITY eval runner.
//
//   node run-implement-eval.mjs --case ../cases/implement/IMPL-notion.json --model opus --rundir <dir>
//
// Resets the fixture to its stubbed baseline, invokes `implement` headless on the code-redacted
// plan, then GRADES by running the mutation-hardened oracle. PASS iff:
//   (a) the oracle test suite exits 0 (all cases green),
//   (b) the oracle file(s) are byte-unchanged (the agent may not weaken the answer-key), and
//   (c) no other unit test regressed.
// It operates ONLY inside cfg.fixture.path (an isolated, history-free copy) — never the real repo.
// node_modules is a junction, so we invoke vitest's binary directly (never `pnpm`, which would try
// to purge/reinstall through the junction and could damage the origin).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
const cfg = JSON.parse(readFileSync(args.case, "utf-8"));
const model = args.model ?? "opus";
const rundir = args.rundir ?? ".";
mkdirSync(rundir, { recursive: true });

const fx = cfg.fixture.path;
const [vitestBin, ...vitestArgs] = cfg.fixture.vitest.split(" ");
const run = (cmd, a, extra = {}) =>
  spawnSync(cmd, a, { cwd: fx, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CI: "true" }, ...extra });
const vitest = (target) => run(vitestBin, [...vitestArgs, "run", target]);

// 1. reset fixture to the stubbed baseline (tracked files -> stub; drop untracked, keep gitignored node_modules)
run("git", ["reset", "--hard", cfg.fixture.baselineRef]);
run("git", ["clean", "-fd"]);

// 2. sanity: baseline oracle must be RED (the oracle actually detects the missing impl)
const baseline = vitest(cfg.fixture.oracleTest);
const baselineRed = baseline.status !== 0;

// 3. invoke implement headless
const exe = process.platform === "win32" ? "claude.exe" : "claude";
const t0 = Date.now();
const res = spawnSync(
  exe,
  ["-p", cfg.invocation, "--output-format", "json", "--dangerously-skip-permissions", "--model", model],
  { cwd: fx, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: "true" } },
);
const wallMs = Date.now() - t0;
writeFileSync(join(rundir, "implement-stdout.txt"), res.stdout ?? "");
writeFileSync(join(rundir, "implement-stderr.txt"), res.stderr ?? "");

let meta = {};
try { meta = JSON.parse((res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1)) ?? {}; } catch { /* raw */ }
if (meta.is_error) {
  const out = { id: cfg.id, graded: false, reason: "is_error (usage limit or run failure) — refusing to grade", wallMs, meta };
  writeFileSync(join(rundir, "result.json"), JSON.stringify(out, null, 2));
  console.log(`[${cfg.id}] NOT GRADED — is_error`);
  process.exit(3);
}

// 4. grade
const changedOracle = cfg.grade.oracleUnchanged.filter((f) => run("git", ["diff", "--exit-code", "--", f]).status !== 0);
const oracle = vitest(cfg.fixture.oracleTest);
const full = vitest(cfg.grade.noRegression);
const diffStat = run("git", ["diff", "--stat"]).stdout ?? "";

const pass = baselineRed && changedOracle.length === 0 && oracle.status === 0 && full.status === 0;
const result = {
  id: cfg.id, model, pass,
  baselineRed,
  oracleUnchanged: changedOracle.length === 0, changedOracleFiles: changedOracle,
  oracleGreen: oracle.status === 0,
  noRegression: full.status === 0,
  oracleTail: (oracle.stdout + oracle.stderr).split("\n").filter(Boolean).slice(-6).join("\n"),
  diffStat, wallMs,
  cost_usd: meta.total_cost_usd, duration_ms: meta.duration_ms,
};
writeFileSync(join(rundir, "result.json"), JSON.stringify(result, null, 2));
console.log(
  `[${cfg.id}] ${pass ? "PASS" : "FAIL"}  oracleGreen=${oracle.status === 0} oracleUnchanged=${changedOracle.length === 0} noRegression=${full.status === 0}  $${meta.total_cost_usd ?? "?"}  ${(wallMs / 1000).toFixed(0)}s`,
);
