---
template_version: 2
date: {Current date and time with timezone in ISO format}
author: {`author:` from injected git context}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
target: {repo-relative target path}
target_kind: {module | directory | file}
layer_count: {N}
entities: {N domain entities from the System Model}
file_count: {N source files, from metrics.mjs}
prior_review: {relative path of the prior review for this target | none}
health_score: {composite verdict — healthy | drifting | degraded}
unresolved_finding_count: {U}    # increments on file, decrements on triage; should be 0 before Step 8
severity: { high: {H}, med: {M}, low: {L} }
verification: { verified: {V}, weakened: {W}, falsified: {F} }    # claim-verifier gate, Step 6
interactions: {IX}    # interaction-sweeper compounds, Step 6.5
clusters_discovered: {K}    # un-anticipated clusters from set-arithmetic, Step 9.5
drift: { resolved: {R}, regressed: {Rg}, still_open: {S}, new: {N}, net: {+/-Δ} }    # omit keys as 0 on baseline
slop_by_lens: { duplication: {D}, fragmentation: {C}, god_file: {G}, dead_abstraction: {A}, test_theater: {T}, leaky_boundary: {L}, missing_abstraction: {M}, state_flow: {S}, low_cohesion: {Lc}, feature_envy: {Fe}, temporal_coupling: {Tc} }
status: {in-progress | ready}
tags: [architecture-review, {target-name}, {relevant components}]
last_updated: {Same ISO timestamp as date: above; bumped on follow-ups}
last_updated_by: {`author:` from Metadata block}
last_updated_note: "{Optional one-line note on follow-ups}"
---

# Architecture review — {target name}

