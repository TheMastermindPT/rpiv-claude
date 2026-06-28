---
name: architectural-review
description: Conduct a deep, anti-slop architecture review of a module or path. Quantifies structural health (metrics.mjs, incl. a deterministic hidden-coupling co-change signal), ingests the repo's own linters as ground truth, then runs nine slop lenses (semantic duplication, concept fragmentation, god-files, dead abstractions, test theater, boundary erosion, missing abstraction, state/data-flow ownership, temporal coupling) the linters miss, walks a top-down 10-dimension checklist per layer, and verifies every agent-found finding before triage. Its depth is systemic synthesis: an Interaction Sweep re-joins the deliberately-isolated lenses into root-caused compound findings, cluster discovery surfaces patterns nobody hand-tagged, themes name the architectural decision behind each cluster, and the risk rollup promotes compound risk over isolated findings. Diffs against the previous review to track drift. Produces a phased polish plan in .rpiv/artifacts/architecture-reviews/ that blueprint consumes per phase. Language-agnostic. Use before a 1.0, after a major refactor, or to sweep accumulated AI slop a module has grown.
argument-hint: "[target path: file, directory, or module — empty auto-picks the densest source root]"
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: architecture-review
    data:
      type: object
      required: [phases, layer_count]
      properties:
        status:
          enum: [in-progress, ready]
        layer_count:
          type: integer
          minimum: 1
        phases:
          type: array
          minItems: 1
          maxItems: 32
          items:
            type: object
            required: [n, title]
            properties:
              n: { type: integer, minimum: 1 }
              title: { type: string }
              depends_on:
                type: array
                items: { type: integer, minimum: 1 }
              blast_radius:
                enum: [internal, public-API, on-disk, cross-module]
              effort:
                enum: [S, M, L]
  consumes:
    meta:
      world: target-path
---

# Architectural Review

You are tasked with conducting a deep, anti-slop architecture review of a target module: a single living artifact that **quantifies** structural health, hunts the **judgment-level slop** that linters (dependency-cruiser, knip, biome, tsc) cannot see, **verifies** every agent-found finding before it reaches the developer, **tracks drift** against the prior review, and ends in a phased polish plan downstream skills consume.

The review runs in three phases:
- **A. Measure & detect** (Steps 1-6.5) — automated, quantified, agent-driven; ends with the **Interaction Sweep** that re-joins the deliberately-isolated lenses to surface compound defects.
- **B. Per-layer review & triage** (Step 7) — interactive, top-down, human judgment.
- **C. Synthesize** (Steps 8-13) — drift delta, **cluster discovery**, root-caused themes, compound-risk-promoted phased plan, chain-out.

Synthesis is the load-bearing depth of this skill: the lenses find symptoms in isolation; Steps 6.5, 9.5, 10 and 11 connect them into the systemic story — *what one decision produced this cluster, and how do these findings compound* — instead of merely re-sorting findings already in hand.

## Input

`$ARGUMENTS` — target path (file, directory, or module). Empty input auto-picks the densest source root (by LOC + churn) and confirms via a checkpoint.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/now.mjs"
echo
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/git-context.mjs"
```

Copy values verbatim — do not reformat the timezone offset. `now.mjs` line 1 is `<iso>\t<slug>`. Metrics, linter ingestion, and prior-review lookup are LLM-invoked at Steps 2 because they depend on `$ARGUMENTS` and on conversational clarification, which render-time substitution cannot capture.

## Flow

```
A. Measure & detect
   1. Identify target -> 2. Metrics + linters + prior review -> 3. Plan layers (+ checkpoint)
   -> 4. Skeleton artifact (Health Scorecard) -> 5. Slop-lens wave (9 lenses) -> 6. Verify gate
   -> 6.5 Interaction sweep (re-join isolated lenses; root-cause compounds)
B. Per-layer review & triage
   7. Per-layer loop: read -> 10-dim sweep -> merge verified slop + interactions -> triage -> persist -> tally
C. Synthesize
   8. Drift delta -> 9. Methodology -> 9.5 Cluster discovery (set-arithmetic over findings)
   -> 10. Root-caused cross-cut themes -> 11. Polish plan + compound-risk Rollup
   -> 12. Present & chain -> 13. Follow-ups
```

The final artifact is blueprint-consumable per phase.

## Steps

### Step 1: Identify the Target

1. **Argument is empty — auto-pick + confirm.** Run the metrics helper with no narrowing to rank source roots:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/metrics.mjs" "."
   ```

   The `size-outliers` + `churn-hotspots` blocks reveal the densest, most-churned areas. Propose the densest source root (typically the largest top-level source dir, e.g. `lib`, `src`, or a heavy submodule like `lib/generation`) via the `ask_user_question` tool: "What should I review?". Header: "Target". Options: "{densest root} (Recommended)"; "{second candidate}"; "Whole repo"; "Specify a path". Re-run with the chosen target.

2. **Argument is a path** — use it verbatim. Validate it exists with `ls` via the Bash tool; if missing, ask for a corrected path.

3. **Capture target context** into main context:
   - Read the target's manifest if one exists (`package.json`, `pom.xml`, `*.csproj`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `build.gradle[.kts]`, `mix.exs`) — it names public exports, dependencies, ecosystem.
   - Read any `README.md` or architecture doc at the target root.
   - For a single file: read it FULLY (no limit/offset).

