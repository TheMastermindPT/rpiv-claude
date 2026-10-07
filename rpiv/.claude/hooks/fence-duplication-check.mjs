// fence-duplication-check.mjs — PostToolUse hook: flag artifact code fences that re-emit
// code already living in the repo.
//
// Fires after Write / Edit / MultiEdit on a .md inside this project's .rpiv/artifacts/.
// Extracts every fenced code block whose language maps to a cpd-supported format, writes
// each to a temp file, and runs jscpd/cpd over (fences + repo source).
//
// Two filters are what make the signal usable. Measured against this repo's six real
// plan/design artifacts (81 fences, counted by the old exactly-3-backtick parser): 123 raw
// clones -> 3 true findings. Re-checked at the move to the shared parser (S6): the same six
// artifacts hold 74 cpd-language fences and the hook's output is unchanged on every one.
//
//   1. Only fence<->repo clones are a "this plan re-emits existing code" claim.
//      fence<->fence (the plan repeating itself) and repo<->repo (duplication that was
//      already there) are dropped.
//   2. A clone is dropped when the matched repo file IS the fence's declared target. A
//      refactor plan quoting the file it modifies is the format working as designed, not
//      duplication. This filter alone removed 33 of the 44 surviving false positives; the
//      worst single case was a 528-line fence headed "store.mjs — MODIFY" that matched
//      store.mjs 19 times.
//
// Declared target comes from the plan format's `**File**: <path>` line, falling back to a
// path-shaped token in the nearest heading (designs carry the path there instead of in a
// File line). A fence with NO declared target cannot be self-filtered, so it is reported
// and tagged [target unknown] rather than silently kept or silently dropped.
//
// Advisory only — always exits 0. Per degrade-distinguishes-broken, every way this check
// can fail to RUN (no cpd binary, cpd crash, unreadable report, unterminated fence) emits
// its own diagnostic naming the cause: a skipped check must never read as a clean one.
//
// Env:
//   RPIV_CPD_BIN     path to a cpd executable, or to jscpd's run-jscpd.js shim
//   RPIV_DUP_SRC     comma-separated project-relative source roots (default: project root)
//   RPIV_DUP_TOKENS  min-tokens (default 50 — the measured sweet spot; 25 yields 9x the
//                    repo<->repo noise for 32% more fence<->repo signal)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { parseFences } from "../../skills/_shared/fences.mjs";

// ---- constants -----------------------------------------------------------------

// Fence language -> { ext, format }. Deliberately language-open: rpiv targets more than
// JS/TS, and cpd already tokenizes these. An unlisted language is skipped, not guessed at.
//
// TypeScript and JSX deliberately route through cpd's JAVASCRIPT tokenizer rather than its
// own `typescript`/`tsx` formats. On cpd 5.0.11 the typescript tokenizer misses clones the
// javascript one catches on byte-identical input — measured 0 vs 1 on a synthetic pair and
// 22 vs 48 across a real Next.js lib/. Since the TS-heavy projects this plugin runs in are
// exactly where that matters, a silent zero there would be the worst failure this hook has.
// FORMAT_EXTS is what makes cpd read .ts/.tsx/.jsx as javascript on the repo side too.
const LANGS = {
  javascript: { ext: "mjs", format: "javascript" },
  js: { ext: "mjs", format: "javascript" },
  mjs: { ext: "mjs", format: "javascript" },
  cjs: { ext: "cjs", format: "javascript" },
  jsx: { ext: "jsx", format: "javascript" },
  typescript: { ext: "ts", format: "javascript" },
  ts: { ext: "ts", format: "javascript" },
  tsx: { ext: "tsx", format: "javascript" },
  mts: { ext: "mts", format: "javascript" },
  cts: { ext: "cts", format: "javascript" },
  python: { ext: "py", format: "python" },
  py: { ext: "py", format: "python" },
  go: { ext: "go", format: "go" },
  rust: { ext: "rs", format: "rust" },
  rs: { ext: "rs", format: "rust" },
  java: { ext: "java", format: "java" },
};

const FORMAT_EXTS = "javascript:ts,tsx,mts,cts,jsx";

