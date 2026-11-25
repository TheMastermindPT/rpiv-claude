// fence-duplication-check.test.mjs — golden tests for the artifact fence duplication hook.
// Builds a throwaway project with a real source tree and real .rpiv/artifacts/ markdown,
// feeds PostToolUse JSON on stdin, and asserts both the finding path and every
// degrade path (per degrade-distinguishes-broken, a check that could not run must say so
// in its own words rather than look clean).
// Prints "OK".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "fence-duplication-check.mjs");

function runHook(filePath, projectDir, env = {}) {
  const res = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env },
  });
  assert.equal(res.status, 0, `hook always exits 0: ${res.stderr}`);
  // What the hook told Claude: the additionalContext of the one JSON object on stdout
  // ("" when it said nothing). Claude never reads an exit-0 hook's stderr.
  return res.stdout.trim() === "" ? "" : JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

/**
 * Did this run reach cpd at all? The hook says SKIPPED (and names the cause) when it
 * cannot find a binary, so the presence of that word in a real run is the honest probe —
 * asking the hook to process a bogus path would exit 0 whether cpd exists or not.
 */
const reachedCpd = (said) => !/SKIPPED/.test(said);

// The body both the artifact fence and the existing source file will share. Must clear
// min-tokens (50) on its own, so it needs real substance rather than a one-liner.
const SHARED = `const findProjectRoot = (startAbs, top) => {
	let dir = startAbs;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return toPosix(dir);
		if (toPosix(dir) === top) return top;
		const parent = dirname(dir);
		if (parent === dir) return top;
		dir = parent;
	}
};

export function resolveTarget(argv2) {
	const target = argv2 || ".";
	const root = safeGit(["rev-parse", "--show-toplevel"], process.cwd());
	const projectRoot = findProjectRoot(target, root);
	return { root, target, projectRoot };
}`;

