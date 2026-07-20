// store.test.mjs — tests for the validated findings store (store.mjs).
//
//   node skills/_shared/store.test.mjs   (prints OK, or throws)
//
// Phase 2 blocks: schema validation, lazy-init, validated insert (JSON side),
// CLI error surface. Later phases append render + finalize blocks below.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateFinding, toSarif, initStore, addFinding, updateFinding, diffReview, queryClusters, renderDrFinding, renderReview, renderFinding, renderTally, spliceRegion, sentinelsFor, renderInto, loadStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "store.mjs");
const FINGERPRINT = join(HERE, "..", "architectural-review", "_helpers", "fingerprint.mjs");

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
{
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
	console.log("OK — add valid finding: appended with computed fp against the seeded envelope.");
}

// 2. a duplicate ID is rejected atomically — nothing written.
{
	const fx = mkFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "first add succeeds");
	const before = readFileSync(fx.storePath, "utf-8");
	const r = runAdd(fx, VALID_FINDING);
	assert.equal(r.status, 1, "duplicate id must exit 1");
	assert.match(r.stderr, /duplicate id: L0-01/, "names the duplicate id");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes identical before/after");
	assert.equal(JSON.parse(before).findings.length, 1, "still one finding");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — duplicate id: rejected atomically, store bytes unchanged.");
}