// Build output, vendored deps and generated code, across the stacks rpiv gets pointed at
// (this hook ships with the plugin, so it runs in every project — a Next.js app's .next/
// or a Rust target/ would otherwise dwarf the real source and blow the time budget).
const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.rpiv/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/reports/**",
  "**/.stryker-tmp/**",
  "**/.next/**",
  "**/.astro/**",
  "**/.svelte-kit/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/vendor/**",
  "**/target/**",
  "**/*.min.js",
  "**/*.generated.*",
].join(",");

const MAX_REPORTED = 10;
const DEFAULT_MIN_TOKENS = 50;
const CPD_TIMEOUT_MS = 12000;
const PATH_IN_TEXT = /([\w.@-]+(?:\/[\w.@-]+)+\.\w+)/;

const warn = (msg) => process.stderr.write(`[rpiv-hook] ${msg}\n`);

// ---- input ---------------------------------------------------------------------

function readArtifactPath() {
  let raw;
  try {
    raw = readFileSync(0, "utf-8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw).tool_input?.file_path || null;
  } catch {
    return null;
  }
}

// ---- fence extraction ----------------------------------------------------------

/** Strip backticks/bold/prose off a declared path, returning the path token or null. */
function cleanPath(s) {
  const m = s.replace(/[`*]/g, "").trim().match(PATH_IN_TEXT);
  return m ? m[1] : null;
}

/**
 * Walk the markdown once, pairing each code fence with the file it claims to target.
 * Fences come from the shared parser (skills/_shared/fences.mjs, D26), so 4-backtick fences,
 * info strings with attributes and CRLF read the same as everywhere else in rpiv.
 * `start` is the 1-based line of the fence's opening marker.
 * Returns { fences, unterminated } where unterminated is that marker's line, or 0.
 */
function extractFences(text) {
  const { fences: parsed, unterminated } = parseFences(text);
  const byStart = new Map(parsed.map((f) => [f.start, f]));
  const lines = text.split(/\r?\n/);
  // Lines from an unclosed opener on are all fence content: no heading or File line there.
  const stop = unterminated ? unterminated.start - 1 : lines.length;
  const fences = [];
  let declaredFile = null; // from `**File**: <path>`
  let heading = ""; // nearest heading, used as fallback

  for (let i = 0; i < stop; i++) {
    const fence = byStart.get(i + 1);
    if (fence) {
      if (Object.hasOwn(LANGS, fence.lang)) {
        fences.push({
          lang: fence.lang,
          start: fence.start,
          target: declaredFile || cleanPath(heading),
          spec: LANGS[fence.lang],
          code: fence.lines.join("\n"),
        });
      }
      i = fence.end - 1;
      continue;
    }

    // A new heading starts a new section: the previous section's File line no longer
    // applies. Designs carry the path in the heading itself, hence the fallback.
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      heading = line.replace(/^#+\s*/, "").trim();
      declaredFile = null;
    } else if (/^\s*\*\*File\*\*\s*:/i.test(line)) {
      declaredFile = cleanPath(line.slice(line.indexOf(":") + 1));
    }
  }

  return { fences, unterminated: unterminated ? unterminated.start : 0 };
}

// ---- cpd discovery -------------------------------------------------------------

/**
 * Resolve a runnable cpd. Returns { cmd, pre } where `pre` are args prepended to the real
 * ones (jscpd ships a Node shim that dispatches to a platform binary), or null.
 */
function findCpd(projectDir) {
  const override = process.env.RPIV_CPD_BIN;
  if (override) {
    if (existsSync(override)) {
      return override.endsWith(".js")
        ? { cmd: process.execPath, pre: [override] }
        : { cmd: override, pre: [] };
    }
    // Not a path on disk — a bare command name is still legitimate, so probe it before
    // giving up. Returning null here (rather than spawning a path we know is missing)
    // is what lets a misconfigured RPIV_CPD_BIN report as SKIPPED-with-a-cause instead
    // of surfacing as an opaque cpd exit code.
    const probe = spawnSync(override, ["--version"], { encoding: "utf-8", timeout: 5000 });
    return !probe.error && probe.status === 0 ? { cmd: override, pre: [] } : null;
  }

  // A real executable on PATH (typical on Linux/macOS). Node refuses to spawn .cmd shims
  // without a shell, so this probe only succeeds for genuine binaries.
  for (const cmd of ["cpd", "jscpd"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (!r.error && r.status === 0) return { cmd, pre: [] };
  }

  // npm-installed jscpd: run its Node shim directly; the shim dispatches per platform.
  const shims = [
    join(projectDir, "node_modules", "jscpd", "run-jscpd.js"),
    ...(process.env.APPDATA
      ? [join(process.env.APPDATA, "npm", "node_modules", "jscpd", "run-jscpd.js")]
      : []),
    join(dirname(process.execPath), "node_modules", "jscpd", "run-jscpd.js"),
    join(homedir(), ".npm-global", "lib", "node_modules", "jscpd", "run-jscpd.js"),
    "/usr/local/lib/node_modules/jscpd/run-jscpd.js",
    "/usr/lib/node_modules/jscpd/run-jscpd.js",
  ];
  for (const shim of shims) {
    if (existsSync(shim)) return { cmd: process.execPath, pre: [shim] };
  }
  return null;
}

// ---- analysis ------------------------------------------------------------------

// Backslashes -> "/", and strip Windows extended-length prefixes: cpd --absolute reports
// `\\?\C:\...`, which no plain project/temp path ever starts with, so without this every
// fence<->repo comparison silently found nothing.
const norm = (p) => String(p).split("\\").join("/").replace(/^\/\/\?\//, "");

/** True when `declared` and `repoRel` name the same file (suffix match on a / boundary). */
function sameFile(declared, repoRel) {
  if (!declared) return false;
  const a = declared.replace(/^\.\//, "").toLowerCase();
  const b = repoRel.toLowerCase();
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

/** Reduce a cpd report to the fence<->repo clones that survive the self-target filter. */
function collectFindings(report, { fenceDir, projectDir, byTmpName }) {
  const isFence = (p) => norm(p).startsWith(norm(fenceDir));
  const root = `${norm(projectDir)}/`;
  const projectRel = (p) => (norm(p).startsWith(root) ? norm(p).slice(root.length) : norm(p));

  const findings = [];
  for (const d of report.duplicates || []) {
    const aIsFence = isFence(d.firstFile.name);
    if (aIsFence === isFence(d.secondFile.name)) continue; // fence<->fence or repo<->repo

    const fenceSide = aIsFence ? d.firstFile : d.secondFile;
    const repoSide = aIsFence ? d.secondFile : d.firstFile;
    const fence = byTmpName.get(basename(norm(fenceSide.name)));
    if (!fence) continue;

    const repoRel = projectRel(repoSide.name);
    if (sameFile(fence.target, repoRel)) continue; // plan quoting the file it modifies

    findings.push({
      tokens: d.tokens,
      lines: d.lines,
      // fence.start is the ``` marker's line; fenceSide.start is 1-based within the
      // extracted body, whose line 1 sits one below the marker.
      artifactLine: fence.start + fenceSide.start,
      target: fence.target,
      repo: `${repoRel}:${repoSide.start}-${repoSide.end}`,
    });
  }
  return findings;
}

