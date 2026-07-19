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

import { renderFinding, renderTally, spliceRegion, sentinelsFor, renderInto, loadStore } from "./store.mjs";

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
	blastRadius: "cross-module",
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
	return { tmp, root: tmp, artifact, storePath: artifact.replace(/\.md$/, ".json") };
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
	return { tmp, root: tmp, artifact, storePath: artifact.replace(/\.md$/, ".json") };
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
	console.log("OK — add valid finding: appended with computed fp; envelope lazy-created from frontmatter.");
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
	assert.equal(existsSync(fx.storePath), false, "review.json NOT created");
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
	assert.equal(existsSync(fx.storePath), false, "store file unchanged (not created)");
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
	assert.match(noArgs.stderr, /^usage: store\.mjs add/, "no args -> usage");

	const badStdin = spawnSync("node", [STORE, "add", "--artifact", fx.artifact, "--root", fx.root], {
		input: "not json",
		encoding: "utf-8",
	});
	assert.equal(badStdin.status, 1, "malformed stdin -> exit 1");
	assert.match(badStdin.stderr, /^store add:/, "malformed stdin -> store add: prefix");

	const unknown = spawnSync("node", [STORE, "frobnicate"], { encoding: "utf-8" });
	assert.equal(unknown.status, 2, "unknown subcommand -> exit 2");
	assert.match(unknown.stderr, /usage: store\.mjs add/, "unknown subcommand -> usage");
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
	blastRadius: "cross-module",
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
	assert.equal(existsSync(fx.storePath), false, "review.json NOT created");
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
	assert.equal(existsSync(fx.storePath), false, "nothing written");
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
	assert.equal(existsSync(fx.storePath), false, "nothing written");
	rmSync(fx.tmp, { recursive: true, force: true });
	console.log("OK — grounding: quote not matching the cited line rejected.");
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

console.log("OK");
