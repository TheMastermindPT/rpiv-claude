---
name: architectural-review
description: Run a deep, anti-slop architecture review of a module or path — quantify structural health, ingest the repo's own linters as ground truth, build a top-down entity/data-flow model, then run the slop lenses linters miss (semantic duplication, concept fragmentation, god-files, dead abstractions, test theater, boundary erosion, missing abstraction, state-ownership, temporal coupling, low-cohesion, feature-envy, failure propagation), verify every finding before triage, and write a phased polish plan to .rpiv/artifacts/architecture-reviews/. Use this whenever the user wants an architecture review, an anti-slop or code-health sweep of a module, a pre-1.0 hardening pass, or a post-refactor cleanup — even if they don't use the words "architectural review". Language-agnostic.
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
- **A. Measure & detect** (Steps 1-6.5) — automated, quantified, agent-driven in **two waves** (Wave 1: structural lenses G+Lc+D with a lightweight interaction pass; steering checkpoint; Wave 2: cross-cutting lenses C+A+T+L+M+S+Fe); ends with the **full Interaction Sweep** that re-joins ALL waves' findings into root-caused compound defects.
- **B. Per-layer review & triage** (Step 7) — interactive, top-down, human judgment.
- **C. Synthesize** (Steps 8-13) — drift delta via **content-hash fingerprints** (survive renames), **cluster discovery**, root-caused themes, compound-risk-promoted phased plan, chain-out.

Synthesis is the load-bearing depth of this skill: the lenses find symptoms in isolation; Steps 6.5, 9.5, 10 and 11 connect them into the systemic story — *what one decision produced this cluster, and how do these findings compound* — instead of merely re-sorting findings already in hand. The two-wave dispatch gives the developer a steering checkpoint between structural and cross-cutting analysis so clean modules pay less and messy modules get smarter-targeted deep analysis.

## Input

`$ARGUMENTS` — target path (file, directory, or module). Empty input auto-picks the densest source root (by LOC + churn) and confirms via a checkpoint.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git
```

Copy values verbatim — do not reformat the timezone offset. `now.mjs` line 1 is `<iso>\t<slug>`. Metrics, linter ingestion, and prior-review lookup are LLM-invoked at Steps 2 because they depend on `$ARGUMENTS` and on conversational clarification, which render-time substitution cannot capture.

## Flow

```
A. Measure & detect
   1. Identify target -> 2. Metrics + linters + prior review -> 2.7 Build System Model (style-aware entity map)
   -> 3. Plan layers as a view of the model (+ checkpoint)
   -> 4. Skeleton artifact (Health Scorecard + System Model)
   -> 5a. Wave 1: G + Lc + D (structural, metric-gated) -> 5b. Wave 1 sweeper (lightweight, over G+Lc+D)
   -> 5c. Steering checkpoint (skip/full/narrow Wave 2)
   -> 5d. Wave 2: C + A + T + L + M + S + Fe (cross-cutting, full-scope, informed by Wave 1)
   -> 6. Verify gate -> 6.5 Full interaction sweep (all waves, root-cause compounds)
B. Per-layer review & triage
   7. Per-layer loop: read -> 10-dim sweep -> merge verified slop + interactions -> triage -> persist -> tally
C. Synthesize
   8. Drift delta (content-hash fingerprint matching) -> 9. Methodology
   -> 9.5 Cluster discovery (set-arithmetic over findings)
   -> 10. Root-caused cross-cut themes -> 11. Polish plan + compound-risk Rollup
   -> 12. Present & chain -> 13. Follow-ups