function report(artifact, findings, minTokens) {
  findings.sort((a, b) => b.tokens - a.tokens);
  const shown = findings.slice(0, MAX_REPORTED);
  const name = basename(artifact);

  warn(
    `Duplication: ${findings.length} code fence region(s) in ${name} re-emit code that already exists ` +
      `(cpd, min-tokens=${minTokens}; fence-vs-its-own-target matches already excluded):`,
  );
  for (const f of shown) {
    const label = f.target ? `for ${f.target}` : "[target unknown — could not self-filter]";
    process.stderr.write(
      `  ${name}:${f.artifactLine} ${label}\n` +
        `    duplicates ${f.repo}  (${f.tokens} tokens, ${f.lines} lines)\n`,
    );
  }
  if (findings.length > shown.length) {
    warn(`  ... and ${findings.length - shown.length} more (showing the ${MAX_REPORTED} largest).`);
  }
  warn(
    "Import or extract the existing code instead of re-emitting it — see the shared-vocab-union standing decision.",
  );
}

// ---- main ----------------------------------------------------------------------

/** Runs the check. Returns nothing; all output is stderr. Never throws past its caller. */
function check(artifact, fences, projectDir) {
  const cpd = findCpd(projectDir);
  if (!cpd) {
    // Two different causes, two different messages — "you configured a bad path" and
    // "nothing is installed" need different fixes.
    const cause = process.env.RPIV_CPD_BIN
      ? `RPIV_CPD_BIN="${process.env.RPIV_CPD_BIN}" is not an existing file and did not run as a command`
      : "no jscpd/cpd binary found (install with `npm i -g jscpd`, or set RPIV_CPD_BIN)";
    warn(
      `Duplication check SKIPPED for ${basename(artifact)}: ${cause}. ` +
        `${fences.length} code fence(s) went unchecked.`,
    );
    return;
  }

  // Cleanup runs via finally — so nothing below may call process.exit(), which would
  // terminate before finally and leak the temp tree.
  const tmp = mkdtempSync(join(tmpdir(), "rpiv-fencedup-"));
  try {
    const fenceDir = join(tmp, "fences");
    const reportDir = join(tmp, "report");
    mkdirSync(fenceDir, { recursive: true });

    const formats = new Set();
    const byTmpName = new Map();
    fences.forEach((f, i) => {
      const tmpName = `f${String(i).padStart(3, "0")}.${f.spec.ext}`;
      writeFileSync(join(fenceDir, tmpName), `${f.code}\n`);
      formats.add(f.spec.format);
      byTmpName.set(tmpName, f);
    });

    const configured = (process.env.RPIV_DUP_SRC || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolve(projectDir, s));
    const roots = configured.length ? configured : [projectDir];
    const minTokens = Number(process.env.RPIV_DUP_TOKENS) || DEFAULT_MIN_TOKENS;

    const run = spawnSync(
      cpd.cmd,
      [
        ...cpd.pre,
        fenceDir,
        ...roots,
        "--format", [...formats].join(","),
        "--formats-exts", FORMAT_EXTS,
        "--min-tokens", String(minTokens),
        "--reporters", "json,silent",
        "-o", reportDir,
        "--absolute",
        "--ignore", IGNORE_GLOBS,
      ],
      { encoding: "utf-8", timeout: CPD_TIMEOUT_MS },
    );

    const unchecked = `${fences.length} code fence(s) went unchecked.`;
    if (run.error?.code === "ETIMEDOUT") {
      warn(
        `Duplication check TIMED OUT for ${basename(artifact)} after ${CPD_TIMEOUT_MS}ms scanning ` +
          `${roots.map((r) => basename(r)).join(", ")}. ${unchecked} ` +
          `Narrow the scan with RPIV_DUP_SRC (e.g. RPIV_DUP_SRC=src,lib).`,
      );
      return;
    }
    if (run.error || run.status !== 0) {
      warn(
        `Duplication check FAILED for ${basename(artifact)}: cpd exited ${run.status ?? run.error?.code}. ` +
          `${unchecked} ${(run.stderr || "").trim().slice(0, 200)}`,
      );
      return;
    }

    const reportFile = join(reportDir, "jscpd-report.json");
    if (!existsSync(reportFile)) {
      warn(
        `Duplication check FAILED for ${basename(artifact)}: cpd wrote no report to ${reportDir}. ${unchecked}`,
      );
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(reportFile, "utf-8"));
    } catch (err) {
      warn(
        `Duplication check FAILED for ${basename(artifact)}: cpd report is unreadable (${err.message}). ${unchecked}`,
      );
      return;
    }

    const findings = collectFindings(parsed, { fenceDir, projectDir, byTmpName });
    if (findings.length > 0) report(artifact, findings, minTokens);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const filePath = readArtifactPath();
  if (!filePath) return;

  // Only artifacts genuinely inside THIS project's .rpiv/artifacts/ tree. Containment is
  // tested against a resolved root, not by substring: `.includes(".rpiv/artifacts/")`
  // would also match /tmp/.rpiv/artifacts/x.md from an unrelated project.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const artifactsDir = resolve(projectDir, ".rpiv", "artifacts");
  const artifact = resolve(filePath);
  if (!artifact.startsWith(artifactsDir + sep)) return;
  if (!artifact.endsWith(".md")) return;
  if (!existsSync(artifact)) return;

  const { fences, unterminated } = extractFences(readFileSync(artifact, "utf-8"));
  if (unterminated) {
    warn(
      `Duplication check INCOMPLETE for ${basename(artifact)}: unterminated code fence opened at ` +
        `line ${unterminated}. Fences after it were not checked — close the fence and re-save.`,
    );
  }
  if (fences.length === 0) return; // no code to compare — genuinely nothing to do

  check(artifact, fences, projectDir);
}

main();
process.exit(0);