### Step 2: Metrics, Linter Ground-Truth, and Prior Review

1. **Run quantified metrics** on the resolved target:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/metrics.mjs" "<target>"
   ```

   Read the output as authoritative. Hold every block in main context — they are the severity anchors for the whole review:
   - `loc_median` / `loc_p90` — the peer baseline outliers are judged against.
   - `---size-outliers---` (`path  loc  x_median`) — raw LOC outliers (size context for the scorecard); NOT the god-file gate by themselves.
   - `---godfile-candidates---` (`path  loc  x_median  cats=N  coh=R  reason`) — **the god-file (G) gate**: responsibility-mixing candidates. `reason` is one of `mixing` (many distinct concern categories, LOC-independent — catches small tangles), `mixing+size`, `size+low-cohesion` (a LOC outlier that is ALSO fragmented), or `size` (non-JS/TS legacy LOC path). A large high-cohesion, few-concern file (parser/schema/fixture) is deliberately ABSENT here even when it is a size-outlier — that absence is the false-positive rescue, not a miss.
   - `---low-cohesion---` (`path  coh  syms  islands`) — **low-cohesion (Lc) candidates**: files whose top-level symbols form multiple disjoint islands (several responsibilities glued together) at ANY size. Excludes god-file candidates so it does not double-report G. The Lc lens confirms and names the split.
   - `---churn-hotspots---` (`path  commits`) — instability signal; weights severity.
   - `---export-usage---` (`path  exports=N  inbound=M`) — `inbound=0` with many exports is a dead-abstraction (A) candidate; `inbound=?` means the stem was too generic to measure (NOT dead).
   - `---test-density---` (`path  cases  asserts  ratio`) — test-theater (T) candidates (ratio < 1).
   - `---dup-candidates---` (`fileA | fileB  shared=N  overlap=R`) — **content-based** parallel-implementation (D) pre-signal: file PAIRS sharing `shared` normalized source lines, `overlap = shared / min(|A|,|B|)`. Grounded in content, not filename coincidence; the D lens confirms semantics.
   - `---co-change-candidates---` (`fileA | fileB  support=N  conf=R`) — **temporal / hidden-coupling (Tc) signal**: file pairs that change together across history (`support` shared commits, `conf` = support / fewer file's total changes) but share NO static import edge. Deterministic, metric-only — there is NO wave agent for this lens; the orchestrator carries these pairs into the Slop Map and the Interaction Sweep (Step 6.5) consumes them directly. Empty on thin-history targets (non-fatal).
   - `---feature-envy-candidates---` (`path  envies=<module>  ext=N  own=M  ratio=R`) — **feature-envy (Fe) pre-signal**: a file that references ONE internal module's bound names (`ext`) far more than its own top-level symbols (`own`), `ratio = ext / (ext + own)`. Coarse + file-level (third-party imports excluded); the Fe lens agent confirms at function granularity.

   **Single-file target:** there is no peer median — judge size against the language's absolute threshold (TS/Rust/Go ~200 LOC, Python/Kotlin ~300, C# ~400, Java ~500) and note this in the scorecard.

2. **Ingest the repo's own linters as ground truth** (portable, best-effort). Read `package.json` (or the ecosystem manifest). If a dependency-boundary or dead-code script exists, run its machine-readable variant to the scratchpad and parse it:
   - dependency-cruiser: detect a `deps`-style script or `.dependency-cruiser.{cjs,js,json}`; run `npx depcruise --config <config> --output-type json <target>` and summarize boundary violations.
   - knip: detect a `knip`-style script or `knip.json`; run `npx knip --reporter json` and summarize dead exports/files within the target.
   - Other ecosystems: the equivalent (`cargo +nightly udeps`, `go vet`, etc.) only if trivially available.

   **These outputs are GROUND TRUTH — the findings you write must NOT re-report them.** They define what the linters already cover so the review spends judgment only on the slop they miss. If a script is absent or a run times out, note "linter signal unavailable" and proceed — never fatal.

3. **Locate the prior review** for drift tracking. Dispatch the `artifacts-locator` agent:

   **Agent — artifacts-locator:** "Find the most recent prior review in `.rpiv/artifacts/architecture-reviews/` whose frontmatter `target:` equals or contains `{target}`. Return its path, date, and the list of its finding IDs with their `file:line` evidence and severity. If none exists, say so."

   Hold the result: it is the drift baseline (Step 8). None -> this run is a baseline review.

### Step 3: Plan Layer Structure

Layers mirror dependency direction. Higher layers consume lower-layer vocabulary; the review walks from the public surface inward.

1. **For non-trivial targets, dispatch parallel agents** to categorize (single message, both at once):

   **Agent — codebase-locator:** "Map every source file in `{target}` to one responsibility bucket: facade/entry, type vocabulary, public API/DSL, command/dispatch/UI, configuration/loaders, validation, orchestration/runtime, sessions/I-O lifecycle, persistence/on-disk, cross-cutting utilities. Return a file -> responsibility table."

   **Agent — codebase-analyzer:** "For `{target}`, identify the import/use-graph dependency direction. Which files are leaves? Which are hubs? Return a topo-ordered list from leaves to hubs."

   Wait for BOTH before proceeding.

2. **Synthesize a layer proposal:** group by responsibility (not file count); top-down by review direction (entry point = Layer 0, deepest concern = Layer N). Layers > ~10 files: propose sub-layers (3.1, 3.2, ...) by file-name cohesion. Aim for 3-10 top-level layers. Flag uncategorisable files as cross-cutting utility candidates. Map each metric outlier (size, churn, export-usage, test-density, dup-candidate) onto its layer so the slop-lens wave (Step 5) and the per-layer loop (Step 7) know where each signal lands.

3. **Layer-split checkpoint.** Use `ask_user_question`: "Proposed split: {N} top-level layers, {file count} files. L0 — {names/count}; L1 — ...; {sub-layers}. Approve?". Header: "Layers". Options: "Approve (Recommended)"; "Adjust split"; "Reduce scope"; "Specify manually". Loop until approved.

### Step 4: Create Skeleton Artifact

1. **Read the template** at `${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/templates/architecture-review.md` FULLY.

2. **Determine metadata** from the Metadata block: filename `.rpiv/artifacts/architecture-reviews/<slug>_<target-kebab>.md` (`<slug>` from `now.mjs` line 1 field 2); `repository:` <- `repo:`; `branch:`/`commit:`/`author:` <- matching labels (fallbacks `no-branch`/`no-commit`/`unknown`); `date:`/`last_updated:` <- `<iso>` (offset verbatim).

3. **Write the skeleton** with the Write tool, `status: in-progress`:
   - **Frontmatter** with all template_version 2 fields. Fill `file_count`, `loc_*`, and the **Health Scorecard** NOW from Step 2 metrics + linter summary (this is the quantified backbone, available before any finding). Set `prior_review` to the Step 2 path or `none`. Leave `severity`/`verification`/`drift`/`slop_by_lens` as zeros for now.
   - **Drift Delta:** placeholder if a prior review exists, else omit the section (scorecard Composite notes "Baseline review").
   - **Methodology / Slop Inventory / per-layer / themes / polish plan:** empty placeholders; one `## Layer N — {name}` heading per approved layer.

4. **All subsequent writes use the Edit tool.** Never re-Write the whole file — the artifact is the durable checkpoint between sessions.

### Step 5: Slop-Lens Wave (global, context-isolated)

Detect the judgment-level slop linters miss. Build a compact **Slop Map** first, then dispatch only the lenses their metric signal warrants — all in a single multi-Agent message.

**Slop Map** (orchestrator-synthesized; the ONLY context each lens receives besides its own file list):
```
Target: {target}   Layers: {layer table, one line each}
Metrics: median {loc_median} LOC, p90 {loc_p90}
Size outliers: {path  loc  x_median rows — raw LOC context}
God-file candidates (G gate): {path  loc  x_median  cats  coh  reason rows from ---godfile-candidates---}
Low-cohesion (Lc): {path  coh  syms  islands rows from ---low-cohesion--- — disjoint responsibilities, any size}
Export-usage flags: {path  exports  inbound rows where inbound is 0 or low}
Test-density flags: {path  cases  asserts  ratio rows}
Dup-candidates: {fileA | fileB  shared  overlap pairs — content-based, not name coincidence}
Co-change pairs (Tc): {fileA | fileB  support  conf rows — hidden coupling, no import edge}
Feature-envy (Fe): {path  envies=module  ext  own  ratio rows from ---feature-envy-candidates---}
Linter ground-truth: depcruise {violations summary}; knip {dead-code summary}
```

The **co-change pairs are the temporal-coupling (Tc) lens in full** — there is no Tc wave agent; the deterministic metric IS the lens. They ride in the Slop Map for the other lenses' context and are consumed whole by the Interaction Sweep (Step 6.5), where two findings on a co-changing pair become a grounded hidden-coupling compound.

**Context isolation (load-bearing, per code-review):** each lens agent receives EXACTLY the Slop Map + the specific file list it must inspect. Do NOT paste raw agent dumps or another lens's output into a lens prompt — summary framing makes agents narrativise instead of reading the code, producing hallucinated findings. Citation contract applies to every lens: every `file:line` MUST carry the verbatim line in backticks; omit any finding you cannot quote.

Dispatch the applicable lenses (skip a lens whose metric block is empty):

- **D — Semantic duplication / parallel implementations** (per `dup-candidates` pair): `codebase-pattern-finder` — "For each candidate PAIR (`{a}`, `{b}`) — {shared} shared normalized lines, overlap {overlap} — read both ends and decide genuine redundancy vs distinct concern. For real duplication emit: both `file:line` ranges with verbatim lines, the divergence, which is canonical, why it is slop. Anchor severity in overlap + shared-line count + combined LOC. A high `overlap` is the content evidence — confirm it is real shared logic, not coincidental boilerplate." Then, for the single strongest pair, `peer-comparator` — "Pair: (`{a}`, `{b}`). Emit one row per public invariant: Mirrored / Missing / Diverged / Intentionally-absent, with verbatim cites. No prose, no severity."
- **C — Concept / type fragmentation** (always for typed targets): `codebase-pattern-finder` — "Find every type/concept defined in >= 2 files in `{target}` (e.g. duplicate `export type X` / `interface X` / enum / const-union names). Per concept emit a row: every definition `file:line` with verbatim line, whether the definitions AGREE or have DRIFTED, and the canonical home. Severity = definition-count + drift."
- **G — God-file / oversized-module** (per `godfile-candidates` row — NOT raw `size-outliers`): `codebase-analyzer` — "For `{file}` ({loc} LOC, {x}x median, {cats} concern categories, cohesion {coh}, flagged: {reason}), name each DISTINCT responsibility with its line-range and the natural split boundary — name each extractable unit and its target filename. Do NOT say 'split into modules'. Severity = responsibility-mixing FIRST (category count + reason), then x_median scaled by inbound blast — a `mixing` flag on a SMALL file is still high-severity. A file the gate rescued by cohesion is not a candidate; do not invent one from `size-outliers`."
- **Lc — Low cohesion / disjoint responsibilities** (per `low-cohesion` row): `codebase-analyzer` — "For `{file}` (cohesion {coh}, {syms} top-level symbols, {islands} disjoint islands), identify the clusters of top-level symbols that never reference each other. Per cluster emit: its responsibility, its symbols + line-range with verbatim cites, and the file it should become. This is NOT a size finding — flag it even at normal LOC. Distinguish from G (god-file = size or import-mixing); Lc is a cohesion defect at any size. Severity = island count + spread across responsibilities."
- **A — Speculative generality / dead abstraction** (per `export-usage` row with `inbound=0`, cross-ref knip): `codebase-analyzer` — "For each of {files}, confirm whether the abstraction is speculative: cite its actual consumers `file:line` or state `<none found>`. Distinguish genuinely-unused (inline/delete) from a knip false-negative. `inbound=?` means unmeasured, NOT dead — verify by reading."
- **T — Test theater** (per `test-density` row): `codebase-analyzer` — "For each of {test files} (assert/case ratio < 1): identify tests that assert nothing, assert only on mocks, or restate the implementation. Emit what each claims to cover, why it is hollow, and what a real assertion would check."
- **L — Leaky abstraction / boundary erosion** (always; fed depcruise violations): `codebase-analyzer` — "dependency-cruiser already flags these import-boundary violations: {paste violations} — treat them as ground truth and do NOT re-report them. Find the SEMANTIC erosion the rules miss: public types exposing implementation details, domain importing infrastructure concepts, contracts that force callers to know internals. Cite `file:line` with verbatim lines."
- **M — Missing abstraction** (always; the inverse of A): `codebase-pattern-finder` — "Find the same CONCEPTUAL shape re-implemented inline across >= 2 files in `{target}` that was never named or extracted — a recurring computation, guard, mapping, or validation pattern repeated structurally (NOT literal copy-paste; that is the D lens). Per cluster emit: every `file:line` with the verbatim line, the shared shape, and the missing primitive that should own it (a named function/type/module). Severity = repetition count + spread across layers. This is the slop that begs for a vocabulary the codebase never grew."
- **S — State / data-flow ownership** (always; least metric-grounded — anchor in reads, not numbers): `codebase-analyzer` — "Trace mutable state and shared data in `{target}`: identify state with unclear ownership, invariants enforced in multiple places (or nowhere central), and partial-update hazards where one writer can leave the data inconsistent. Per finding emit `file:line` with the verbatim line, what the invariant IS, and which sites can violate it. Flag this lens's findings as **lower-confidence** — they lean on reasoning over reads, so cite at least two concrete sites or drop the finding."
- **Fe — Feature envy** (per `feature-envy-candidates` row): `codebase-analyzer` — "For `{file}` (envies `{module}`, {ext} external refs vs {own} own, ratio {ratio}), confirm at FUNCTION granularity which functions reference `{module}`'s members more than their own module's. Per envious function emit `file:line` + verbatim, the function name, and the method/home on `{module}` it should move to. Distinguish genuine envy from a legitimate orchestrator/facade (whose job IS to delegate). Scope away from L (boundary erosion — exposed internals) and M (missing abstraction — un-named repeated shape). Flag as **lower-confidence**: cite >= 2 sites in the same function or drop it."

Note the wave now runs **ten agent-lenses** (D, C, G, A, T, L, M, S, Lc, Fe) plus the metric-only **Tc** (temporal coupling) carried in the Slop Map — eleven lenses total. M and S always fire; the rest (Lc and Fe included) are metric-gated.

Also dispatch, in the same message:
- **Agent — integration-scanner:** "Map inbound references, outbound dependencies, and wiring for these files: {size-outliers + high-export files + dup-candidate files}. Flag hubs (>= 3 consumers) and any boundary crossings. Connections only — this feeds blast-radius for remediation."
- **Agent — precedent-locator:** "In git history for `{target}`, find prior splits / dedups / boundary-moves. Per precedent: commit, blast radius, follow-up fixes within 30 days, one-sentence lesson. These weight severity (repeat offenders) and inform remediation sequencing."

Wait for ALL wave agents. Collect their findings as **candidate slop findings**, each keyed to a file and its layer, with a provisional `L<layer>-<seq>` ID and lens tag.

### Step 6: Verify Gate (anti-slop meta-guard)

The slop-wave findings are agent-generated and prone to confident-but-unread assertions — verify them before the developer ever sees them, so the review does not ship its own slop. Dispatch ONE `claim-verifier`:

```
Verify each candidate finding against actual repository state. You have Read access to the whole tree.

Findings (verbatim — id, file:line, the quoted line, lens, provisional severity):
{paste every candidate slop finding}

For EACH finding:
1. grep the verbatim quote in the cited file. Absent -> Falsified. Present at a different line -> rewrite the citation, continue. Present -> continue.
2. If the finding claims behavior reachable elsewhere (a consumer, a duplicate definition site, a peer invariant, a dead export's callers), Read those files too — do not trust a single-file view.
3. For a duplication claim, confirm both ends still exist and still diverge as described. For a dead-abstraction claim, confirm there is genuinely no consumer.

Return ONE row per finding: `FINDING <id> | <Verified|Weakened|Falsified> | <one-sentence justification citing file:line>`.
- Verified — quote matches, claim reproducible.
- Weakened — true but narrower than stated (severity drops one tier).
- Falsified — quote does not match, or contradicted by code the lens did not read.
Citation contract applies. No new findings.
```

Apply: **Falsified -> drop** (ID retired, counted in frontmatter `verification.falsified`). **Weakened -> demote one severity tier**, rewrite the evidence to the narrower claim. **Verified -> carry**. Record `verified`/`weakened`/`falsified` counts in frontmatter. The surviving, verified slop findings now enter the Interaction Sweep and the per-layer loop alongside the dimension sweep.

### Step 6.5: Interaction Sweep (re-join the isolated lenses)

The slop lenses ran in deliberate isolation (Step 5 forbids them seeing each other) — so no lens could see a defect that emerges only when findings COMBINE. This is the single most important depth step: it undoes that isolation over the *verified* set and names the root architectural decision behind each cluster. Without it, synthesis later (Step 10) is just grouping-by-tag.

**Gate:** SKIP only when fewer than 4 verified findings survived Step 6 OR they span fewer than 2 files — interactions need surface area. Otherwise dispatch ONE `interaction-sweeper`:

```
Target: {target}   Layers: {layer table, one line each}

Verified finding set (each: id | lens | file:line | `verbatim line` | severity | one-line what-it-is):
{paste every Verified/Weakened finding from Step 6, plus the 10dim candidates already in hand if any}

Co-change pairs (hidden coupling, no import edge): {paste ---co-change-candidates--- rows from Step 2}

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 `file:line` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.
```

Collect the returned `IX-<n>` compounds. Each carries: Kind, Constituent finding IDs, **Root cause**, >=2 cross-file evidence cites, why-it-compounds, aggregate severity. These are **cross-layer by nature** — hold them for Step 9.5 (cluster discovery cross-checks them) and Step 10 (they seed the root-caused themes), and surface any whose constituents fall in a single layer during that layer's 7.3 merge. Record the `IX` count in frontmatter `interactions`.

### Step 7: Per-Layer Review and Triage (Loop)

**For each layer (and sub-layer) in top-down order (L0, L0.1, L1, ...)**, run the sub-steps below. The `## Layer N` section fills progressively; the tally is the visible progress marker.

#### 7.1 Read Files
1. **Batch large layers.** A layer not pre-decomposed at Step 3 holding > ~10 files: propose batches by file-name cohesion via `ask_user_question` ("Layer {N}: {count} files. Batches: ...; Approve?"; options Approve / Adjust batches / Promote to sub-layers).
2. **Read files FULLY** (no limit/offset) — the whole layer (or current batch). Selective reads bias findings.
3. **Resolve non-obvious call graphs** with a parallel `codebase-analyzer` when a file's internal structure is not clear from one read.

#### 7.2 Dimension Sweep (10 dimensions)
Walk all ten across every file in the layer; hold candidates in memory (do NOT triage yet). These catch layer-local issues the slop lenses, which are file-targeted, do not:
- **Boundary** — what the layer owns; leaks up or down.
- **Public surface** — exported names/types/ergonomics; siblings reaching past the facade; per-symbol consumer counts (from integration-scanner).
- **Coherence / SRP** — each file and function does one thing.
- **Granularity** — functions/methods too big/small; god-parameter lists.
- **Programming by intention** — reads top-down as a story; named operations over inline blocks.
- **DRY** — duplicated patterns within the layer or across siblings (hand any cross-file duplication to the D-lens evidence).
- **DDD / ubiquitous language** — domain vocabulary consistent; no lingering legacy names.
- **Naming** — file/type/function/constant names; symmetric where the concept is symmetric.
- **Error / fail-soft posture** — uniform across the layer; multi-state returns use the language's idiomatic discriminated form.
- **Module-graph hygiene** — no cycles; type-only back-refs only where supported.

Produce a candidate list (typically 6-14/layer), each with ID `L<layer>-<seq>`, lens `10dim`, Evidence (`file:line` + verbatim quote), Quantified anchor (cite the relevant metric), What it is, Why it's slop, provisional Severity / Effort / Blast radius / Class.

#### 7.3 Merge Verified Slop Findings (+ single-layer interactions)
Pull in the Step 6 verified slop findings whose files belong to this layer. They already carry lens tag, quantified anchor, and Verify status. De-duplicate against 7.2 candidates (a DRY dimension hit and a D-lens hit on the same code are ONE finding — keep the richer one, note both signals). Also pull in any Step 6.5 `IX` compound whose constituents ALL fall in this layer — triage it here as a finding (lens `IX`, carrying its Root cause). Cross-layer `IX` compounds stay deferred to Step 10, where they seed the themes.

#### 7.4 Triage Each Candidate
Present each via `ask_user_question`: "L{X}-{YY} ({lens}) — {headline}. Evidence: `file:line` (`{quote}`). Anchor: {metric}. Why slop: {one sentence}. Pick an outcome.". Header: "L{X}-{YY}". Options: concrete action A; concrete action B; "Defer".
- Batch 2-4 INDEPENDENT candidates per call; sequential when answers depend on each other or blast-radius is `public-API`/`cross-module`.
- **Deletion/dead-abstraction candidates with zero consumers:** ALWAYS include a "Keep as composition primitive / type-narrowing idiom" option — the developer judges abstraction value, not the skill.
- **Multi-state return candidates:** include "Convert to {target language's discriminated form}".
- **God-file candidates:** include "Split into `<dir>/` with the proposed decomposition" using the G-lens's named extractable units.

#### 7.5 Persist Each Triaged Finding
Edit the `## Layer N` section the instant an outcome is chosen. Write the FULL enriched finding block (per the template's Finding shape): Lens, Evidence (+verbatim), Quantified anchor, What it is, Why it's slop, **Remediation** (safe-refactor sequence + Acceptance criteria + Test strategy + Trade-off/alternative — use integration-scanner's consumer list for blast radius and precedent-locator for the sequence), Severity/Effort/Blast radius/Class, Verify, Status (verbatim from the chosen option: `accepted` / `rejected` / `deferred` / `withdrawn`), Depends on, Cross-cut tag. Maintain `unresolved_finding_count` (increment on file from 7.2, decrement on triage).

#### 7.6 Tally
Append the layer tally table (accepted/rejected/deferred/withdrawn), the **slop lenses fired in this layer** (D/C/G/A/T/L/M/S/Tc/IX/10dim counts), cross-cut tags introduced/reused, and within-layer dependency edges. Batched layers: per-batch tally + a roll-up after all batches.

### Step 8: Drift Delta

If Step 2 found no prior review: omit the Drift Delta section; the scorecard Composite already says "Baseline review". Otherwise, match the prior review's findings against this run's. Dispatch ONE `claim-verifier` as a row-only matcher:

```
Prior findings (from {prior path}): {id, file#symbol, lens-ish class, severity, evidence}.
Current findings (this run, post-triage): {id, file#symbol, lens, severity, evidence}.

Match by FINGERPRINT = path + '#' + nearest symbol + '@' + lens class (IGNORE line numbers). Tag every prior finding and surface every current finding with no prior match:
- Resolved   — prior finding's evidence is gone; VERIFY by reading the cited file at HEAD (a falsely-claimed fix must not hide a regression).
- Regressed  — prior finding was marked fixed/accepted, but the slop is present again now.
- Still-open — prior finding still reproduces (fingerprint match to a current finding).
- NEW        — a current finding with no prior match (net-new slop since last review).
Return: `prior_id | fingerprint | status | current_id_or_'-' | current_evidence file:line — `line``.
```

Write the **Drift Delta** section + scorecard `Resolved R · Regressed Rg · Still-open S · NEW N · Net Δ`. Update frontmatter `drift`. Headline the Regressed and NEW rows — they are the net-new slop the review exists to surface.

### Step 9: Capture Emergent Methodology Principles

A principle surfaces when the developer reverses a finding with a generalizable reason, picks the same option type across independent triages, or articulates a future-review rule. Ask via `ask_user_question`: "Across {F} findings, did a methodology principle emerge worth naming?". Header: "Methodology". Options: "No new principle (Recommended if none articulated)"; "Capture one"; "Capture multiple". Format captured principles into the Methodology Principles section (M{N} — name / Origin / Rule / Apply-to keep / Apply-to drop).

### Step 9.5: Cluster Discovery (set-arithmetic over the finding graph)

Cross-cut tags were hand-attached per finding at 7.5, so Step 10 can only surface clusters someone already labelled — un-anticipated clusters stay invisible. This step finds them. **No agent dispatch** — the orchestrator computes inline over the persisted finding set (the same idiom as code-review's Gap-Finder):

1. **Build the finding graph.** For every accepted/deferred finding, extract its `file`, nearest symbol, `Depends on` edges, lens, and any Step 6.5 `IX` constituency.
2. **Cluster by shared key**, ignoring the hand-set cross-cut tag: group findings that share (a) the same file, (b) the same exported concept/symbol, (c) a `Depends on` edge, (d) membership in the same `IX` compound, or (e) a co-change pair from `---co-change-candidates---`. A cluster needs >= 2 findings.
3. **Subtract the known themes.** `{discovered clusters}` − `{clusters already covered by an existing cross-cut tag}` = the **un-anticipated clusters**. These are the systemic patterns no human named.
4. **Promote each surviving cluster** into a candidate theme for Step 10, tagged `auto`, carrying the shared key as its provisional root-cause hypothesis. Record the discovered-cluster count in frontmatter `clusters_discovered`.

### Step 10: Synthesize Root-Caused Cross-Cutting Themes

Themes are where findings become a story — but only if each names the DECISION that produced it, not merely what its findings have in common. Group findings into themes from three sources: (a) the hand-set cross-cut tags, (b) the Step 6.5 `IX` compounds, (c) the Step 9.5 discovered `auto` clusters. Merge overlapping sources into one theme.

Write one `### T{N} — {theme}` block per theme. Each MUST carry:
- **Root cause** (required): the single architectural decision behind the cluster — a misplaced boundary, a missing/un-named vocabulary, a premature or absent abstraction, an ownerless invariant. "These are all in the validator" is a location, not a cause; "validation rules have no owning module so each caller re-derives them" is a cause. Pull the `IX` compound's Root cause verbatim when one seeded the theme.
- **Findings**: the constituent IDs (including any `IX-n`).
- **Thread**: one paragraph — how the findings compound, what fixing the root cause delivers, and the closing finding if any.

Also write the **Slop Inventory by lens** tables (D/C/G/A/T/L/M/S/Tc) from the accepted findings — omit any lens with zero. Confirm grouping AND the named root causes via `ask_user_question` (Approve / Merge / Split / Re-cause / Other).

### Step 11: Consolidated Polish Plan + Risk Rollup

Phases are agent-driven (handed to `blueprint` -> `implement`); size by signals blueprint acts on (file count, finding count, blast-radius mix, coordination), never human-days.

1. **Topo-sort** findings by `Depends on`. Dependency-free findings land first.
2. **Group by leverage:** Foundation (no deps, low risk) / Vocabulary (renames) / Locality (moves) / Structural (file splits, dir restructures) / Behavioural (shape conversions, dispatchers) / Public-API (additive surface, downstream coordination).
3. **Describe each phase** by agent-relevant signals: Findings (count + IDs), Files touched (count + paths), Blast-radius mix, Coordination, Class mix. Risk-flag phases touching on-disk format, public-API shape, or cross-module coordination.
4. **Write the Risk Rollup — fix these first:** rank by `severity x blast-radius / effort`, then apply the **compound-risk promotion rule** (load-bearing): when >= 2 findings share an entity/boundary/root cause and combine into an emergent failure (a Step 6.5 `IX` compound, or a Step 9.5 discovered cluster, or a theme's root cause), rank the AGGREGATE — not its constituents. The interaction IS the defect: a cluster of three `Med` findings rooted in one bad boundary can top the list above any single `High`. Rank the *theme/IX root cause* as one line, list its constituent IDs beneath, and do NOT also rank the constituents individually. Name the top 3 (promoted aggregates eligible) with one-line ROI rationale. This is the prioritization the old artifacts never gave.
5. **Draw the ASCII phase dependency graph** + phase scope summary table + final tally.
6. **Confirm + flip status** via `ask_user_question` ("{N} phases ({F} findings, {Files} files). Approve?"; Approve / Adjust boundaries / Resequence / Other). On approve: rebuild the `phases:` frontmatter array from the `### Phase N — name` headings (one `{ n, title, depends_on, blast_radius, effort }` per heading, body order), then Edit `status: in-progress` -> `status: ready`.

### Step 12: Present and Chain

```
Architectural review written to:
`.rpiv/artifacts/architecture-reviews/{filename}.md`

Health:       {health_score} — {file_count} files, median {loc_median} LOC, {outlier_count} outliers
Slop:         {D} dup · {C} fragmentation · {G} god-file · {A} dead-abstraction · {T} test-theater · {L} leaky-boundary · {M} missing-abstraction · {S} state-flow · {Lc} low-cohesion · {Fe} feature-envy · {Tc} hidden-coupling
Synthesis:    {IX} interaction compounds · {clusters_discovered} clusters discovered · {themes} root-caused themes
Verification: {V} verified · {W} weakened · {F} falsified (dropped)
Drift:        Resolved {R} · Regressed {Rg} · Still-open {S} · NEW {N} · Net Δ {+/-Δ}   (or "Baseline review")
Findings:     {F} reviewed — {A} accepted, {Rj} rejected, {D} deferred, {W} withdrawn
Plan:         {P} phases across {Files} files

Fix these first:
1. {ID} — `file:line` — {headline}
2. {ID} — `file:line` — {headline}
3. {ID} — `file:line` — {headline}

The artifact is blueprint-consumable per phase:
- `/rpiv:blueprint .rpiv/artifacts/architecture-reviews/{filename}.md` then "Implement Phase 1: {phase name}".
- Repeat per phase.

> Tip: start a fresh session with `/new` before each blueprint invocation — chained skills work best with a clean context window.
```

### Step 13: Handle Follow-ups

1. **Append, never rewrite.** Add a `## Follow-up Review {ISO 8601 timestamp}` section; prior content stays immutable. Retired (Falsified) IDs stay retired; new findings take new IDs.
2. **Bump frontmatter** `last_updated` / `last_updated_by`; set `last_updated_note`.
3. **Re-dispatch narrowly** — a single `codebase-analyzer` on the area in question (1-2 agents max). For a fresh measurement, re-run `metrics.mjs`.
4. **Re-invoke instead** when the target materially changed (new files, restructured layers): re-run `/rpiv:architectural-review` for a fresh artifact and a new Drift Delta against this one.

## Guidelines

1. **Be Quantified.** Every severity cites a number from `metrics.mjs` (x_median, inbound count, definition count, assert/case ratio) or a linter ground-truth fact. "Med because it feels big" is not a finding.
2. **Be Complementary.** The linters' output is ground truth — never re-report a dependency-cruiser violation or a knip dead-export as your own finding. Spend judgment only on the slop they cannot see.
3. **Be Grounded.** Every finding cites `file:line` + a verbatim quote (citation contract). If you cannot quote it, it is not a finding.
4. **Be Verified.** Agent-found slop passes the Step 6 claim-verifier before a human sees it. Falsified is dropped; the review never ships its own slop.
5. **Be Top-Down.** Walk the facade (Layer 0) first, persistence last. Fixing the public surface before the runtime inverts the dependency direction.
6. **Be Structural.** Every checkpoint is `ask_user_question` with concrete options — never prose "what do you think?".
7. **Be Patient with the Wise-Decision Lens.** A deletion/dead-abstraction candidate's "drop it" is ONE option, never the only one. The developer judges abstraction value.

## Subagent Usage

| Context | Agents |
|---|---|
| Step 1 auto-pick / Step 2 metrics | `metrics.mjs` helper (no agent) |
| Step 2 prior-review lookup | `artifacts-locator` (1) |
| Step 3 layer discovery | `codebase-locator` + `codebase-analyzer` in parallel |
| Step 5 slop-lens wave | `codebase-pattern-finder` (D, C, M), `codebase-analyzer` (G, A, T, L, S, Lc, Fe), `peer-comparator` (D pair), `integration-scanner` (blast radius), `precedent-locator` (history) — single parallel message, context-isolated. **Tc (temporal coupling) has NO agent** — it is the metric-only `---co-change-candidates---` block from `metrics.mjs`. |
| Step 6 verify gate | `claim-verifier` (1) — verifies all slop candidates |
| Step 6.5 interaction sweep | `interaction-sweeper` (1) — re-joins isolated lenses over the verified set; emits root-caused `IX` compounds |
| Step 7.1 deep-file analysis | `codebase-analyzer` (per file or batched) |
| Step 8 drift delta | `claim-verifier` (1) — row-only fingerprint matcher |
| Step 9.5 cluster discovery | orchestrator set-arithmetic (no agent) |
| Step 13 follow-up rescan | `codebase-analyzer` (1-2) |

Spawn agents in parallel only when searching for different things. Each runs in isolation — provide complete context in the prompt, including the target path, and (for Step 5) the Slop Map and nothing else. The `interaction-sweeper` (Step 6.5) is the one agent that deliberately receives the full verified finding set — its job is to undo isolation, not preserve it.

## Important Notes

- **All checkpoints are `ask_user_question`** — the tool always offers free-text via "Other"; don't author prose prompts.
- **Read all in-scope files FULLY in Step 7.1** — selective reads bias findings toward what you happened to load.
- **Edit the artifact progressively in Step 7.5** — never batch all findings into one final write. The artifact is the durable checkpoint between sessions.
- **Critical ordering:**
  - ALWAYS gather metrics + linter ground-truth (Step 2) BEFORE writing the skeleton (Step 4) — the Health Scorecard is the quantified backbone every finding cites.
  - ALWAYS run the slop-lens wave (Step 5) context-isolated — each lens gets the Slop Map + its file list, nothing else. Pasting raw agent dumps causes narrativisation and hallucinated findings.
  - ALWAYS run the verify gate (Step 6) BEFORE the per-layer triage — the developer must never triage a Falsified slop finding. This is the only mechanism that stops agent slop from reaching the artifact.
  - ALWAYS run the Interaction Sweep (Step 6.5) over the VERIFIED set (after Step 6, before triage), and ALWAYS run cluster discovery (Step 9.5) BEFORE themes (Step 10) — these two are the systemic-synthesis core; skipping either collapses Step 10 back into shallow grouping-by-tag.
  - ALWAYS confirm the layer split (Step 3) BEFORE the skeleton (Step 4).
  - ALWAYS read every file in a layer (7.1) BEFORE the dimension sweep (7.2); ALWAYS triage via `ask_user_question` (7.4) — never auto-accept; ALWAYS Edit immediately after each outcome (7.5).
  - ALWAYS produce the Drift Delta (Step 8) when a prior review exists, and re-verify its `Resolved` rows at HEAD — a falsely-claimed fix must not hide a regression.
  - NEVER skip the per-layer tally (7.6) — it is the visible progress marker.
  - NEVER edit source files during the review — the artifact is the product; implementation is blueprint's job.
- **Linter ground-truth is portable, not hard-wired** — detect scripts from the manifest; degrade gracefully when absent. Never assume a specific repo's `npm run` names.
- **Frontmatter consistency**: snake_case multi-word fields; preserve `verification` / `drift` / `slop_by_lens` keys verbatim (`artifacts-locator` greps them). `slop_by_lens` now carries `missing_abstraction`, `state_flow`, `temporal_coupling`, `low_cohesion`, and `feature_envy`; the synthesis counts live in `interactions` and `clusters_discovered`.
- **Status invariants**: `in-progress` during Steps 1-10; flips to `ready` at Step 11 confirmation.
- **The artifact is blueprint-consumable per phase** — per-phase blueprint invocations are the supported chaining pattern.