// 3. an ambiguous bare-basename evidence path is rejected at insert.
{
	const fx = mkFixture({ seed: { "a/service.ts": "export const x = 1;\n", "b/service.ts": "export const x = 1;\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ ...VALID_FINDING.evidence[0], path: "service.ts" }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "ambiguous bare basename must exit 1");
	assert.match(r.stderr, /ambiguous bare basename: service\.ts/, "names the ambiguous path");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — no finding persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — ambiguous evidence: rejected at insert, no store file created.");
}

// 4. evidence that normalises away yields fp:null and is rejected with the helper's own error.
{
	const fx = mkFixture({ seed: { "lib/x/service.ts": "// just a comment\n" } });
	const finding = { ...VALID_FINDING, id: "L0-02", evidence: [{ ...VALID_FINDING.evidence[0], quoted: ["// just a comment"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "fp:null must exit 1");
	assert.match(r.stderr, /fingerprint invalid for L0-02/, "names the finding");
	assert.match(r.stderr, /empty after normalisation/, "surfaces the helper's own error");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged (nothing persisted)");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — fp-null: rejected with the fingerprint helper's error, nothing written.");
}

// 5. validation reports ALL errors at once, including unknown-field typos.
{
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
	console.log("OK — all errors reported at once (missing + unknown + enum).");
}

// 6. CLI error surface — usage and malformed stdin.
{
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
	console.log("OK — CLI error paths: usage (exit 2), malformed stdin (exit 1), unknown subcommand (exit 2).");
}

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
{
	assert.equal(renderFinding(GOLDEN_FINDING), GOLDEN_FINDING_BLOCK, "finding block matches the frozen golden");
	console.log("OK — golden finding block: 15 rendered fields, heading-vs-list-item split, fp/symbol never render.");
}

// 8. the tally region is derived deterministically.
{
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
	console.log("OK — golden tally: status counts, inline-code lens counts, introduced/reused tags, dependency edges.");
}

// 9. the splice is idempotent and never touches prose outside the sentinels.
{
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
	console.log("OK — idempotent splice: hand prose outside the sentinels is never touched; re-render is a no-op.");
}

// 10. a missing sentinel pair rejects the add atomically — neither file written.
{
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
	console.log("OK — missing sentinels: add rejected atomically, neither file written.");
}

// 11. quoted lines with backticks render code-span-safe while the JSON stays verbatim.
{
	const fx = mkFixture({ seed: { "lib/x/tpl.ts": "a\nb\nc\nd\nconst s = `x`;\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/tpl.ts", startLine: 5, endLine: null, quoted: ["const s = `x`;"] }] };
	assert.equal(runAdd(fx, finding).status, 0, "add succeeds");
	assert.ok(readFileSync(fx.artifact, "utf-8").includes("`lib/x/tpl.ts:5` — `const s =...`"), "evidence line is code-span-safe");
	const store = JSON.parse(readFileSync(fx.storePath, "utf-8"));
	assert.equal(store.findings[0].evidence[0].quoted[0], "const s = `x`;", "review.json keeps the quote verbatim");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — backtick-safe quotes: render truncates at the backtick; JSON stays verbatim.");
}

// 12. `render --tally` re-renders ONLY the tally region.
{
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
	console.log("OK — tally-only render: re-renders only the tally, leaves the findings region as-is.");
}

// ---- Phase 4: finalize ------------------------------------------------------

// 13. a fully-triaged store finalizes — dual flip, content_hash stamped LAST, real lint passes.
{
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
	const lint = spawnSync("node", [join(HERE, "validate-artifact.mjs"), fx.artifact, "--root", fx.root], { encoding: "utf-8" });
	assert.equal(lint.status, 0, `validate-artifact must pass (stderr: ${lint.stderr})`);
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — finalize happy path: dual flip, content_hash stamped last, the real lint passes.");
}

// 14. an untriaged (status: open) finding blocks the flip — nothing written.
{
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
	console.log("OK — untriaged gate: an open finding blocks the flip, nothing written.");
}

// 15. the health verdict is a hard enum gate — pending and absence both rejected.
{
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
	console.log("OK — health enum gate: pending and absence both rejected, files unchanged.");
}

// 16. the citation re-check catches evidence that went ambiguous AFTER insert.
{
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
	console.log("OK — finalize ambiguity re-check: evidence that went ambiguous after insert blocks the flip.");
}

// 17. double-finalize is refused.
{
	const fx = mkReviewFixture();
	assert.equal(runAdd(fx, VALID_FINDING).status, 0, "add accepted finding");
	assert.equal(runFinalize(fx, "drifting").status, 0, "first finalize succeeds");
	const mdBefore = readFileSync(fx.artifact, "utf-8");
	const r = runFinalize(fx, "drifting");
	assert.equal(r.status, 1, "second finalize refused");
	assert.match(r.stderr, /already ready — re-stamp via validate-artifact\.mjs --stamp/, "points to the re-stamp path");
	assert.equal(readFileSync(fx.artifact, "utf-8"), mdBefore, ".md bytes unchanged (no re-stamp)");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — double-finalize refused: second flip rejected, no re-stamp.");
}

// 18. the three content-hash concepts stay name-distinct.
{
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
	console.log("OK — field-name distinctness: content_hash never a finding field; fp is the only record hash.");
}

// ---- Phase 7: insert-time evidence grounding --------------------------------

// 19. an evidence path that resolves to no repo file is rejected at insert.
{
	const fx = mkFixture();
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/ghost.ts", startLine: 1, endLine: null, quoted: ["export const x = 1;"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "non-resolving evidence path must exit 1");
	assert.match(r.stderr, /evidence\[0\]\.path does not resolve to a repo file: lib\/x\/ghost\.ts/, "names the unresolved path");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — no finding persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — grounding: non-resolving evidence path rejected at insert.");
}

// 20. a startLine beyond the file length is rejected.
{
	const fx = mkFixture({ seed: { "lib/x/service.ts": "a\nb\nc" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/service.ts", startLine: 99, endLine: null, quoted: ["a"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "out-of-bounds startLine must exit 1");
	assert.match(r.stderr, /startLine 99 exceeds lib\/x\/service\.ts length \(3 lines\)/, "names the line overrun");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — nothing persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — grounding: startLine beyond file length rejected.");
}

// 21. a quoted line that does not appear at the cited path:line (±3) is rejected.
{
	const fx = mkFixture(); // lib/x/service.ts line 1 = export const x = 1;
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/service.ts", startLine: 1, endLine: null, quoted: ["export const NOPE = 999;"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "mismatched quote must exit 1");
	assert.match(r.stderr, /evidence\[0\]\.quoted not found at lib\/x\/service\.ts:1 \(±3\)/, "names the missing quote");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 0, "seeded store unchanged — nothing persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — grounding: quote not matching the cited line rejected.");
}

// 23. a quote that IS in the file but at a different line names the actual line (actionable).
{
	const fx = mkFixture({ seed: { "lib/x/f.ts": "a\nb\nc\nd\nTARGET_LINE\n" } });
	const finding = { ...VALID_FINDING, evidence: [{ path: "lib/x/f.ts", startLine: 1, endLine: null, quoted: ["TARGET_LINE"] }] };
	const r = runAdd(fx, finding);
	assert.equal(r.status, 1, "wrong-line quote must exit 1");
	assert.match(r.stderr, /not found at lib\/x\/f\.ts:1 \(±3\) \(found at line 5\)/, "names where the quote actually is");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — grounding: a quote found elsewhere reports its actual line (actionable hint).");
}

// ---- Phase 8: finalize body-lint -------------------------------------------

// 22. a {token}-dirty body prose blocks finalize — nothing flipped.
{
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
	console.log("OK — finalize body-lint: a {token}-dirty body cannot flip to ready.");
}

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
{
	assert.deepEqual(validateFinding(VALID_AR, new Map(), new Set()), [], "valid AR (kind omitted) validates clean");
	assert.deepEqual(
		validateFinding({ ...VALID_AR, kind: "xr" }, new Map(), new Set()),
		["kind must be one of ar | dr (got: xr)"],
		"unknown kind rejected with exactly the enum message",
	);
	console.log("OK — P1 kind discriminator: unknown kind rejected; kind-absent defaults to ar.");
}

// P1.2 kind gates the AR-extra fields.
{
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
	console.log("OK — P1 kind gates ar-extra: dr shared-core clean; as-ar reports missing AR fields + wrong-set severity.");
}

// P1.3 severity is shared core with a kind-dependent value set.
{
	assert.ok(
		validateFinding({ ...VALID_AR, severity: "critical" }, new Map(), new Set()).includes("severity must be one of Low | Med | High (got: critical)"),
		"an AR finding rejects a dr-severity",
	);
	assert.ok(
		validateFinding({ ...DR_MIN, severity: "High" }, new Map(), new Set()).includes("severity must be one of critical | important | suggestion | discuss (got: High)"),
		"a dr finding rejects an ar-severity",
	);
	console.log("OK — P1 severity kind-dependent: AR value set != DR value set.");
}

// P1.4 blastRadius is an OPEN multi-value set; renderFinding joins it.
{
	const emptyErr = "blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)";
	assert.deepEqual(validateFinding({ ...VALID_AR, blastRadius: ["on-disk", "cross-module", "runtime-config"] }, new Map(), new Set()), [], "multi-value + free-form accepted");
	assert.deepEqual(validateFinding({ ...VALID_AR, blastRadius: ["other"] }, new Map(), new Set()), [], "'other' accepted");
	assert.ok(validateFinding({ ...VALID_AR, blastRadius: [] }, new Map(), new Set()).includes(emptyErr), "empty array rejected");
	assert.ok(validateFinding({ ...VALID_AR, blastRadius: "cross-module" }, new Map(), new Set()).includes(emptyErr), "bare string rejected (no longer valid)");
	assert.ok(renderFinding({ ...VALID_AR, blastRadius: ["on-disk", "cross-module"] }).includes("- **Blast radius:** on-disk, cross-module"), "render joins the array with ', '");
	assert.ok(renderFinding({ ...VALID_AR, blastRadius: "cross-module" }).includes("- **Blast radius:** cross-module"), "render coerces a legacy scalar as-is");
	console.log("OK — P1 blastRadius open array: multi-value + free-form accepted; scalar/empty rejected; render joins.");
}

// P1.5 drift fields validated when present; verify:"Falsified" accepted on AR.
{
	assert.deepEqual(
		validateFinding({ ...VALID_AR, verify: "Falsified", baselineState: "unchanged", driftClass: "Still-open", priorFp: "a1b2c3d4e5f60718", priorId: "L0-00" }, new Map(), new Set()),
		[],
		"Falsified + drift fields accepted",
	);
	const errs = validateFinding({ ...VALID_AR, baselineState: "gone", driftClass: "Mutated" }, new Map(), new Set());
	assert.ok(errs.includes("baselineState must be one of new | unchanged | updated | absent (got: gone)"), "bad baselineState rejected");
	assert.ok(errs.includes("driftClass must be one of NEW | Still-open | Resolved | Regressed (got: Mutated)"), "bad driftClass rejected");
	console.log("OK — P1 drift fields + Falsified: validated when present; verify:Falsified accepted on AR.");
}

// ---- Phase 2: SARIF export (toSarif) ----------------------------------------

// P2.1 minimal-valid 2.1.0 log.
{
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
	console.log("OK — P2 sarif minimal valid: version/$schema/per-lens rule/result/fingerprint/baselineState.");
}

// P2.2 DR severity + persisted drift map, driver flips to deep-review.
{
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
	console.log("OK — P2 sarif dr + drift: driver flips, dr severity/drift map, persisted baselineState.");
}

// P2.3 Regressed rides the property bag.
{
	const store = { schema: 1, findings: [{ ...VALID_AR, fp: "newfp0000000000a", baselineState: "new", driftClass: "Regressed", priorFp: "oldfp0000000000b", priorId: "L0-00" }] };
	const r0 = toSarif(store).runs[0].results[0];
	assert.equal(r0.baselineState, "new", "Regressed baselineState new");
	assert.equal(r0.properties.rpivDriftClass, "Regressed", "rpivDriftClass");
	assert.equal(r0.properties.priorFingerprint, "oldfp0000000000b", "priorFingerprint");
	assert.equal(r0.properties.priorId, "L0-00", "priorId");
	console.log("OK — P2 sarif regressed bag: baselineState new + drift class + prior identity in bag.");
}

// P2.4 triaged-away findings are suppressed, not active.
{
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f1", status: "rejected" }] }).runs[0].results[0].suppressions[0].kind, "external", "rejected -> suppressed");
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f2", verify: "Falsified" }] }).runs[0].results[0].suppressions[0].kind, "external", "Falsified -> suppressed");
	assert.equal(toSarif({ schema: 1, findings: [{ ...VALID_AR, fp: "f3", status: "accepted" }] }).runs[0].results[0].suppressions, undefined, "accepted -> not suppressed");
	console.log("OK — P2 sarif suppressions: rejected/Falsified suppressed; accepted active.");
}

// P2.5 CLI export --sarif writes --out and prints to stdout otherwise; missing --sarif errors.
{
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
	console.log("OK — P2 cli export sarif: --out writes file, stdout otherwise, missing --sarif -> usage.");
}

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
{
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
	console.log("OK — P3 init emits envelope + layer sections in order, preserves the store:layers markers.");
}

// P3.2 init refuses to clobber an existing store.
{
	const fx = mkLayersFixture();
	initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0", name: "L0" }] });
	const before = readFileSync(fx.storePath, "utf-8");
	assert.throws(() => initStore(fx.artifact, { target: "lib/x", layers: [{ n: "0" }] }), /store already initialized/, "second init throws");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes unchanged");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P3 init no clobber: a second init throws, store bytes unchanged.");
}

// P3.3 init validates the spec, writing nothing on failure.
{
	const fx = mkLayersFixture();
	assert.throws(() => initStore(fx.artifact, { layers: [{ n: "0" }] }), /spec\.target/, "missing target");
	assert.equal(existsSync(fx.storePath), false, "no store after missing-target");
	assert.throws(() => initStore(fx.artifact, { target: "x", layers: [] }), /non-empty array/, "empty layers");
	assert.equal(existsSync(fx.storePath), false, "no store after empty-layers");
	assert.throws(() => initStore(fx.artifact, { target: "x", layers: [{ n: "zero" }] }), /layer\.n must be N or N\.M/, "bad layer.n");
	assert.equal(existsSync(fx.storePath), false, "no store after bad-layer.n");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P3 init spec validation: target/layers/layer.n checked, nothing written on failure.");
}

// P3.4 loadStore no longer lazy-inits; addFinding on an un-init'd artifact throws.
{
	const tmp = mkdtempSync(join(tmpdir(), "store-noinit-"));
	const mdPath = join(tmp, "review.md");
	writeFileSync(mdPath, "---\ntarget: lib/x\n---\n# Review\n");
	const storePath = mdPath.replace(/\.md$/, ".json");
	assert.throws(() => loadStore(mdPath), /no store for review\.md — run/, "loadStore directs to init");
	assert.throws(() => loadStore(mdPath), /store init/, "loadStore names store init");
	assert.throws(() => addFinding(mdPath, tmp, VALID_AR), /no store for review\.md — run/, "addFinding on un-init'd throws");
	assert.equal(existsSync(storePath), false, "no review.json created");
	rmSync(tmp, { recursive: true, force: true });
	console.log("OK — P3 loadStore requires init: a missing store throws directing to init; nothing written.");
}

// P3.5 after init, store add splices into the init-created sentinels (end-to-end).
{
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
	console.log("OK — P3 init then add: add splices into the init-created sentinels.");
}

// ---- Phase 4: store update (verify transitions) -----------------------------

/** Seed a fixture and persist one groundable AR finding (id L0-01, severity High). */
function mkUpdateFixture() {
	const fx = mkFixture();
	addFinding(fx.artifact, fx.root, VALID_FINDING);
	return fx;
}

// P4.1 Verified stands — verify set, severity unchanged.
{
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Verified" });
	assert.equal(rec.verify, "Verified", "verify set");
	assert.equal(rec.severity, "High", "severity unchanged");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0].verify, "Verified", "persisted");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P4 update verified: verify set, severity unchanged.");
}

// P4.2 Weakened demotes one tier and requires a verifyNote.
{
	const fx = mkUpdateFixture();
	const r1 = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "only the cold path" });
	assert.equal(r1.severity, "Med", "High -> Med");
	assert.equal(r1.verify, "Weakened", "verify Weakened");
	assert.equal(r1.verifyNote, "only the cold path", "verifyNote recorded");
	assert.equal(updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "narrower" }).severity, "Low", "Med -> Low");
	assert.equal(updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "floor" }).severity, "Low", "Low -> Low (floor)");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened" }), /Weakened requires a verifyNote/, "no note throws");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P4 update weakened demotes: High->Med->Low->floor; verifyNote required.");
}