```

The final artifact is blueprint-consumable per phase.

**References (progressive disclosure — read each file at the step its pointer names, never earlier; resolve paths against this skill's directory, i.e. `${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/`):** `references/metrics-blocks.md` (Step 2.1, after metrics.mjs) · `references/tool-ingestion.md` (Step 2.2, before any external tool runs) · `references/slop-map.md` (Step 5a, map assembly) · `references/wave2-lenses.md` (Step 5d, only when Wave 2 dispatches) · `references/dimension-sweep.md` (Step 7.2, first layer) · `references/drift-fingerprints.md` (Step 8, only when a prior review exists).

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

   Read the output as authoritative. Hold every block in main context — they are the severity anchors for the whole review. Read `references/metrics-blocks.md` NOW — it is the block-by-block interpretation glossary (loc baselines, size-outliers vs the godfile G gate, low-cohesion Lc, churn, export-usage, test-density, dup-candidates run/tokenSim semantics, co-change Tc pairs + ripple-groups, feature-envy pre-signal, catch-swallows Fp seed, bus-factor weight, and the single-file-target rule); interpret every block exactly per that file.

2. **Probe + ingest external tools as ground truth** (read-only, portable, suggest-never-install). Run the capability probe:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/tool-probe.mjs" "<target>"
   ```

   It maps each tool to the **lens it sharpens** and classifies it `configured | installed-unconfigured | absent` — **without running or installing anything**. Then Read `references/tool-ingestion.md` NOW — BEFORE running any external tool — and follow it exactly: the read-only tool contract, the per-tool ingestion instructions (depcruise, knip, jscpd, coverage, stryker, ts-morph, ast-grep/opengrep, CodeScene, SonarQube), the DB ground-truth gates (SQLFluff, Atlas), the per-tool degradation checkpoint, the `## Tool Coverage` section rule, the Deterministic Ground Truth Fold (K- / DC- / DC-orphan- / CS- / AS- / OG- / P- Slop Map entries), and the per-lens tool precedence.

   **These outputs are GROUND TRUTH — findings must NOT re-report them.** They define what the tools already cover so the review spends judgment only on the slop they miss. Any tool absent / unconfigured / timed-out routes through the per-tool degradation checkpoint in `references/tool-ingestion.md` — never silently skipped; on **Proceed** it is recorded "{lens} running unaided" and the review continues, on **Pause** the review stops until the user sets it up.

3. **Locate the prior review** for drift tracking. Dispatch the `artifacts-locator` agent:

   **Agent — artifacts-locator:** "Find the most recent prior review in `.rpiv/artifacts/architecture-reviews/` whose frontmatter `target:` equals or contains `{target}`. Return its path, date, and the list of its finding IDs with their `file:line` evidence and severity. If none exists, say so."

   Hold the result: it is the drift baseline (Step 8). None -> this run is a baseline review.

### Step 2.7: Build the System Model (top-down)

Before planning layers, build the top-down domain-entity / data-flow model the rest of the review reasons against. This inverts the default bottom-up flow: the model is the FRAME, the layers (Step 3) become a view of it, and findings later carry `(entity, stage)` coordinates.

**Gate:** SKIP for a single-file target, or when `---co-change-groups---` is empty AND there are no db row-type / domain-contract files to seed entities — note "no system model (insufficient structure)" and proceed to Step 3. Otherwise dispatch ONE `entity-mapper`:

   **Agent — entity-mapper:** "Target: `{target}`. Style: `auto` (detect per entity — use event/CQRS/pipeline/hex signal when present; fall back to CRUD). Build the top-down System Model. Seeds — ripple-groups (`co-change-groups` rows from metrics): {paste rows}. Write-site counts (the `write-sites-semantic` rows when semantic.mjs ran — type-resolved, incl. imported/aliased table names — else the regex `write-sites` rows: table/RPC -> writers=N + files): {paste rows}. Type seeds: the db row-type file(s) (e.g. `lib/db/types.ts`) and domain contracts (`lib/<domain>/*-contracts.ts`). Name the canonical entities from the type/contract seeds, attach the ripple-group files, auto-detect the architecture style per entity, place each entity's files across its style-appropriate lifecycle stages, **judge ownership per the style-specific rule** (CRUD: `writers=1` -> that module owns; `writers>=2` -> `owner: NONE`; event-driven: multiple owners by design, EMIT owns schema, each HANDLE owns side effects; CQRS: WRITE aggregate owns invariant, READ is a projection — no independent owner; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports, each ADAPTER owns its impl), and record cross-entity edges. Output L0 (Entity | Style | Outbound edges) + per-entity L1 (name each entity, style, stage placement with style-specific stage names, owner per the style's rule, unguarded/split-brain notes). Cite repo-relative `file:line` from the repository root (never bare basenames — `service.ts:34` is un-greppable); emit the model only, no findings."

Hold the returned model. It is written into the skeleton (Step 4) as the `## System Model` section and carried into:
- **Step 3** — layers are grouped as a *view* of the model's entities/stages.
- **Step 5** — each lens's Slop Map row gains the entity/stage its file belongs to (so findings can be tagged).
- **Steps 9.5 / 10 / 11** — entities are a cluster source, `owner: NONE` becomes a first-class theme, and entity-level compounds are promoted in the Risk Rollup.

Record the entity count in frontmatter `entities`. The model is descriptive (what the system IS), not a conformance check against declared architecture.

### Step 3: Plan Layer Structure

Layers mirror dependency direction. Higher layers consume lower-layer vocabulary; the review walks from the public surface inward. When a System Model exists (Step 2.7), the layers are a **view** of it — group files by the entity/stage they serve rather than deriving structure from scratch.

1. **For non-trivial targets, dispatch parallel agents** to categorize (single message, both at once):

   **Agent — codebase-locator:** "Map every source file in `{target}` to one responsibility bucket: facade/entry, type vocabulary, public API/DSL, command/dispatch/UI, configuration/loaders, validation, orchestration/runtime, sessions/I-O lifecycle, persistence/on-disk, cross-cutting utilities. Return a file -> responsibility table."

   **Agent — codebase-analyzer:** "For `{target}`, identify the import/use-graph dependency direction. Which files are leaves? Which are hubs? Return a topo-ordered list from leaves to hubs."

   Wait for BOTH before proceeding.

2. **Synthesize a layer proposal:** group by responsibility (not file count); top-down by review direction (entry point = Layer 0, deepest concern = Layer N). Layers > ~10 files: propose sub-layers (3.1, 3.2, ...) by file-name cohesion. Aim for 3-10 top-level layers. Flag uncategorisable files as cross-cutting utility candidates. Map each metric outlier (size, churn, export-usage, test-density, dup-candidate) onto its layer so the slop-lens wave (Step 5) and the per-layer loop (Step 7) know where each signal lands.

   **Database layer performance enrichment.** When the target includes `lib/db/` or `supabase/migrations/` files, query pg_stat_statements for runtime evidence on the tables these files define. Run:
   ```bash
   psql "$SUPABASE_DB_URL" -c "SELECT LEFT(query, 120), calls, ROUND(total_exec_time::numeric, 2) AS total_ms, shared_blks_read FROM pg_stat_statements WHERE query ~ 'table_name' ORDER BY total_exec_time DESC LIMIT 10;"
   ```
   For each table in the target's schema layer, capture: top queries by total time, cache miss ratio (`shared_blks_read > 0`), and query frequency (`calls`). Fold into the Slop Map under a `## DB Runtime Evidence` row — one line per table with its most expensive query. This upgrades structural findings ("this table has no index") to 🔴 severity when pg_stat_statements shows the queries hitting it are already slow. Schema findings backed by runtime evidence outrank pure structural ones in the Risk Rollup. If psql or the DB is unavailable, record `DB runtime: unavailable` and proceed — the structural lenses remain the fallback.

3. **Layer-split checkpoint.** Use `ask_user_question`: "Proposed split: {N} top-level layers, {file count} files. L0 — {names/count}; L1 — ...; {sub-layers}. Approve?". Header: "Layers". Options: "Approve (Recommended)"; "Adjust split"; "Reduce scope"; "Specify manually". Loop until approved.

4. **Turn the approved layers into an executable check (layer-rules.mjs).** Until now the layer model only ORDERS the review; this step makes it VALIDATE the code. Write the approved structure to `<scratchpad>/layers.json` — an ordered array `[{ "name": "Layer 0 — {name}", "paths": ["{dir prefix}", ...] }, ...]`, Layer 0 first, sub-layers folded into their parent, cross-cutting-utility files omitted. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/layer-rules.mjs" --layers=<scratchpad>/layers.json > <scratchpad>/layer-rules.dependency-cruiser.cjs
   ```

   Add one `--forbid="<owning-dir>-><forbidden-dir>"` per System-Model ownership boundary worth enforcing (e.g. the write path of an `owner: NONE` entity). When dependency-cruiser is runnable (`configured` OR `installed-unconfigured` — the generated file IS the config), validate from the repo root: `npx depcruise . --config <scratchpad>/layer-rules.dependency-cruiser.cjs --output-type json`, filter violations to the target, and fold each as a 🟡 L-row prefix `LM-` per `references/tool-ingestion.md` (layer-model breach: code contradicting the structure just approved — NOT a repo-rule breach). Keep the generated config — Step 11 offers it as a deliverable. Collision-safe by construction: the generated file lives in the scratchpad and is passed via `--config` explicitly, so the repo's own dependency-cruiser config (if any) is never read, appended to, or replaced by this run — it gets its own separate Step 2 scan. When dependency-cruiser is absent, skip silently (no degradation checkpoint; the layer model still frames the review).

### Step 4: Create Skeleton Artifact

1. **Read the template** at `${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/templates/architecture-review.md` FULLY.

2. **Determine metadata** from the Metadata block: filename `.rpiv/artifacts/architecture-reviews/<slug>_<target-kebab>.md` (`<slug>` from `now.mjs` line 1 field 2); `repository:` <- `repo:`; `branch:`/`commit:`/`author:` <- matching labels (fallbacks `no-branch`/`no-commit`/`unknown`); `date:`/`last_updated:` <- `<iso>` (offset verbatim).

3. **Write the skeleton** with the Write tool, `status: in-progress`:
   - **Frontmatter** with all template_version 2 fields. Fill `file_count`, `loc_*`, `entities`, and the **Health Scorecard** NOW from Step 2 metrics + linter summary (this is the quantified backbone, available before any finding). Set `prior_review` to the Step 2 path or `none`. Leave `severity`/`verification`/`drift`/`slop_by_lens` as zeros for now, and set frontmatter `health_score: pending` — the composite verdict is written only at the Step 11 ready-flip. An interrupted run must not leave a skeleton carrying a verdict ("healthy") computed before any lens ran; the Scorecard section holds the raw metrics in the meantime.
   - **System Model:** write the `## System Model` section from the Step 2.7 `entity-mapper` output (L0 table + per-entity L1/L2 with style-specific stage bullets). Omit only when Step 2.7 was gate-skipped.
   - **Drift Delta:** placeholder if a prior review exists, else omit the section (scorecard Composite notes "Baseline review").
   - **Methodology / Slop Inventory / per-layer / themes / polish plan:** empty placeholders; one `## Layer N — {name}` heading per approved layer.

4. **All subsequent writes use the Edit tool.** Never re-Write the whole file — the artifact is the durable checkpoint between sessions.

5. **Path discipline at write time (applies to EVERY section, every step).** Any `file:line` cite written into the artifact — finding rows, System Model stage cells, layer prose, IX evidence, phase plans, and especially CONDENSED or summarized agent output — carries the repo-relative path from the repository root. Condensing is where paths die: shortening `lib/generation/plan-generation/service.ts:329` to `service.ts:329` makes the cite un-greppable in a repo with three `service.ts` files, and downstream verify/drift tooling treats it as broken. Compress prose, never paths.

### Step 5: Slop-Lens Wave (two-wave, context-isolated)

**Pre-index the target (ctx_index — NEW, runs once before any lens dispatch).** Before dispatching Wave 1, pre-index the target directory into the FTS5 knowledge base so all 10+ lens agents query `ctx_search` instead of re-reading files from disk. This saves significant token budget — the same pattern is proven in the research and deep-review skills.
  ```
  ctx_index(
    path: "<target>",
    source: "arch-review-target",
    maxDepth: 5
  )
  ```
  Lens agents receive `Known Context: target pre-indexed — prefer ctx_search(source: "arch-review-target", queries: [...]) over Read for structural scans`. If the target is < 20 files, skip — the index overhead exceeds the benefit. If ctx_index is unavailable (offline/no-FTS5), skip silently — agents fall back to grep/read as before.

Detect the judgment-level slop linters miss. Instead of dispatching all 10 lenses at once, dispatch in two waves. **Wave 1** runs the structural lenses — god-file (G), low-cohesion (Lc), and duplication (D) — which are metric-gated (run only on the files metrics flagged), cheap, and produce findings immediately actionable at the steering checkpoint. **Wave 2** runs the cross-cutting lenses — fragmentation (C), dead abstraction (A), test theater (T), leaky boundary (L), module security (Sec), missing abstraction (M), state ownership (S), feature envy (Fe), and persistence health (P) — which search the full codebase and are more expensive. A lightweight sweeper between waves finds G+Lc+D interactions; a **warrant-driven** steering checkpoint (Step 5c) then decides — from the FULL deterministic seed surface, not just the Wave-1 findings — whether to skip Wave 2, run it selectively (only the warranted lenses), or run it in full.

**M and L always fire whenever Wave 2 runs** — missing-abstraction and boundary have no cheap metric seed, so they run in every selective or full wave (skipped only when the wave is skipped entirely). **S is seed-gated**: it fires when `write-sites` shows `writers >= 2` OR the System Model has an `owner: NONE` entity (a `writers=1` path with a clear owner is clean by design), so the warrant runs it only where an ownership concern actually exists.

#### 5a. Build the Slop Map (shared across both waves)

Read `references/slop-map.md` NOW and assemble the map exactly per its template — one row per Step-2 signal (metrics blocks, tool ground-truth incl. the mutation scope-line semantics, arch-lint AS-/OG- rows, CodeScene CS- rows), filled from the Step 2 outputs.

The **co-change pairs are the temporal-coupling (Tc) lens in full** — there is no Tc agent; the deterministic metric IS the lens. They ride in the Slop Map and are consumed by the full Interaction Sweep (Step 6.5).

**Context isolation (load-bearing):** each lens agent receives EXACTLY the Slop Map + its specific file list. Do NOT paste raw agent dumps or another lens's output into a lens prompt. Citation contract: every `file:line` MUST carry the verbatim line in backticks; omit any finding you cannot quote. Paths are **repo-relative from the repository root** (`lib/generation/adaptive-context/validation.ts:311`), never bare basenames (`validation.ts:311`) or target-relative fragments — real codebases have many files named `service.ts`/`types.ts`, so a shorthand cite cannot be grepped to one location and the verify gate treats it as broken. Quotes are **character-exact**: never paraphrase, never normalize punctuation (a dropped apostrophe makes the quote un-greppable); when a line is too long, truncate with a trailing `...` so downstream matchers know it is a prefix. Include these rules verbatim in every lens dispatch.

#### 5b. Wave 1 — Structural lenses (G, Lc, D)

Dispatch these three metric-gated lenses in a single multi-Agent message. Skip any whose metric block is empty (no godfile-candidates → skip G; no low-cohesion → skip Lc; no dup-candidates + no jscpd → skip D).

- **G — God-file / oversized-module** (per `godfile-candidates` row — NOT raw `size-outliers`): `lens-analyst` — "For `{file}` ({loc} LOC, {x}x median, {cats} concern categories, cohesion {coh}, flagged: {reason}), name each DISTINCT responsibility with its line-range and the natural split boundary — name each extractable unit and its target filename. Do NOT say 'split into modules'. Severity = responsibility-mixing FIRST (category count + reason), then x_median scaled by inbound blast. A file flagged for mixed responsibilities is high-severity regardless of LOC — the mixing IS the defect, not the size. A file rescued by cohesion is not a candidate; do not invent one from `size-outliers`."
- **Lc — Low cohesion / disjoint responsibilities** (per `low-cohesion` row): `lens-analyst` — "For `{file}` (cohesion {coh}, {syms} top-level symbols, {islands} disjoint islands), identify the clusters of top-level symbols that never reference each other. Per cluster emit: its responsibility, its symbols + line-range, and the file it should become. Severity = island count + spread across responsibilities. This is NOT a size finding — flag low cohesion even at normal LOC."
- **D — Semantic duplication / parallel implementations** (per dup pair): `lens-analyst` — "When jscpd ran, its `duplicates` are AUTHORITATIVE. For each candidate PAIR (`{a}`, `{b}`), read both ends. `via=lines`/`both` = literal copy-paste — anchor on the contiguous block. `via=structural` = Type-2 clone — read for matching control flow. REJECT convention idioms (CRUD scaffolding, error boilerplate, re-export facades). If the shared block is a repeated DECLARATION that should be a named type/helper, emit tagged **M (missing abstraction)** — don't force it into D. Then, for the strongest pair, `peer-comparator` — emit Mirrored / Missing / Diverged / Intentionally-absent, no severity."

Also dispatch in the same message:
- **Agent — integration-scanner:** "Map inbound references, outbound dependencies, and wiring for: {size-outliers + godfile-candidates + dup-candidate files}. Flag hubs (>= 3 consumers) and boundary crossings. Connections only — feeds blast-radius."

Wait for all Wave 1 agents. Collect their findings — these are structural findings (G, Lc, D) with provisional IDs, each keyed to a file and layer.

#### 5b2. Wave 1 Sweeper (lightweight, G+Lc+D only)

**Gate:** skip when fewer than 4 Wave 1 findings OR they span < 2 files. Otherwise dispatch ONE `interaction-sweeper`:

```
Target: {target}   Layers: {layer table}

Wave 1 findings (G, Lc, D only): {paste every finding with id, lens, file:line, verbatim line, severity, one-liner}
Co-change pairs: {paste ---co-change-candidates--- rows}

Group by shared file / concept / boundary / co-change pair. Per group, re-read the cited code. Emit only compounds with >= 2 file:line facts from DIFFERENT files. Name the root architectural decision behind each. Output: IX-{n} blocks per your format. These feed the steering checkpoint and Wave 2 context.
```

The Wave 1 sweeper output is lightweight — typically 0-3 compounds. Its findings:
- Feed the steering checkpoint (so the developer sees "these god-files interact" before deciding on Wave 2)
- Are passed to Wave 2 lenses as context ("when analyzing concept fragmentation, check these interacting god-files first")
- Are re-consumed by the full sweeper (Step 6.5) alongside Wave 2 findings

#### 5c. Steering Checkpoint (warrant-driven)

The decision to run the expensive cross-cutting wave is driven by the **full deterministic seed surface**, not just the Wave-1 structural findings. This closes a real blind spot: a target can be structurally clean (no god-files, cohesive, no dup) yet carry genuine fragmentation, dead code, scattered writes, feature-envy, or swallowed failure paths that only the cross-cutting lenses find — and the old structural-only gate would skip right past it. (Verified on gymapp: `lib/generation/adaptive-context` — 17 files, G=0 Lc=0 D=0, structurally silent — nonetheless has a real feature-envy finding the old gate skipped.)

Compute the warrant deterministically. `metrics_out.txt` and `semantic_out.txt` are the Step 2 outputs; `{knip_dead}` is the count of knip dead exports+types whose path is under the target (from the Step 2 knip run — omit the flag when knip was absent); `{owner_none}` is the count of System-Model entities with `owner: NONE` (Step 2.7):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/warrant.mjs" \
  --files={file_count} --knip-dead={knip_dead} --owner-none={owner_none} \
  --semantic=semantic_out.txt {--pre10 if pre-1.0} \
  < metrics_out.txt
```

It applies each lens's DEFECT PREDICATE — not raw row counts (`export-usage` and `write-sites` are dominated by non-defect rows; A is knip-primary) — and returns one JSON line: `band` (`skip` / `selective` / `full`), `liveLenses`, `selectiveWave2` (the exact Wave-2 lens set to dispatch), `prompt`, `reason`. Act on `band`:

- **`skip`** (nothing warranted — no cross-cutting seed AND no structural finding) — auto-skip Wave 2 + verify gate + full sweeper; go straight to the per-layer 10-dim sweep (Step 7). Record "Wave 2 skipped — warrant 0" and the per-lens vector in the artifact. **No prompt.**
- **`selective`** (1–3 lenses warranted, < 100 files, not pre-1.0) — auto-run Step 5d on **exactly `selectiveWave2`** — the live cross-cutting lenses plus the always-on M and L. The dead seed-driven lenses are skipped (e.g. no A agent dispatched when nothing is dead). Record the vector + which lenses ran. **No prompt** — it is cheap and targeted.
- **`full`** (`prompt: true` — ≥ 4 lenses warranted, or ≥ 100 files, or pre-1.0) — the expensive path, and the ONLY band that stops for input. Present the warrant via `ask_user_question`:

  "Warrant: {liveLenses, each with its seed count}. {file_count} files. {reason}. Run the full Wave 2 (7 lenses)?" Header "Wave 2". Options:
  - **"Run full Wave 2 (Recommended)"** — execute Step 5d on all seven cross-cutting lenses.
  - **"Narrow scope"** — run Wave 2 only on files touched by Wave 1 findings + their direct consumers (from integration-scanner). The orchestrator computes the restricted file set and passes it to each lens.
  - **"Pause — I'll fix findings first"** — STOP. Print "Review paused. Re-run /rpiv:architectural-review after fixing findings." and stop.

The warrant never overrides a developer choice — on the `full` band the developer still decides full / narrow / pause. It removes the reflexive prompt on the cheap bands and makes the skip decision **evidence-based**: it sees the cross-cutting seeds the old structural proxy could not.

**Fallback:** if `warrant.mjs` is unavailable (missing node, etc.), degrade to the structural heuristic — skip only when Wave 1 found 0–1 findings AND file_count < 100 AND not pre-1.0; otherwise run full — and note "warrant unavailable — structural heuristic" in the artifact.

#### 5d. Wave 2 — Cross-cutting lenses (C, A, T, L, Sec, M, S, Fe, Fp, P)

**Dispatch only the lenses the checkpoint selected.** On the `full` band, dispatch all nine. On the `selective` band, dispatch exactly the warrant's `selectiveWave2` set (the live cross-cutting lenses + always-on M, L, Sec, and P) — skip the rest and note them as "no seed — not dispatched" in the artifact. Below, each lens is described in full; run the subset that applies. Send them in a single multi-Agent message. Each receives the full Slop Map + the Wave 1 findings + IX compounds as context (they CAN see each other's output — Wave 2 lenses run cooperatively, not isolated from Wave 1).

Read `references/wave2-lenses.md` NOW (only on a dispatching band — never when Wave 2 is skipped) and use its nine lens prompts verbatim for the selected subset, plus its `precedent-locator` dispatch in the same message.

Wait for all Wave 2 agents. Collect their findings alongside the Wave 1 findings — together they form the complete **candidate slop findings** set, each keyed to a file and its layer, with a provisional `L<layer>-<seq>` ID and lens tag (G, Lc, D, C, A, T, L, Sec, M, S, Fe, Fp, P).

### Step 6: Verify Gate (anti-slop meta-guard)

The slop-wave findings are agent-generated and prone to confident-but-unread assertions — verify them before the developer ever sees them, so the review does not ship its own slop. Dispatch ONE `claim-verifier`:

```
Verify each candidate finding against actual repository state. You have Read access to the whole tree.

Findings (verbatim — id, file:line, the quoted line, lens, provisional severity):
{paste every candidate slop finding}

For EACH finding:
1. Re-find the verbatim quote in the cited file (prefer `rg` over `grep`). Absent -> Falsified. Present at a different line -> rewrite the citation, continue. Present -> continue. While here, normalize the citation's PATH: if it is a bare basename or target-relative fragment, rewrite it repo-relative from the repository root (an ambiguous path is as broken as a wrong line). For a duplication / missing-abstraction SHAPE claim, you MAY also confirm the shape's structural occurrence count via `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/structural.mjs" --tool ast-grep --pattern '<shape>' --lang <l> <target>` (read-only) rather than trusting a regex count.
2. If the finding claims behavior reachable elsewhere (a consumer, a duplicate definition site, a peer invariant, a dead export's callers), Read those files too — do not trust a single-file view.
3. For a duplication claim, confirm both ends still exist and still diverge as described. For a dead-abstraction claim, confirm there is genuinely no consumer.

Return ONE row per finding: `FINDING <id> | <Verified|Weakened|Falsified> | <one-sentence justification citing file:line>`.
- Verified — quote matches, claim reproducible.
- Weakened — true but narrower than stated (severity drops one tier).
- Falsified — quote does not match, or contradicted by code the lens did not read.
Citation contract applies. No new findings.
```

Apply: **Falsified -> drop** (ID retired, counted in frontmatter `verification.falsified`). **Weakened -> demote one severity tier**, rewrite the evidence to the narrower claim. **Verified -> carry**. Record `verified`/`weakened`/`falsified` counts in frontmatter. The surviving, verified slop findings now enter the Interaction Sweep and the per-layer loop alongside the dimension sweep.

### Step 6.5: Full Interaction Sweep (re-join ALL waves)

The lenses ran in two waves: Wave 1 lenses were isolated from each other (the Wave 1 sweeper alone saw G+Lc+D interactions), and Wave 2 lenses received Wave 1 context but were still isolated from full cross-wave interactions. This step undoes ALL isolation over the *verified* set from both waves and names the root architectural decision behind each cluster. It consumes the Wave 1 sweeper's `IX` compounds (re-grounding them alongside Wave 2 findings) and surfaces emergent defects no single wave's isolation could see. Without it, synthesis later (Step 10) is just grouping-by-tag.

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
Walk all ten across every file in the layer; hold candidates in memory (do NOT triage yet). These catch layer-local issues the slop lenses, which are file-targeted, do not. Read `references/dimension-sweep.md` at the FIRST layer (it applies to every layer) — it defines the ten dimensions and the exact candidate-list format (`L<layer>-<seq>`, lens `10dim`, Evidence, Quantified anchor, What/Why, provisional Severity / Effort / Blast radius / Class).

#### 7.3 Merge Verified Slop Findings (+ single-layer interactions)
Pull in the Step 6 verified slop findings whose files belong to this layer. They already carry lens tag, quantified anchor, and Verify status. De-duplicate against 7.2 candidates (a DRY dimension hit and a D-lens hit on the same code are ONE finding — keep the richer one, note both signals). Also pull in any Step 6.5 `IX` compound whose constituents ALL fall in this layer — triage it here as a finding (lens `IX`, carrying its Root cause). Cross-layer `IX` compounds stay deferred to Step 10, where they seed the themes.

#### 7.4 Triage Each Candidate
Present each via `ask_user_question`: "L{X}-{YY} ({lens}) — {headline}. Evidence: `file:line` (`{quote}`). Anchor: {metric}. Why slop: {one sentence}. Pick an outcome.". Header: "L{X}-{YY}". Options: concrete action A; concrete action B; "Defer".
- Batch 2-4 INDEPENDENT candidates per call; sequential when answers depend on each other or blast-radius is `public-API`/`cross-module`.
- **Deletion/dead-abstraction candidates with zero consumers:** ALWAYS include a "Keep as composition primitive / type-narrowing idiom" option — the developer judges abstraction value, not the skill.
- **Multi-state return candidates:** include "Convert to {target language's discriminated form}".
- **God-file candidates:** include "Split into `<dir>/` with the proposed decomposition" using the G-lens's named extractable units.

#### 7.5 Persist Each Triaged Finding
Edit the `## Layer N` section the instant an outcome is chosen. Write the FULL enriched finding block (per the template's Finding shape): Lens, Evidence (+verbatim), Quantified anchor, What it is, Why it's slop, **Remediation** (safe-refactor sequence + Acceptance criteria + Test strategy + Trade-off/alternative — use integration-scanner's consumer list for blast radius and (when Wave 2 ran) precedent-locator for the sequence, or `git log --grep` for the target when Wave 2 was skipped), Severity/Effort/Blast radius/Class, Verify, Status (verbatim from the chosen option: `accepted` / `rejected` / `deferred` / `withdrawn`), Entity/stage (the System Model coordinate this finding lives in, or `—` when no model), Depends on, Cross-cut tag. Maintain `unresolved_finding_count` (increment on file from 7.2, decrement on triage).

#### 7.6 Tally
Append the layer tally table (accepted/rejected/deferred/withdrawn), the **slop lenses fired in this layer** (D/C/G/A/T/L/M/S/Tc/IX/10dim counts), cross-cut tags introduced/reused, and within-layer dependency edges. Batched layers: per-batch tally + a roll-up after all batches.

### Step 8: Drift Delta (content-hash fingerprints)

If Step 2 found no prior review: omit the Drift Delta section; the scorecard Composite already says "Baseline review".

Otherwise, match prior review findings against this run's using **content-hash fingerprints** that survive file renames and line-number drift — unlike the old `path#symbol@lens` pattern which breaks when files move.

Read `references/drift-fingerprints.md` NOW (gated — only when a prior review exists) and execute its 8a–8d exactly: fingerprint current + prior findings via `fingerprint.mjs` (count + no-null assertions, abort on either), match inline (no agent), classify `Still-open` / `Resolved` (claim-verifier-verified at HEAD) / `Regressed` / `NEW`, write the Drift Delta section + scorecard row + frontmatter `drift`, and fall back to `path#symbol@lens` matching when the helper is unavailable.

### Step 9: Capture Emergent Methodology Principles

A principle surfaces when the developer reverses a finding with a generalizable reason, picks the same option type across independent triages, or articulates a future-review rule. Ask via `ask_user_question`: "Across {F} findings, did a methodology principle emerge worth naming?". Header: "Methodology". Options: "No new principle (Recommended if none articulated)"; "Capture one"; "Capture multiple". Format captured principles into the Methodology Principles section (M{N} — name / Origin / Rule / Apply-to keep / Apply-to drop).

### Step 9.5: Cluster Discovery (set-arithmetic over the finding graph)

Cross-cut tags were hand-attached per finding at 7.5, so Step 10 can only surface clusters someone already labelled — un-anticipated clusters stay invisible. This step finds them. **No agent dispatch** — the orchestrator computes inline over the persisted finding set (the same idiom as code-review's Gap-Finder):

1. **Build the finding graph.** For every accepted/deferred finding, extract its `file`, nearest symbol, `Depends on` edges, lens, and any Step 6.5 `IX` constituency.
2. **Cluster by shared key**, ignoring the hand-set cross-cut tag: group findings that share (a) the same file, (b) the same exported concept/symbol, (c) a `Depends on` edge, (d) membership in the same `IX` compound, (e) a co-change pair from `---co-change-candidates---`, or (f) the same System Model entity (their `Entity/stage` coordinate). A cluster needs >= 2 findings.
3. **Subtract the known themes.** `{discovered clusters}` − `{clusters already covered by an existing cross-cut tag}` = the **un-anticipated clusters**. These are the systemic patterns no human named.
4. **Promote each surviving cluster** into a candidate theme for Step 10, tagged `auto`, carrying the shared key as its provisional root-cause hypothesis. Record the discovered-cluster count in frontmatter `clusters_discovered`.

### Step 10: Synthesize Root-Caused Cross-Cutting Themes

Themes are where findings become a story — but only if each names the DECISION that produced it, not merely what its findings have in common. Group findings into themes from four sources: (a) the hand-set cross-cut tags, (b) the Step 6.5 `IX` compounds, (c) the Step 9.5 discovered `auto` clusters, (d) the **System Model** — every `owner: NONE` entity becomes a first-class **ownerless-entity** theme (root cause: the entity's writes/invariants have no owning module), and findings sharing an entity cluster under it. Merge overlapping sources into one theme.

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
4. **Write the Risk Rollup — fix these first:** rank by `severity x blast-radius / effort`, then apply the **compound-risk promotion rule** (load-bearing): when >= 2 findings share an entity/boundary/root cause and combine into an emergent failure (a Step 6.5 `IX` compound, a Step 9.5 discovered cluster, a System Model `owner: NONE` entity, or a theme's root cause), rank the AGGREGATE — not its constituents. The interaction IS the defect: a cluster of three `Med` findings rooted in one bad boundary can top the list above any single `High`. Rank the *theme/IX root cause* as one line, list its constituent IDs beneath, and do NOT also rank the constituents individually. Name the top 3 (promoted aggregates eligible) with one-line ROI rationale. This is the prioritization the old artifacts never gave.
5. **Draw the ASCII phase dependency graph** + phase scope summary table + final tally. When Step 3.4 generated a layer-rules config, add an **"Adopt boundary rules"** deliverable to the earliest fitting phase (usually Foundation): inline the generated `.dependency-cruiser.cjs` in the phase body so the approved layer model becomes a permanent CI check — the review's direction findings stop regressing the day the config lands. Adoption mode depends on what exists: repo has NO dependency-cruiser config → place the file at the repo root; repo HAS one → the deliverable is a **merge** (append the generated `forbidden` rules — names are namespaced `no-upward-l*`/`boundary-*` — and drop the generated `no-circular` if one already exists), NEVER a replacement. Weight the Risk Rollup with `---volatile-hubs---` and `---bus-factor---`: a finding on a high `churn x inbound` file outranks the same finding elsewhere, and `top_share≈1.00` on a hot file means single-owner knowledge — call that out so fixes there get the owning developer in the loop.
6. **Citation-path gate (deterministic, before the flip).** Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/check-citations.mjs" <the artifact path> --root .`. It exits non-zero and lists every **ambiguous bare-basename** cite (`service.ts:329` in a repo with three `service.ts`) — the un-greppable form the path-discipline prose keeps leaking from dense System-Model stage cells. For each one, grep the repo for the basename, pick the file the surrounding prose means, rewrite the cite repo-relative from the repository root, and re-run until it exits 0. Do NOT flip status while it fails — an ambiguous cite is as broken as a wrong line.

7. **Confirm + flip status** via `ask_user_question` ("{N} phases ({F} findings, {Files} files). Approve?"; Approve / Adjust boundaries / Resequence / Other). On approve: rebuild the `phases:` frontmatter array from the `### Phase N — name` headings (one `{ n, title, depends_on, blast_radius, effort }` per heading, body order), write the final `health_score:` composite verdict (healthy | drifting | degraded — replacing the skeleton's `pending`), then Edit `status: in-progress` -> `status: ready`.

### Step 12: Present and Chain

```
Architectural review written to:
`.rpiv/artifacts/architecture-reviews/{filename}.md`

Health:       {health_score} — {file_count} files, median {loc_median} LOC, {outlier_count} outliers
Slop:         {D} dup · {C} fragmentation · {G} god-file · {A} dead-abstraction · {T} test-theater · {L} leaky-boundary · {M} missing-abstraction · {S} state-flow · {Lc} low-cohesion · {Fe} feature-envy · {Fp} failure-propagation · {Tc} hidden-coupling
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
| Step 2 tool probe + coverage | `tool-probe.mjs` (detect tools→lenses, read-only) + `coverage.mjs` (parse coverage→T) + `semantic.mjs` (ts-morph→S/Fe/A when `configured`, read-only, optional — degrades to regex) + `stability.mjs` (SDP violations / cycles / volatile hubs derived from the captured depcruise or madge graph JSON) — helpers, no agent; external tools (depcruise/knip via `npx`, jscpd v5 Rust binary) run with consent |
| Step 2 prior-review lookup | `artifacts-locator` (1) |
| Step 2.7 system model | `entity-mapper` (1) — style-aware top-down entity/data-flow map from `co-change-groups` ripple-groups + db/domain type seeds. Auto-detects CRUD / CQRS / event-driven / pipeline / hexagonal per entity |
| Step 3 layer discovery | `codebase-locator` + `codebase-analyzer` in parallel; after approval, `layer-rules.mjs` helper turns the layers into a dependency-cruiser config (validated via `npx depcruise` when runnable — `LM-` rows) |
| Step 5b Wave 1 (structural) | `lens-analyst` (G, Lc, D), `peer-comparator` (D pair), `integration-scanner` (blast radius) — single parallel message, context-isolated. **Tc (temporal coupling) has NO agent** — metric-only |
| Step 5b2 Wave 1 sweeper | `interaction-sweeper` (1) — lightweight, G+Lc+D only. Feeds steering checkpoint + Wave 2 context |
| Step 5d Wave 2 (cross-cutting) | `lens-analyst` (C, A, T, L, Sec, M, S, Fe, Fp, P), `precedent-locator` (history) — single parallel message, receives Wave 1 findings + IX compounds as context |
| Step 6 verify gate | `claim-verifier` (1) — verifies all Wave 1 + Wave 2 slop candidates |
| Step 6.5 full interaction sweep | `interaction-sweeper` (1) — re-joins ALL waves; consumes Wave 1 sweeper's IX compounds + Wave 2 findings over the verified set; emits root-caused `IX` compounds |
| Step 7.1 deep-file analysis | `codebase-analyzer` (per file or batched) |
| Step 8 drift delta | `fingerprint.mjs` helper (compute fingerprints for current + prior findings) + `claim-verifier` (1 — verify Resolved claims at HEAD; fallback when fingerprint unavailable). Orchestrator computes the match inline — no agent needed for the matching pass |
| Step 9.5 cluster discovery | orchestrator set-arithmetic (no agent) |
| Step 13 follow-up rescan | `codebase-analyzer` (1-2) |

Spawn agents in parallel only when searching for different things. Wave 1 lenses are isolated from each other (context-isolated per lens). Wave 2 lenses receive Wave 1 findings + IX compounds as context — they run cooperatively, not isolated. The `interaction-sweeper` (Step 5b2 for Wave 1, Step 6.5 for full) deliberately receives the full finding set — its job is to undo isolation, not preserve it.

**Wave gating:** when the steering checkpoint (Step 5c) chooses "Skip Wave 2," the Wave 2 lenses, verify gate, and full interaction sweeper are ALL skipped. The review proceeds directly to the per-layer 10-dim sweep (Step 7). Record "Wave 2 skipped by developer" in the artifact.

## Important Notes

- **All checkpoints are `ask_user_question`** — the tool always offers free-text via "Other"; don't author prose prompts.
- **References are load-bearing**: read each `references/*.md` at the step its pointer names (see the References index after Flow); apply reference content verbatim — never paraphrase it into a dispatch or the artifact, and never read a gated reference (`wave2-lenses`, `drift-fingerprints`) when its gate did not fire.
- **Read all in-scope files FULLY in Step 7.1** — selective reads bias findings toward what you happened to load.
- **Edit the artifact progressively in Step 7.5** — never batch all findings into one final write. The artifact is the durable checkpoint between sessions.
- **Critical ordering:**
  - ALWAYS gather metrics + linter ground-truth (Step 2) BEFORE writing the skeleton (Step 4) — the Health Scorecard is the quantified backbone every finding cites.
  - ALWAYS build the System Model (Step 2.7) with `style: auto` BEFORE planning layers (Step 3) — the layers are a *view* of the style-aware model; deriving layers from scratch discards the top-down frame.
  - Wave 1 (Step 5b): ALWAYS run G, Lc, D context-isolated — each lens gets the Slop Map + its file list, nothing else. Pasting raw agent dumps causes narrativisation.
  - ALWAYS run the Wave 1 sweeper (Step 5b2) when >= 4 findings span >= 2 files — it surfaces G+Lc+D interactions that inform the steering checkpoint.
  - ALWAYS present the steering checkpoint (Step 5c) BEFORE Wave 2 — the developer decides whether Wave 2 runs, and their choice gates cost.
  - Wave 2 (Step 5d): C, A, T, L, M, S, Fe, Fp receive Wave 1 findings + IX compounds as context. They run cooperatively (not fully isolated) over the full codebase.
  - ALWAYS run the verify gate (Step 6) BEFORE the per-layer triage — the developer must never triage a Falsified slop finding.
  - ALWAYS run the full Interaction Sweep (Step 6.5) over the VERIFIED set from BOTH waves (after Step 6, before triage), and ALWAYS run cluster discovery (Step 9.5) BEFORE themes (Step 10) — these two are the systemic-synthesis core.
  - ALWAYS confirm the layer split (Step 3) BEFORE the skeleton (Step 4).
  - ALWAYS read every file in a layer (7.1) BEFORE the dimension sweep (7.2); ALWAYS triage via `ask_user_question` (7.4) — never auto-accept; ALWAYS Edit immediately after each outcome (7.5).
  - ALWAYS produce the Drift Delta (Step 8) when a prior review exists. Use content-hash fingerprints (survive renames). Re-verify `Resolved` rows at HEAD — a falsely-claimed fix must not hide a regression.
  - NEVER skip the per-layer tally (7.6) — it is the visible progress marker.
  - NEVER edit source files during the review — the artifact is the product; implementation is blueprint's job.
- **Linter ground-truth is portable, not hard-wired** — detect scripts from the manifest; degrade gracefully when absent. Never assume a specific repo's `npm run` names.
- **Frontmatter consistency**: snake_case multi-word fields; preserve `verification` / `drift` / `slop_by_lens` keys verbatim (`artifacts-locator` greps them). `slop_by_lens` now carries `missing_abstraction`, `state_flow`, `temporal_coupling`, `low_cohesion`, `feature_envy`, and `failure_propagation`; the synthesis counts live in `interactions` and `clusters_discovered`.
- **Status invariants**: `in-progress` during Steps 1-10; flips to `ready` at Step 11 confirmation.
- **The artifact is blueprint-consumable per phase** — per-phase blueprint invocations are the supported chaining pattern.