{One-paragraph context: what's being reviewed, the trigger (pre-1.0 release / post-major-refactor / standalone audit / slop sweep), the scope, and the headline of what the numbers say. 2-4 sentences.}

---

## Health Scorecard

Quantified structural health from `metrics.mjs` + ingested linters. Every number here is the severity anchor the findings below cite — no vibes.

| Signal | Value | Baseline / threshold | Verdict |
|---|---|---|---|
| Source files | {file_count} | — | — |
| Total LOC (non-blank) | {loc_total} | — | — |
| Median file LOC | {loc_median} | — | — |
| p90 file LOC | {loc_p90} | — | — |
| Size outliers (> max(3x median, 1.5x p90)) | {count} | 0 ideal | {ok / watch / hot} |
| Largest file | `{file}` ({loc}, {x}x median) | < 3x median | {verdict} |
| Churn hotspots (>= 2 commits / {window}) | {count} | — | {verdict} |
| Speculative-generality candidates (many exports, low inbound) | {count} | 0 ideal | {verdict} |
| Test-theater candidates (assert/case ratio < 1) | {count} | 0 ideal | {verdict} |
| dependency-cruiser violations | {count | n/a} | 0 | {verdict} |
| Most-unstable folders (instability `I`, from `--metrics`) | {folder: I, … | n/a} | — | {SDP watch} |
| knip dead exports / files | {count | n/a} | 0 | {verdict} |
| Coverage (stmt / branch / fn) | {%/%/% | n/a} | — | {branch-gap watch} |
| **Composite** | **{health_score}** | healthy | **{healthy / drifting / degraded}** |

> Single-file target: peer-relative outlier detection is unavailable; size is judged against the language's absolute threshold instead (TS/Rust/Go ~200 LOC, Python/Kotlin ~300, C# ~400, Java ~500).

---

## System Model

Top-down domain-entity / data-flow model from the `entity-mapper` agent (Build System Model step), seeded by the `co-change-groups` ripple-groups + db row-types + domain contracts. **Architecture-style-aware per entity** (CRUD, CQRS, event-driven, pipeline, or hexagonal — auto-detected). **The review reasons against THIS**: the layers below are a *view* of it, findings carry `(entity, stage)` coordinates, and themes attach to entities. Reading rules: **missing stage the style expects = unguarded entity; style-appropriate ownership semantics (event-driven PERSIST has no single owner by design; CQRS READ has no independent owner — do NOT flag these).**

### L0 — System (entities + styles + cross-entity edges)

| Entity | Style | Outbound edges |
|---|---|---|
| {Entity} | {crud \| event-driven \| cqrs \| pipeline \| hexagonal} | consumes {EntityB}, feeds {EntityC} |

### L1 / L2 — per entity

#### {Entity} (style: {crud | event-driven | cqrs | pipeline | hexagonal})

- **Stage: {NAME}** — `file:line` ...
- **Stage: {NAME}** — `file:line` ...
{one row per stage in the style's lifecycle; expand fat stages (PRODUCE / TRANSFORM) to L2 sub-steps}

- **Owner:** {style-appropriate description — CRUD: module or NONE + scattered writes; event-driven: EMIT owner + per-HANDLE owners; CQRS: WRITE aggregate owns invariant, READ is a projection; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports, each ADAPTER owns its impl}
- **Ripple-group:** {the `co-change-groups` cluster that seeded this entity}
- **Unguarded / split-brain:** {missing stages the style expects; duplicated stages; contradictory invariants — or "none"}

{repeat per entity}

---

## Drift Delta — vs {prior review filename} ({prior date})

<!-- OMIT this whole section (heading through its trailing `---`) when there is no prior review for this target. In that case the Health Scorecard's Composite row notes "Baseline review — no prior to diff against." -->

**Scorecard:** Resolved {R} · Regressed {Rg} · Still-open {S} · NEW {N} · **Net slop Δ {+/-Δ}**

Matched by content-hash fingerprint via `fingerprint.mjs` — survives file renames and line drift. Prior finding IDs shown as display aliases.

### Regressed — was fixed, slop returned ({Rg})

| Prior ID -> Current ID | Where | What came back |
|---|---|---|
| {LX-YY -> Gn} | `file:line` — `{verbatim line}` | {one line} |

### NEW since last review — net-new slop ({N})

| Current ID | Lens | Where | One-line |
|---|---|---|---|
| {Gn} | {D/C/G/A/T/L/M/S/Lc/Fe} | `file:line` — `{verbatim line}` | {one line} |

### Still-open — carried from prior ({S})

| Prior ID -> Current ID | Where | Note |
|---|---|---|
| {LX-YY -> Gn} | `file:line` — `{verbatim line}` | {still reproduces} |

### Resolved — verified gone at {commit} ({R})

| Prior ID | What was fixed |
|---|---|
| {LX-YY} | {one line; re-verified absent at HEAD} |

---

## Risk Rollup — fix these first

Ranked by `severity x blast-radius / effort`, with the **compound-risk promotion rule** applied: when >= 2 findings share a root cause and compound (an `IX` compound, a discovered cluster, or a theme), the AGGREGATE is ranked — not its constituents. A cluster of three `Med` findings rooted in one bad boundary can outrank a lone `High`. The interaction IS the defect. If you only act on three things, act on these.

| Rank | ID | Headline | Why it tops the list (ROI) |
|---|---|---|---|
| 1 | {ID / IX-n / T-n} | `{file}` — {headline; for an aggregate, name the root cause + constituent IDs} | {High severity x cross-module reach / S effort; or "3 Med findings, one root cause, single boundary fix"} |
| 2 | {ID} | `{file}` — {headline} | {...} |
| 3 | {ID} | `{file}` — {headline} | {...} |

---

## Slop Inventory by lens

Judgment-level slop the linters cannot see. One table per lens; **omit any lens subsection with zero findings**.

### D — Semantic duplication / parallel implementations ({count})

| ID | Files | Overlap / tokenSim (via) | Divergence | Canonical | Severity |
|---|---|---|---|---|---|
| {ID} | `a.ts` <-> `b.ts` | {overlap} / {tokenSim} ({via}; {N} lines) | {what drifted} | `{which is canonical}` | {Low/Med/High} |

### C — Concept / type fragmentation ({count})

| ID | Concept | Definition sites | Drifted? | Canonical home |
|---|---|---|---|---|
| {ID} | `{Type}` | `a.ts:L`, `b.ts:L`, `c.ts:L` | {yes/no} | `{file}` |

### G — God-file / oversized-module ({count})

| ID | File | LOC (x median) | Distinct responsibilities | Inbound blast |
|---|---|---|---|---|
| {ID} | `{file}` | {loc} ({x}x) | {N — named in finding} | {N consumers} |

### A — Speculative generality / dead abstraction ({count})

| ID | File | Exports | Known inbound | Action |
|---|---|---|---|---|
| {ID} | `{file}` | {N} | {M | unknown} | {inline / delete / keep — per triage} |

### T — Test theater ({count})

| ID | Test file | cases / asserts | What it pretends to cover |
|---|---|---|---|
| {ID} | `{file}` | {c}/{a} | {behavior with no real assertion} |

### L — Leaky abstraction / boundary erosion ({count})

| ID | Where | Leak | Consumers forced to know internals |
|---|---|---|---|
| {ID} | `file:line` | {what leaks} | {N} |

### M — Missing abstraction ({count})

| ID | Repeated shape | Inline sites | Missing primitive |
|---|---|---|---|
| {ID} | `{the recurring computation/guard/mapping}` | `a.ts:L`, `b.ts:L`, `c.ts:L` | `{named function/type/module that should own it}` |

### S — State / data-flow ownership ({count})

| ID | Invariant | Enforced / violated at | Confidence |
|---|---|---|---|
| {ID} | `{the rule that must hold}` | enforced `a.ts:L`; can violate `b.ts:L` | {lower — reasoned over reads} |

### Tc — Temporal / hidden coupling ({count})

| ID | Co-changing pair | support / conf | Why they couple (no import edge) |
|---|---|---|---|
| {ID} | `a.ts` <-> `b.ts` | {N} / {R} | {shared implicit contract / duplicated invariant / parallel dispatch} |

### Lc — Low cohesion / disjoint responsibilities ({count})

| ID | File | cohesion / islands | Disjoint clusters | Proposed split |
|---|---|---|---|---|
| {ID} | `{file}` | {coh} / {K} | {top-level symbol clusters that never reference each other} | {file each cluster should become} |

### Fe — Feature envy ({count})

| ID | Function (file:line) | Envied module | Members used vs own | Suggested home |
|---|---|---|---|---|
| {ID} | `{fn}` `file:line` | `{module}` | {ext} vs {own} | `{method/home on the envied module}` |

---

## Interaction compounds

Emergent defects the isolated lenses could not see, surfaced by the Interaction Sweep (Step 6.5). Each ties >= 2 findings to ONE root architectural decision. **Omit this section when no grounded compound survived.**

### IX-{n} — {emergent-defect headline}

- **Kind:** {compounding-remediation | shared-root | hidden-coupling | contradictory-design | masking | distributed-invariant}
- **Constituents:** {L{X}-{YY}, L{Z}-{WW}, ...}
- **Root cause:** {the single architectural decision behind the cluster}
- **Evidence:** `a.ext:line` — `{verbatim}`; `b.ext:line` — `{verbatim}` (>= 2, different files)
- **Why it compounds:** {what emerges from the combination none of the constituents shows alone}
- **Aggregate severity:** {Low | Med | High — promoted when the interaction IS the defect}

---

## Discovered clusters

Un-anticipated clusters from Step 9.5 set-arithmetic — finding groups no human hand-tagged, surfaced by shared file/symbol/dependency/co-change. Each becomes (or merges into) a theme below. **Omit when none discovered.**

| Cluster | Shared key | Findings | Promoted to theme |
|---|---|---|---|
| {auto-1} | `{file / concept / co-change pair}` | {L{X}-{YY}, ...} | {T{N}} |

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` followed by the fields below. The `Lens` and `Verify` fields are new in template_version 2.

| Field | Meaning |
|---|---|
| **Lens** | `D` duplication / `C` fragmentation / `G` god-file / `A` dead-abstraction / `T` test-theater / `L` leaky-boundary / `M` missing-abstraction / `S` state-flow / `Lc` low-cohesion / `Fe` feature-envy / `Tc` temporal-coupling / `IX` interaction-compound / `10dim` (classic dimension sweep) |
| **Entity / stage** | the System Model coordinate (entity name + style-specific stage, e.g. `Order/EMIT` (event-driven), `WeeklyPlan/PERSIST` (CRUD), `Report/TRANSFORM` (pipeline)) this finding lives in, or `—` when no model |
| **Fingerprint** | content-hash fingerprint for drift delta matching (survives file renames and line drift). Computed via `fingerprint.mjs` at Step 8 |
| **Symbol** | the canonical symbol name this finding targets (e.g. `GodFile`, `validateOrder`). Used with `lens` + evidence to construct the fingerprint. Omit only when the finding targets no single named symbol (e.g. co-change pairs) |
| **Evidence** | `file.ext:lineA-lineB` + verbatim line in backticks (citation contract) |
| **Quantified anchor** | the metric that sets severity (e.g. `1178 LOC = 11.9x median`; `21 exports, 0 inbound`; `3 definition sites`) |
| **What it is** | what the code does today |
| **Why it's slop** | why this is accumulated redundancy/erosion, not intentional design |
| **Remediation** | safe-refactor sequence + acceptance criteria + trade-off (see Remediation recipe) |
| **Severity** | Low / Med / High — anchored in the quantified threshold, not vibes |
| **Effort** | S (single-file, no consumers) / M (<=5 files, mechanical) / L (public-API or >=6 files) |
| **Blast radius** | `internal` / `public-API` / `on-disk` / `cross-module` (from integration-scanner) |
| **Class** | `polish` (rename / refactor / DRY) vs `redesign` (structural shift) |
| **Verify** | `Verified` / `Weakened` (demoted one tier) — `Falsified` findings are dropped, never written |
| **Status** | `open` / `accepted` / `rejected` / `deferred` / `withdrawn` |
| **Depends on** | other finding IDs that must land first |
| **Cross-cut tag** | optional — see "Cross-cutting themes" |

### Status legend

- `open` — flagged, not yet triaged
- `accepted` — will land; includes the chosen option summary
- `rejected` — declined with reason inline
- `deferred` — accepted in principle but punted post-release
- `withdrawn` — initial diagnosis turned out incorrect; kept for audit

### Layers (top -> down)

{Insert the layer table from Step 3. Large layers: file count + representative names. Sub-layers: dot-numbered rows after the parent.}

| # | Layer | Files |
|---|---|---|
| 0 | {layer name} | `file1.ext`, `file2.ext` |
| 1 | {layer name} | `file3.ext` |

---

## Methodology principles

_Principles emerge during Step 5 triage and are captured at Step 7. Patterns that govern multiple decisions get named here; one block per principle._

<!--
### M{N} — {principle name}

**Origin:** {finding ID where it first surfaced + one-sentence quote from the developer's reasoning, if available}.

**Rule.** {One paragraph: what to do, why, when to apply.}

**Apply to (keep):** {bullet list of cases the principle says to preserve.}
**Apply to (drop / change):** {bullet list of cases the principle says to act on.}
-->

---

## Layer 0 — {layer name}

{Files: `file1.ext`, `file2.ext`, ...}

{Optional preamble: 1-2 paragraphs on what the layer owns + any ripple-ins from prior decisions in the same review.}

### L0-01 — {short headline}

- **Lens:** {D | C | G | A | T | L | M | S | Lc | Fe | Tc | IX | 10dim}

**Evidence**

`file.ext:lineA-lineB` — `{verbatim line}`

**Quantified anchor**

{the metric that sets severity, e.g. `927 LOC = 9.4x median; 15 consumers (cross-module)`}

**What it is**

{What the code does today.}

**Why it's slop**

{Why this is accumulated redundancy / erosion the linters missed, not intentional design. For the classic 10dim sweep this reads as the architectural problem statement.}

**Remediation**

1. {Safe-refactor step 1 — reversible (e.g. "extract pure helpers behind a re-export shim").}
2. {Step 2 — migrate consumers one cluster at a time.}
3. {Step 3 — delete the shim.}

- **Acceptance criteria:** {checkable, e.g. "`metrics.mjs` reports this file < 3x median"; "`npm run deps` passes"; "no duplicate `{Type}` definition remains".}
- **Test strategy:** {characterization test before a split; assertion added where the T lens found theater.}
- **Trade-off / alternative:** {>= 1 alternative considered + why not chosen.}

- **Severity:** {Low | Med | High}
- **Effort:** {S | M | L}
- **Blast radius:** {internal | public-API | on-disk | cross-module}
- **Class:** {polish | redesign}
- **Entity / stage:** {System Model coordinate, e.g. `WeeklyPlan/PERSIST` | — when no model}
- **Verify:** {Verified | Weakened — narrower than first stated}
- **Status:** {open -> triaged outcome inline, e.g., **accepted** — {chosen option summary}}
- **Depends on:** {LX-YY, ...}
- **Cross-cut tag:** `T{N}-{theme-name}` _(optional)_

{Repeat for L0-02, L0-03, ...}

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | {A} |
| rejected | {R} |
| deferred | {D} |
| withdrawn | {W} |

Slop lenses fired in this layer: {D: N; C: N; G: N; A: N; T: N; L: N; M: N; S: N; Lc: N; Fe: N; 10dim: N}.
Cross-cutting tags introduced: {list}. Reused: {list}.

Dependency edges within Layer 0:

- L0-XX depends on L0-YY (...)

---

## Layer 1 — {layer name}

{Same structure as Layer 0.}

{... repeat per layer ...}

---

## Cross-cutting themes

Root-caused threads tying multiple findings to ONE architectural decision. Drawn from three sources — hand-set cross-cut tags, the Step 6.5 `IX` interaction compounds, and the Step 9.5 discovered clusters. Every theme names its **Root cause** (a decision, not a location); the polishing plan groups by theme so a single root-cause fix retires a whole cluster.

### T1 — {theme name} ({active | closed by L{X}-{YY}})

**Root cause:** {REQUIRED — the single architectural decision that produced this cluster: a misplaced boundary, a missing/un-named vocabulary, a premature or absent abstraction, an ownerless invariant. A location ("all in the validator") is NOT a cause. When an IX compound seeded this theme, carry its Root cause verbatim.}

**Findings:** L{X}-{YY}, L{Z}-{WW}, {IX-n}, ...

**Source:** {hand-tag | IX-{n} | auto-cluster (Step 9.5)}

{One paragraph: how these findings COMPOUND, what fixing the root cause delivers, what the closing finding is (if any).}

{Repeat per theme.}

---

## Consolidated polish plan

{N} phases, ordered top-to-bottom. Each phase is blueprint-consumable; sizing is by agent-relevant signals (file count, finding count, blast-radius mix, coordination need) — never human-days.

### Phase 1 — {phase name}

**Goal:** {one-line goal — what this phase delivers when complete}.

**Findings ({count}):** L{X}-{YY}, L{Z}-{WW}, ...

**Files touched ({count}):** `path/one.ext`, `path/two.ext`, ...

**Blast-radius mix:** {internal: N; public-API: N; on-disk: N; cross-module: N}.

**Class mix:** {polish: N; redesign: N}.

**Coordination:** {none | sibling-package PR required | downstream consumer release required}.

**Risk callouts:** {phase-specific risk, especially when the phase touches on-disk format, public-API shape, or requires cross-module coordination}.

{Repeat per phase.}

### Guardrail rules (prevention)

<!-- Proposed dependency-cruiser `forbidden` rules that would PREVENT the boundary leaks (L lens) from recurring. The review is READ-ONLY — these are actionable fixes for the downstream implement skill / the developer, NOT applied here. Omit if no L finding is rule-codifiable. -->

| Prevents (finding) | Proposed `.dependency-cruiser.cjs` rule |
|---|---|
| {L{X}-{YY}} | `{ name: "{rule-name}", severity: "error", from: { path: "{from}" }, to: { path: "{to}" }, comment: "{why}" }` |

### Dependency graph (phase-level)

```
Phase 1 ({name})
   |
Phase 2 ({name})
   |
   +--> Phase 3 ({name}) --+
   +--> Phase 4 ({name}) --+
   +--> Phase 5 ({name})   |
                           |
                Phase 6 ({name})
```

### Phase scope summary

| Phase | Findings | Files | Blast-radius mix | Coordination |
|---|---|---|---|---|
| 1 — {name} | {N} | {N} | {breakdown} | {none / sibling / downstream} |
| ... | ... | ... | ... | ... |
| **Total** | **{N}** | **{N}** | — | — |

### Risk callouts (cross-phase)

1. {Cross-phase risk 1 — e.g., "Phase X + Y touch overlapping state. Land X completely before starting Y."}
2. ...

### Final tally

| Layer | Findings | Accepted | Withdrawn |
|---|---|---|---|
| L0 — {name} | {N} | {A} | {W} |
| ... | ... | ... | ... |
| **Total** | **{N}** | **{A}** | **{W}** |

**Cross-cuts closed by completion of this plan:** {T1, T3, ...} ({K} of {Total}).
**Cross-cuts remaining active (by design):** {T2, T4, ...} _(rationale per item)_

Plan ready for the implementation phase.

---

## Tool Coverage

<!-- From the Step-2 capability probe (`tool-probe.mjs`). Records which external tools backed which lens — explicit about what ran vs ran unaided. Tools are SUGGESTED, never installed. OMIT only when no manifest/ecosystem was recognized. -->

| Tool | Lens | Status | Ran? | Notes |
|---|---|---|---|---|
| dependency-cruiser | L | {configured / installed-unconfigured / absent} | {yes/no} | {N forbidden rules — "meaningful" OR "weak: no-violations not trustworthy, suggested `depcruise --init`"} |
| knip | A | {status} | {yes/no} | {dead-export summary} |
| jscpd | D | {configured / installed / absent} | {yes/no} | {N clones, M% duplicated lines (Rust v5), or "absent — D on metrics dup-candidates"} |
| coverage ({vitest/jest/…}) | T | {status} | {yes/no} | {report path, or "no report — gathered via checkpoint" / "running unaided"} |
| ts-morph | S / Fe / A / C | {configured / installed-unconfigured / absent} | {yes/no} | {type-resolved write-sites / feature-envy / dead-exports / type-fragmentation via `semantic.mjs`, or "unavailable: {reason} — S/Fe/A/C on regex+agent signals"} |
| ast-grep | D/M (+C/S/Fe confirm) | {configured / installed / absent} | {yes/no} | {structural confirmation of NAMED candidate shapes via `structural.mjs`; curated arch pattern pack deferred} |
| opengrep | L/M (deep-review Security) | {status} | {yes/no} | {arch rule pack deferred — registered; runs live only in deep-review's Security lens} |
| rg | search | {installed / absent} | {n/a} | {orchestrator / claim-verifier prefer rg over literal grep} |
| {other} | {lens} | {status} | {no} | {suggested: `{install hint}`} |

**Lenses running unaided (no backing tool):** {M, C, …; + S/Fe/A when ts-morph absent} — inherently agent-only.

### Ground truth ingested (do NOT re-report)

Ingested verbatim from the repo's own tooling — the findings above intentionally do NOT re-report these; they address the slop the tools miss.

- **dependency-cruiser** ({command}): {N violations | clean | rules-weak | unavailable}; instability — {highest-I folders}; circular — {N}; orphans — {N}.
  {- rule -> `file` -> `file` (one line per violation, capped)}
- **knip** ({command}): {N dead exports, M dead files | clean | unavailable}.
  {- `file` — dead export `{symbol}` (capped)}
- **jscpd** ({command}): {N clones, M% duplicated lines (Rust v5) | clean | absent — D ran on metrics dup}.
  {- `fileA` <-> `fileB` (N lines) (capped)}
- **coverage** ({command}): overall {stmt% / branch% / fn%}; {N} files with branch-gaps fed to the T lens.
- **ts-morph / semantic.mjs** ({command}): {N type-resolved write-sites (writers>=2: …), N feature-envy candidates (behavioral split), dead-exports: N | "delegated to knip", type-fragmentation: N drift + N same-shape | unavailable: {reason}}.