// P4.3 Falsified retires-not-deletes — record stays, status->withdrawn, verifyNote required.
{
	const fx = mkUpdateFixture();
	const rec = updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Falsified", verifyNote: "quote not in file" });
	assert.equal(rec.verify, "Falsified", "verify Falsified");
	assert.equal(rec.status, "withdrawn", "status withdrawn");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 1, "record retained (not deleted)");
	const fx2 = mkUpdateFixture();
	assert.throws(() => updateFinding(fx2.artifact, fx2.root, { id: "L0-01", verify: "Falsified" }), /Falsified requires a verifyNote/, "no note throws");
	rmSync(fx.tmp, { recursive: true, force: true });
	rmSync(fx2.tmp, { recursive: true, force: true });
	console.log("OK — P4 update falsified retires: status withdrawn, record retained, verifyNote required.");
}

// P4.4 update rejects an unknown id and a bad verify value.
{
	const fx = mkUpdateFixture();
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "ZZ", verify: "Verified" }), /no finding with id ZZ/, "unknown id");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Maybe" }), /verify must be one of Verified \| Weakened \| Falsified/, "bad verify");
	assert.throws(() => updateFinding(fx.artifact, fx.root, { verify: "Verified" }), /patch\.id/, "missing id");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P4 update rejects bad input: unknown id, bad verify, missing id.");
}