function artifact({ target, code = SHARED, lang = "javascript" }) {
  const decl = target ? `**File**: ${target}\n**Changes**: NEW — owns the helper.\n` : "";
  return `# Plan\n\n## Phase 1\n\n#### 1. the slice\n${decl}\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

const tmp = mkdtempSync(join(tmpdir(), "fence-dup-"));
try {
  const proj = join(tmp, "proj");
  const plans = join(proj, ".rpiv", "artifacts", "plans");
  mkdirSync(plans, { recursive: true });
  mkdirSync(join(proj, "lib"), { recursive: true });
  // The pre-existing source the fences will collide with.
  writeFileSync(join(proj, "lib", "existing.mjs"), `${SHARED}\n`);

  const plan = join(plans, "p.md");
  const write = (body) => {
    writeFileSync(plan, body);
    return plan;
  };

  // ---- scope gating (no cpd needed) ------------------------------------------------

  writeFileSync(join(proj, "notes.md"), artifact({ target: "lib/other.mjs" }));
  assert.equal(runHook(join(proj, "notes.md"), proj), "", "file outside .rpiv/artifacts is silent");

  writeFileSync(join(plans, "data.json"), "{}");
  assert.equal(runHook(join(plans, "data.json"), proj), "", "non-.md artifact is silent");

  // An artifacts path belonging to a DIFFERENT project must not be picked up: containment
  // is resolved against this project's root, not matched as a substring.
  const other = join(tmp, "other");
  mkdirSync(join(other, ".rpiv", "artifacts", "plans"), { recursive: true });
  const foreign = join(other, ".rpiv", "artifacts", "plans", "p.md");
  writeFileSync(foreign, artifact({ target: "lib/other.mjs" }));
  assert.equal(runHook(foreign, proj), "", "another project's artifacts tree is silent");

  assert.equal(runHook(join(plans, "missing.md"), proj), "", "nonexistent artifact is silent");

  write("# Plan\n\nProse only, no fences.\n");
  assert.equal(runHook(plan, proj), "", "artifact with no code fences is silent");

  write("# Plan\n\n```javascript\nconst a = 1;\n");
  assert.match(runHook(plan, proj), /INCOMPLETE.*unterminated code fence opened at line 3/s,
    "unterminated fence reports INCOMPLETE rather than passing silently");

  // ---- degrade paths: a check that cannot run must NOT look clean -------------------

  write(artifact({ target: "lib/new.mjs" }));

  const missingBin = runHook(plan, proj, { RPIV_CPD_BIN: join(tmp, "no-such-cpd") });
  assert.match(missingBin, /SKIPPED/, "unusable RPIV_CPD_BIN reports SKIPPED");
  assert.match(missingBin, /no-such-cpd/, "SKIPPED names the configured path");
  assert.match(missingBin, /1 code fence\(s\) went unchecked/, "SKIPPED states what went unchecked");

  const failing = join(tmp, "failing-cpd.js");
  writeFileSync(failing, 'process.stderr.write("boom\\n"); process.exit(3);\n');
  const failed = runHook(plan, proj, { RPIV_CPD_BIN: failing });
  assert.match(failed, /FAILED/, "a crashing cpd reports FAILED");
  assert.match(failed, /exited 3/, "FAILED names the exit code");
  assert.doesNotMatch(failed, /SKIPPED/, "a crash is reported as FAILED, not SKIPPED");

  const noReport = join(tmp, "silent-cpd.js");
  writeFileSync(noReport, "process.exit(0);\n");
  const noRep = runHook(plan, proj, { RPIV_CPD_BIN: noReport });
  assert.match(noRep, /FAILED.*wrote no report/s, "a cpd that writes no report reports FAILED");

  // Only the second (TypeScript-reader) pass fails: the first pass's result still stands,
  // but the run must say PARTIAL — never read as a clean, complete check.
  const tsOnlyFails = join(tmp, "ts-fails-cpd.js");
  writeFileSync(
    tsOnlyFails,
    `const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a[a.indexOf("--format") + 1].includes("typescript")) { process.stderr.write("ts boom\\n"); process.exit(4); }
const out = a[a.indexOf("-o") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "jscpd-report.json"), JSON.stringify({ duplicates: [] }));
`,
  );
  writeFileSync(join(tmp, "package.json"), '{"type":"commonjs"}\n'); // the fake cpd uses require()
  write(artifact({ target: "src/x.ts", code: "export const x: number = 1;", lang: "typescript" }));
  const partial = runHook(plan, proj, { RPIV_CPD_BIN: tsOnlyFails });
  assert.match(partial, /PARTIAL.*TypeScript-reader pass cpd exited 4/s,
    "a failing TypeScript pass reports PARTIAL with its cause");
  assert.match(partial, /1 TypeScript fence\(s\) were checked by the javascript reader only/,
    "PARTIAL states what went under-checked");
  assert.doesNotMatch(partial, /FAILED|SKIPPED/, "a second-pass failure is PARTIAL, not a full failure");

  write(artifact({ target: "lib/x.mjs", code: "export const x = 1;" }));
  assert.equal(runHook(plan, proj, { RPIV_CPD_BIN: tsOnlyFails }), "",
    "a fence set with no TypeScript runs no second pass, so it cannot go PARTIAL");

  // ---- detection + filtering (needs a real cpd) ------------------------------------

  // 1. Fence declares a NEW file, body already exists in lib/existing.mjs -> flagged.
  write(artifact({ target: "lib/new-helper.mjs" }));
  const hit = runHook(plan, proj);

  if (!reachedCpd(hit)) {
    console.log("OK (fence-duplication-check) — scope + degrade paths. " +
      "DETECTION CASES SKIPPED: no cpd binary on this machine.");
  } else {
    assert.match(hit, /re-emit code that already exists/, "cross-file duplication is reported");
    assert.match(hit, /lib\/existing\.mjs:\d+-\d+/, "the report names the existing file and lines");
    assert.match(hit, /for lib\/new-helper\.mjs/, "the report names the fence's declared target");

    // 2. Same body, but the fence declares the very file it matched -> a refactor plan
    //    quoting its own target. This is the filter that kills most false positives.
    write(artifact({ target: "lib/existing.mjs" }));
    assert.equal(runHook(plan, proj), "", "fence targeting the file it matched is filtered out");

    // 3. Declared target given only in the heading (the design format) is honoured too.
    write(`# Design\n\n## lib/existing.mjs — MODIFY\n\n\`\`\`javascript\n${SHARED}\n\`\`\`\n`);
    assert.equal(runHook(plan, proj), "", "heading-declared target also self-filters");

    // 4. No declared target at all -> reported, but tagged so the reader knows it could
    //    not be self-filtered. Neither silently dropped nor silently trusted.
    write(`# Plan\n\n## Slice one\n\n\`\`\`javascript\n${SHARED}\n\`\`\`\n`);
    const untagged = runHook(plan, proj);
    assert.match(untagged, /target unknown/, "a fence with no declared target is tagged, not dropped");

    // 5. TypeScript must detect. Regression guard: cpd's own `typescript` reader (5.0.11-5.4.3)
    //    counts this byte-identical pair as too few tokens to report, while the javascript
    //    reader (first pass) matches it. If that routing is ever reverted, TS projects go
    //    quietly under-reported — the worst failure mode here.
    mkdirSync(join(proj, "src"), { recursive: true });
    const TS_SHARED = `export interface AthleteRow {
	id: string;
	heightCm: number | null;
	weightKg: number | null;
}

export function buildAthleteInsert(profile: AthleteRow, userId: string) {
	return {
		user_id: userId,
		height_cm: profile.heightCm ?? null,
		weight_kg: profile.weightKg ?? null,
		updated_at: new Date().toISOString(),
	};
}`;
    writeFileSync(join(proj, "src", "mappers.ts"), `${TS_SHARED}\n`);
    write(artifact({ target: "src/brand-new.ts", code: TS_SHARED, lang: "typescript" }));
    const tsHit = runHook(plan, proj, { RPIV_DUP_TOKENS: "40" });
    assert.match(tsHit, /src\/mappers\.ts/, "TypeScript fences detect duplication (cpd typescript-format bug workaround)");
    assert.match(tsHit, /Duplication: 1 code fence region/, "a clone both passes see is reported once");

    // 5b. The second pass earns its place. The repo copy gained a comment mid-function; in
    //     an annotated file the javascript reader counts comment words as code, so its match
    //     splits into two halves (56 + 69 tokens) under a 75-token bar. The TypeScript
    //     reader skips comments and still sees one 101-token copy. Same counts on cpd 5.0.11 and 5.4.3.
    const TOKEN_BODY = [
      "  const bytes = new Uint8Array(byteLength);",
      "  crypto.getRandomValues(bytes);",
      "  const encoded: string = btoa(String.fromCodePoint(...bytes))",
      '    .replaceAll("+", "-")',
      '    .replaceAll("/", "_")',
      '    .replace(/=+$/, "");',
      "  const stamp: number = Date.now();",
      "  const scope: string = prefix.toLowerCase().trim();",
      "  return `${scope}.${stamp}.${encoded}`;",
      "}",
    ];
    const withComment = [
      ...TOKEN_BODY.slice(0, 4),
      "    // base64url without padding (RFC 4648 section 5): 32 bytes -> 43 chars.",
      ...TOKEN_BODY.slice(4),
    ];
    writeFileSync(
      join(proj, "src", "owner-link.ts"),
      `export function newToken(byteLength: number, prefix: string): string {\n${withComment.join("\n")}\n`,
    );
    write(artifact({
      target: "src/guest-link.ts",
      code: `export function newGuestToken(byteLength: number, prefix: string): string {\n${TOKEN_BODY.join("\n")}`,
      lang: "typescript",
    }));
    const splitHit = runHook(plan, proj, { RPIV_DUP_TOKENS: "75" });
    assert.match(splitHit, /src\/owner-link\.ts/, "a comment-split TypeScript copy is caught by the second pass");
    assert.doesNotMatch(splitHit, /PARTIAL/, "both passes ran");

    // 6. A fence whose body is nothing like the repo stays silent.
    write(artifact({ target: "lib/new.mjs", code: "export const greet = () => console.log(\"hi\");" }));
    assert.equal(runHook(plan, proj), "", "an original fence produces no findings");

    // 7. A language cpd does not tokenize is skipped, not misreported.
    write(artifact({ target: "docs/x.txt", code: SHARED, lang: "text" }));
    assert.equal(runHook(plan, proj), "", "an unsupported fence language is skipped silently");

    console.log("OK (fence-duplication-check) — scope gating, 5 degrade paths (incl. PARTIAL), " +
      "cross-file detection (js + ts, both readers, merged once), self-target filter " +
      "(File: + heading), unknown-target tagging.");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
