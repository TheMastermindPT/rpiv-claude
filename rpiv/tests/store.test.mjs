// tests/store.test.mjs — vitest port of skills/_shared/store.test.mjs (Phase-0 bookend).
//
//   npm run test:vitest
//
// Mechanically ported from the node characterization suite: each OK-marked block is one
// it() case, node:assert/strict kept verbatim. Source of truth stays store.test.mjs until
// the terminal bookend migrates the remaining suites. Two-file transient by design.

import { it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateFinding, toSarif, initStore, addFinding, updateFinding, diffReview, queryClusters, renderClusters, renderDrFinding, renderDrift, renderReview, renderFinding, renderTally, spliceRegion, sentinelsFor, renderInto, loadStore, deriveStorePath, checkEvidenceGrounding, finalizeReview } from "../skills/_shared/store.mjs";
// Namespace import so the Phase-7 dispatch tests read `store.dispatch` — before the
// extraction lands that is `undefined` (a clean runtime "not a function" red), not an
// ESM load-time error that would break the whole suite.
import * as store from "../skills/_shared/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "..", "skills", "_shared", "store.mjs");
const FINGERPRINT = join(HERE, "..", "skills", "_shared", "fingerprint.mjs");

// ---- fixtures ----------------------------------------------------------------

/** A fully-valid finding record (Phase-2 schema — no statusNote yet). */
const VALID_FINDING = {
	id: "L0-01",
	layer: 0,
	lens: "G",
	title: "god-file service.ts",
	evidence: [{ path: "lib/x/service.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }],
	symbol: "PlanService",
	anchor: "1178 LOC = 11.9x median",
	what: "Central service accretes planning, validation, and IO.",
	why: "Three responsibilities share one file; every change rebuilds all consumers.",
	remediation: {
		steps: ["Extract pure helpers behind a re-export shim."],
		acceptance: ["metrics.mjs reports service.ts < 3x median"],
		testStrategy: "Characterization test before split.",
		tradeoff: "Keep as-is — rejected: growth trend.",
	},
	severity: "High",
	effort: "L",
	blastRadius: ["cross-module"],
	class: "redesign",
	entityStage: "WeeklyPlan/PERSIST",
	verify: "Verified",
	status: "accepted",
	dependsOn: [],
	crossCutTag: null,
};

// Every artifact fixture now emits the store-managed sentinel pairs for layers 0
// and 1 (Phase-3 migration): render-before-persist requires them, and the Phase-2
// rejection oracles all reject before the render step, so their assertions stay
// verbatim over the migrated body.
const pair = (kind, n) => `<!-- BEGIN store:${kind} layer=${n} -->\n<!-- END store:${kind} layer=${n} -->`;
const layerRegions = (n) => `${pair("findings", n)}\n\n${pair("tally", n)}`;
const DEFAULT_BODY = `# Review\n\n## Layer 0\n\n${layerRegions(0)}\n\n## Layer 1\n\n${layerRegions(1)}\n`;

/** Build a throwaway artifact: seeds `seed` (path->content map) under the root, writes review.md. */
function mkFixture({ seed = { "lib/x/service.ts": "export const x = 1;\n" }, target = "lib/x", body = DEFAULT_BODY } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "store-"));
	for (const [rel, content] of Object.entries(seed)) {
		const p = join(tmp, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	const artifact = join(tmp, "review.md");
	writeFileSync(artifact, `---\ntarget: ${target}\nstatus: in-progress\n---\n${body}`);
	const storePath = artifact.replace(/\.md$/, ".json");
	// Phase-3 migration: the store is no longer lazy-created — seed the sibling
	// envelope directly (NOT via initStore: these fixture bodies carry hand-written
	// layer sentinels, not the store:layers region initStore splices into).
	writeFileSync(storePath, `${JSON.stringify({ schema: 1, artifact: "review.md", target, findings: [] }, null, 2)}\n`);
	return { tmp, root: tmp, artifact, storePath };
}

/** The text a store-managed region currently holds (between its begin/end markers). */
function regionContent(text, kind, n) {
	const { begin, end } = sentinelsFor(kind, n);
	const bi = text.indexOf(begin);
	const ei = text.indexOf(end);
	return text.slice(bi + begin.length, ei);
}

/** A finalize-ready fixture: review.md at a real architecture-reviews path, carrying
 * all six CORE_REQUIRED fields + the kind extras + health_score + the sentinels. */
function mkReviewFixture({ seed = { "lib/x/service.ts": "export const x = 1;\n" }, health = "pending" } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "store-fin-"));
	for (const [rel, content] of Object.entries(seed)) {
		const p = join(tmp, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	const dir = join(tmp, ".rpiv", "artifacts", "architecture-reviews");
	mkdirSync(dir, { recursive: true });
	const artifact = join(dir, "review.md");
	const fm = [
		"---",
		"date: 2026-07-19T00:00:00+0100",
		"author: Test",
		"commit: abc1234",
		"branch: test-branch",
		"repository: rpiv-test",
		"status: in-progress",
		"last_updated: 2026-07-19T00:00:00+0100",
		"last_updated_by: Test",
		`health_score: ${health}`,
		"---",
	].join("\n");
	writeFileSync(artifact, `${fm}\n${DEFAULT_BODY}`);
	const storePath = artifact.replace(/\.md$/, ".json");
	// Phase-3 migration: seed the sibling envelope (no lazy-init).
	writeFileSync(storePath, `${JSON.stringify({ schema: 1, artifact: "review.md", target: "", findings: [] }, null, 2)}\n`);
	return { tmp, root: tmp, artifact, storePath };
}

const runFinalize = (fx, health) => {
	const argv = [STORE, "finalize", "--artifact", fx.artifact, "--root", fx.root];
	if (health != null) argv.push("--health-score", health);
	return spawnSync("node", argv, { encoding: "utf-8" });
};

const runAdd = (fx, finding, argv = []) =>
	spawnSync("node", [STORE, "add", "--artifact", fx.artifact, "--root", fx.root, ...argv], {
		input: JSON.stringify(finding),
		encoding: "utf-8",
	});

/** The fingerprint the subprocess yields for a given finding's {id,lens,quoted,symbol}. */
function fpDirect({ id, lens, quoted, symbol }) {
	const res = spawnSync("node", [FINGERPRINT], {
		input: `${JSON.stringify({ id, lens, quoted, symbol: symbol ?? null })}\n`,
		encoding: "utf-8",
	});
	return JSON.parse(res.stdout.trim().split("\n").filter(Boolean)[0]).fp;
}

// 1. a valid finding is appended with its computed fingerprint, lazy-creating the envelope.
it("1. a valid finding is appended with its computed fingerprint, lazy-creating the envelope.", () => {
	const fx = mkFixture();
	const r = runAdd(fx, VALID_FINDING);
	assert.equal(r.status, 0, `add valid finding must exit 0 (stderr: ${r.stderr})`);
	assert.match(r.stdout, /^added L0-01 \(fp [0-9a-f]{16}\) -> .*review\.json/, "stdout announces the add");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.schema, 1, "schema === 1");
	assert.equal(store.artifact, "review.md", "artifact basename");
	assert.equal(store.target, "lib/x", "target from frontmatter");
	assert.equal(store.findings.length, 1, "one finding appended");
	const expectedFp = fpDirect({ id: "L0-01", lens: "G", quoted: ["export const x = 1;"], symbol: "PlanService" });
	assert.equal(store.findings[0].fp, expectedFp, "fp equals the direct fingerprint.mjs subprocess output");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 2. a duplicate ID is rejected atomically — nothing written.
it("2. a duplicate ID is rejected atomically — nothing written.", () => {
	const fx = mkFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "first add succeeds");
	const before = readFileSync(fx.storePath, "utf-8");
	const r = runAdd(fx, VALID_FINDING);
	assert.equal(r.status, 1, "duplicate id must exit 1");
	assert.match(r.stderr, /duplicate id: L0-01/, "names the duplicate id");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes identical before/after");
	assert.equal(JSON.parse(before).findings.length, 1, "still one finding");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 3. an ambiguous bare-basename evidence path is rejected at insert.
it("3. an ambiguous bare-basename evidence path is rejected at insert.", () => {
	const fx = mkFixture({ seed: { "a/service.ts": "export const x = 1;\n", "b/service.ts": "export const x = 1;\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ ...VALID_FINDING.evidence[0], path: "service.ts" }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "ambiguous bare basename must exit 1");
	assert.match(r.stderr, /ambiguous bare basename: service\.ts/, "names the ambiguous path");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — no finding persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 4. evidence that normalises away yields fp:null and is rejected with the helper's own error.
it("4. evidence that normalises away yields fp:null and is rejected with the helper's own error.", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "// just a comment\n" } });
	const finding = { ...VALID_FINDING, id: "L0-02", evidence: [{ ...VALID_FINDING.evidence[0], quoted: ["// just a comment"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "fp:null must exit 1");
	assert.match(r.stderr, /fingerprint invalid for L0-02/, "names the finding");
	assert.match(r.stderr, /empty after normalisation/, "surfaces the helper's own error");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged (nothing persisted)");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 5. validation reports ALL errors at once, including unknown-field typos.
it("5. validation reports ALL errors at once, including unknown-field typos.", () => {
	const fx = mkFixture();
	const { why, severity, ...rest } = VALID_FINDING;
	void why;
	const finding = { ...rest, severty: severity }; // drop `why`, misname `severity`
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "malformed finding must exit 1");
	assert.match(r.stderr, /missing or empty field: why/, "reports the missing required field");
	assert.match(r.stderr, /unknown field: severty/, "reports the unknown-field typo");
	assert.match(r.stderr, /severity must be one of Low \| Med \| High \(got: undefined\)/, "reports the enum miss");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 6. CLI error surface — usage and malformed stdin.
it("6. CLI error surface — usage and malformed stdin.", () => {
	const fx = mkFixture();
	const noArgs = spawnSync("node", [STORE], { encoding: "utf-8" });
	assert.equal(noArgs.status, 2, "no args -> exit 2");
	assert.match(noArgs.stderr, /^usage: store\.mjs init/, "no args -> usage");

	const badStdin = spawnSync("node", [STORE, "add", "--artifact", fx.artifact, "--root", fx.root], {
		input: "not json",
		encoding: "utf-8",
	});
	assert.equal(badStdin.status, 1, "malformed stdin -> exit 1");
	assert.match(badStdin.stderr, /^store add:/, "malformed stdin -> store add: prefix");

	const unknown = spawnSync("node", [STORE, "frobnicate"], { encoding: "utf-8" });
	assert.equal(unknown.status, 2, "unknown subcommand -> exit 2");
	assert.match(unknown.stderr, /usage: store\.mjs init/, "unknown subcommand -> usage");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 3: deterministic renderer ----------------------------------------

/** The golden finding (statusNote + 2-step remediation) — its rendered block is frozen below. */
const GOLDEN_FINDING = {
	id: "L0-01",
	title: "god-object service",
	layer: 0,
	lens: "G",
	evidence: [{ path: "lib/x/service.ts", startLine: 320, endLine: 340, quoted: ["export class PlanService {"] }],
	symbol: "PlanService", // persist-only — never renders
	anchor: "1178 LOC = 11.9x median",
	what: "Central service accretes planning, validation, and IO.",
	why: "Three responsibilities share one file; every change rebuilds all consumers.",
	remediation: {
		steps: ["Extract pure helpers behind a re-export shim.", "Migrate consumers one cluster at a time."],
		acceptance: ["metrics.mjs reports service.ts < 3x median"],
		testStrategy: "Characterization test before split.",
		tradeoff: "Keep as-is — rejected: growth trend.",
	},
	severity: "High",
	effort: "L",
	blastRadius: ["cross-module"],
	class: "redesign",
	entityStage: "WeeklyPlan/PERSIST",
	verify: "Verified",
	status: "accepted",
	statusNote: "split into service/ dir",
	dependsOn: ["L0-02"],
	crossCutTag: "T1-boundaries",
};

// 38 lines — the byte-exact template shape (15 rendered fields; fp/symbol never render).
const GOLDEN_FINDING_BLOCK = [
	"### L0-01 — god-object service",
	"",
	"- **Lens:** G",
	"",
	"**Evidence**",
	"",
	"`lib/x/service.ts:320-340` — `export class PlanService {`",
	"",
	"**Quantified anchor**",
	"",
	"1178 LOC = 11.9x median",
	"",
	"**What it is**",
	"",
	"Central service accretes planning, validation, and IO.",
	"",
	"**Why it's slop**",
	"",
	"Three responsibilities share one file; every change rebuilds all consumers.",
	"",
	"**Remediation**",
	"",
	"1. Extract pure helpers behind a re-export shim.",
	"2. Migrate consumers one cluster at a time.",
	"",
	"- **Acceptance criteria:** metrics.mjs reports service.ts < 3x median",
	"- **Test strategy:** Characterization test before split.",
	"- **Trade-off / alternative:** Keep as-is — rejected: growth trend.",
	"",
	"- **Severity:** High",
	"- **Effort:** L",
	"- **Blast radius:** cross-module",
	"- **Class:** redesign",
	"- **Entity / stage:** WeeklyPlan/PERSIST",
	"- **Verify:** Verified",
	"- **Status:** **accepted** — split into service/ dir",
	"- **Depends on:** L0-02",
	"- **Cross-cut tag:** `T1-boundaries`",
].join("\n");

// 7. the rendered finding block is byte-identical to the template shape.
it("7. the rendered finding block is byte-identical to the template shape.", () => {
	assert.equal(renderFinding(GOLDEN_FINDING), GOLDEN_FINDING_BLOCK, "finding block matches the frozen golden");
});

// 8. the tally region is derived deterministically.
it("8. the tally region is derived deterministically.", () => {
	const L0_02 = { id: "L0-02", layer: 0, lens: "Lc", title: "dead validation cluster", status: "deferred", crossCutTag: null, dependsOn: [] };
	const GOLDEN_TALLY = [
		"### Layer 0 — tally",
		"",
		"| Status | Count |",
		"|---|---|",
		"| accepted | 1 |",
		"| rejected | 0 |",
		"| deferred | 1 |",
		"| withdrawn | 0 |",
		"",
		"Slop lenses fired in this layer: `{G: 1; Lc: 1}`",
		"Cross-cutting tags introduced: T1-boundaries. Reused: none.",
		"",
		"Dependency edges within Layer 0:",
		"",
		"- L0-01 depends on L0-02 (dead validation cluster)",
	].join("\n");
	assert.equal(renderTally({ findings: [GOLDEN_FINDING, L0_02] }, 0), GOLDEN_TALLY, "tally matches the frozen golden");
});

// 9. the splice is idempotent and never touches prose outside the sentinels.
it("9. the splice is idempotent and never touches prose outside the sentinels.", () => {
	const body = ["HAND-PROSE-BEFORE", "", pair("findings", 0), "", pair("tally", 0), "", "HAND-PROSE-AFTER", ""].join("\n");
	const fx = mkFixture({ body });
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add succeeds");
	const after1 = readFileSync(fx.artifact, "utf-8");
	assert.match(after1, /HAND-PROSE-BEFORE/, "preamble untouched");
	assert.match(after1, /HAND-PROSE-AFTER/, "postamble untouched");
	const { store } = loadStore(fx.artifact);
	renderInto(fx.artifact, store, 0);
	assert.equal(readFileSync(fx.artifact, "utf-8"), after1, "second renderInto is byte-identical (idempotent)");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 10. a missing sentinel pair rejects the add atomically — neither file written.
it("10. a missing sentinel pair rejects the add atomically — neither file written.", () => {
	const body = ["## Layer 0", "", pair("findings", 0), "", pair("tally", 0), ""].join("\n"); // NO layer-1 markers
	const fx = mkFixture({ body });
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "layer-0 add succeeds (pre-existing state)");
	const mdBefore = readFileSync(fx.artifact, "utf-8");
	const jsonBefore = readFileSync(fx.storePath, "utf-8");
	const r = runAdd(fx, { ...VALID_FINDING, id: "L1-01", layer: 1 });
	assert.equal(r.status, 1, "layer-1 add rejects (no layer-1 sentinels)");
	assert.match(r.stderr, /sentinel pair not found in artifact: <!-- BEGIN store:findings layer=1 -->/, "names the missing pair");
	assert.equal(readFileSync(fx.storePath, "utf-8"), jsonBefore, "review.json bytes unchanged");
	assert.equal(readFileSync(fx.artifact, "utf-8"), mdBefore, ".md bytes unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 11. quoted lines with backticks render code-span-safe while the JSON stays verbatim.
it("11. quoted lines with backticks render code-span-safe while the JSON stays verbatim.", () => {
	const fx = mkFixture({ seed: { "lib/x/tpl.ts": "a\nb\nc\nd\nconst s = `x`;\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/tpl.ts", startLine: 5, endLine: null, quoted: ["const s = `x`;"] }] };
	assert.equal(runAdd(fx, finding).status, 0, "add succeeds");
	assert.ok(readFileSync(fx.artifact, "utf-8").includes("`lib/x/tpl.ts:5` — `const s =...`"), "evidence line is code-span-safe");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.findings[0].evidence[0].quoted[0], "const s = `x`;", "review.json keeps the quote verbatim");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 12. `render --tally` re-renders ONLY the tally region.
it("12. `render --tally` re-renders ONLY the tally region.", () => {
	const fx = mkFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add succeeds");
	writeFileSync(fx.artifact, spliceRegion(readFileSync(fx.artifact, "utf-8"), sentinelsFor("findings", 0), "TAMPERED"));
	const r = spawnSync("node", [STORE, "render", "--artifact", fx.artifact, "--layer", "0", "--tally"], { encoding: "utf-8" });
	assert.equal(r.status, 0, "render --tally exits 0");
	assert.match(r.stdout, /^rendered layer 0 \(tally only\)/, "announces tally-only render");
	const md = readFileSync(fx.artifact, "utf-8");
	assert.equal(regionContent(md, "findings", 0).trim(), "TAMPERED", "findings region left untouched");
	assert.match(regionContent(md, "tally", 0), /\| accepted \| 1 \|/, "tally region re-rendered");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 4: finalize ------------------------------------------------------

// 13. a fully-triaged store finalizes — dual flip, content_hash stamped LAST, real lint passes.
it("13. a fully-triaged store finalizes — dual flip, content_hash stamped LAST, real lint passes.", () => {
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add accepted finding");
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 0, `finalize must exit 0 (stderr: ${r.stderr})`);
	assert.match(r.stdout, /^finalized: 1 finding\(s\), health drifting, content_hash [0-9a-f]{12}\.\.\./, "announces finalize");
	const md = readFileSync(fx.artifact, "utf-8");
	assert.match(md, /^status: ready$/m, "status flipped to ready");
	assert.match(md, /^health_score: drifting$/m, "health_score written");
	const fmBlock = md.slice(md.indexOf("---") + 3, md.indexOf("\n---", 3));
	const fmLines = fmBlock.split("\n").filter((l) => l.trim());
	assert.match(fmLines[fmLines.length - 1], /^content_hash: /, "content_hash is the LAST frontmatter field");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.status, "ready", "envelope status mirrored");
	assert.equal(store.healthScore, "drifting", "envelope healthScore mirrored");
	assert.match(store.finalizedAt, /^\d{4}-\d\d-\d\dT/, "finalizedAt is an ISO string");
	const lint = spawnSync("node", [join(HERE, "..", "skills", "_shared", "validate-artifact.mjs"), fx.artifact, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(lint.status, 0, `validate-artifact must pass (stderr: ${lint.stderr})`);
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 14. an untriaged (status: open) finding blocks the flip — nothing written.
it("14. an untriaged (status: open) finding blocks the flip — nothing written.", () => {
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, { ...VALID_FINDING, id: "L0-03", status: "open" }).status, 0, "add open finding");
	const mdBefore = readFileSync(fx.artifact, "utf-8");
	const jsonBefore = readFileSync(fx.storePath, "utf-8");
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 1, "untriaged blocks finalize");
	assert.match(r.stderr, /untriaged findings remain: L0-03/, "names the open finding");
	assert.equal(readFileSync(fx.artifact, "utf-8"), mdBefore, ".md unchanged");
	assert.equal(readFileSync(fx.storePath, "utf-8"), jsonBefore, "review.json unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 15. the health verdict is a hard enum gate — pending and absence both rejected.
it("15. the health verdict is a hard enum gate — pending and absence both rejected.", () => {
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add accepted finding");
	const before = readFileSync(fx.artifact, "utf-8");
	const pending = runFinalize(fx, "pending");
	assert.equal(pending.status, 1, "pending rejected");
	assert.match(pending.stderr, /--health-score must be one of healthy \| drifting \| degraded \(got: pending\)/, "names pending");
	const omitted = runFinalize(fx, null);
	assert.equal(omitted.status, 1, "omitted rejected");
	assert.match(omitted.stderr, /--health-score must be one of healthy \| drifting \| degraded \(got: none\)/, "names none");
	assert.equal(readFileSync(fx.artifact, "utf-8"), before, "files unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 16. the citation re-check catches evidence that went ambiguous AFTER insert.
it("16. the citation re-check catches evidence that went ambiguous AFTER insert.", () => {
	const fx = mkReviewFixture({ seed: { "only.ts": "export const x = 1;\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "only.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] };
	assert.equal(runAdd(fx, finding).status, 0, "insert while unique succeeds");
	mkdirSync(join(fx.root, "second"), { recursive: true });
	writeFileSync(join(fx.root, "second", "only.ts"), "export const y = 1;\n");
	const mdBefore = readFileSync(fx.artifact, "utf-8");
	const jsonBefore = readFileSync(fx.storePath, "utf-8");
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 1, "now-ambiguous evidence blocks finalize");
	assert.match(r.stderr, /evidence went ambiguous since insert/, "explains the failure");
	assert.match(r.stderr, /L0-01: only\.ts/, "names the finding and path");
	assert.equal(readFileSync(fx.artifact, "utf-8"), mdBefore, ".md unchanged");
	assert.equal(readFileSync(fx.storePath, "utf-8"), jsonBefore, "review.json unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 17. double-finalize is refused.
it("17. double-finalize is refused.", () => {
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add accepted finding");
	assert.equal(runFinalize(fx, "drifting").status, 0, "first finalize succeeds");
	const mdBefore = readFileSync(fx.artifact, "utf-8");
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 1, "second finalize refused");
	assert.match(r.stderr, /already ready — re-stamp via validate-artifact\.mjs --stamp/, "points to the re-stamp path");
	assert.equal(readFileSync(fx.artifact, "utf-8"), mdBefore, ".md bytes unchanged (no re-stamp)");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 18. the three content-hash concepts stay name-distinct.
it("18. the three content-hash concepts stay name-distinct.", () => {
	const fx = mkReviewFixture();
	const withHash = runAdd(fx, { ...VALID_FINDING, content_hash: "deadbeef" });
	assert.equal(withHash.status, 1, "content_hash rejected as a finding field");
	assert.match(withHash.stderr, /unknown field: content_hash/, "names it unknown");
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "valid finding adds");
	assert.equal(runFinalize(fx, "drifting").status, 0, "finalize succeeds");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.ok(!("content_hash" in store), "envelope has no content_hash key");
	assert.ok(!("content_hash" in store.findings[0]), "record has no content_hash key");
	assert.match(store.findings[0].fp, /^[0-9a-f]{16}$/, "the record's hash lives under `fp`");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 7: insert-time evidence grounding --------------------------------

// 19. an evidence path that resolves to no repo file is rejected at insert.
it("19. an evidence path that resolves to no repo file is rejected at insert.", () => {
	const fx = mkFixture();
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/ghost.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "non-resolving evidence path must exit 1");
	assert.match(r.stderr, /evidence\[0\]\.path does not resolve to a repo file: lib\/x\/ghost\.ts/, "names the unresolved path");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — no finding persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 20. a startLine beyond the file length is rejected.
it("20. a startLine beyond the file length is rejected.", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "a\nb\nc" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/service.ts", startLine: 99, endLine: null, quoted: ["a"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "out-of-bounds startLine must exit 1");
	assert.match(r.stderr, /startLine 99 exceeds lib\/x\/service\.ts length \(3 lines\)/, "names the line overrun");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — nothing persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 21. a quoted line that does not appear at the cited path:line (±3) is rejected.
it("21. a quoted line that does not appear at the cited path:line (±3) is rejected.", () => {
	const fx = mkFixture(); // lib/x/service.ts line 1 = export const x = 1;
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/service.ts", startLine: 1, endLine: null, quoted: ["export const NOPE = 999;"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "mismatched quote must exit 1");
	assert.match(r.stderr, /evidence\[0\]\.quoted not found at lib\/x\/service\.ts:1 \(±3\)/, "names the missing quote");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — nothing persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// 23. a quote that IS in the file but at a different line names the actual line (actionable).
it("23. a quote that IS in the file but at a different line names the actual line (actionable).", () => {
	const fx = mkFixture({ seed: { "lib/x/f.ts": "a\nb\nc\nd\nTARGET_LINE\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/f.ts", startLine: 1, endLine: null, quoted: ["TARGET_LINE"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "wrong-line quote must exit 1");
	assert.match(r.stderr, /not found at lib\/x\/f\.ts:1 \(±3\) \(found at line 5\)/, "names where the quote actually is");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 8: finalize body-lint -------------------------------------------

// 22. a {token}-dirty body prose blocks finalize — nothing flipped.
it("22. a {token}-dirty body prose blocks finalize — nothing flipped.", () => {
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add accepted finding");
	// inject an unfilled template token into the body prose (outside any code span)
	writeFileSync(fx.artifact, readFileSync(fx.artifact, "utf-8").replace("# Review", "# Review\n\nPhase 1 {Files: , }"));
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 1, "token-dirty body must block finalize");
	assert.match(r.stderr, /body fails the finalization lint/, "names the lint failure");
	assert.match(r.stderr, /unfilled template token in prose: \{Files: , \}/, "surfaces the token");
	assert.match(readFileSync(fx.artifact, "utf-8"), /^status: in-progress$/m, "status NOT flipped");
	assert.notEqual(JSON.parse(readFileSync(fx.storePath, "utf-8")).status, "ready", "envelope not flipped to ready");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 1: schema foundation (kind discriminator + drift fields) ----------

/** A fully-valid AR finding under the Slice-1 schema (blastRadius is now an array).
 * Reused by later phases (SARIF, init, update, diff, query). */
const VALID_AR = {
	id: "L0-01",
	title: "god-file service.ts",
	anchor: "1178 LOC",
	what: "w",
	why: "y",
	layer: 0,
	lens: "G",
	severity: "High",
	effort: "L",
	blastRadius: ["cross-module"],
	class: "redesign",
	verify: "Verified",
	status: "accepted",
	dependsOn: [],
	evidence: [{ path: "lib/x/service.ts", startLine: 320, quoted: ["export class PlanService {"] }],
	remediation: { steps: ["s"], acceptance: ["a"], testStrategy: "t", tradeoff: "o" },
};

/** A valid kind:"dr" finding (shared core + the dr-arm fields Slice 8 requires: an
 * I/Q/S/G lens and the important-tier why + fix). Used to prove kind gates the AR-extra
 * fields — treated as kind:"ar" it reports the AR requirements a dr finding never carries. */
const DR_MIN = {
	kind: "dr",
	id: "S1",
	lens: "S",
	title: "race in loader",
	severity: "important",
	status: "open",
	evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }],
	why: "w",
	fix: "f",
};

// P1.1 kind discriminator — unknown kind rejected; kind-absent defaults to "ar".
it("P1.1 kind discriminator — unknown kind rejected; kind-absent defaults to \"ar\".", () => {
	assert.deepEqual(validateFinding(VALID_AR, new Map(), new Set()), [], "valid AR (kind omitted) validates clean");
	assert.deepEqual(
		validateFinding({ ...VALID_AR, kind: "xr" }, new Map(), new Set()),
		["kind must be one of ar | dr (got: xr)"],
		"unknown kind rejected with exactly the enum message",
	);
});

// P1.2 kind gates the AR-extra fields.
it("P1.2 kind gates the AR-extra fields.", () => {
	assert.deepEqual(validateFinding(DR_MIN, new Map(), new Set()), [], "DR minimal validates clean (shared core only)");
	assert.ok(
		validateFinding(DR_MIN, new Map(), new Set(["S1"])).includes("duplicate id: S1 (IDs are append-only, never reused)"),
		"the shared duplicate-id check fires for dr",
	);
	const asAr = validateFinding({ ...DR_MIN, kind: "ar" }, new Map(), new Set());
	for (const msg of [
		"missing or empty field: anchor",
		"missing or empty field: what",
		"layer must be N or N.M (got: undefined)",
		"remediation must be an object",
		"severity must be one of Low | Med | High (got: important)",
	]) {
		assert.ok(asAr.includes(msg), `the same finding as kind:ar reports: ${msg}`);
	}
});

// P1.3 severity is shared core with a kind-dependent value set.
it("P1.3 severity is shared core with a kind-dependent value set.", () => {
	assert.ok(
		validateFinding({ ...VALID_AR, severity: "critical" }, new Map(), new Set()).includes("severity must be one of Low | Med | High (got: critical)"),
		"an AR finding rejects a dr-severity",
	);
	assert.ok(
		validateFinding({ ...DR_MIN, severity: "High" }, new Map(), new Set()).includes("severity must be one of critical | important | suggestion | discuss (got: High)"),
		"a dr finding rejects an ar-severity",
	);
});

// P1.4 blastRadius is an OPEN multi-value set; renderFinding joins it.
it("P1.4 blastRadius is an OPEN multi-value set; renderFinding joins it.", () => {
	const emptyErr = "blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)";
	assert.deepEqual(validateFinding({ ...VALID_AR, blastRadius: ["on-disk", "cross-module", "runtime-config"] }, new Map(), new Set()), [], "multi-value + free-form accepted");
	assert.deepEqual(validateFinding({ ...VALID_AR, blastRadius: ["other"] }, new Map(), new Set()), [], "'other' accepted");
	assert.ok(validateFinding({ ...VALID_AR, blastRadius: [] }, new Map(), new Set()).includes(emptyErr), "empty array rejected");
	assert.ok(validateFinding({ ...VALID_AR, blastRadius: "cross-module" }, new Map(), new Set()).includes(emptyErr), "bare string rejected (no longer valid)");
	assert.ok(renderFinding({ ...VALID_AR, blastRadius: ["on-disk", "cross-module"] }).includes("- **Blast radius:** on-disk, cross-module"), "render joins the array with ', '");
	assert.ok(renderFinding({ ...VALID_AR, blastRadius: "cross-module" }).includes("- **Blast radius:** cross-module"), "render coerces a legacy scalar as-is");
});

// P1.5 drift fields validated when present; verify:"Falsified" accepted on AR.
it("P1.5 drift fields validated when present; verify:\"Falsified\" accepted on AR.", () => {
	assert.deepEqual(
		validateFinding({ ...VALID_AR, verify: "Falsified", baselineState: "unchanged", driftClass: "Still-open", priorFp: "a1b2c3d4e5f60718", priorId: "L0-00" }, new Map(), new Set()),
		[],
		"Falsified + drift fields accepted",
	);
	const errs = validateFinding({ ...VALID_AR, baselineState: "gone", driftClass: "Mutated" }, new Map(), new Set());
	assert.ok(errs.includes("baselineState must be one of new | unchanged | updated | absent (got: gone)"), "bad baselineState rejected");
	assert.ok(errs.includes("driftClass must be one of NEW | Still-open | Resolved | Regressed (got: Mutated)"), "bad driftClass rejected");
});

// ---- Phase 2: SARIF export (toSarif) ----------------------------------------

// P2.1 minimal-valid 2.1.0 log.
it("P2.1 minimal-valid 2.1.0 log.", () => {
	const store = { schema: 1, findings: [{ ...VALID_AR, fp: "a1b2c3d4e5f60718" }] };
	const s = toSarif(store);
	assert.equal(s.version, "2.1.0", "version");
	assert.ok(s.$schema.endsWith("sarif-schema-2.1.0.json"), "$schema");
	assert.equal(s.runs.length, 1, "one run");
	assert.equal(s.runs[0].tool.driver.name, "rpiv-architectural-review", "AR driver name");
	assert.deepEqual(s.runs[0].tool.driver.rules.map((r) => r.id), ["G"], "one per-lens rule");
	assert.equal(s.runs[0].results.length, 1, "one result");
	const r0 = s.runs[0].results[0];
	assert.equal(r0.ruleId, "G", "ruleId=lens");
	assert.equal(r0.ruleIndex, 0, "ruleIndex");
	assert.equal(r0.level, "error", "High -> error");
	assert.equal(r0.message.text, "god-file service.ts", "message.text=title");
	assert.equal(r0.partialFingerprints["rpivFingerprint/v1"], "a1b2c3d4e5f60718", "partialFingerprints");
	assert.equal(r0.baselineState, "new", "baselineState default new");
	assert.equal(r0.locations[0].physicalLocation.artifactLocation.uri, "lib/x/service.ts", "location uri");
	assert.equal(r0.locations[0].physicalLocation.region.startLine, 320, "region startLine");
	assert.equal(r0.properties.lens, "G", "properties.lens");
	assert.equal(r0.properties.severity, "High", "properties.severity");
	assert.equal(r0.properties.class, "redesign", "properties.class");
	assert.equal(r0.rank, 90, "rank");
	assert.equal(r0.suppressions, undefined, "no suppression for accepted");
});

// P2.2 DR severity + persisted drift map, driver flips to deep-review.
it("P2.2 DR severity + persisted drift map, driver flips to deep-review.", () => {
	const store = {
		schema: 1,
		findings: [{ kind: "dr", id: "S1", title: "race in loader", lens: "S", severity: "important", status: "accepted", baselineState: "unchanged", driftClass: "Still-open", evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }], fp: "beefbeefbeefbeef" }],
	};
	const s = toSarif(store);
	assert.equal(s.runs[0].tool.driver.name, "rpiv-deep-review", "DR driver name");
	const r0 = s.runs[0].results[0];
	assert.equal(r0.level, "warning", "important -> warning");
	assert.equal(r0.baselineState, "unchanged", "persisted baselineState");
	assert.equal(r0.properties.rpivDriftClass, "Still-open", "drift class in bag");
	assert.equal(r0.properties.severity, "important", "dr severity in bag");
	assert.equal(r0.rank, 60, "important rank");
});

// P2.3 Regressed rides the property bag.
it("P2.3 Regressed rides the property bag.", () => {
	const store = { schema: 1, findings: [{ ...VALID_AR, fp: "newfp0000000000a", baselineState: "new", driftClass: "Regressed", priorFp: "oldfp0000000000b", priorId: "L0-00" }] };
	const r0 = toSarif(store).runs[0].results[0];
	assert.equal(r0.baselineState, "new", "Regressed baselineState new");
	assert.equal(r0.properties.rpivDriftClass, "Regressed", "rpivDriftClass");
	assert.equal(r0.properties.priorFingerprint, "oldfp0000000000b", "priorFingerprint");
	assert.equal(r0.properties.priorId, "L0-00", "priorId");
});

// P2.4 triaged-away findings are suppressed, not active.
it("P2.4 triaged-away findings are suppressed, not active.", () => {
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f1", status: "rejected" }] }).runs[0].results[0].suppressions[0].kind, "external", "rejected -> suppressed");
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f2", verify: "Falsified" }] }).runs[0].results[0].suppressions[0].kind, "external", "Falsified -> suppressed");
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f3", status: "accepted" }] }).runs[0].results[0].suppressions, undefined, "accepted -> not suppressed");
});

// P2.5 CLI export --sarif writes --out and prints to stdout otherwise; missing --sarif errors.
it("P2.5 CLI export --sarif writes --out and prints to stdout otherwise; missing --sarif errors.", () => {
	const fx = mkFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add succeeds");
	const outPath = join(fx.tmp, "o.sarif");
	const withOut = spawnSync("node", [STORE, "export", "--sarif", "--artifact", fx.artifact, "--out", outPath, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(withOut.status, 0, `export --out exits 0 (stderr: ${withOut.stderr})`);
	assert.match(withOut.stdout, /^exported 1 finding\(s\) ->/, "announces the export");
	const written = JSON.parse(readFileSync(outPath, "utf-8"));
	assert.equal(written.version, "2.1.0", "written SARIF version");
	assert.equal(written.runs[0].results.length, 1, "one result written");
	const toStdout = spawnSync("node", [STORE, "export", "--sarif", "--artifact", fx.artifact, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(toStdout.status, 0, "export to stdout exits 0");
	assert.equal(JSON.parse(toStdout.stdout).version, "2.1.0", "stdout SARIF parses");
	const noFlag = spawnSync("node", [STORE, "export", "--artifact", fx.artifact, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(noFlag.status, 2, "export without --sarif exits 2");
	assert.match(noFlag.stderr, /usage:/, "usage on stderr");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 3: store init (explicit envelope + .md sentinel-region emission) ---

/** A throwaway .md carrying the store:layers region (what init splices into). */
function mkLayersFixture({ seed = {}, target = "lib/x" } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "store-init-"));
	for (const [rel, content] of Object.entries(seed)) {
		const p = join(tmp, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	const artifact = join(tmp, "review.md");
	writeFileSync(artifact, `---\ntarget: ${target}\nstatus: in-progress\n---\n# Review\n\n<!-- BEGIN store:layers -->\n<!-- END store:layers -->\n`);
	return { tmp, root: tmp, artifact, storePath: artifact.replace(/\.md$/, ".json") };
}

// P3.1 initStore creates the envelope and splices per-layer sections.
it("P3.1 initStore creates the envelope and splices per-layer sections.", () => {
	const fx = mkLayersFixture();
	const ret = initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0", name: "Persistence" }, { n: "1", name: "Domain" }] });
	assert.deepEqual(ret.layers, ["0", "1"], "returns the layer ids");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.schema, 1, "schema");
	assert.equal(store.artifact, "review.md", "artifact basename");
	assert.equal(store.target, "lib/x", "target");
	assert.deepEqual(store.layers, [{ n: "0", name: "Persistence" }, { n: "1", name: "Domain" }], "layers");
	assert.deepEqual(store.findings, [], "empty findings");
	assert.match(store.createdAt, /^\d{4}-\d\d-\d\dT/, "createdAt ISO");
	const md = readFileSync(fx.artifact, "utf-8");
	const order = ["## Layer 0 — Persistence", "<!-- BEGIN store:findings layer=0 -->", "<!-- END store:findings layer=0 -->", "<!-- BEGIN store:tally layer=0 -->", "<!-- END store:tally layer=0 -->", "## Layer 1 — Domain", "<!-- BEGIN store:findings layer=1 -->"];
	let prev = -1;
	for (const marker of order) {
		const at = md.indexOf(marker);
		assert.ok(at > prev, `md contains ${marker} in order`);
		prev = at;
	}
	assert.match(md, /<!-- BEGIN store:layers -->/, "outer begin preserved");
	assert.match(md, /<!-- END store:layers -->/, "outer end preserved");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P3.2 init refuses to clobber an existing store.
it("P3.2 init refuses to clobber an existing store.", () => {
	const fx = mkLayersFixture();
	initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0", name: "L0" }] });
	const before = readFileSync(fx.storePath, "utf-8");
	assert.throws(() => initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0" }] }), /store already initialized/, "second init throws");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P3.3 init validates the spec, writing nothing on failure.
it("P3.3 init validates the spec, writing nothing on failure.", () => {
	const fx = mkLayersFixture();
	assert.throws(() => initStore(fx.artifact, { layers: [{ n: "0" }] }), /spec\.target/, "missing target");
	assert.equal(existsSync(fx.storePath), false, "no store after missing-target");
	assert.throws(() => initStore(fx.artifact, { target: "x", layers: [] }), /non-empty array/, "empty layers");
	assert.equal(existsSync(fx.storePath), false, "no store after empty-layers");
	assert.throws(() => initStore(fx.artifact, { target: "x", layers: [{ n: "zero" }] }), /layer\.n must be N or N\.M/, "bad layer.n");
	assert.equal(existsSync(fx.storePath), false, "no store after bad-layer.n");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P3.4 loadStore no longer lazy-inits; addFinding on an un-init'd artifact throws.
it("P3.4 loadStore no longer lazy-inits; addFinding on an un-init'd artifact throws.", () => {
	const tmp = mkdtempSync(join(tmpdir(), "store-noinit-"));
	const mdPath = join(tmp, "review.md");
	writeFileSync(mdPath, "---\ntarget: lib/x\n---\n# Review\n");
	const storePath = mdPath.replace(/\.md$/, ".json");
	assert.throws(() => loadStore(mdPath), /no store for review\.md — run/, "loadStore directs to init");
	assert.throws(() => loadStore(mdPath), /store init/, "loadStore names store init");
	assert.throws(() => addFinding(mdPath, tmp, VALID_AR), /no store for review\.md — run/, "addFinding on un-init'd throws");
	assert.equal(existsSync(storePath), false, "no review.json created");
	rmSync(tmp, { recursive: true, force: true });
});

// P3.5 after init, store add splices into the init-created sentinels (end-to-end).
it("P3.5 after init, store add splices into the init-created sentinels (end-to-end).", () => {
	const fx = mkLayersFixture({ seed: { "lib/x/service.ts": "export const x = 1;\n" } });
	initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0", name: "L0" }] });
	const groundable = { ...VALID_AR, layer: 0, evidence: [{ path: "lib/x/service.ts", startLine: 1, quoted: ["export const x = 1;"] }] };
	addFinding(fx.artifact, fx.root, groundable);
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.findings.length, 1, "one finding persisted");
	const md = readFileSync(fx.artifact, "utf-8");
	const region = md.slice(md.indexOf("<!-- BEGIN store:findings layer=0 -->"), md.indexOf("<!-- END store:findings layer=0 -->"));
	assert.ok(region.includes("### L0-01 — god-file service.ts"), "finding rendered into the init-created layer-0 region");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 4: store update (verify transitions) -----------------------------

/** Seed a fixture and persist one groundable AR finding (id L0-01, severity High). */
function mkUpdateFixture() {
	const fx = mkFixture();
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	return fx;
}

// P4.1 Verified stands — verify set, severity unchanged.
it("P4.1 Verified stands — verify set, severity unchanged.", () => {
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Verified" });
	assert.equal(rec.verify, "Verified", "verify set");
	assert.equal(rec.severity, "High", "severity unchanged");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0].verify, "Verified", "persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.2 Weakened demotes one tier and requires a verifyNote.
it("P4.2 Weakened demotes one tier and requires a verifyNote.", () => {
	const fx = mkUpdateFixture();
	const r1 = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "only the cold path" });
	assert.equal(r1.severity, "Med", "High -> Med");
	assert.equal(r1.verify, "Weakened", "verify Weakened");
	assert.equal(r1.verifyNote, "only the cold path", "verifyNote recorded");
	assert.equal(updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "narrower" }).severity, "Low", "Med -> Low");
	assert.equal(updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "floor" }).severity, "Low", "Low -> Low (floor)");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened" }), /Weakened requires a verifyNote/, "no note throws");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.3 Falsified retires-not-deletes — record stays, status->withdrawn, verifyNote required.
it("P4.3 Falsified retires-not-deletes — record stays, status->withdrawn, verifyNote required.", () => {
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Falsified", verifyNote: "quote not in file" });
	assert.equal(rec.verify, "Falsified", "verify Falsified");
	assert.equal(rec.status, "withdrawn", "status withdrawn");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 1, "record retained (not deleted)");
	const fx2 = mkUpdateFixture();
	assert.throws(() => updateFinding(fx2.artifact, fx2.root, { id: "L0-01", verify: "Falsified" }), /Falsified requires a verifyNote/, "no note throws");
	rmSync(fx.tmp, { recursive: true, force: true });
	rmSync(fx2.tmp, { recursive: true, force: true });
});

// P4.4 update rejects an unknown id and a bad verify value.
it("P4.4 update rejects an unknown id and a bad verify value.", () => {
	const fx = mkUpdateFixture();
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "ZZ", verify: "Verified" }), /no finding with id ZZ/, "unknown id");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Maybe" }), /verify must be one of Verified \| Weakened \| Falsified/, "bad verify");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { verify: "Verified" }), /patch\.id/, "missing id");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.5 update re-renders the finding's layer (demoted severity shows in the .md).
it("P4.5 update re-renders the finding's layer (demoted severity shows in the .md).", () => {
	const fx = mkUpdateFixture();
	updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "narrower" });
	const md = readFileSync(fx.artifact, "utf-8");
	const region = md.slice(md.indexOf("<!-- BEGIN store:findings layer=0 -->"), md.indexOf("<!-- END store:findings layer=0 -->"));
	assert.ok(region.includes("- **Severity:** Med"), "demoted severity rendered");
	assert.ok(!region.includes("- **Severity:** High"), "old severity gone");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 4b: store update content patches (dogfooding #1 — the only sanctioned
// writer inside sentinel regions must accept the full finding shape, not just verdicts).

// P4.6 content fields persist AND re-render — no verify needed in the patch.
it("P4.6 update content fields persist and re-render without a verify verdict.", () => {
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, {
		id: "L0-01",
		anchor: "1178 LOC = 11.9x median; 41 inbound",
		what: "Rewritten what: the service accretes IO on top of planning.",
		remediation: { steps: ["Split IO into lib/x/io.ts."], acceptance: ["service < 3x median"], testStrategy: "characterize first", tradeoff: "none" },
	});
	assert.equal(rec.anchor, "1178 LOC = 11.9x median; 41 inbound", "anchor replaced");
	assert.equal(rec.verify, "Verified", "verify untouched by a content-only patch");
	const persisted = JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0];
	assert.equal(persisted.what, "Rewritten what: the service accretes IO on top of planning.", "what persisted");
	assert.deepEqual(persisted.remediation.steps, ["Split IO into lib/x/io.ts."], "remediation replaced wholesale");
	const md = readFileSync(fx.artifact, "utf-8");
	const region = md.slice(md.indexOf("<!-- BEGIN store:findings layer=0 -->"), md.indexOf("<!-- END store:findings layer=0 -->"));
	assert.ok(region.includes("1178 LOC = 11.9x median; 41 inbound"), "new anchor rendered");
	assert.ok(region.includes("Rewritten what"), "new what rendered");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.7 unknown/immutable patch keys are a HARD error; an id-only patch has nothing to apply.
it("P4.7 update rejects unknown and immutable patch fields loudly; id-only patch rejected.", () => {
	const fx = mkUpdateFixture();
	assert.equal(
		throwMsg(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", anchour: "typo" })).split(" (updatable:")[0],
		"update: unknown or immutable patch field(s): anchour",
		"a typo'd field must never be silently dropped",
	);
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", layer: 1 }), /unknown or immutable patch field\(s\): layer/, "layer is immutable (render home)");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", lens: "D" }), /unknown or immutable patch field\(s\): lens/, "lens is immutable (identity)");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01" }), /patch carries only id — nothing to apply/, "id-only patch rejected");
	const persisted = JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0];
	assert.equal(persisted.anchor, VALID_FINDING.anchor, "rejected patches persist nothing");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.8 an evidence patch re-grounds against the repo and recomputes the fingerprint.
it("P4.8 update evidence re-grounds and recomputes fp; a bad quote persists nothing.", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "export const x = 1;\nexport const y = 2;\n" } });
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	const fpBefore = JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0].fp;
	assert.throws(
		() => updateFinding(fx.artifact, fx.root, { id: "L0-01", evidence: [{ path: "lib/x/service.ts", startLine: 1, endLine: null, quoted: ["not the real line"] }] }),
		/invalid finding after update: evidence\[0\]\.quoted not found/,
		"ungroundable evidence rejected",
	);
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0].fp, fpBefore, "rejected evidence patch persists nothing");
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", evidence: [{ path: "lib/x/service.ts", startLine: 2, endLine: null, quoted: ["export const y = 2;"] }] });
	assert.notEqual(rec.fp, fpBefore, "fp recomputed for the changed quote");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0].fp, rec.fp, "new fp persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.9 verify + content compose in one patch: content lands first, Weakened demotes from it.
it("P4.9 update composes content + verdict: Weakened demotes from the patched severity.", () => {
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", severity: "Med", verify: "Weakened", verifyNote: "narrower than stated" });
	assert.equal(rec.severity, "Low", "patched Med, then demoted one tier -> Low");
	assert.equal(rec.verify, "Weakened", "verdict applied");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P4.10 prose-citation gate at write time (dogfooding #1 fix-candidate b): an ambiguous
// bare-basename cite in a PROSE field bounces at add AND at update — it must never get
// into a sentinel region only the store may edit, to be flagged at the Step-11.7 gate.
it("P4.10 ambiguous bare-basename cites in prose fields bounce at add and update.", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "export const x = 1;\n", "lib/y/service.ts": "export const y = 1;\n" } });
	const bad = { ...VALID_FINDING, what: "Callers re-derive the rule in service.ts:3 on every save." };
	assert.throws(
		() => addFinding(fx.artifact, fx.root, bad),
		/what cites ambiguous bare basename service\.ts:3 \(2 files named service\.ts in repo/,
		"ambiguous prose cite bounces at insert",
	);
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "nothing persisted");
	// The gate reads EVERY prose field — the base fixture's title and acceptance also
	// carry bare `service.ts`, so the passing record must qualify all of them.
	addFinding(fx.artifact, fx.root, {
		...VALID_FINDING,
		title: "god-file lib/x/service.ts",
		what: "Callers re-derive the rule in lib/x/service.ts:3 on every save.",
		remediation: { ...VALID_FINDING.remediation, acceptance: ["metrics.mjs reports lib/x/service.ts < 3x median"] },
	});
	assert.throws(
		() => updateFinding(fx.artifact, fx.root, { id: "L0-01", anchor: "3 copies of service.ts logic" }),
		/anchor cites ambiguous bare basename service\.ts/,
		"ambiguous prose cite bounces at update re-validate",
	);
	const ok = updateFinding(fx.artifact, fx.root, { id: "L0-01", anchor: "3 copies of lib/x/service.ts logic" });
	assert.equal(ok.anchor, "3 copies of lib/x/service.ts logic", "repo-relative cite passes");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 5: store diff (drift classification) -----------------------------

/** A .md with the store:drift region + a seeded review.json (findings carry fp). */
function mkDiffFixture({ findings = [], hasFrontmatterDrift = false } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "store-diff-"));
	const artifact = join(tmp, "review.md");
	const fmDrift = hasFrontmatterDrift ? "drift: {}\n" : "";
	writeFileSync(artifact, `---\ntarget: lib/x\n${fmDrift}status: in-progress\n---\n# Review\n\n## Drift Delta — vs prior review\n\n<!-- BEGIN store:drift -->\n<!-- END store:drift -->\n`);
	const storePath = artifact.replace(/\.md$/, ".json");
	writeFileSync(storePath, `${JSON.stringify({ schema: 1, artifact: "review.md", target: "lib/x", findings }, null, 2)}\n`);
	return { tmp, root: tmp, artifact, storePath };
}
const writePrior = (fx, prior) => { const p = join(fx.tmp, "prior.json"); writeFileSync(p, JSON.stringify(prior)); return p; };

// P5.1 NEW vs Still-open + baselineState persisted.
it("P5.1 NEW vs Still-open + baselineState persisted.", () => {
	const fx = mkDiffFixture({ findings: [{ id: "L0-01", title: "t1", fp: "A" }, { id: "L0-02", title: "t2", fp: "B" }] });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-01", fp: "A", title: "t" }] }));
	const byFp = Object.fromEntries(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.map((f) => [f.fp, f]));
	assert.equal(byFp.A.driftClass, "Still-open", "fp A still-open");
	assert.equal(byFp.A.baselineState, "unchanged", "fp A baselineState unchanged");
	assert.equal(byFp.A.priorId, "L0-01", "fp A priorId");
	assert.equal(byFp.B.driftClass, "NEW", "fp B new");
	assert.equal(byFp.B.baselineState, "new", "fp B baselineState new");
	assert.equal(byFp.B.priorFp, null, "fp B priorFp null");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P5.2 Regressed — fp present in the prior review's drift.resolved set.
it("P5.2 Regressed — fp present in the prior review's drift.resolved set.", () => {
	const fx = mkDiffFixture({ findings: [{ id: "L0-01", title: "t", fp: "C" }] });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [], drift: { resolved: [{ id: "L0-09", title: "old", fp: "C" }] } }));
	const f = JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0];
	assert.equal(f.driftClass, "Regressed", "Regressed");
	assert.equal(f.baselineState, "new", "baselineState new");
	assert.equal(f.priorFp, "C", "priorFp");
	assert.equal(f.priorId, "L0-09", "priorId");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P5.3 Resolved — a prior finding gone from current, captured in the drift summary.
it("P5.3 Resolved — a prior finding gone from current, captured in the drift summary.", () => {
	const fx = mkDiffFixture({ findings: [] });
	const ret = diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-05", fp: "D", title: "gone" }] }));
	assert.deepEqual(ret.resolved, [{ id: "L0-05", title: "gone", fp: "D" }], "resolved captured");
	assert.equal(ret.counts.resolved, 1, "resolved count");
	assert.ok(!JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.some((f) => f.id === "L0-05"), "resolved NOT carried into findings array");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P5.4 Drift Delta region + frontmatter drift counts.
it("P5.4 Drift Delta region + frontmatter drift counts.", () => {
	const fx = mkDiffFixture({ findings: [{ id: "N1", title: "new one", fp: "N" }, { id: "R1", title: "regressed one", fp: "RG" }], hasFrontmatterDrift: true });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-05", fp: "D", title: "gone" }], drift: { resolved: [{ id: "L0-09", title: "old", fp: "RG" }] } }));
	const md = readFileSync(fx.artifact, "utf-8");
	assert.match(md, /^drift: \{ resolved: 1, regressed: 1, still_open: 0, new: 1, net: \+0 \}$/m, "frontmatter drift line");
	const region = md.slice(md.indexOf("<!-- BEGIN store:drift -->"), md.indexOf("<!-- END store:drift -->"));
	for (const row of ["| NEW | 1 |", "| Regressed | 1 |", "| Resolved | 1 |", "- L0-05 — gone"]) {
		assert.ok(region.includes(row), `region contains ${row}`);
	}
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P5.5 diff closes the Slice-2 decoupling — toSarif reads persisted baselineState/driftClass.
it("P5.5 diff closes the Slice-2 decoupling — toSarif reads persisted baselineState/driftClass.", () => {
	const sev = { lens: "G", severity: "High", status: "accepted", evidence: [{ path: "lib/x/a.ts", startLine: 1, quoted: ["x"] }] };
	const fx = mkDiffFixture({ findings: [{ id: "L0-01", title: "t", ...sev, fp: "A" }] });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-00", fp: "A", title: "t" }] }));
	const r0 = toSarif(JSON.parse(readFileSync(fx.storePath, "utf-8"))).runs[0].results[0];
	assert.equal(r0.baselineState, "unchanged", "still-open -> baselineState unchanged in sarif");
	rmSync(fx.tmp, { recursive: true, force: true });
	const fx2 = mkDiffFixture({ findings: [{ id: "L0-02", title: "t2", ...sev, fp: "RG" }] });
	diffReview(fx2.artifact, writePrior(fx2, { artifact: "prior.md", findings: [], drift: { resolved: [{ id: "L0-09", title: "old", fp: "RG" }] } }));
	const rr = toSarif(JSON.parse(readFileSync(fx2.storePath, "utf-8"))).runs[0].results[0];
	assert.equal(rr.baselineState, "new", "regressed -> baselineState new");
	assert.equal(rr.properties.rpivDriftClass, "Regressed", "regressed drift class in sarif");
	assert.ok(rr.properties.priorFingerprint, "priorFingerprint set");
	rmSync(fx2.tmp, { recursive: true, force: true });
});

// P5.6 diff rejects a missing prior file.
it("P5.6 diff rejects a missing prior file.", () => {
	const fx = mkDiffFixture({ findings: [] });
	assert.throws(() => diffReview(fx.artifact, join(fx.tmp, "nope.json")), /prior review not found/, "missing prior throws");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 6: store query --clusters (read-only cluster discovery) ----------

/** The 3-finding cluster fixture from the Phase-6 contract. */
const clusterFindings = () => [
	{ id: "L0-01", evidence: [{ path: "lib/x/a.ts" }], symbol: "Svc", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
	{ id: "L0-02", evidence: [{ path: "lib/x/a.ts" }], symbol: "Other", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
	{ id: "L0-03", evidence: [{ path: "lib/y/b.ts" }], symbol: "Svc", entityStage: "E/Q", status: "deferred", crossCutTag: null, dependsOn: ["L0-01"] },
];
const cl = (clusters, dim, key) => clusters.find((x) => x.dimension === dim && x.key === key);

// P6.1 clusters by shared file / symbol / entity-stage AND by a Depends-on edge.
it("P6.1 clusters by shared file / symbol / entity-stage AND by a Depends-on edge.", () => {
	const { clusters, discovered } = queryClusters({ findings: clusterFindings() });
	assert.deepEqual(cl(clusters, "file", "lib/x/a.ts").ids.slice().sort(), ["L0-01", "L0-02"], "file cluster");
	assert.equal(cl(clusters, "file", "lib/x/a.ts").anticipated, false, "file cluster not anticipated");
	assert.deepEqual(cl(clusters, "symbol", "Svc").ids.slice().sort(), ["L0-01", "L0-03"], "symbol cluster");
	assert.deepEqual(cl(clusters, "entity", "E/P").ids.slice().sort(), ["L0-01", "L0-02"], "entity cluster");
	assert.deepEqual(cl(clusters, "dependsOn", "L0-01 <-> L0-03").ids.slice().sort(), ["L0-01", "L0-03"], "dependsOn cluster");
	assert.equal(cl(clusters, "symbol", "Other"), undefined, "no Other cluster (singleton)");
	assert.equal(cl(clusters, "entity", "E/Q"), undefined, "no E/Q cluster (singleton)");
	assert.equal(discovered, 4, "4 clusters discovered");
});

// P6.2 a Depends-on edge forms an undirected 2-member cluster; a dangling dependsOn is dropped.
it("P6.2 a Depends-on edge forms an undirected 2-member cluster; a dangling dependsOn is dropped.", () => {
	const q = queryClusters({ findings: clusterFindings() });
	assert.deepEqual(q.clusters.find((x) => x.dimension === "dependsOn").ids.slice().sort(), ["L0-01", "L0-03"], "undirected pair");
	const withGhost = clusterFindings();
	withGhost[2].dependsOn = ["L0-01", "GHOST"];
	const q2 = queryClusters({ findings: withGhost });
	assert.equal(q2.clusters.filter((x) => x.dimension === "dependsOn").length, 1, "GHOST adds no dependsOn cluster");
	assert.equal(q2.discovered, q.discovered, "discovered unchanged by the dangling edge");
});

// P6.3 dependsOn clusters guarded — mutual A<->B is ONE cluster, self-dependency yields none.
it("P6.3 dependsOn clusters guarded — mutual A<->B is ONE cluster, self-dependency yields none.", () => {
	const mutual = { findings: [
		{ id: "A", evidence: [{ path: "p1" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: ["B"] },
		{ id: "B", evidence: [{ path: "p2" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: ["A"] },
	] };
	const dep = queryClusters(mutual).clusters.filter((x) => x.dimension === "dependsOn");
	assert.equal(dep.length, 1, "mutual A<->B is ONE cluster");
	assert.equal(dep[0].key, "A <-> B", "canonical unordered key");
	const selfRef = { findings: [
		{ id: "A", evidence: [{ path: "p1" }], symbol: "S", entityStage: null, status: "accepted", crossCutTag: null, dependsOn: ["A"] },
		{ id: "C", evidence: [{ path: "p1" }], symbol: "S", entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
	] };
	assert.equal(queryClusters(selfRef).clusters.filter((x) => x.dimension === "dependsOn").length, 0, "self-dep adds no dependsOn cluster");
});

// P6.4 anticipated flag — the "subtract known themes" step.
it("P6.4 anticipated flag — the \"subtract known themes\" step.", () => {
	const mk = (t1, t2) => ({ findings: [
		{ id: "L0-01", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: t1, dependsOn: [] },
		{ id: "L0-02", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: t2, dependsOn: [] },
	] });
	const same = queryClusters(mk("T1-x", "T1-x"));
	assert.equal(same.clusters.find((x) => x.dimension === "file").anticipated, true, "same tag -> anticipated");
	assert.equal(same.unanticipated, same.discovered - 1, "unanticipated drops by one");
	assert.equal(queryClusters(mk("T1-x", "T2-y")).clusters.find((x) => x.dimension === "file").anticipated, false, "differing tags -> not anticipated");
	assert.equal(queryClusters(mk("T1-x", null)).clusters.find((x) => x.dimension === "file").anticipated, false, "only one tagged -> not anticipated");
});

// P6.5 only accepted/deferred findings cluster (withdrawn/rejected/open excluded).
it("P6.5 only accepted/deferred findings cluster (withdrawn/rejected/open excluded).", () => {
	const withStatus = (status) => ({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "X", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status, crossCutTag: null, dependsOn: [] },
	] });
	for (const status of ["withdrawn", "rejected", "open"]) {
		assert.equal(queryClusters(withStatus(status)).clusters.filter((x) => x.dimension === "file").length, 0, `${status} excluded -> no file cluster (1 active)`);
	}
});

// P6.6 read-only — the store file bytes are unchanged.
it("P6.6 read-only — the store file bytes are unchanged.", () => {
	const fx = mkDiffFixture({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "B", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
	] });
	const before = readFileSync(fx.storePath, "utf-8");
	queryClusters(JSON.parse(before));
	assert.equal(spawnSync("node", [STORE, "query", "--clusters", "--artifact", fx.artifact], { encoding: "utf-8" }).status, 0, "cli query exits 0");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes unchanged (read-only)");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P6.7 CLI query --clusters prints the report; missing flag errors.
it("P6.7 CLI query --clusters prints the report; missing flag errors.", () => {
	const fx = mkDiffFixture({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "B", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
	] });
	const ok = spawnSync("node", [STORE, "query", "--clusters", "--artifact", fx.artifact], { encoding: "utf-8" });
	assert.equal(ok.status, 0, "query --clusters exits 0");
	assert.match(ok.stdout, /^Clusters:/, "report starts with Clusters:");
	const noFlag = spawnSync("node", [STORE, "query", "--artifact", fx.artifact], { encoding: "utf-8" });
	assert.equal(noFlag.status, 2, "query without --clusters exits 2");
	assert.match(noFlag.stderr, /usage:/, "usage on stderr");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 8: DR render mode (kind:"dr" arm + whole-document assembly) -------

/** A fully-valid kind:"dr" critical finding grounding at lib/x/a.ts:10. */
const DR_C = { kind: "dr", id: "S1", lens: "S", title: "race", severity: "critical", status: "open", evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }], why: "w", fix: "f" };

/** A DR fixture: seeds lib/x/a.ts (line 10 = `const x = 1;`) + review.json + a plain .md. */
function mkDrFixture({ findings = [], mdBody = "# DR\n" } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "store-dr-"));
	mkdirSync(join(tmp, "lib", "x"), { recursive: true });
	writeFileSync(join(tmp, "lib", "x", "a.ts"), `${[...Array.from({ length: 9 }, (_, i) => `// line ${i + 1}`), "const x = 1;"].join("\n")}\n`);
	const artifact = join(tmp, "review.md");
	writeFileSync(artifact, `---\nstatus: in-progress\n---\n${mdBody}`);
	const storePath = artifact.replace(/\.md$/, ".json");
	writeFileSync(storePath, `${JSON.stringify({ schema: 1, artifact: "review.md", target: "lib/x", findings }, null, 2)}\n`);
	return { tmp, root: tmp, artifact, storePath };
}

// P8.1 DR validation arm — I/Q/S/G lens, per-tier why/fix, capitalized verify.
it("P8.1 DR validation arm — I/Q/S/G lens, per-tier why/fix, capitalized verify.", () => {
	assert.deepEqual(validateFinding(DR_C, new Map(), new Set()), [], "DR critical validates clean");
	assert.ok(validateFinding({ ...DR_C, lens: "Z" }, new Map(), new Set()).includes("lens must be one of I/Q/S/G for kind:dr (got: Z)"), "bad DR lens rejected");
	const sugErrs = validateFinding({ kind: "dr", id: "S1", lens: "S", title: "race", severity: "suggestion", status: "open", evidence: DR_C.evidence, why: "w" }, new Map(), new Set());
	assert.ok(sugErrs.includes("kind:dr suggestion finding requires a fix"), "suggestion requires a fix");
	assert.ok(!sugErrs.some((e) => e.includes("requires a why")), "suggestion does NOT require a why");
	const disErrs = validateFinding({ kind: "dr", id: "S1", lens: "S", title: "race", severity: "discuss", status: "open", evidence: DR_C.evidence, fix: "f" }, new Map(), new Set());
	assert.ok(disErrs.includes("kind:dr discuss finding requires a why"), "discuss requires a why");
	assert.ok(!disErrs.some((e) => e.includes("requires a fix")), "discuss does NOT require a fix");
	assert.deepEqual(validateFinding({ ...DR_C, verify: "Falsified" }, new Map(), new Set()), [], "capitalized verify accepted");
	assert.ok(validateFinding({ ...DR_C, verify: "verified" }, new Map(), new Set()).includes("verify must be one of Verified | Weakened | Falsified (got: verified)"), "lowercase verify rejected");
});

// P8.2 renderDrFinding degrades per tier + byte-preserves the emoji.
it("P8.2 renderDrFinding degrades per tier + byte-preserves the emoji.", () => {
	const crit = renderDrFinding(DR_C);
	assert.ok(crit.includes("### S1 🔴 race"), "critical heading + emoji");
	assert.ok(crit.includes("**Code**") && crit.includes("**Why**") && crit.includes("**Fix**"), "critical shows Code/Why/Fix");
	const sug = renderDrFinding({ ...DR_C, severity: "suggestion", fix: "f" });
	assert.ok(sug.includes("### S1 🔵 race"), "suggestion emoji");
	assert.ok(sug.includes("**Fix**") && !sug.includes("**Code**") && !sug.includes("**Why**"), "suggestion shows only Fix");
	const dis = renderDrFinding({ ...DR_C, severity: "discuss", why: "w" });
	assert.ok(dis.includes("💭") && dis.includes("**Why**") && !dis.includes("**Fix**") && !dis.includes("**Code**"), "discuss shows only Why");
});

// P8.3 renderReview assembles the whole document.
it("P8.3 renderReview assembles the whole document.", () => {
	const store = { schema: 1, target: "lib/x", review: { review_type: "pr", status: "needs_changes", scope: "lib/x", commit: "abc123", date: "2026-07-20T00:00:00+0100" }, findings: [
		{ ...DR_C, verify: "Verified" },
		{ ...DR_C, id: "I1", lens: "I", severity: "important", why: "w", fix: "f2" },
		{ ...DR_C, id: "Q1", lens: "Q", severity: "suggestion", fix: "f3" },
		{ ...DR_C, id: "G1", severity: "critical", status: "withdrawn" },
	] };
	const out = renderReview(store);
	assert.ok(out.includes("template_version: 2"), "template_version 2");
	assert.ok(out.includes("date: 2026-07-20T00:00:00+0100"), "date");
	assert.ok(out.includes("commit: abc123"), "commit");
	assert.ok(out.includes("severity: { critical: 1, important: 1, suggestion: 1 }"), "severity counts (withdrawn excluded)");
	assert.ok(out.includes("verification: { verified: 1, weakened: 0, falsified: 0 }"), "verification counts");
	assert.ok(out.includes("blockers_count: 2"), "blockers_count");
	assert.ok(out.includes("## 🔴 Critical") && out.includes("### S1 🔴"), "critical section");
	assert.ok(out.includes("## 🟡 Important") && out.includes("### I1 🟡"), "important section");
	assert.ok(out.includes("## 🔵 Suggestions") && out.includes("### Q1 🔵"), "suggestions section");
	assert.ok(!out.includes("G1"), "withdrawn G1 omitted from the body");
	assert.ok(out.includes("**S1**") && out.includes("**I1**"), "Top Blockers lists S1 + I1");
	assert.ok(out.includes("**Commit:** `abc123`"), "post-heading summary commit");
	assert.ok(out.includes("**Findings:** 1🔴 · 1🟡 · 1🔵"), "summary findings line");
	assert.ok(out.includes("**Verification:** 1✓ / 0− / 0✗"), "summary verification line");
	assert.ok(out.includes("[precedent-weighted]"), "Legend Annotate row");
});

// P8.4 addFinding skips the AR-sentinel render for kind:"dr".
it("P8.4 addFinding skips the AR-sentinel render for kind:\"dr\".", () => {
	const fx = mkDrFixture();
	const rec = addFinding(fx.artifact, fx.root, DR_C);
	assert.equal(rec.id, "S1", "returns the record");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 1, "one finding persisted");
	assert.equal(readFileSync(fx.artifact, "utf-8"), "---\nstatus: in-progress\n---\n# DR\n", ".md unchanged by the DR add (write-once later)");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// P8.5 CLI render --review writes the whole DR .md write-once.
it("P8.5 CLI render --review writes the whole DR .md write-once.", () => {
	const fx = mkDrFixture();
	addFinding(fx.artifact, fx.root, DR_C);
	const r = spawnSync("node", [STORE, "render", "--review", "--artifact", fx.artifact, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(r.status, 0, `render --review exits 0 (stderr: ${r.stderr})`);
	assert.match(r.stdout, /^rendered DR review/, "announces the render");
	const md = readFileSync(fx.artifact, "utf-8");
	assert.ok(md.startsWith("---"), "starts with frontmatter");
	assert.ok(md.includes("template_version: 2"), "template_version 2");
	assert.ok(md.includes("blockers_count:"), "blockers_count present");
	assert.ok(md.includes("## 🔴 Critical"), "critical section");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ---- Phase 7: in-process dispatch routing (Stryker attributes these mutants) ----

/** Capture streams + feed stdin for one in-process dispatch() call. */
function runDispatch(argv, stdin = "") {
	const out = [];
	const err = [];
	const code = store.dispatch(argv, {
		readStdin: () => stdin,
		stdout: { write: (s) => out.push(s) },
		stderr: { write: (s) => err.push(s) },
	});
	return { code, out: out.join(""), err: err.join("") };
}

// D1. dispatch routing + exit codes — the Phase-7 Test Contract oracle (0 ok / 2 usage / 1 thrown).
it("dispatch routing + exit codes", () => {
	const fx = mkFixture();
	const added = runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(VALID_FINDING));
	assert.equal(added.code, 0, `add returns 0 (stderr: ${added.err})`);
	assert.match(added.out, /^added L0-01 \(fp [0-9a-f]{16}\) -> .*review\.json/, "add stdout announces the add");
	assert.equal(runDispatch([]).code, 2, "no args -> exit 2");
	assert.match(runDispatch([]).err, /^usage: store\.mjs init/, "no args -> usage on stderr");
	assert.equal(runDispatch(["frobnicate"]).code, 2, "unknown subcommand -> exit 2");
	assert.equal(runDispatch(["add"]).code, 2, "add without --artifact -> exit 2");
	const empty = runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], "   ");
	assert.equal(empty.code, 2, "empty stdin -> exit 2");
	assert.match(empty.err, /store add: empty stdin/, "empty stdin -> store add: message");
	rmSync(fx.tmp, { recursive: true, force: true });
	const tmp2 = mkdtempSync(join(tmpdir(), "store-noinit-"));
	writeFileSync(join(tmp2, "review.md"), "---\ntarget: lib/x\n---\n# Review\n");
	const thrown = runDispatch(["add", "--artifact", join(tmp2, "review.md"), "--root", tmp2], "{}");
	assert.equal(thrown.code, 1, "thrown (un-init'd store) -> exit 1");
	assert.match(thrown.err, /^store add:/, "thrown -> store add: prefix");
	rmSync(tmp2, { recursive: true, force: true });
});

// D2. import smoke-test — the 4 harness-critical exports still resolve (frozen-contract guard).
it("import smoke-test (harness exports resolve)", () => {
	for (const fn of [deriveStorePath, renderFinding, renderTally, sentinelsFor]) {
		assert.equal(typeof fn, "function", "harness export resolves as a function");
	}
});

// D3. dispatch init — happy path + empty-stdin + no-artifact.
it("dispatch init", () => {
	const fx = mkLayersFixture();
	const r = runDispatch(["init", "--artifact", fx.artifact], JSON.stringify({ target: "lib/x", layers: [{ n: "0", name: "L0" }] }));
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^initialized .* with layer\(s\) 0/, "init announces the layers");
	const fx2 = mkLayersFixture();
	assert.equal(runDispatch(["init", "--artifact", fx2.artifact], "").code, 2, "init empty stdin -> 2");
	assert.match(runDispatch(["init", "--artifact", fx2.artifact], "").err, /store init: empty stdin/, "init empty stdin message");
	assert.equal(runDispatch(["init"]).code, 2, "init without --artifact -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
	rmSync(fx2.tmp, { recursive: true, force: true });
});

// D4. dispatch update — happy path + empty-stdin + no-artifact.
it("dispatch update", () => {
	const fx = mkFixture();
	runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(VALID_FINDING));
	const r = runDispatch(["update", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify({ id: "L0-01", verify: "Weakened", verifyNote: "narrower" }));
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^updated L0-01: verify Weakened, severity Med, status accepted/, "update announces verify/severity/status");
	assert.equal(runDispatch(["update", "--artifact", fx.artifact, "--root", fx.root], "").code, 2, "update empty stdin -> 2");
	assert.equal(runDispatch(["update"]).code, 2, "update without --artifact -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D5. dispatch query --clusters — report + missing-flag.
it("dispatch query --clusters", () => {
	const fx = mkDiffFixture({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "B", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
	] });
	const r = runDispatch(["query", "--clusters", "--artifact", fx.artifact]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^Clusters:/, "query prints the cluster report");
	assert.equal(runDispatch(["query", "--artifact", fx.artifact]).code, 2, "query without --clusters -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D6. dispatch diff — drift line + missing --prior.
it("dispatch diff", () => {
	const fx = mkDiffFixture({ findings: [{ id: "L0-01", title: "t1", fp: "A" }, { id: "L0-02", title: "t2", fp: "B" }], hasFrontmatterDrift: true });
	const prior = join(fx.tmp, "prior.json");
	writeFileSync(prior, JSON.stringify({ artifact: "prior.md", findings: [{ id: "L0-01", fp: "A", title: "t" }] }));
	const r = runDispatch(["diff", "--artifact", fx.artifact, "--prior", prior]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /drift vs .*: 1 new, 1 still-open, 0 regressed, 0 resolved/, "diff announces the drift counts");
	assert.equal(runDispatch(["diff", "--artifact", fx.artifact]).code, 2, "diff without --prior -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D7. dispatch render --layer / --tally — both modes + missing --layer.
it("dispatch render --layer / --tally", () => {
	const fx = mkFixture();
	runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(VALID_FINDING));
	const r = runDispatch(["render", "--artifact", fx.artifact, "--layer", "0"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^rendered layer 0/, "render announces the layer");
	const t = runDispatch(["render", "--artifact", fx.artifact, "--layer", "0", "--tally"]);
	assert.equal(t.code, 0, t.err);
	assert.match(t.out, /^rendered layer 0 \(tally only\)/, "render --tally announces tally-only");
	assert.equal(runDispatch(["render", "--artifact", fx.artifact]).code, 2, "render without --layer -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D8. dispatch render --review — DR write-once + missing artifact.
it("dispatch render --review", () => {
	const fx = mkDrFixture();
	runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(DR_C));
	const r = runDispatch(["render", "--review", "--artifact", fx.artifact, "--root", fx.root]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^rendered DR review/, "render --review announces the write");
	assert.equal(runDispatch(["render", "--review"]).code, 2, "render --review without --artifact -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D9. dispatch finalize — dual flip + missing artifact.
it("dispatch finalize", () => {
	const fx = mkReviewFixture();
	runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(VALID_FINDING));
	const r = runDispatch(["finalize", "--artifact", fx.artifact, "--root", fx.root, "--health-score", "drifting"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^finalized: 1 finding\(s\), health drifting, content_hash [0-9a-f]{12}\.\.\./, "finalize announces the stamp");
	assert.equal(runDispatch(["finalize"]).code, 2, "finalize without --artifact -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// D10. dispatch export --sarif — --out file + stdout + missing --sarif.
it("dispatch export --sarif", () => {
	const fx = mkFixture();
	runDispatch(["add", "--artifact", fx.artifact, "--root", fx.root], JSON.stringify(VALID_FINDING));
	const outPath = join(fx.tmp, "o.sarif");
	const withOut = runDispatch(["export", "--sarif", "--artifact", fx.artifact, "--out", outPath, "--root", fx.root]);
	assert.equal(withOut.code, 0, withOut.err);
	assert.match(withOut.out, /^exported 1 finding\(s\) ->/, "export --out announces the write");
	assert.equal(JSON.parse(readFileSync(outPath, "utf-8")).version, "2.1.0", "written SARIF version");
	const toStdout = runDispatch(["export", "--sarif", "--artifact", fx.artifact, "--root", fx.root]);
	assert.equal(toStdout.code, 0, toStdout.err);
	assert.equal(JSON.parse(toStdout.out).version, "2.1.0", "stdout SARIF parses");
	assert.equal(runDispatch(["export", "--artifact", fx.artifact, "--root", fx.root]).code, 2, "export without --sarif -> 2");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// ============================================================================
// Mutation hardening (Batch A + B) — frozen golden-equality + exact error arrays
// ============================================================================
// The ported oracle blocks above are characterization tests (presence checks:
// includes / loose regex). They leave StringLiteral + ConditionalExpression
// mutants alive because a mutated string still "includes" the checked substring.
// The blocks below assert BYTE-EXACT render output and EXACT validator error
// arrays. Goldens were captured ONCE from the proven-correct milestone (commit
// 3c9283c, node+vitest 71/71 green) and frozen as literals here — they never
// re-derive from source, so a mutant that changes output can no longer match.

// ---- Batch A: frozen render goldens ----------------------------------------

const GOLDEN_DR_REVIEW = [
	"---",
	"template_version: 2",
	"date: 2026-07-20T00:00:00+0100",
	"author: ",
	"repository: ",
	"branch: ",
	"commit: abc123",
	"review_type: pr",
	"scope: \"lib/x\"",
	"scope_strategy: working-tree",
	"in_scope_files_count: 0",
	"status: needs_changes",
	"severity: { critical: 1, important: 1, suggestion: 1 }",
	"verification: { verified: 1, weakened: 0, falsified: 0 }",
	"blockers_count: 2",
	"tags: [code-review]",
	"---",
	"# Code Review — lib/x",
	"**Commit:** `abc123` · **Status:** `needs_changes` · **Findings:** 1🔴 · 1🟡 · 1🔵 · **Verification:** 1✓ / 0− / 0✗",
	"## Top Blockers",
	"1. **S1** — race",
	"2. **I1** — race",
	"## Legend",
	"",
	"```text",
	"Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss",
	"ID prefix   I interaction   Q quality   S security   G gap",
	"Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)",
	"Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]",
	"```",
	"## 🔴 Critical",
	"",
	"",
	"",
	"### S1 🔴 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Code**",
	"```",
	"const x = 1;",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f",
	"",
	"## 🟡 Important",
	"",
	"",
	"",
	"### I1 🟡 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Code**",
	"```",
	"const x = 1;",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f2",
	"",
	"## 🔵 Suggestions",
	"",
	"",
	"",
	"### Q1 🔵 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Fix**",
	"f3",
].join("\n");

const GOLDEN_DR_CRIT_ALT = [
	"### S1 🔴 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Code**",
	"```",
	"const x = 1;",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f",
	"",
	"**Alt**",
	"use a lock",
].join("\n");

const GOLDEN_DR_CRIT = [
	"### S1 🔴 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Code**",
	"```",
	"const x = 1;",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f",
].join("\n");

const GOLDEN_DR_IMPORTANT = [
	"### I1 🟡 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Code**",
	"```",
	"const x = 1;",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f2",
].join("\n");

const GOLDEN_DR_SUGGESTION = [
	"### Q1 🔵 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Fix**",
	"f3",
].join("\n");

const GOLDEN_DR_DISCUSS = [
	"### D1 💭 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
	"",
	"**Why**",
	"w",
].join("\n");

const GOLDEN_DR_UNKNOWN = [
	"### U1 🔵 race",
	"",
	"**Where**",
	"`lib/x/a.ts:10`",
].join("\n");

const GOLDEN_DR_MULTI = [
	"### S1 🔴 race",
	"",
	"**Where**",
	"`a.ts:10-20` `b.ts:5`",
	"",
	"**Code**",
	"```",
	"x",
	"y",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f",
].join("\n");

const GOLDEN_CLUSTERS = [
	"Clusters: 4 discovered (4 un-anticipated).",
	"  [AUTO] file lib/x/a.ts: L0-01, L0-02",
	"  [AUTO] symbol Svc: L0-01, L0-03",
	"  [AUTO] entity E/P: L0-01, L0-02",
	"  [AUTO] dependsOn L0-01 <-> L0-03: L0-01, L0-03",
].join("\n");

const GOLDEN_CLUSTERS_EMPTY = [
	"Clusters: 0 discovered (0 un-anticipated).",
	"  (none — no shared dimension across >= 2 findings)",
].join("\n");

const GOLDEN_DRIFT = [
	"_vs `prior.md` — compared 2026-07-20_",
	"",
	"| Class | Count |",
	"|---|---|",
	"| NEW | 1 |",
	"| Still-open | 1 |",
	"| Regressed | 1 |",
	"| Resolved | 1 |",
	"",
	"**NEW**",
	"",
	"- N1 — new one",
	"",
	"**Regressed (fixed, now back)**",
	"",
	"- RG1 — regressed one",
	"",
	"**Resolved (gone since prior)**",
	"",
	"- L0-05 — gone",
].join("\n");

const GOLDEN_SARIF_AR = {
	"$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	"version": "2.1.0",
	"runs": [
		{
			"tool": {
				"driver": {
					"name": "rpiv-architectural-review",
					"informationUri": "https://github.com/rpiv",
					"rules": [
						{ "id": "G", "name": "G", "shortDescription": { "text": "rpiv lens G" } },
					],
				},
			},
			"results": [
				{
					"ruleId": "G",
					"ruleIndex": 0,
					"level": "error",
					"message": { "text": "god-file service.ts" },
					"locations": [
						{
							"physicalLocation": {
								"artifactLocation": { "uri": "lib/x/service.ts" },
								"region": { "startLine": 320, "endLine": 320, "snippet": { "text": "export class PlanService {" } },
							},
						},
					],
					"partialFingerprints": { "rpivFingerprint/v1": "a1b2c3d4e5f60718" },
					"baselineState": "new",
					"properties": { "lens": "G", "severity": "High", "class": "redesign" },
					"rank": 90,
				},
			],
		},
	],
};

const GOLDEN_SARIF_DR = {
	"$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	"version": "2.1.0",
	"runs": [
		{
			"tool": {
				"driver": {
					"name": "rpiv-deep-review",
					"informationUri": "https://github.com/rpiv",
					"rules": [
						{ "id": "S", "name": "S", "shortDescription": { "text": "rpiv lens S" } },
					],
				},
			},
			"results": [
				{
					"ruleId": "S",
					"ruleIndex": 0,
					"level": "warning",
					"message": { "text": "race in loader" },
					"locations": [
						{
							"physicalLocation": {
								"artifactLocation": { "uri": "lib/x/a.ts" },
								"region": { "startLine": 10, "endLine": 10, "snippet": { "text": "const x = 1;" } },
							},
						},
					],
					"partialFingerprints": { "rpivFingerprint/v1": "beefbeefbeefbeef" },
					"baselineState": "unchanged",
					"properties": { "lens": "S", "severity": "important", "rpivDriftClass": "Still-open" },
					"rank": 60,
				},
			],
		},
	],
};

// MA1. renderReview — whole DR document byte-exact (frontmatter counts, summary line,
// Top Blockers, Legend, all three severity sections, withdrawn G1 omitted).
it("MA1. renderReview whole-document byte-exact", () => {
	const store = { schema: 1, target: "lib/x", review: { review_type: "pr", status: "needs_changes", scope: "lib/x", commit: "abc123", date: "2026-07-20T00:00:00+0100" }, findings: [
		{ ...DR_C, verify: "Verified" },
		{ ...DR_C, id: "I1", lens: "I", severity: "important", why: "w", fix: "f2" },
		{ ...DR_C, id: "Q1", lens: "Q", severity: "suggestion", fix: "f3" },
		{ ...DR_C, id: "G1", severity: "critical", status: "withdrawn" },
	] };
	assert.equal(renderReview(store), GOLDEN_DR_REVIEW, "renderReview output byte-identical to the frozen golden");
});

// MA2. renderDrFinding — every tier byte-exact (Code/Why/Fix/Alt gating, emoji, endLine).
it("MA2. renderDrFinding per-tier byte-exact", () => {
	assert.equal(renderDrFinding({ ...DR_C, alt: "use a lock" }), GOLDEN_DR_CRIT_ALT, "critical + Alt");
	assert.equal(renderDrFinding(DR_C), GOLDEN_DR_CRIT, "critical, no Alt (alt absent)");
	assert.equal(renderDrFinding({ ...DR_C, id: "I1", lens: "I", severity: "important", fix: "f2" }), GOLDEN_DR_IMPORTANT, "important");
	assert.equal(renderDrFinding({ ...DR_C, id: "Q1", severity: "suggestion", fix: "f3" }), GOLDEN_DR_SUGGESTION, "suggestion (Fix only)");
	assert.equal(renderDrFinding({ ...DR_C, id: "D1", severity: "discuss", why: "w" }), GOLDEN_DR_DISCUSS, "discuss (Why only)");
	assert.equal(renderDrFinding({ ...DR_C, id: "U1", severity: "banana" }), GOLDEN_DR_UNKNOWN, "unknown severity -> emoji + Where only");
	assert.equal(renderDrFinding({ ...DR_C, evidence: [{ path: "a.ts", startLine: 10, endLine: 20, quoted: ["x"] }, { path: "b.ts", startLine: 5, quoted: ["y"] }] }), GOLDEN_DR_MULTI, "multi-evidence + endLine range");
});

// MA3. renderClusters — report byte-exact (populated + empty).
it("MA3. renderClusters report byte-exact", () => {
	const clusterFindings = () => [
		{ id: "L0-01", evidence: [{ path: "lib/x/a.ts" }], symbol: "Svc", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "L0-02", evidence: [{ path: "lib/x/a.ts" }], symbol: "Other", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "L0-03", evidence: [{ path: "lib/y/b.ts" }], symbol: "Svc", entityStage: "E/Q", status: "deferred", crossCutTag: null, dependsOn: ["L0-01"] },
	];
	assert.equal(renderClusters(queryClusters({ findings: clusterFindings() })), GOLDEN_CLUSTERS, "4-cluster report byte-identical");
	assert.equal(renderClusters(queryClusters({ findings: [] })), GOLDEN_CLUSTERS_EMPTY, "empty report byte-identical");
});

// MA4. renderDrift — Drift Delta region byte-exact (vs-line, count table, id lists).
it("MA4. renderDrift region byte-exact", () => {
	const store = {
		findings: [
			{ id: "N1", title: "new one", driftClass: "NEW" },
			{ id: "RG1", title: "regressed one", driftClass: "Regressed" },
			{ id: "SO1", title: "still open", driftClass: "Still-open" },
		],
		drift: { priorArtifact: "prior.md", comparedAt: "2026-07-20T00:00:00+0100", resolved: [{ id: "L0-05", title: "gone" }], counts: { new: 1, stillOpen: 1, regressed: 1, resolved: 1 } },
	};
	assert.equal(renderDrift(store), GOLDEN_DRIFT, "drift region byte-identical to the frozen golden");
});

// MA5. toSarif — full 2.1.0 log deep-equal (AR driver + DR driver, whole object frozen).
it("MA5. toSarif whole-log deepEqual (AR + DR)", () => {
	assert.deepEqual(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "a1b2c3d4e5f60718" }] }), GOLDEN_SARIF_AR, "AR SARIF log frozen");
	assert.deepEqual(toSarif({ schema: 1, findings: [{ kind: "dr", id: "S1", title: "race in loader", lens: "S", severity: "important", status: "accepted", baselineState: "unchanged", driftClass: "Still-open", evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }], fp: "beefbeefbeefbeef" }] }), GOLDEN_SARIF_DR, "DR SARIF log frozen");
});

// ---- Batch B: validator exact error-arrays ---------------------------------
// Each asserts the FULL error array all-at-once (order + every message frozen),
// killing StringLiteral mutants in every message + ConditionalExpression mutants
// that would drop/add a branch's error. Clean cases ([]) are pinned by P1.1/P1.2.

const ERR_DR_AS_AR = [
	"severity must be one of Low | Med | High (got: critical)",
	"missing or empty field: anchor",
	"missing or empty field: what",
	"layer must be N or N.M (got: undefined)",
	"effort must be one of S | M | L (got: undefined)",
	"class must be one of polish | redesign (got: undefined)",
	"verify must be one of Verified | Weakened | Falsified (got: undefined)",
	"blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)",
	"remediation must be an object",
	"dependsOn must be a string array (may be empty)",
];

const ERR_AR_BROKEN = [
	"missing or empty field: title",
	"status must be one of open | accepted | rejected | deferred | withdrawn (got: undefined)",
	"severity must be one of Low | Med | High (got: undefined)",
	"evidence must be a non-empty array",
	"missing or empty field: anchor",
	"missing or empty field: what",
	"missing or empty field: why",
	"layer must be N or N.M (got: undefined)",
	"lens must be one of D/C/G/A/T/L/Sec/M/S/Lc/Fe/Fp/Tc/P/IX/10dim (got: undefined)",
	"effort must be one of S | M | L (got: undefined)",
	"class must be one of polish | redesign (got: undefined)",
	"verify must be one of Verified | Weakened | Falsified (got: undefined)",
	"blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)",
	"remediation must be an object",
	"dependsOn must be a string array (may be empty)",
];

const ERR_EVIDENCE = [
	"evidence[0].path missing",
	"evidence[0].startLine must be a positive integer",
	"evidence[0].quoted must be a non-empty array of verbatim lines",
];

const ERR_REMEDIATION = [
	"remediation.steps must be a non-empty string array",
	"remediation.acceptance must be a non-empty string array",
	"remediation.testStrategy missing",
	"remediation.tradeoff missing",
];

const ERR_DR_FIELDS = [
	"lens must be one of I/Q/S/G for kind:dr (got: Z)",
	"kind:dr critical finding requires a why",
	"kind:dr critical finding requires a fix",
];

const ERR_DRIFT = [
	"baselineState must be one of new | unchanged | updated | absent (got: gone)",
	"driftClass must be one of NEW | Still-open | Resolved | Regressed (got: Mutated)",
	"priorFp must be a non-empty string or null",
	"priorId must be a non-empty string or null",
	"verifyNote must be a non-empty string or null",
];

// MB1. the shared-enum + AR-required + AR-enum surface, all-at-once, in source order.
it("MB1. validateFinding DR-as-AR exact error array", () => {
	assert.deepEqual(validateFinding({ ...DR_C, kind: "ar" }, new Map(), new Set()), ERR_DR_AS_AR, "kind:ar over a dr finding reports every AR requirement");
});

// MB2. a near-empty AR finding surfaces every shape + enum + required error at once.
it("MB2. validateFinding maximally-broken AR exact error array", () => {
	assert.deepEqual(validateFinding({ id: "L0-01", kind: "ar" }, new Map(), new Set()), ERR_AR_BROKEN, "every missing/enum error at once");
});

// MB3. evidence-entry errors (path/startLine/quoted) all-at-once.
it("MB3. validateFinding evidence-entry exact error array", () => {
	assert.deepEqual(validateFinding({ ...VALID_AR, evidence: [{ path: "", startLine: 0, quoted: [] }] }, new Map(), new Set()), ERR_EVIDENCE, "every evidence[0] error at once");
});

// MB4. remediation object errors all-at-once.
it("MB4. validateFinding remediation exact error array", () => {
	assert.deepEqual(validateFinding({ ...VALID_AR, remediation: { steps: [], acceptance: "x", testStrategy: "", tradeoff: null } }, new Map(), new Set()), ERR_REMEDIATION, "every remediation error at once");
});

// MB5. DR-arm errors (lens + per-tier why/fix) all-at-once.
it("MB5. validateFinding DR-fields exact error array", () => {
	assert.deepEqual(validateFinding({ kind: "dr", id: "S1", lens: "Z", title: "t", severity: "critical", status: "open", evidence: [{ path: "a.ts", startLine: 1, quoted: ["x"] }] }, new Map(), new Set()), ERR_DR_FIELDS, "DR lens + critical why/fix at once");
});

// MB6. drift-field errors (baselineState/driftClass/priorFp/priorId/verifyNote) all-at-once.
it("MB6. validateFinding drift-fields exact error array", () => {
	assert.deepEqual(validateFinding({ ...VALID_AR, baselineState: "gone", driftClass: "Mutated", priorFp: 5, priorId: "", verifyNote: 3 }, new Map(), new Set()), ERR_DRIFT, "every drift-field error at once");
});

// ---- Batch C: in-process branch coverage -----------------------------------
// Many branches in checkEvidenceGrounding / deriveStorePath / spliceRegion /
// renderInto / finalizeReview / addFinding / the DR-demotion guard survived only
// because the ported oracles exercise them OUT-OF-PROCESS (spawnSync), which
// Stryker's perTest coverage cannot attribute. These call the functions directly
// and assert the EXACT message/array/region for both sides of each guard.

/** The message a thrown call produced (or "NO THROW"), for exact-equality asserts. */
const throwMsg = (fn) => { try { fn(); return "NO THROW"; } catch (e) { return e.message; } };

// MC1. deriveStorePath — the .md guard (throw) + the .md->.json swap (both sides).
it("MC1. deriveStorePath .md guard + .json swap", () => {
	assert.equal(deriveStorePath("foo/review.md"), "foo/review.json", ".md -> .json");
	assert.equal(throwMsg(() => deriveStorePath("foo/review.txt")), "artifact must be a .md path: foo/review.txt", "non-.md rejected with exact message");
});

// MC2. checkEvidenceGrounding — exact per-branch error arrays, in-process (kills the
// resolve / bounds / quote-window guards the spawnSync grounding oracles can't attribute).
it("MC2. checkEvidenceGrounding exact per-branch arrays (in-process)", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "a\nb\nc\nd\nTARGET\n" } });
	const ground = (ev) => checkEvidenceGrounding({ evidence: [ev] }, fx.root);
	assert.deepEqual(ground({ path: "lib/x/service.ts", startLine: 5, quoted: ["TARGET"] }), [], "resolves + in-range + quote present -> []");
	assert.deepEqual(ground({ path: "lib/x/ghost.ts", startLine: 1, quoted: ["x"] }), ["evidence[0].path does not resolve to a repo file: lib/x/ghost.ts (cite it repo-relative from the root)"], "non-resolving path");
	assert.deepEqual(ground({ path: "lib/x/service.ts", startLine: 99, quoted: ["a"] }), ["evidence[0].startLine 99 exceeds lib/x/service.ts length (6 lines)"], "startLine past EOF");
	assert.deepEqual(ground({ path: "lib/x/service.ts", startLine: 1, quoted: ["NOPE"] }), ["evidence[0].quoted not found at lib/x/service.ts:1 (±3): \"NOPE\""], "quote absent");
	assert.deepEqual(ground({ path: "lib/x/service.ts", startLine: 1, quoted: ["TARGET"] }), ["evidence[0].quoted not found at lib/x/service.ts:1 (±3) (found at line 5): \"TARGET\""], "quote elsewhere -> names the real line");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MC3. spliceRegion — missing-sentinel throw + exact idempotent splice.
it("MC3. spliceRegion missing-sentinel throw + exact splice", () => {
	assert.equal(throwMsg(() => spliceRegion("no markers", sentinelsFor("findings", 0), "X")), "sentinel pair not found in artifact: <!-- BEGIN store:findings layer=0 -->", "missing pair throws exact message");
	const text = `PRE\n${pair("findings", 0)}\nPOST`;
	assert.equal(spliceRegion(text, sentinelsFor("findings", 0), "INSERTED"), "PRE\n<!-- BEGIN store:findings layer=0 -->\nINSERTED\n<!-- END store:findings layer=0 -->\nPOST", "splice replaces only the region body");
});

// MC4. renderInto — the parts.{findings,tally} gates touch ONLY the named region.
it("MC4. renderInto parts gates isolate the region", () => {
	const fx = mkFixture();
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	// tally-only: tamper the findings region, render {findings:false, tally:true}
	writeFileSync(fx.artifact, spliceRegion(readFileSync(fx.artifact, "utf-8"), sentinelsFor("findings", 0), "FTAMPER"));
	let loaded = loadStore(fx.artifact);
	renderInto(fx.artifact, loaded.store, 0, { findings: false, tally: true });
	let md = readFileSync(fx.artifact, "utf-8");
	assert.equal(regionContent(md, "findings", 0).trim(), "FTAMPER", "findings region untouched when findings:false");
	assert.match(regionContent(md, "tally", 0), /\| accepted \| 1 \|/, "tally re-rendered when tally:true");
	// findings-only: tamper the tally region, render {findings:true, tally:false}
	writeFileSync(fx.artifact, spliceRegion(readFileSync(fx.artifact, "utf-8"), sentinelsFor("tally", 0), "TTAMPER"));
	loaded = loadStore(fx.artifact);
	renderInto(fx.artifact, loaded.store, 0, { findings: true, tally: false });
	md = readFileSync(fx.artifact, "utf-8");
	assert.equal(regionContent(md, "tally", 0).trim(), "TTAMPER", "tally region untouched when tally:false");
	assert.ok(regionContent(md, "findings", 0).includes("### L0-01"), "findings re-rendered when findings:true");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MC5. finalizeReview — every gate message + the dual flip, in-process.
it("MC5. finalizeReview gate messages + dual flip (in-process)", () => {
	const fxBad = mkReviewFixture();
	addFinding(fxBad.artifact, fxBad.root, VALID_FINDING);
	assert.equal(throwMsg(() => finalizeReview(fxBad.artifact, fxBad.root, "pending")), "--health-score must be one of healthy | drifting | degraded (got: pending)", "pending rejected");
	assert.equal(throwMsg(() => finalizeReview(fxBad.artifact, fxBad.root, null)), "--health-score must be one of healthy | drifting | degraded (got: none)", "omitted rejected");
	rmSync(fxBad.tmp, { recursive: true, force: true });

	const fxOpen = mkReviewFixture();
	addFinding(fxOpen.artifact, fxOpen.root, { ...VALID_FINDING, id: "L0-03", status: "open" });
	assert.equal(throwMsg(() => finalizeReview(fxOpen.artifact, fxOpen.root, "drifting")), "untriaged findings remain: L0-03", "untriaged blocks");
	rmSync(fxOpen.tmp, { recursive: true, force: true });

	const fxAmb = mkReviewFixture({ seed: { "only.ts": "export const x = 1;\n" } });
	addFinding(fxAmb.artifact, fxAmb.root, { ...VALID_FINDING, evidence: [{ path: "only.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] });
	mkdirSync(join(fxAmb.root, "second"), { recursive: true });
	writeFileSync(join(fxAmb.root, "second", "only.ts"), "export const y = 1;\n");
	assert.equal(throwMsg(() => finalizeReview(fxAmb.artifact, fxAmb.root, "drifting")), "evidence went ambiguous since insert (repo gained same-named files): L0-01: only.ts", "now-ambiguous evidence blocks");
	rmSync(fxAmb.tmp, { recursive: true, force: true });

	const fxLint = mkReviewFixture();
	addFinding(fxLint.artifact, fxLint.root, VALID_FINDING);
	writeFileSync(fxLint.artifact, readFileSync(fxLint.artifact, "utf-8").replace("# Review", "# Review\n\nPhase 1 {Files: , }"));
	assert.match(throwMsg(() => finalizeReview(fxLint.artifact, fxLint.root, "drifting")), /body fails the finalization lint/, "dirty body blocks");
	rmSync(fxLint.tmp, { recursive: true, force: true });

	const fx = mkReviewFixture();
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	const ret = finalizeReview(fx.artifact, fx.root, "drifting");
	assert.equal(ret.findings, 1, "returns finding count");
	assert.match(ret.hash, /^[0-9a-f]{64}$/, "returns a 64-char content hash");
	const md = readFileSync(fx.artifact, "utf-8");
	assert.match(md, /^status: ready$/m, "status flipped to ready");
	assert.match(md, /^health_score: drifting$/m, "health_score written");
	assert.equal(throwMsg(() => finalizeReview(fx.artifact, fx.root, "drifting")), "artifact already ready — re-stamp via validate-artifact.mjs --stamp", "double-finalize refused");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MC6. addFinding — validation / grounding / fingerprint rejections, in-process.
it("MC6. addFinding rejection messages (in-process)", () => {
	const fx1 = mkFixture();
	assert.equal(throwMsg(() => addFinding(fx1.artifact, fx1.root, { ...VALID_FINDING, why: "" })), "invalid finding: missing or empty field: why", "schema rejection");
	rmSync(fx1.tmp, { recursive: true, force: true });
	const fx2 = mkFixture();
	assert.equal(throwMsg(() => addFinding(fx2.artifact, fx2.root, { ...VALID_FINDING, evidence: [{ path: "lib/x/ghost.ts", startLine: 1, endLine: null, quoted: ["x"] }] })), "invalid finding: evidence[0].path does not resolve to a repo file: lib/x/ghost.ts (cite it repo-relative from the root)", "grounding rejection");
	rmSync(fx2.tmp, { recursive: true, force: true });
	const fx3 = mkFixture({ seed: { "lib/x/service.ts": "// just a comment\n" } });
	assert.equal(throwMsg(() => addFinding(fx3.artifact, fx3.root, { ...VALID_FINDING, id: "L0-02", evidence: [{ ...VALID_FINDING.evidence[0], quoted: ["// just a comment"] }] })), "fingerprint invalid for L0-02: 'quoted' evidence is empty after normalisation", "fp:null rejection");
	rmSync(fx3.tmp, { recursive: true, force: true });
});

// MC7. updateFinding — the DR cross-tier demotion guard (both sides), in-process.
it("MC7. updateFinding DR cross-tier demotion guard (in-process)", () => {
	const fx = mkDrFixture();
	addFinding(fx.artifact, fx.root, { kind: "dr", id: "S1", lens: "S", title: "race", severity: "suggestion", status: "open", evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }], fix: "f" });
	assert.equal(throwMsg(() => updateFinding(fx.artifact, fx.root, { id: "S1", verify: "Weakened", verifyNote: "narrower" })), "update: cannot Weaken S1 to discuss — that tier requires a `why` this finding lacks", "demotion into a tier that needs a missing field is refused");
	rmSync(fx.tmp, { recursive: true, force: true });
	const fx2 = mkDrFixture();
	addFinding(fx2.artifact, fx2.root, { kind: "dr", id: "S1", lens: "S", title: "race", severity: "critical", status: "open", evidence: [{ path: "lib/x/a.ts", startLine: 10, quoted: ["const x = 1;"] }], why: "w", fix: "f" });
	assert.equal(updateFinding(fx2.artifact, fx2.root, { id: "S1", verify: "Weakened", verifyNote: "n" }).severity, "important", "critical weakens to important when why+fix present");
	rmSync(fx2.tmp, { recursive: true, force: true });
});

// MC8. initStore — the artifact-exists guard + spec normalization (trim), in-process.
it("MC8. initStore artifact-not-found guard + spec trim", () => {
	const tmp = mkdtempSync(join(tmpdir(), "store-noart-"));
	assert.match(throwMsg(() => initStore(join(tmp, "ghost.md"), { target: "x", layers: [{ n: "0" }] })), /^artifact not found: /, "missing artifact throws");
	rmSync(tmp, { recursive: true, force: true });
	const fx = mkLayersFixture();
	initStore(fx.artifact, { target: "  lib/x  ", layers: [{ n: "0", name: "  Persist  " }] });
	const s = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(s.target, "lib/x", "spec.target trimmed");
	assert.equal(s.layers[0].name, "Persist", "layer name trimmed");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MC9. renderFinding — mdEscape backtick truncation + multi-evidence line shape.
it("MC9. renderFinding mdEscape backtick + multi-evidence", () => {
	const bt = renderFinding({ ...VALID_AR, evidence: [{ path: "lib/x/tpl.ts", startLine: 5, quoted: ["const s = `x`;"] }] });
	assert.ok(bt.includes("`lib/x/tpl.ts:5` — `const s =...`"), "backtick quote is truncated code-span-safe");
	const multi = renderFinding({ ...VALID_AR, evidence: [{ path: "a.ts", startLine: 1, endLine: 9, quoted: ["L1"] }, { path: "b.ts", startLine: 3, quoted: ["L2"] }] });
	assert.ok(multi.includes("`a.ts:1-9` — `L1`"), "endLine renders a range");
	assert.ok(multi.includes("`b.ts:3` — `L2`"), "no endLine renders a single line");
});

// MC10. toSarif — empty findings default to the AR driver (the length>0 guard) +
// the no-notes suppression justification (String(verify ?? status)).
it("MC10. toSarif empty-findings AR driver + suppression justification", () => {
	const s = toSarif({ schema: 1, findings: [] });
	assert.equal(s.runs[0].tool.driver.name, "rpiv-architectural-review", "empty findings -> AR driver, not DR");
	assert.deepEqual(s.runs[0].results, [], "no results for empty findings");
	const rejected = toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f1", status: "rejected" }] }).runs[0].results[0];
	assert.equal(rejected.suppressions[0].justification, "Verified", "no-notes suppression justification falls back to verify");
});

// ============================================================================
// Mutation hardening (Batch D) — alternate-branch goldens
// ============================================================================
// Batch A froze ONE representative output per renderer; that leaves the OTHER
// side of each field-conditional / `?? default` untested (e.g. an absent
// entityStage, an empty dependsOn, absent metadata falling back to defaults, a
// multi-line SARIF snippet). These goldens freeze the alternate branch.

// MD1. renderTally — a rich 2-layer store, both layers frozen (status counts incl.
// rejected/withdrawn, multi-lens map, cross-cut introduced vs reused, dep edges).
const GOLDEN_TALLY_L0 = [
	"### Layer 0 — tally",
	"",
	"| Status | Count |",
	"|---|---|",
	"| accepted | 1 |",
	"| rejected | 1 |",
	"| deferred | 1 |",
	"| withdrawn | 1 |",
	"",
	"Slop lenses fired in this layer: `{G: 2; Lc: 1; S: 1}`",
	"Cross-cutting tags introduced: T1-boundaries. Reused: none.",
	"",
	"Dependency edges within Layer 0:",
	"",
	"- L0-01 depends on L0-02 (dead cluster)",
].join("\n");

const GOLDEN_TALLY_L1 = [
	"### Layer 1 — tally",
	"",
	"| Status | Count |",
	"|---|---|",
	"| accepted | 1 |",
	"| rejected | 0 |",
	"| deferred | 0 |",
	"| withdrawn | 0 |",
	"",
	"Slop lenses fired in this layer: `{G: 1}`",
	"Cross-cutting tags introduced: none. Reused: T1-boundaries.",
].join("\n");

it("MD1. renderTally rich 2-layer byte-exact (both layers)", () => {
	const store = { findings: [
		{ id: "L0-01", layer: 0, lens: "G", title: "god-file", status: "accepted", crossCutTag: "T1-boundaries", dependsOn: ["L0-02"] },
		{ id: "L0-02", layer: 0, lens: "Lc", title: "dead cluster", status: "rejected", crossCutTag: null, dependsOn: [] },
		{ id: "L0-03", layer: 0, lens: "G", title: "gone", status: "withdrawn", crossCutTag: null, dependsOn: [] },
		{ id: "L0-04", layer: 0, lens: "S", title: "race", status: "deferred", crossCutTag: "T1-boundaries", dependsOn: [] },
		{ id: "L1-01", layer: 1, lens: "G", title: "reuse", status: "accepted", crossCutTag: "T1-boundaries", dependsOn: [] },
	] };
	assert.equal(renderTally(store, 0), GOLDEN_TALLY_L0, "layer 0 tally byte-identical");
	assert.equal(renderTally(store, 1), GOLDEN_TALLY_L1, "layer 1 tally byte-identical (T1 reused, not introduced)");
});

// MD2. renderFinding — the ABSENT-field branches: no statusNote, empty dependsOn ("—"),
// null entityStage ("—"), multi-item acceptance ("; " join), 2-value blastRadius.
const GOLDEN_FINDING_MINIMAL = [
	"### L0-09 — minimal",
	"",
	"- **Lens:** A",
	"",
	"**Evidence**",
	"",
	"`lib/y/m.ts:7` — `const y = 2;`",
	"",
	"**Quantified anchor**",
	"",
	"42 LOC",
	"",
	"**What it is**",
	"",
	"what.",
	"",
	"**Why it's slop**",
	"",
	"why.",
	"",
	"**Remediation**",
	"",
	"1. one.",
	"2. two.",
	"",
	"- **Acceptance criteria:** a1; a2",
	"- **Test strategy:** ts.",
	"- **Trade-off / alternative:** to.",
	"",
	"- **Severity:** Low",
	"- **Effort:** S",
	"- **Blast radius:** internal, public-API",
	"- **Class:** polish",
	"- **Entity / stage:** —",
	"- **Verify:** Weakened",
	"- **Status:** **deferred**",
	"- **Depends on:** —",
].join("\n");

it("MD2. renderFinding minimal (absent-field branches) byte-exact", () => {
	const f = {
		id: "L0-09", layer: 0, lens: "A", title: "minimal",
		evidence: [{ path: "lib/y/m.ts", startLine: 7, endLine: null, quoted: ["const y = 2;"] }],
		symbol: "M", anchor: "42 LOC", what: "what.", why: "why.",
		remediation: { steps: ["one.", "two."], acceptance: ["a1", "a2"], testStrategy: "ts.", tradeoff: "to." },
		severity: "Low", effort: "S", blastRadius: ["internal", "public-API"], class: "polish",
		entityStage: null, verify: "Weakened", status: "deferred", dependsOn: [], crossCutTag: null,
	};
	assert.equal(renderFinding(f), GOLDEN_FINDING_MINIMAL, "no statusNote / empty dependsOn / null entityStage all render the em-dash + multi-acceptance joins");
});

// MD3. renderReview — the DEFAULT side of every `meta.X ?? default` (absent metadata),
// plus the trailing meta.sections join, plus the fully-empty (no findings) shape.
const GOLDEN_REVIEW_DEFAULTS = [
	"---",
	"template_version: 2",
	"date: ",
	"author: ",
	"repository: ",
	"branch: ",
	"commit: ",
	"review_type: working",
	"scope: \"lib/z\"",
	"scope_strategy: working-tree",
	"in_scope_files_count: 0",
	"status: needs_changes",
	"severity: { critical: 1, important: 0, suggestion: 0 }",
	"verification: { verified: 0, weakened: 0, falsified: 0 }",
	"blockers_count: 1",
	"tags: [code-review]",
	"---",
	"# Code Review — lib/z",
	"**Commit:** `` · **Status:** `needs_changes` · **Findings:** 1🔴 · 0🟡 · 0🔵 · **Verification:** 0✓ / 0− / 0✗",
	"## Top Blockers",
	"1. **S1** — t-S1",
	"## Legend",
	"",
	"```text",
	"Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss",
	"ID prefix   I interaction   Q quality   S security   G gap",
	"Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)",
	"Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]",
	"```",
	"## 🔴 Critical",
	"",
	"",
	"",
	"### S1 🔴 t-S1",
	"",
	"**Where**",
	"`a.ts:1`",
	"",
	"**Code**",
	"```",
	"x",
	"```",
	"",
	"**Why**",
	"w",
	"",
	"**Fix**",
	"f",
	"## Extra A",
	"",
	"## Extra B",
].join("\n");

const GOLDEN_REVIEW_EMPTY = [
	"---",
	"template_version: 2",
	"date: ",
	"author: ",
	"repository: ",
	"branch: ",
	"commit: ",
	"review_type: working",
	"scope: \"\"",
	"scope_strategy: working-tree",
	"in_scope_files_count: 0",
	"status: needs_changes",
	"severity: { critical: 0, important: 0, suggestion: 0 }",
	"verification: { verified: 0, weakened: 0, falsified: 0 }",
	"blockers_count: 0",
	"tags: [code-review]",
	"---",
	"# Code Review — ",
	"**Commit:** `` · **Status:** `needs_changes` · **Findings:** 0🔴 · 0🟡 · 0🔵 · **Verification:** 0✓ / 0− / 0✗",
	"## Top Blockers",
	"_none_",
	"## Legend",
	"",
	"```text",
	"Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss",
	"ID prefix   I interaction   Q quality   S security   G gap",
	"Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)",
	"Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]",
	"```",
].join("\n");

it("MD3. renderReview default-metadata + empty byte-exact", () => {
	const DR = (id, sev, extra = {}) => ({ kind: "dr", id, lens: "S", title: `t-${id}`, severity: sev, status: "open", evidence: [{ path: "a.ts", startLine: 1, quoted: ["x"] }], why: "w", fix: "f", ...extra });
	assert.equal(renderReview({ schema: 1, target: "lib/z", findings: [DR("S1", "critical")], review: { sections: ["## Extra A", "## Extra B"] } }), GOLDEN_REVIEW_DEFAULTS, "absent metadata falls to defaults; scope from store.target; sections appended");
	assert.equal(renderReview({ schema: 1, target: "", findings: [] }), GOLDEN_REVIEW_EMPTY, "no findings -> _none_ blockers + empty scope");
});

// MD4. toSarif — a rich finding (backslash-path -> forward slashes, multi-line snippet,
// entityStage/crossCutTag/priorFp/priorId property bag) + a withdrawn finding (statusNote
// suppression justification).
const GOLDEN_SARIF_RICH = {
	"$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	"version": "2.1.0",
	"runs": [
		{
			"tool": { "driver": { "name": "rpiv-architectural-review", "informationUri": "https://github.com/rpiv", "rules": [{ "id": "G", "name": "G", "shortDescription": { "text": "rpiv lens G" } }] } },
			"results": [
				{
					"ruleId": "G",
					"ruleIndex": 0,
					"level": "error",
					"message": { "text": "rich" },
					"locations": [{ "physicalLocation": { "artifactLocation": { "uri": "lib/x/a.ts" }, "region": { "startLine": 3, "endLine": 9, "snippet": { "text": "line one\nline two" } } } }],
					"partialFingerprints": { "rpivFingerprint/v1": "richfp0000000001" },
					"baselineState": "new",
					"properties": { "lens": "G", "severity": "High", "class": "redesign", "entityStage": "WeeklyPlan/PERSIST", "crossCutTag": "T1-boundaries", "rpivDriftClass": "Regressed", "priorFingerprint": "oldfp00000000000a", "priorId": "L0-00" },
					"rank": 90,
				},
			],
		},
	],
};

const GOLDEN_SARIF_WITHDRAWN = {
	"$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	"version": "2.1.0",
	"runs": [
		{
			"tool": { "driver": { "name": "rpiv-architectural-review", "informationUri": "https://github.com/rpiv", "rules": [{ "id": "G", "name": "G", "shortDescription": { "text": "rpiv lens G" } }] } },
			"results": [
				{
					"ruleId": "G",
					"ruleIndex": 0,
					"level": "error",
					"message": { "text": "rich" },
					"locations": [{ "physicalLocation": { "artifactLocation": { "uri": "lib/x/a.ts" }, "region": { "startLine": 3, "endLine": 9, "snippet": { "text": "line one\nline two" } } } }],
					"partialFingerprints": { "rpivFingerprint/v1": "wfp" },
					"baselineState": "new",
					"properties": { "lens": "G", "severity": "High", "class": "redesign" },
					"rank": 90,
					"suppressions": [{ "kind": "external", "justification": "merged elsewhere" }],
				},
			],
		},
	],
};

it("MD4. toSarif rich property-bag + withdrawn suppression deepEqual", () => {
	const rich = {
		id: "L0-01", title: "rich", lens: "G", severity: "High", status: "accepted", verify: "Verified", fp: "richfp0000000001",
		evidence: [{ path: "lib\\x\\a.ts", startLine: 3, endLine: 9, quoted: ["line one", "line two"] }],
		class: "redesign", entityStage: "WeeklyPlan/PERSIST", crossCutTag: "T1-boundaries",
		baselineState: "new", driftClass: "Regressed", priorFp: "oldfp00000000000a", priorId: "L0-00",
	};
	assert.deepEqual(toSarif({ schema: 1, findings: [rich] }), GOLDEN_SARIF_RICH, "backslash->slash uri, multi-line snippet, full property bag");
	assert.deepEqual(toSarif({ schema: 1, findings: [{ ...rich, fp: "wfp", status: "withdrawn", statusNote: "merged elsewhere", driftClass: null, priorFp: null, priorId: null, entityStage: null, crossCutTag: null }] }), GOLDEN_SARIF_WITHDRAWN, "withdrawn -> suppression w/ statusNote justification");
});

// MD5. toSarif — mixed AR+DR store defaults to the AR driver (every, not some), and an
// unknown severity emits no rank + the warning-level default.
it("MD5. toSarif mixed-driver + unknown-severity rank/level", () => {
	const ar = { id: "L0-01", title: "t", lens: "G", severity: "High", status: "accepted", fp: "a", evidence: [{ path: "a.ts", startLine: 1, quoted: ["x"] }] };
	const dr = { kind: "dr", id: "S1", lens: "S", severity: "critical", title: "t", status: "open", fp: "z", evidence: [{ path: "a.ts", startLine: 1, quoted: ["x"] }] };
	assert.equal(toSarif({ schema: 1, findings: [ar, dr] }).runs[0].tool.driver.name, "rpiv-architectural-review", "mixed kinds -> AR driver (every dr must hold, not some)");
	const weird = toSarif({ schema: 1, findings: [{ ...ar, severity: "weird" }] }).runs[0].results[0];
	assert.equal("rank" in weird, false, "unknown severity -> no rank field");
	assert.equal(weird.level, "warning", "unknown severity -> warning level default");
});

// MD6. addFinding — duplicate id rejected in-process (attributes the priorIds Set build).
it("MD6. addFinding duplicate-id rejection (in-process)", () => {
	const fx = mkFixture();
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	assert.equal(throwMsg(() => addFinding(fx.artifact, fx.root, VALID_FINDING)), "invalid finding: duplicate id: L0-01 (IDs are append-only, never reused)", "second add of the same id rejected");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MD7. updateFinding — the patch guards' EXACT messages (a loose regex let the guard vs the
// re-validate message be confused; freeze the guard's own text).
it("MD7. updateFinding patch-guard exact messages", () => {
	const fx = mkUpdateFixture();
	assert.equal(throwMsg(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Maybe" })), "update: verify must be one of Verified | Weakened | Falsified (got: Maybe)", "bad verify -> the guard message (not the re-validate message)");
	assert.equal(throwMsg(() => updateFinding(fx.artifact, fx.root, { verify: "Verified" })), "update: patch.id (string) is required", "missing id");
	assert.equal(throwMsg(() => updateFinding(fx.artifact, fx.root, { id: "ZZ", verify: "Verified" })), "update: no finding with id ZZ", "unknown id");
	rmSync(fx.tmp, { recursive: true, force: true });
});

// MD8. spliceRegion — the partial-sentinel branches (only BEGIN present, END before BEGIN)
// both throw (attributes the `ei !== -1` and `bi <= ei` clauses of sentinelPairFound).
it("MD8. spliceRegion partial-sentinel branches throw", () => {
	const only = sentinelsFor("findings", 0);
	assert.equal(throwMsg(() => spliceRegion("<!-- BEGIN store:findings layer=0 -->\nonly begin", only, "X")), "sentinel pair not found in artifact: <!-- BEGIN store:findings layer=0 -->", "BEGIN without END throws");
	assert.equal(throwMsg(() => spliceRegion("<!-- END store:findings layer=0 -->\nx\n<!-- BEGIN store:findings layer=0 -->", only, "X")), "sentinel pair not found in artifact: <!-- BEGIN store:findings layer=0 -->", "END before BEGIN throws");
});

// MD9. validateFinding — remediation non-object variants + the N.M layer regex boundary.
it("MD9. validateFinding remediation-shape + layer-format edges", () => {
	assert.deepEqual(validateFinding({ ...VALID_AR, remediation: null }, new Map(), new Set()), ["remediation must be an object"], "null remediation");
	assert.deepEqual(validateFinding({ ...VALID_AR, remediation: [] }, new Map(), new Set()), ["remediation must be an object"], "array remediation");
	assert.deepEqual(validateFinding({ ...VALID_AR, layer: "1.2.3" }, new Map(), new Set()), ["layer must be N or N.M (got: 1.2.3)"], "N.M.P rejected");
	assert.deepEqual(validateFinding({ ...VALID_AR, layer: "1.2" }, new Map(), new Set()), [], "N.M accepted");
});

// ============================================================================
// Mutation hardening (Batch E) — multi-element join separators + a bounds edge
// ============================================================================
// Single-element fixtures left the `.join(sep)` separators equivalent (one item
// never emits the separator). These use 2+ elements so the separator is real.

// ME1. finalizeReview — the untriaged (", ") and ambiguous ("; ") id-list separators.
it("ME1. finalizeReview multi-id join separators", () => {
	const fxOpen = mkReviewFixture();
	addFinding(fxOpen.artifact, fxOpen.root, { ...VALID_FINDING, id: "L0-03", status: "open" });
	addFinding(fxOpen.artifact, fxOpen.root, { ...VALID_FINDING, id: "L0-04", status: "open" });
	assert.equal(throwMsg(() => finalizeReview(fxOpen.artifact, fxOpen.root, "drifting")), "untriaged findings remain: L0-03, L0-04", "two open ids joined with ', '");
	rmSync(fxOpen.tmp, { recursive: true, force: true });

	const fxAmb = mkReviewFixture({ seed: { "only.ts": "export const x = 1;\n" } });
	addFinding(fxAmb.artifact, fxAmb.root, { ...VALID_FINDING, id: "L0-01", evidence: [{ path: "only.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] });
	addFinding(fxAmb.artifact, fxAmb.root, { ...VALID_FINDING, id: "L0-02", evidence: [{ path: "only.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] });
	mkdirSync(join(fxAmb.root, "second"), { recursive: true });
	writeFileSync(join(fxAmb.root, "second", "only.ts"), "export const y = 1;\n");
	assert.equal(throwMsg(() => finalizeReview(fxAmb.artifact, fxAmb.root, "drifting")), "evidence went ambiguous since insert (repo gained same-named files): L0-01: only.ts; L0-02: only.ts", "two ambiguous entries joined with '; '");
	rmSync(fxAmb.tmp, { recursive: true, force: true });
});

// ME2. renderFinding — the dependsOn ", " separator (2 ids).
it("ME2. renderFinding multi-dependsOn join", () => {
	assert.ok(renderFinding({ ...VALID_AR, dependsOn: ["L0-02", "L0-03"] }).includes("- **Depends on:** L0-02, L0-03"), "two dependsOn ids joined with ', '");
});

// ME3. renderTally — the introduced-tags ", " separator (2 distinct tags in a layer).
it("ME3. renderTally multi-tag introduced join", () => {
	const store = { findings: [
		{ id: "L0-01", layer: 0, lens: "G", title: "a", status: "accepted", crossCutTag: "T1-x", dependsOn: [] },
		{ id: "L0-02", layer: 0, lens: "G", title: "b", status: "accepted", crossCutTag: "T2-y", dependsOn: [] },
	] };
	assert.ok(renderTally(store, 0).includes("Cross-cutting tags introduced: T1-x, T2-y. Reused: none."), "two introduced tags joined with ', '");
});

// ME4. checkEvidenceGrounding — the startLine bounds boundary (== length ok, > length error).
it("ME4. checkEvidenceGrounding startLine boundary (> vs >=)", () => {
	const fx = mkFixture({ seed: { "lib/x/service.ts": "l1\nl2\nl3" } });
	assert.deepEqual(checkEvidenceGrounding({ evidence: [{ path: "lib/x/service.ts", startLine: 3, quoted: ["l3"] }] }, fx.root), [], "startLine == length is in range");
	assert.deepEqual(checkEvidenceGrounding({ evidence: [{ path: "lib/x/service.ts", startLine: 4, quoted: ["l3"] }] }, fx.root), ["evidence[0].startLine 4 exceeds lib/x/service.ts length (3 lines)"], "startLine == length + 1 overruns");
	rmSync(fx.tmp, { recursive: true, force: true });
});