// P4.5 update re-renders the finding's layer (demoted severity shows in the .md).
{
	const fx = mkUpdateFixture();
	updateFinding(fx.artifact, fx.root, { id: "L0-01", verify: "Weakened", verifyNote: "narrower" });
	const md = readFileSync(fx.artifact, "utf-8");
	const region = md.slice(md.indexOf("<!-- BEGIN store:findings layer=0 -->"), md.indexOf("<!-- END store:findings layer=0 -->"));
	assert.ok(region.includes("- **Severity:** Med"), "demoted severity rendered");
	assert.ok(!region.includes("- **Severity:** High"), "old severity gone");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P4 update re-renders layer: demoted severity shows in the .md.");
}

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
{
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
	console.log("OK — P5 diff classifies new + still-open; baselineState persisted.");
}

// P5.2 Regressed — fp present in the prior review's drift.resolved set.
{
	const fx = mkDiffFixture({ findings: [{ id: "L0-01", title: "t", fp: "C" }] });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [], drift: { resolved: [{ id: "L0-09", title: "old", fp: "C" }] } }));
	const f = JSON.parse(readFileSync(fx.storePath, "utf-8")).findings[0];
	assert.equal(f.driftClass, "Regressed", "Regressed");
	assert.equal(f.baselineState, "new", "baselineState new");
	assert.equal(f.priorFp, "C", "priorFp");
	assert.equal(f.priorId, "L0-09", "priorId");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P5 diff regressed: fp in prior drift.resolved -> Regressed.");
}

// P5.3 Resolved — a prior finding gone from current, captured in the drift summary.
{
	const fx = mkDiffFixture({ findings: [] });
	const ret = diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-05", fp: "D", title: "gone" }] }));
	assert.deepEqual(ret.resolved, [{ id: "L0-05", title: "gone", fp: "D" }], "resolved captured");
	assert.equal(ret.counts.resolved, 1, "resolved count");
	assert.ok(!JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.some((f) => f.id === "L0-05"), "resolved NOT carried into findings array");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P5 diff resolved: prior gone from current captured in summary, not findings.");
}

// P5.4 Drift Delta region + frontmatter drift counts.
{
	const fx = mkDiffFixture({ findings: [{ id: "N1", title: "new one", fp: "N" }, { id: "R1", title: "regressed one", fp: "RG" }], hasFrontmatterDrift: true });
	diffReview(fx.artifact, writePrior(fx, { artifact: "prior.md", findings: [{ id: "L0-05", fp: "D", title: "gone" }], drift: { resolved: [{ id: "L0-09", title: "old", fp: "RG" }] } }));
	const md = readFileSync(fx.artifact, "utf-8");
	assert.match(md, /^drift: \{ resolved: 1, regressed: 1, still_open: 0, new: 1, net: \+0 \}$/m, "frontmatter drift line");
	const region = md.slice(md.indexOf("<!-- BEGIN store:drift -->"), md.indexOf("<!-- END store:drift -->"));
	for (const row of ["| NEW | 1 |", "| Regressed | 1 |", "| Resolved | 1 |", "- L0-05 — gone"]) {
		assert.ok(region.includes(row), `region contains ${row}`);
	}
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P5 diff renders region + frontmatter drift counts.");
}

// P5.5 diff closes the Slice-2 decoupling — toSarif reads persisted baselineState/driftClass.
{
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
	console.log("OK — P5 diff feeds sarif: persisted baselineState/driftClass surface in toSarif.");
}

// P5.6 diff rejects a missing prior file.
{
	const fx = mkDiffFixture({ findings: [] });
	assert.throws(() => diffReview(fx.artifact, join(fx.tmp, "nope.json")), /prior review not found/, "missing prior throws");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P5 diff rejects missing prior.");
}

// ---- Phase 6: store query --clusters (read-only cluster discovery) ----------

/** The 3-finding cluster fixture from the Phase-6 contract. */
const clusterFindings = () => [
	{ id: "L0-01", evidence: [{ path: "lib/x/a.ts" }], symbol: "Svc", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
	{ id: "L0-02", evidence: [{ path: "lib/x/a.ts" }], symbol: "Other", entityStage: "E/P", status: "accepted", crossCutTag: null, dependsOn: [] },
	{ id: "L0-03", evidence: [{ path: "lib/y/b.ts" }], symbol: "Svc", entityStage: "E/Q", status: "deferred", crossCutTag: null, dependsOn: ["L0-01"] },
];
const cl = (clusters, dim, key) => clusters.find((x) => x.dimension === dim && x.key === key);

// P6.1 clusters by shared file / symbol / entity-stage AND by a Depends-on edge.
{
	const { clusters, discovered } = queryClusters({ findings: clusterFindings() });
	assert.deepEqual(cl(clusters, "file", "lib/x/a.ts").ids.slice().sort(), ["L0-01", "L0-02"], "file cluster");
	assert.equal(cl(clusters, "file", "lib/x/a.ts").anticipated, false, "file cluster not anticipated");
	assert.deepEqual(cl(clusters, "symbol", "Svc").ids.slice().sort(), ["L0-01", "L0-03"], "symbol cluster");
	assert.deepEqual(cl(clusters, "entity", "E/P").ids.slice().sort(), ["L0-01", "L0-02"], "entity cluster");
	assert.deepEqual(cl(clusters, "dependsOn", "L0-01 <-> L0-03").ids.slice().sort(), ["L0-01", "L0-03"], "dependsOn cluster");
	assert.equal(cl(clusters, "symbol", "Other"), undefined, "no Other cluster (singleton)");
	assert.equal(cl(clusters, "entity", "E/Q"), undefined, "no E/Q cluster (singleton)");
	assert.equal(discovered, 4, "4 clusters discovered");
	console.log("OK — P6 query clusters by shared key: file/symbol/entity/dependsOn; singletons excluded.");
}

// P6.2 a Depends-on edge forms an undirected 2-member cluster; a dangling dependsOn is dropped.
{
	const q = queryClusters({ findings: clusterFindings() });
	assert.deepEqual(q.clusters.find((x) => x.dimension === "dependsOn").ids.slice().sort(), ["L0-01", "L0-03"], "undirected pair");
	const withGhost = clusterFindings();
	withGhost[2].dependsOn = ["L0-01", "GHOST"];
	const q2 = queryClusters({ findings: withGhost });
	assert.equal(q2.clusters.filter((x) => x.dimension === "dependsOn").length, 1, "GHOST adds no dependsOn cluster");
	assert.equal(q2.discovered, q.discovered, "discovered unchanged by the dangling edge");
	console.log("OK — P6 query dependsOn cluster: undirected pair; dangling edge dropped.");
}

// P6.3 dependsOn clusters guarded — mutual A<->B is ONE cluster, self-dependency yields none.
{
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
	console.log("OK — P6 query dependsOn guarded: mutual -> one cluster; self-dep -> none.");
}

// P6.4 anticipated flag — the "subtract known themes" step.
{
	const mk = (t1, t2) => ({ findings: [
		{ id: "L0-01", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: t1, dependsOn: [] },
		{ id: "L0-02", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: t2, dependsOn: [] },
	] });
	const same = queryClusters(mk("T1-x", "T1-x"));
	assert.equal(same.clusters.find((x) => x.dimension === "file").anticipated, true, "same tag -> anticipated");
	assert.equal(same.unanticipated, same.discovered - 1, "unanticipated drops by one");
	assert.equal(queryClusters(mk("T1-x", "T2-y")).clusters.find((x) => x.dimension === "file").anticipated, false, "differing tags -> not anticipated");
	assert.equal(queryClusters(mk("T1-x", null)).clusters.find((x) => x.dimension === "file").anticipated, false, "only one tagged -> not anticipated");
	console.log("OK — P6 query anticipated flag: same cross-cut tag across all members -> anticipated.");
}

// P6.5 only accepted/deferred findings cluster (withdrawn/rejected/open excluded).
{
	const withStatus = (status) => ({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "X", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status, crossCutTag: null, dependsOn: [] },
	] });
	for (const status of ["withdrawn", "rejected", "open"]) {
		assert.equal(queryClusters(withStatus(status)).clusters.filter((x) => x.dimension === "file").length, 0, `${status} excluded -> no file cluster (1 active)`);
	}
	console.log("OK — P6 query active only: withdrawn/rejected/open excluded from clustering.");
}

// P6.6 read-only — the store file bytes are unchanged.
{
	const fx = mkDiffFixture({ findings: [
		{ id: "A", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
		{ id: "B", evidence: [{ path: "lib/x/a.ts" }], symbol: null, entityStage: null, status: "accepted", crossCutTag: null, dependsOn: [] },
	] });
	const before = readFileSync(fx.storePath, "utf-8");
	queryClusters(JSON.parse(before));
	assert.equal(spawnSync("node", [STORE, "query", "--clusters", "--artifact", fx.artifact], { encoding: "utf-8" }).status, 0, "cli query exits 0");
	assert.equal(readFileSync(fx.storePath, "utf-8"), before, "review.json bytes unchanged (read-only)");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P6 query read-only: review.json bytes unchanged.");
}

// P6.7 CLI query --clusters prints the report; missing flag errors.
{
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
	console.log("OK — P6 cli query clusters: prints report; missing flag -> usage.");
}

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
{
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
	console.log("OK — P8 dr validation arm: lens I/Q/S/G, per-tier why/fix, capitalized verify.");
}

// P8.2 renderDrFinding degrades per tier + byte-preserves the emoji.
{
	const crit = renderDrFinding(DR_C);
	assert.ok(crit.includes("### S1 🔴 race"), "critical heading + emoji");
	assert.ok(crit.includes("**Code**") && crit.includes("**Why**") && crit.includes("**Fix**"), "critical shows Code/Why/Fix");
	const sug = renderDrFinding({ ...DR_C, severity: "suggestion", fix: "f" });
	assert.ok(sug.includes("### S1 🔵 race"), "suggestion emoji");
	assert.ok(sug.includes("**Fix**") && !sug.includes("**Code**") && !sug.includes("**Why**"), "suggestion shows only Fix");
	const dis = renderDrFinding({ ...DR_C, severity: "discuss", why: "w" });
	assert.ok(dis.includes("💭") && dis.includes("**Why**") && !dis.includes("**Fix**") && !dis.includes("**Code**"), "discuss shows only Why");
	console.log("OK — P8 renderDrFinding: degrade-per-tier, emoji byte-preserved.");
}

// P8.3 renderReview assembles the whole document.
{
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
	console.log("OK — P8 renderReview: full frontmatter, severity-grouped, withdrawn omitted, counts + blockers derived.");
}

// P8.4 addFinding skips the AR-sentinel render for kind:"dr".
{
	const fx = mkDrFixture();
	const rec = addFinding(fx.artifact, fx.root, DR_C);
	assert.equal(rec.id, "S1", "returns the record");
	assert.equal(JSON.parse(readFileSync(fx.storePath, "utf-8")).findings.length, 1, "one finding persisted");
	assert.equal(readFileSync(fx.artifact, "utf-8"), "---\nstatus: in-progress\n---\n# DR\n", ".md unchanged by the DR add (write-once later)");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — P8 addFinding DR: skips the AR-sentinel render, no throw on a sentinel-less .md.");
}

// P8.5 CLI render --review writes the whole DR .md write-once.
{
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
	console.log("OK — P8 cli render --review: writes the whole DR .md write-once.");
}

console.log("OK");
