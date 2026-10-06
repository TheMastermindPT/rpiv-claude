---
name: deep-review
description: "Conduct comprehensive code reviews of pending changes, a branch, or a PR using parallel specialist agents that audit the diff, compare against peer code, and verify every claim before reporting it. Use whenever the user asks to 'review this', wants pending changes, a PR, a branch, or a diff reviewed, or asks for a code review — even a quick one. Produces review documents in .rpiv/artifacts/reviews/."
argument-hint: "[scope] [lane=<lane>] [design=<design-path>]"
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: review
    data:
      type: object
      required: [blockers_count]
      properties:
        status:
          enum: [in-progress, in-review, ready]
        review_status:
          enum: [complete]
        merge_status:
          enum: [blocked, clear]
        blockers_count:
          type: integer
          minimum: 0
  consumes:
    meta:
      world: working-tree
---

# Code Review

Review changes across **Quality**, **Security**, **Dependencies** lenses with optional advisor adjudication. Valid scopes: `commit` | `staged` | `working` | hash | `A..B` | PR branch. **Empty scope defaults to feature-branch-vs-default-branch first-parent review** (default branch auto-detected; see Step 1).

## Input

`$ARGUMENTS` — scope: `commit` | `staged` | `working` | a commit hash | `A..B` range | PR branch name. Empty defaults to feature-branch-vs-default-branch (first-parent). An optional trailing `lane=<lane>` token (`fast`, `normal` or `rigorous`; implement's next-step line passes it) is removed before scope resolution and sets the review depth at Step 1.6. An optional `design=<design-path>` token (the approved brief or design the reviewed slices implement; implement passes it too) is removed the same way and is carried into the Step 8 next step.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git
```

Scope resolution (default branch, range, ChangedFiles) is LLM-invoked at Step 1.1 via the bundled `_helpers/review-range.mjs` — it depends on `$ARGUMENTS` and on conversational clarification, which render-time substitution cannot capture.

## Flow

1. Input → 2. Wave-1 dispatch → 3. Wave-2 dispatch → 4. Wave-3 dispatch → 5. Reconcile → 6. Verify → 7. Write artifact → 8. Present → 9. Follow-ups

**File-orientation contract**: agents reason about *files* as coherent units. Hunks are evidence *within* a file's analysis, never the unit of analysis. The `-U30` patch (Step 1) inlines function-level context so agents rarely need extra `Read` calls.

Every Wave-2 agent prompt contains EXACTLY `Known Context:` + the Discovery Map verbatim, and one resolved shard patch path — nothing else from Wave-1 (see "Wave-2 context isolation" in Step 3 for why). Wave-1 agents that don't consume the Discovery Map receive the changed-files manifest or manifest diff only.

## Conventions

- **Citation contract** (every Wave-2+ agent, every step): every `file:line` citation MUST carry the literal line text in backticks — `file:line — \`<verbatim line>\` — <note>`. Omit any finding whose line you cannot quote verbatim.
- **Severity**: 🔴 fix before merge · 🟡 fix soon · 🔵 nice-to-have · 💭 discuss.
- **References** (progressive disclosure — read each file at the step its pointer names, never earlier; resolve paths against this skill's directory, i.e. `${CLAUDE_PLUGIN_ROOT}/skills/deep-review/`): `references/pre-wave-gates.md` (Step 2, after preflight) · `references/discovery-map.md` (Step 2, at map synthesis) · `references/quality-surfaces.md` + `references/security-sinks.md` (Step 3, at Wave-2 dispatch — inlined verbatim into the lens prompts) · `references/gated-prompts.md` (Waves 1–3, only when the owning gate fires) · `references/severity-model.md` (Step 5 start; also governs Step 6 tag application).

## Steps

### Step 1: Resolve Scope and Assemble the Diff

1. **Resolve scope via the bundled helper.** Determine the scope spec from the value the user supplied (visible in `## Input` above as the substituted argument). If empty, use the literal string `auto`; if ambiguous (prose, mixed list, unrecognised branch name), clarify via `ask_user_question` — options: (A) "review current branch vs default branch (first-parent)" → `auto`, (B) "review every tracked change vs HEAD (staged + unstaged)" → `modified`, (C) "review unstaged changes only" → `working`, (D) "restate scope" → free-text — then re-invoke. Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/_helpers/review-range.mjs" "<scope-spec>"
   ```

   The helper emits labeled scope fields plus `changed_files_manifest`, reviewable/excluded counts, shard metadata, and `prior_review`, followed by the changed/in-scope/peer/companion blocks. Read these as authoritative; never re-derive them by hand. The JSON manifest is the complete, uncapped file contract and includes path categories and shards. If `strategy: unrecognised` appears, clarify using its `note:` and re-invoke.

   `<scope-spec>` translation table — map the user's substituted argument to one of these forms:

   | Argument shape | Pass to helper |
   |---|---|
   | empty (no argument provided) | `auto` |
   | literal `commit` / `staged` / `working` / `modified` | same word verbatim |
   | hex commit hash (4-40 chars, e.g. `abc1234`) | the hash verbatim |
   | `<A>..<B>` (e.g. `HEAD~5..HEAD`, `main..feature`) | the range verbatim |
   | comma- or whitespace-separated hashes (`h1,h2,h3` or `h1 h2 h3`) | the list verbatim |
   | branch name (must be checked out at HEAD locally) | the branch name verbatim |
   | anything else (prose, mixed list, unresolvable ref) | clarify via `ask_user_question`, then re-invoke |

2. **Confirm strategy** from the helper output. The mapping into the rest of the skill:
   - `strategy: first-parent` (`auto` / checked-out PR branch / commit list) — normal branches use `<range>` + `<fp_flag>`. Commit-list manifests also carry `commits`; those exact commits, including non-contiguous lists, are authoritative over the display range.
   - `strategy: explicit-range` (single hash / `A..B`) — use `<range>` without `<fp_flag>`. `<base>` is OLDEST^; when OLDEST is a root commit, the helper emits a root-inclusive revision instead.
   - `strategy: working-tree` (`commit` / `staged` / `working`) — no `<range>`; use the working-tree commands listed in the next bullet.

   `--first-parent` is orthogonal to `--no-merges`: the former prunes second-parent subtrees from reachability, the latter drops merge commits themselves from the log. Both flags are independently controllable below.

3. **Bail-out before patch assembly.** Read `manifest.changedFiles`. If empty, print `No changes in scope {scope}. Exiting.` and STOP. Do not write an artifact.

4. **Assemble review patches from the manifest.** This preserves the union of commit changes, writes one worktree-safe patch per shard, uses `-U30`, and automatically retries patches larger than 1 MB with `-U10`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/_helpers/assemble-review-patches.mjs" "<changed_files_manifest>"
   ```
   Read the returned patch list, then re-read the updated manifest. `ChangedFiles` is `manifest.changedFiles`; `ReviewPatches` is `manifest.patches`. Each patch owns exactly the files listed beside it. Never build or split patches by hand.

5. **Read the derived scope flags from the helper output** (all deterministic — the helper computes them at Step 1.1; do NOT re-derive them by hand):
   - `InScopeFiles` ← the `---in-scope-files---` block; the literal `(identical to changed-files)` marker means `InScopeFiles = ChangedFiles`. Used by the Step 6 pre-filter. `ChangedFiles` reflects *tree-reachability* (inflated on branches that back-merged the default branch); `InScopeFiles` reflects the *commits' own diffs* — what the developer actually authored (first-parent: union of the feature commits' `diff-tree` deltas; commit-list input iterates the user-named hashes to preserve non-contiguous-list intent; explicit-range / working-tree: identical by definition).
   - **Invariant**: `InScopeFiles ⊆ ChangedFiles`. On back-merged feature branches, `InScopeFiles ⊊ ChangedFiles` is the primary mechanism by which sidecar findings get dropped at Step 6.
   - `ManifestChanged` ← `manifest_changed:`; when `yes`, `manifest_files:` names the touched manifests/lockfiles (the Dependencies/CVE lenses' extraction source).
   - `LockstepSelfReview` ← `lockstep_self_review:`.
   - `PeerPairs` ← the `---peer-pairs---` block (`new_file \t peer_file \t heuristic`; heuristics: interface-impl pairs, the shared peer-noun suffix vocabulary, and stem similarity — tests are never peers, both-added pairs are excluded, capped per new file). Empty block ⇒ skip the peer-mirror agent. Co-modified peers are KEPT — the agent Reads them at HEAD (post-diff tree state), so any invariant present at HEAD counts as peer evidence regardless of whether the peer was edited in this diff.
   - `ReviewShards` / `ReviewPatches` ← the manifest's `shards` / `patches`; every reviewable file appears exactly once.
   - `PriorReview` ← `prior_review:`. `(none)` means no same-branch JSON baseline exists.
   - `HasGatingPredicate` = a shard patch adds or modifies a **status/enum-comparison predicate** (`Status == X`, `Status is X or Y`, `X.Contains(Status)`, pattern-match on a discriminator) OR introduces a new value into an enum referenced by existing gating predicates. NOT merely the presence of `if (!x) return`.
   - `ReviewType` = one of `commit | pr | staged | working`.

6. **Set the review depth from the lane.** Run `lane.mjs --range <range>` for the `first-parent` and `explicit-range` strategies, or `lane.mjs --working` for `working-tree` (as `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/lane.mjs" …`). The lane is the higher of the passed `lane=<lane>` token and `lane.mjs` (raise-only, as `mergeLane`), so a review never runs below the slice it reviews. A token that is not a lane is broken: read it as `normal` and record `broken passed lane: <value>`; keep a `lane: broken:` line from `lane.mjs` the same way. A missing or broken lane means `normal` (full depth), never `fast`. Depth: `fast` → light, `normal` → full, `rigorous` → rigorous (the **Lanes** table in `skills/_shared/candidate-workflow.md`). Record the depth, the lane and its reasons under `## Reconciliation Notes`.
   - **Light** — In the fast lane (light), dispatch no `integration-scanner`, no `precedent-locator`, no Security lens, no sink-candidate sweep and no Wave-3 agent. The review is Step 1, the deterministic pre-wave gates, one Quality `diff-analyst` per shard (it carries the documented-standards surface) and the Step 6 claim-verifier. Wave-1 lenses gated on input data (Dependencies, CVE, Peer-Mirror, Spec conformance) still run when their gate fires. Record each skipped part as `skipped (fast lane)`, never as `unavailable`.
   - **Full** — every step as written below.
   - **Rigorous** — full, plus: In the rigorous lane, Security runs on every shard, test and docs shards included, and the interaction sweep (4b) and the gap-finder (4c) run whenever 2 or more files changed. The lenses that need input data stay data-gated (Dependencies, CVE, Peer-Mirror, Predicate-Trace, Spec conformance): with no input there is nothing for them to review.

   The deterministic pre-wave gates run in every lane, and claim verification runs in every lane (Step 6).

### Step 2: Dispatch Wave-1 — Integration + Precedents + Deps/CVE + Peer-Mirror

**Pre-Wave-1 deterministic gates run before agent dispatch.** At light depth (fast lane) this step dispatches only the input-gated Wave-1 lenses (Step 1.6). Create the capability snapshot once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/_helpers/review-preflight.mjs" "."
```

Read `references/pre-wave-gates.md` NOW and execute only gates supported by this snapshot and repository configuration. Digest successful results into the Discovery Map. Record each unavailable capability once; its matching lens retains full coverage. Structured diagnostics from non-zero commands are findings, while empty/malformed output is an unavailable gate.

Spawn ALL of the following in parallel at T=0 in a **single message with multiple Agent tool calls**. Do NOT wait for integration-scanner before dispatching precedents / dependencies / CVE — they do not consume Discovery-Map output, only `ChangedFiles` and the manifest diff (both orchestrator-produced in Step 1).

**Agent — Integration map:**
- subagent_type: `rpiv:integration-scanner`
- Prompt: "Read `{changed_files_manifest}` and map inbound references, outbound dependencies, and infrastructure wiring for every path in `changedFiles`. Flag auth-boundary crossings and config/DI/event registration touching these paths. Do not analyse code quality; connections only, in your standard output format."

**Agent — Precedents** (full and rigorous depth; not dispatched in the fast lane): use the `precedent-locator` prompt defined in Step 3 below — dispatch it here, not in Wave-2. Give it `{changed_files_manifest}`, not a pasted file list.

**Agent — Dependencies** (only when `ManifestChanged`): use the `codebase-analyzer` Dependencies prompt defined in Step 3 below — dispatch here. Input it needs: touched manifest paths + `LockstepSelfReview` flag.

**Agent — CVE / advisory** (only when `ManifestChanged`): use the `web-search-researcher` prompt defined in Step 3 below — dispatch here. Input it needs: parsed `name@version` list from the manifest diff (orchestrator extracts and hands over directly).

**Agent — Peer-Mirror** (only when `len(PeerPairs) > 0`): `subagent_type: rpiv:peer-comparator`. Input: the `PeerPairs` list verbatim, nothing else — no Discovery Map (it isn't built yet and the agent doesn't need it), no patch path (the work is peer-vs-new entity comparison, not diff analysis). Prompt: Read §Peer-Mirror in `references/gated-prompts.md` and use its fenced block byte-for-byte, substituting only the `{list of (new_file, peer_file) tuples}` placeholder.

**Agent — Spec conformance** (optional — only when the branch/PR links an external issue and `gh` resolves it): Read §Spec Conformance in `references/gated-prompts.md` before dispatch — it owns issue resolution, the always-emitted status line (no issue / `gh` unavailable / `gh` failed are distinct), and the prompt. Its output is a separate, unranked artifact section; it never enters the Discovery Map, Wave-2, or the severity map.

**Agent — Sink-candidate sweep** (only when preflight reports opengrep unavailable): dispatch one `rpiv:diff-auditor` per ReviewPatch whose shard category is `mixed`, `source`, `migration`, `config`, `manifest`, or `other`. Each receives only its patch path. Read §Sink-candidate sweep in `references/gated-prompts.md`, substitute that path, and digest all returned rows into one `Grep sink candidates` map row. When opengrep is available, skip these agents.

While these agents run, the orchestrator produces the rest of the Discovery Map inline from Step 1's data:
- `ChangedFiles`, `ManifestChanged`, `LockstepSelfReview`, `ReviewType`
- **Semantic file map** (per file: `path (+A -B)` + role tag + top-level symbol names touched; see format and rules below)
- Commit-message context (if applicable)
- **Project standards** — the target repo's prose rules (agent instructions, standing decisions/ADRs, domain vocabulary) extracted per §Project standards in `references/discovery-map.md`, minus rules configured tooling already enforces

**Wait for `integration-scanner`, the peer-mirror agent, and every sink-candidate shard sweep (when dispatched)** before Wave-2. Digest their results into the Discovery Map. Precedents / Dependencies / CVE continue in the background; **Precedents MUST be awaited before Step 5 begins** (except in the fast lane, where it is not dispatched). Dependencies / CVE also merge at Step 5 but may arrive later.

**Pre-index the dependency neighborhood (ctx_index)** — only when preflight reports Context Mode configured. Run AFTER integration-scanner returns, BEFORE Wave-2 dispatch. The Quality lens's Surface 3 (blast radius) and Surface 8 (cross-layer drift) depend on reading files outside ChangedFiles — inbound consumers, peer aggregates, upstream guards. Pre-index the outbound dependency files of ChangedFiles so lens agents query `ctx_search` instead of issuing Read calls:
  - Collect the union of files referenced by integration-scanner's `Outbound deps` and `Inbound refs` rows
  - Run:
    ```
    ctx_index(
      path: "<repo-root>",
      source: "deep-review-deps",
      include: [<outbound-dependency-paths>],
      maxDepth: 1
    )
    ```
  - Lens agents receive `Known Context: pre-indexed dependency files available via ctx_search(source: "deep-review-deps")` in their Wave-2 prompt. They query instead of reading — cheaper on token budget. If the dependency set is empty (< 3 files to index), skip — direct reads are cheaper than index overhead.

**Synthesize the Discovery Map** — a compact block that Wave-2 agents receive verbatim as `Known Context`. Each file line carries a *role tag* and a *symbols-touched hint*; files are clustered by shared directory prefix so agents orient without re-reading the patch.

Read `references/discovery-map.md` NOW — it holds the exact map template, the clustering / role-tag / symbols-touched-hint rules, and the tool-gated structural-enrichment digest rules (opengrep sinks, ast-grep dispatch shapes, rg risk keywords, CodeScene Code Health and its regression findings, SonarQube issues, dependency-cruiser boundary violations) plus the Project standards extraction. Build the map exactly per that file before dispatching Wave-2.

### Step 3: Dispatch Wave-2 — Quality + Security Lenses

Dispatch all shard lenses in one parallel wave. Spawn one Quality `diff-analyst` per ReviewPatch. Spawn one Security `diff-analyst` per ReviewPatch whose shard category is `mixed`, `source`, `migration`, `config`, `manifest`, or `other`; docs-only and test-only shards skip Security (in the rigorous lane Security runs on every shard; in the fast lane no Security lens runs). Each agent receives the Discovery Map and its own patch path. Precedents / Dependencies / CVE are already running from Wave-1.

**Wave-2 context isolation (LOAD-BEARING — violations cause silent quality collapse)**: Each Wave-2 agent receives EXACTLY two things, nothing else: (1) the Discovery Map and (2) its resolved shard patch path.

**DO NOT paste into Wave-2 prompts**, under any circumstance, even if the orchestrator has already received them:
- raw integration-scanner output (the Discovery Map already summarises its auth/ref/wiring findings)
- precedent-locator output
- Dependencies lens output
- CVE lens output
- any prior Wave-2 or Wave-3 output from earlier runs in the same Pi session

**Why this is load-bearing**: summary context induces *narrativisation* — the agent treats the preamble as "the orchestrator already framed the findings, I just classify them" instead of independently reading the patch file. Observed failure signatures when this is violated: Quality drops from ~40 tool calls / 3M tokens / 500s to ~5-15 tool calls / 300k tokens / 100-200s, and returns hallucinated findings (invented statuses, mis-cited line numbers, claims that files are "missing from patch" when they are in fact present).

**Self-check before dispatching Wave-2**: read your outgoing Agent prompt. If it contains any content from Wave-1 agent RESULTS beyond the Discovery Map you synthesised, strip it. The Discovery Map is the contract; raw outputs are reconciliation-only.

**Quality lens** (`diff-analyst`) — **file-oriented**. Before dispatching: Read `references/quality-surfaces.md`, strip its leading `<!-- -->` comment, and substitute the remainder for the `{{QUALITY_SURFACES}}` line below — the dispatched prompt must carry the full 14-surface block verbatim, never the placeholder:
  ```
  Analyse changes file by file. For each file in this shard patch, read its diff region (the patch has `-U30`, or `-U10` only when size-bounded), form a mental model of the file and its change, then apply the 14 surfaces below. Cite `file:line` with verbatim line text for every finding. Omit findings not traceable to a diff-touched change. No severity.

  **File order strategy**: prioritise by role tag — `[boundary]` files first (security-sensitive), then `[persistence]` (durable-state surfaces), then `[hub]` (blast-radius amplifiers), then `[code]`, then `[config]`, then `[test]` last. Within the same tag, prioritise files with the largest diffs.

  **Per file**, emit the standard per-file block: heading `### file/path.ext` + ONE pipe-row table (`file:line | verbatim | surface-id | note`) holding every row for that file — rows only for surfaces that APPLY to that file's changes. A surface may be flagged across multiple files — report the evidence where it lives, and rely on cross-layer surfaces (8, 9) to tie them together.

  {{QUALITY_SURFACES}}

  **Companion candidates**: when the Discovery Map carries a `Companion candidates` row, check each — is this change incomplete without touching its historical partner (mirror table, registry, migration, doc, test)? Open the companion and emit a row (surface 8 or 9) ONLY when its content shows the concrete gap; a co-change statistic alone is never a finding.

  **Economising Reads**: issue a `Read` only when (a) you need a file outside this shard or (b) the changed function is longer than the bounded patch context. Never re-Read a file just to re-orient. When dependencies were pre-indexed, prefer `ctx_search(source: "deep-review-deps", queries: [...])` for cross-file traces.
  ```

**Security lens** (`diff-analyst`) — **file-oriented**. Before dispatching: Read `references/security-sinks.md`, strip its leading `<!-- -->` comment, and substitute the remainder for the `{{SECURITY_SINKS}}` line below — the dispatched prompt must carry the full sink-class catalog + do-NOT-report list verbatim, never the placeholder:
  ```
  Analyse each changed file in this shard patch as a whole, looking for the sink classes below. Start from successful AST/Opengrep rows in the Discovery Map; they are candidates until you trace source-to-sink reachability. For uncovered sink classes, inspect this shard patch directly. For each hit emit a row with the verbatim line; the note carries `confidence: N/10` plus the other endpoint of the trace. Drop confidence below 8. Cross-reference auth-boundary crossings and inbound refs. Never emit an untraced static-analysis candidate.

  **Sink detection hierarchy:** successful ast-grep rows (structural precision) ▶ successful Opengrep rows (recall) ▶ patch inspection (fallback). Use only rows present in the Discovery Map; an unavailable gate leaves the class to this lens.

  **File order strategy**: `[boundary]` files first (direct source→sink exposure); then `[persistence]` (query injection, unsafe deserialization); then `[code]` (command exec, SSRF, explicit-trust rendering); then `[hub]` / `[config]`; skip `[test]` unless a test helper touches a sink.

  IN-SCOPE RULE: only report findings whose sink line is inside a changed file's diff region (add/modify/adjacent-context rewrite). Pre-existing sinks in files the diff did not change are out of scope, UNLESS the diff changes how data flows TO the sink (e.g. new user-controlled source routed to an untouched sink) — then cite both locations. When in doubt, trace data flow from Discovery Map boundary crossings through the changed files.

  {{SECURITY_SINKS}}

  Name the sink class and the matched idiom. Evidence only. No CVE lookups.
  ```

**Dependencies lens** (`codebase-analyzer`, only when `ManifestChanged`; otherwise SKIP and omit `### Dependencies` in artifact): when the gate fires, Read §Dependencies in `references/gated-prompts.md` — it selects between the Knip-primary prompt (Knip ran at the Pre-Wave-1 gate) and the full fallback prompt; use the applicable fenced block byte-for-byte.

**Precedents lens** (`precedent-locator`):
  ```
  Code review of {scope}. Read `{changed_files_manifest}` and use its `changedFiles` list.
  Find similar past changes touching those files or nearby. Per precedent: commit hash, blast radius, follow-up fixes within 30 days, one-sentence takeaway. Distil composite lessons.
  ```

**CVE/advisory lens** (`web-search-researcher`, only when `ManifestChanged`): when the gate fires, Read §CVE/advisory in `references/gated-prompts.md` and use its fenced block byte-for-byte, substituting the `{name@version per line}` placeholder (orchestrator-extracted).

**Wait for every shard lens to complete**, then merge outputs in ReviewPatch order and preserve row order within each patch. Precedents / Dependencies / CVE from Wave-1 may still be running; gather them before Step 5, not before Step 4.

**Assign finding IDs now** (orchestrator-side, before Wave-3): number Quality's rows `Q1..Qn` and Security's rows `S1..Sn` in output order. These are the stable lens-prefix ordinals Step 7's ID contract requires — assigning them here (not at Step 5) gives Wave-3's interaction sweep real constituent IDs to reference, and Step 5/6 a stable handle per finding. Ordinals never renumber.

### Step 3.5: Relation Audit (optional, Jev-backed — narrative-vs-record fact-check)

Before Wave-3 compounds anything, fact-check the Wave-2 narratives against the deterministic record the gates already extracted. The relation auditor (`scripts/jev-rel-audit.mjs`) asks one question per finding: *does the finding's description of relationships match the extracted record for its cited files?* — consumers, imports, boundaries, call sites.

**Gate**: SKIP this step when the Pre-Wave-1 gates did not produce a dependency record (dependency-cruiser unavailable/absent) or no TypeSafe key is configured — note it once under Reconciliation Notes and continue; this assist is never a gate.

When the gate fires:
1. **Assemble the record** from the gate's own output (already digested into the Discovery Map — save its JSON):
   ```bash
   node "$RPIV_PLUGIN_ROOT/scripts/jev-rel-audit.mjs" --depcruise <depcruise.json> [--astgrep <astgrep.json>] --out relations.json
   ```
2. **Write findings.json** from the merged Wave-2 rows (per finding: `id`, `file`, `line`, `verbatim`, `note`), then audit:
   ```bash
   node "$RPIV_PLUGIN_ROOT/scripts/jev-rel-audit.mjs" --findings findings.json --record relations.json --out rel-audit.json
   ```
3. **Digest the verdicts** — findings whose cited files have no record data are `no-record` and pass untouched (asymmetry of evidence: a silent record is never proof of a wrong claim). `RECORD-CONTRADICTION` and `UNCERTAIN` lines go to the orchestration as review notes and ride along to Steps 4/5; they are advisory — they never demote or drop a finding by themselves. The interaction-sweeper and the Step 6 verifier remain the authorities.

### Step 4: Dispatch Wave-3 — Predicate-Trace + Interaction Sweep + Gap-Finder

At light depth (fast lane) skip all of Step 4 and record `Wave-3: skipped (fast lane)`.

Once Wave-2 (Quality + Security) completes, dispatch 4a and 4b as parallel agents **in a single message**; compute 4c inline (orchestrator-side set arithmetic — no agent). They do NOT consume each other's output:

- **Interaction Sweep (4b)** receives Quality's `Predicate-set coherence` table directly as its predicate-row source. Quality's table already flags mismatches — Predicate-Trace (4a) only *elaborates* them through consumers. The sweeper's built-in kinds don't need 4a at all; the caller-supplied kinds `stranded-state`, `false-promise`, and `co-tenant-filter-gap` operate on the same rows 4a would trace.
- **Gap-Finder (4c)** is coverage arithmetic: `{in-scope files} − {files with ≥1 Quality/Security finding} = {uncovered files}`. Orchestrator already holds both sets post-Wave-2 — an agent would discard context only to re-receive it via prompt. Inline is strictly cheaper and deterministic.
- If Predicate-Trace (4a) surfaces a row that was not visible in Quality's table, append it via a Step 9 follow-up — cheaper than a serial gate.

#### Step 4a: Predicate-Trace

**Gate**: SKIP this sub-step (do not dispatch 4a) unless `HasGatingPredicate` is true AND the Quality lens returned ≥2 rows in its `Predicate-set coherence` table referencing the same enum/type. If skipped, 4b and 4c still dispatch.

Otherwise spawn ONE `diff-analyst` in parallel with 4b — Read §Predicate-Trace in `references/gated-prompts.md` and use its fenced block byte-for-byte as the prompt, substituting the coherence-rows and gating-predicates placeholders. (This is traced-surface work with a review-scope table output — diff-analyst's contract; codebase-analyzer's narrative format and no-defect-finding rule both mismatch it.)

Do NOT wait — 4b (Interaction Sweep) dispatches in the same message as 4a; 4c runs inline in the orchestrator.

#### Step 4b: Interaction Sweep

**Gate**: SKIP this sub-step (do not dispatch 4b) when EITHER `len(ChangedFiles) < 2` OR the Quality lens returned fewer than 4 total observations across all files (in the rigorous lane only the `len(ChangedFiles) < 2` condition applies). Emergent interactions need surface area; tiny diffs cannot structurally produce them.

Otherwise spawn ONE `interaction-sweeper` in parallel with 4a:
  ```
  Target: {scope} (deep-review — no layer table)

  Finding set — CANDIDATE tier (Wave-2 lens rows, not yet verified; ground each compound's OWN evidence by re-reading the cited code):
  {every Quality row as: Q<n> | Q | file:line | `verbatim` | (severity unassigned) | note}
  {every Security row as: S<n> | S | file:line | `verbatim` | (severity unassigned) | note}
  Predicate-set coherence rows (verbatim from Quality's table — full Step 4a output is NOT required and is NOT awaited): {verbatim | "not applicable"}
  Precedents: {verbatim if Wave-1 finished; else "deferred to Step 5"}

  Additional compound kinds (admissible Kind values; group by shared entity, state machine, workflow, data-flow path, API boundary, background process, or producer-consumer contract):
  - stuck-state — unreachable, stuck, or non-terminal states across the constituents' files,
  - inert-recovery — a retry/reprocess mechanism made inert by another constituent's behavior,
  - duplicate-processing — idempotency gaps from ordering or missing guards,
  - guard-invalidation — a guard in one layer invalidating transitions in another,
  - stranded-state — state X reachable via one conditional but every conditional operating on this entity elsewhere excludes X,
  - false-promise — a matching branch whose consumer excludes this entity's source/type/state,
  - co-tenant-filter-gap — a shared discriminator filter where a new or terminal value the diff touches falls through every consumer's filter.
  (Contradictory assumptions between components map to your built-in contradictory-design; masking/amplifying/permanently-triggering maps to masking.)

  For compounds involving ordering/races/concurrency across processes or handlers, the Why-it-compounds sentence must name the ordering primitive that would prevent the race (distributed lock, exclusive-key wrapper, ordered partition, transaction, idempotency key, etc.) and explain why it does NOT apply here. Drop the compound if the primitive exists in the diff or nearby and your argument against it is speculative.
  ```

  The sweeper returns `IX-<n>` blocks; Step 5 adopts each as finding `I<n>` (ordinal preserved) and maps its Aggregate severity High → 🔴, Med → 🟡 (Low: fold into a constituent's evidence or keep 🟡 when independently actionable — Interaction findings carry no 🔵/💭 per `references/severity-model.md`).

#### Step 4c: Gap-Finder (orchestrator-side coverage arithmetic)

**Gate**: SKIP when `len(ChangedFiles) < 2`. Tiny diffs cannot structurally have coverage gaps.

No agent dispatch. Compute inline while 4a / 4b run:

1. **Coverage map** — parse Quality + Security outputs; for each finding row extract its `file:line` citation and map `file → {finding-id}`. Files with ≥1 row are covered; files with none are uncovered.
2. **In-scope filter** — keep files tagged `[boundary]`, `[persistence]`, `[code]`, or `[hub]` AND whose diff delta (sum of added + removed lines) is ≥ 5. Drop `[test]` and `[config]` entirely; drop files with tiny deltas.
3. **Emit gap findings** — walk uncovered in-scope files in role-tag priority `[boundary]` → `[persistence]` → `[hub]` → `[code]`. For each, use the manifest to open its owning shard patch and pick ONE risk-bearing line (first non-comment `+` line, or the function-declaration header if a whole function was added). Emit:

   `G<ordinal> — file:line — \`<verbatim line>\` — {role-tag} — <risk class in 3-6 words>`

   Risk-bearing behavior class (diff introduces one of): state mutation | I/O (DB/network/file) | error path | conditional on mutable state | concurrent/shared-state access | public API surface change. Maximum **5** gap findings; stop once reached. Citation contract applies.

**Wait for ALL of 4a / 4b AND the Precedents agent from Wave-1 to complete** before proceeding to Step 5 (Reconciliation). Precedents is a **hard gate** (except in the fast lane, where it is not dispatched) — severity weighting in Step 5 reads its follow-up-within-30-days counts. Dependencies / CVE (when dispatched) also merge in here but are not individually hard-gated; wait for them too unless they clearly exceed the review SLA, in which case omit `## Dependencies` and note it in the artifact. 4c has no wait — it completes synchronously with the orchestrator.

### Step 5: Reconcile Findings

**Barrier**: Step 5 MUST NOT begin until the Precedents agent has returned — except in the fast lane, where Precedents is not dispatched, Step 5 does no precedent weighting, and the review records `precedents: skipped (fast lane)`. Severity weighting depends on historical follow-up counts; starting reconciliation without them produces mis-weighted severities that the verification pass (Step 6) cannot correct.

**Resolution integrity check** (load-bearing): when Precedents returns a commit that claims to resolve or supersede a current finding, run `git merge-base --is-ancestor <precedent-hash> <TIP>` before accepting the resolution.
  - Ancestor: the precedent IS in the reviewed branch; mark the finding `resolved-by: <hash>` and demote its severity to 💭 (kept for context).
  - Not ancestor: the precedent is on a different branch / not merged; treat it as **context only**. Do NOT mark the finding resolved; annotate the precedent's row in `## Precedents` third column `NOT ancestor of {TIP} (context only)`.
  - Orchestrator unable to run git (e.g., `staged` / `working` scope with no commit): skip the check and annotate `resolution: unverified`.

1. **Compile and classify evidence** per lens — Read `references/severity-model.md` NOW (it also governs Step 6's tag application). Apply its per-lens classification (Quality, Security, Dependencies, Interaction-sweep, Gap-finder, Peer-mirror — including the peer-mirror severity bumps), its Precedents compilation + severity-weighting rule, and the tool-gated CodeScene business-case annotation.

2. **Probe advisor availability** — attempt a probe by checking whether `advisor` is in the active tool set (main-thread visibility). If yes, proceed to advisor path; otherwise take the inline path.

3. **Advisor path** (when advisor is active):
   - Print a main-thread `## Pre-Adjudication Findings` block first — the advisor reads `getBranch()`, so evidence must be flushed before the call.
   - Call `advisor()` (zero-param). If it returns usable prose, paste it verbatim as a blockquote at the top of `## Recommendation` and skip the inline path. Otherwise fall through.

4. **Inline path** (advisor unavailable or errored):
   - Run a dimension-sweep modeled on `skills/_shared/dimension-sweep-and-checkpoint.md` (Step 3): Data model / API surface / Integration / Scope / Verification / Performance.
   - For every finding, ask: does another finding contradict this severity given the Discovery Map? If yes, note the tension.
   - Record every severity move as a title-line annotation on the affected finding (`[precedent-weighted]`, `[cascade: <kind>]`, `[subsumed-by <ID>]`). No standalone reconciliation section.

5. **Emit the reconciled severity map** — authoritative severity per finding, carrying the advisor's guidance when present. Keep the per-pass grouping (do NOT tag each finding with its originating lens in prose; the H2 it sits under is the tag).
   - Interaction findings carry `I<n>` IDs and appear under the severity H2 that matches their final tier (`## 🔴 Critical`, `## 🟡 Important`). The old `### Cross-Finding Interactions` sub-heading is retired — severity is the top-level grouping.
   - When an interaction finding subsumes a local finding at the root-cause level, keep the local finding only if its evidence is independently actionable; annotate the local finding's title line `[subsumed-by I<n>]`.
   - Distinct structural defects MUST remain distinct findings even when related. Specifically: a *stranded state* (entity reaches X, no exit path) and a *false-promise predicate* (TRUE branch promises unreachable behavior) are separate defects even when they arise in the same subsystem — do NOT collapse them. Collapse only when the narrative, fix, and evidence locations are identical.
   - **Cascade detection** (load-bearing — missed cascades are the biggest historical quality regression): apply §Cascade detection from `references/severity-model.md` verbatim — scan findings for its three defect triples and emit a 🔴 Cross-Finding bullet if any fires; it also mandates the prior-review cascade-reproduction check.

6. **Scope assist (optional, Jev-backed — pre-existing re-badge detection).** When `scripts/jev-pair-judge.mjs` exists under `$RPIV_PLUGIN_ROOT/scripts/` and a TypeSafe key is configured, run one advisory pass over the reconciled map: write `findings.json` (per finding: `id`, `file`, `line`, `verbatim`, `note`) and invoke
   ```bash
   node "$RPIV_PLUGIN_ROOT/scripts/jev-pair-judge.mjs" --check scope --findings findings.json --patches "<review-patch>" --out scope.json
   ```
   using the shard patch that owns the finding's file (Step 1's manifest). Findings whose cited file is outside every patch are reported `NO CONTEXT` — that is the mechanical InScopeFiles pre-filter's job (Step 6), not this pass. Digest `OUT-OF-SCOPE` / `UNCERTAIN` lines as review notes and surface them with the verification results; they are advisory only and never demote a finding by themselves. If the script is missing, fails, or has no key: note it once under Reconciliation Notes and continue — this assist is never a gate.

### Step 6: Verify Findings

Before writing the artifact, spawn ONE `claim-verifier` whose sole job is to ground every reconciled finding in the actual code at its cited `file:line`. This catches two classes of error the lenses cannot self-detect: (a) *confident assertions* the agent never opened a file to confirm, and (b) *rationalisations* ("intentional-by-design", "pre-existing", "not a real deadlock") that contradict what the code does. Lens agents reason from the patch; the verifier reasons from the file.

**Dispatch** after Step 5's reconciled severity map is final, before Step 7 writes anything. First apply the **InScopeFiles pre-filter**: drop any finding whose cited `file` ∉ `InScopeFiles` (orchestrator-side set arithmetic, matches Step 4c's idiom). On `first-parent` strategies `InScopeFiles ⊊ ChangedFiles` is expected — this is where back-merge sidecar findings get dropped. Record the dropped count in `## Reconciliation Notes` so the omission is auditable. Then dispatch the filtered map:

  ```
  Verify each finding below against the actual repository state. You have Read access to the whole tree.

  Findings (verbatim from Step 5):
  {paste the full reconciled severity map — each finding with its file:line citation, verbatim line quote per the citation contract, and severity tier}

  For EACH finding:
  1. `grep -n` the verbatim quote in the cited file. Absent → Falsified. Present at a different line → rewrite the citation to the actual line, then continue. Present at cited line → continue.
  2. If the finding makes a claim about behavior reachable elsewhere (consumer filters, dispatch registrations, peer aggregates, upstream guards, downstream sinks), Read those referenced files too. Do NOT trust the patch-only view.
  3. If the finding claims a state is "stranded" / a predicate is "false-promise" / a precondition is "missing" — construct a concrete 2–3 line reproducer trace: "caller at A:L invokes B:L with entity in state X; guard at C:L rejects; exit path would require D which the code does not provide." If you cannot construct it, the finding is Weakened.
  4. If the finding was marked `resolved-by: <hash>` in Step 5, Read the resolving commit's changes on the reviewed branch (via `git show <hash> -- <file>`) and confirm the resolution is actually present at TIP.

  Return ONE tag per finding — output format:

    FINDING <id> | <tag> | <one-sentence justification citing a file:line>

  Tags:
  - Verified — quote matches, claim is reproducible against the actual code, no contradiction found
  - Weakened — claim is partially true but narrower than stated (severity should drop one tier), OR it relies on a consumer-side assumption that the actual consumer does not make
  - Falsified — quote does not match, OR the claimed behavior is contradicted by code the lens did not read (peer site, upstream guard, existing handler, resolution already applied)

  Be explicit about contradictions. If finding A says "intentional by design" and finding B says "stranded state" about the same entity, mark the one whose claim the code does NOT support as Falsified and cite the contradicting line.

  Citation contract applies to every justification. No recommendations. No new findings.
  ```

**Apply the verifier's tags** per §Verification tag semantics & application in `references/severity-model.md` (read at Step 5; re-open it if no longer in context): the tag-override check runs first, then the per-tag actions — Falsified removed + ID retired, Weakened demoted one tier + evidence rewritten, Verified carried through, and the Cross-Finding edge case re-evaluated.

Carry every verifier result into Step 7. Verified and Weakened findings remain active. Falsified findings remain in the store with `verify:"Falsified"` and `status:"withdrawn"`; rendering omits them from the body but preserves the audit count. Set review metadata to `status: ready` and `review_status: complete`; `merge_status` is derived from remaining critical + important findings.

**Do not skip this step** — claim verification runs in every lane; it is the only mechanism that stops confident-but-unread lens assertions from reaching the artifact.

### Step 7: Write the Review Document

1. **Determine metadata** (from the Metadata block at the top of this skill):
   - Filename: `.rpiv/artifacts/reviews/<slug>_<scope-kebab>.md` — `<slug>` is the second tab-separated field on line 1 of the Metadata block above.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels (fallbacks `no-branch` / `no-commit` already substituted).
   - `date:` ← `<iso>` (first tab-separated field on line 1 of the Metadata block above, offset verbatim).
   - Reviewer: `author:` from the Metadata block (fallback: `unknown`).

2. **Create the write-once review store.** Create the target `.md` as an empty placeholder, then initialize it with review metadata (date/author/repository/branch/commit/review_type/scope/scope_strategy/in_scope_files_count/status/review_status) and pre-rendered trailing sections (Reconciliation Notes/Pattern/Impact/Precedents/Recommendation):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/store.mjs" init --review --artifact <review.md> --root . < <review-init.json>
   ```

3. **Persist all verification outcomes atomically.** Pipe one JSON array to `add-many`; each record is `kind:"dr"`. Include Verified, Weakened, and Falsified records. Weakened/Falsified records carry the verifier's justification in `verifyNote`; Falsified records use `status:"withdrawn"` and remain auditable even though rendering omits them:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/store.mjs" add-many --artifact <review.md> --root . < <findings.json>
   ```
   Validation is all-or-nothing: if any record fails, fix the array and rerun; never fall back to one-by-one adds.

4. **Classify drift against the same-branch baseline.** When `PriorReview != (none)`, run before rendering:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/store.mjs" diff --artifact <review.md> --prior <PriorReview> --root .
   ```
   This persists `NEW`, `Still-open`, `Regressed`, and resolved counts. When there is no baseline, omit the Drift Delta section.

5. **Render once from the store:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/store.mjs" render --review --artifact <review.md> --root .
   ```
   `renderReview` derives severity, verification, blockers, and merge status from the persisted records.

6. **Run the citation-path gate:** `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/check-citations.mjs" <review.md> --root .`. For each ambiguous basename, update the corresponding finding's repo-relative evidence path through `store update`, rerender, and repeat until the gate exits 0. Never hand-edit the rendered body.

**Finding IDs**: lens-prefix + ordinal, stable across severity moves. `I` = interaction, `Q` = quality, `S` = security, `G` = gap. Ordinals never renumber — if a finding is dropped by Step 6, its ID is retired, not reused.

**Title-line annotations** (appear in square brackets on the finding's title line, point-of-demand for reconciliation facts):
- `[precedent-weighted]` — severity bumped by Step 5's precedent follow-up weighting.
- `[cascade: <kind>]` — severity set by Step 5's cascade-detection triple (`stranded-state`, `duplicate-processing`, `contradictory-predicate-deadlock`).
- `[subsumed-by <ID>]` — root-cause subsumed by another finding but kept because its specific evidence is independently actionable.

**Section-omission rules**: omit entirely (no empty placeholders) when —
- `## 💭 Discussion` — no 💭 findings.
- `## Pattern Analysis` — no peer-mirror pair existed for this diff.
- `## Impact` — integration-scanner returned no inbound refs to changed files.
- `## Precedents` — precedent-locator returned no precedents.
- `## Spec Conformance` is NEVER omitted: it always carries its status line (§Spec Conformance in `references/gated-prompts.md`), and its rows are unranked — they never become findings.

**What is NOT emitted to the artifact**: verification outcomes in prose (frontmatter `verification` string is the only channel), advisor availability / dispatch path / tool failures (skill trace, not review content), `last_updated` / `last_updated_by` (git mtime + git author carry this for a write-once artifact).

**Advisor prose**, when advisor ran, is pasted verbatim as a blockquote at the top of `## Recommendation`, not as a standalone section.

**Template shape**: `templates/review.md` (house pattern per `.rpiv/guidance/skills/architecture.md:66` — `templates/` subfolder, runtime-read, never inlined) is the byte-shape reference `renderReview` matches — the store now PRODUCES this shape rather than a hand fill-and-strip. `renderReview` emits the frontmatter, the post-heading summary line, the Legend, Top Blockers, and the per-tier severity sections (degrade-per-tier finding blocks); the section-omission rules are intrinsic to it (a tier/section with no findings is not emitted). The trailing analysis sections (Pattern/Impact/Precedents/Recommendation) ride the envelope's `review.sections` (pre-rendered by this skill, with the same omission rules applied) and are appended verbatim.

### Step 8: Present Summary

Before presenting, count the fix commits on the branch that name a review artifact (implement's fix-commit messages name the review and its fix round). With 1 fix round already made and the review still `Merge: blocked`, present the Fix step as the stop below, not as a new round.

```
Review written to:
`.rpiv/artifacts/reviews/{filename}.md`

Severity:     {C} critical · {I} important · {S} suggestions
Lenses:       {Q} quality · {Se} security · {D} dependencies
Verification: {V} verified · {W} weakened · {F} falsified (dropped)
Advisor:      {adjudicated | inline}
Spec:         {Spec Conformance status line}
Review:       complete · Merge: {blocked | clear} · {B} blockers (🔴 + 🟡)
Depth:        {light | full | rigorous} ({lane} lane)

Top items:
1. {ID} — `file:line` — {headline}
2. {ID} — `file:line` — {headline}
3. {ID} — `file:line` — {headline}

Ask follow-ups, or chain forward.

---

💬 Follow-up: describe the question in chat to append a timestamped Follow-up section. Retired IDs stay retired; re-run `/rpiv:deep-review` for a fresh review.

**Fix step:** when `Merge: blocked`, run `/clear`, then `/rpiv:implement <review-path>` — implement turns the verified 🔴 and 🟡 findings into fix commits on the branch, then deep-review runs again on the branch. After 1 fix round with the review still `Merge: blocked`, stop and ask the developer with `ask_user_question` (open findings and choices); never start a second fix round unasked.

**Next step:** `/rpiv:validate <design-path> <reviewed-range>` — once the review is `Merge: clear`, validate certifies the final code against the approved contract (`<design-path>` from the `design=` token; without a `design=` token, validate asks for the contract). Run `/clear` first, then this command, so the next stage starts in a fresh session; stop here instead if a developer decision or any other **Lanes** stop is pending.
```

### Step 9: Handle Follow-ups

- **Append, never rewrite.** Edit the artifact to add a `## Follow-up {ISO 8601 timestamp}` section. The section heading's timestamp is the append-time record — no frontmatter update needed.
- **Re-dispatch narrowly.** Spawn a single targeted `codebase-analyzer` on the area in question (1 agent max).
- **Retired IDs stay retired.** Findings dropped at Step 6 (Falsified) do not re-enter follow-ups; new findings introduce new IDs with the same lens-prefix scheme (next ordinal).
- **Retire a PERSISTED finding a follow-up re-verification falsifies (retire-not-delete).** When a follow-up re-verification invalidates a finding already written to `review.json` (distinct from the Step-6 gate above, whose candidates were never persisted), apply it via the store — never a hand-Edit:
  ```bash
  echo '{"id":"<ID>","verify":"Falsified","verifyNote":"<why it no longer holds>"}' | node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/store.mjs" update --artifact <review.md> --root .
  ```
  `status` flips to `withdrawn` (the record is RETAINED, append-only; `renderReview` omits it from the body but the `verification` count still reflects it), then re-run `store render --review`. This is the "DR falsification" trigger the AR verify-verdict wiring refers to.
- **When to re-invoke instead.** If the diff itself changed (new commits, scope shift, different branch), re-run `/rpiv:deep-review` for a fresh review. The previous block's `Next step:` stays valid for the existing review.

## Important Notes

- **Read-only review**: deep-review stays read-only — it never edits code; findings become fix commits on the branch through `/rpiv:implement <review-path>`, one fix round at most before the developer decides (Step 8). Fix rounds are counted from the fix commits on the branch, whose messages name the review artifact and its fix round.
- **Frontmatter**: `allowed-tools` is intentionally omitted — the skill inherits `Agent`, `ask_user_question`, `advisor`, `Write`, `web_search`, `todo`. Do NOT re-add the line.
- **Security-lens precision stance**: prefer false negatives. Evidence must carry `confidence ≥ 8`; 🔴 requires an explicit source→sink trace. Missing hardening without a traced sink is NOT a finding.
- **Load-bearing invariants** (each is enforced in the cited step; this is the do-not-break checklist):
  - Wave-1 fans out at T=0; integration-scanner (not in the fast lane) + peer-mirror gate Wave-2; Precedents is a **hard gate on Step 5** (drives severity weighting; not dispatched in the fast lane); Dependencies + CVE soft-gate Step 5 (Steps 2, 5).
  - Wave-3: 4a + 4b dispatch in parallel after Wave-2 (not in the fast lane), 4c is inline arithmetic; wait for 4a/4b + Precedents before Step 5. 4b evaluates the `stranded-state` / `false-promise` / `co-tenant-filter-gap` kinds whenever Quality returns ≥2 mismatched predicate rows (Step 4). Q/S finding IDs are assigned at Wave-2 completion, before Wave-3 (Step 3).
  - Manifest shards cover every reviewable file exactly once. Their patches use `-U30` (never `-U0`; `-U10` fallback >1MB); findings organise per file, not per hunk (Step 1, lenses).
  - **Wave-2 isolation**: lens prompts carry Discovery Map + one shard patch path ONLY — no Wave-1 raw output. Violation → narrativisation (~5× speedup, hallucinated/mis-cited findings) (Step 3).
  - Step 6 verification runs between reconcile and write — never skip it; it also validates `resolved-by` via `git merge-base --is-ancestor` (Step 6).
  - Advisor: emit `## Pre-Adjudication Findings` to the main branch before `advisor()` (reads `getBranch()`, main-thread-only, `advisor.ts:336`); probe availability first (`advisor.ts:463-472`); NEVER call from a sub-agent or parse its prose (paste verbatim).
  - PRESERVE severity emoji + frontmatter keys verbatim — `artifacts-locator`/`artifacts-analyzer` grep these. Scope is orchestrator-owned; agent contracts (`claim-verifier.md:11-30`) stay scope-blind.
  - **References are load-bearing**: read each `references/*.md` at the step its pointer names (see Conventions); the placeholders `{{QUALITY_SURFACES}}` / `{{SECURITY_SINKS}}` must NEVER reach a dispatched prompt — substitute the reference file's contents verbatim (leading `<!-- -->` comment stripped), never a paraphrase (Steps 2, 3, 5).
- **Row-only specialists** at narrativisation-prone sites: `diff-analyst` (Wave-2 Q+S + Step 4a predicate-trace — judgment tier, row output), `diff-auditor` (Wave-1 sink sweep — mechanical recall tier), `peer-comparator` (Wave-1 PM), `interaction-sweeper` (Step 4b — IX-block output), `claim-verifier` (Step 6). See `.rpiv/guidance/agents/architecture.md`.
- **Agent roles**:
  - `integration-scanner` (Wave-1) — not in the fast lane; inbound/outbound refs, auth-boundary crossings.
  - `precedent-locator` (Wave-1; not in the fast lane) — git history + `.rpiv/artifacts/`.
  - `codebase-analyzer` ×1 (Wave-1, `ManifestChanged`) — dependencies parse.
  - `web-search-researcher` (Wave-1, `ManifestChanged`) — CVE/advisory lookups with LINKS.
  - `peer-comparator` ×1 (Wave-1, gated on `len(PeerPairs) > 0`) — peer-mirror check; tags Mirrored/Missing/Diverged/Intentionally-absent.
  - `diff-analyst` ×1 (Wave-1, gated on a resolved linked issue) — spec conformance vs the external issue (unranked section, never findings).
  - `diff-auditor` × eligible shard (Wave-1, gated on opengrep absent) — mechanical sink-candidate sweep; rows digest into the Discovery Map.
  - `diff-analyst` × review shards (Wave-2) — one Quality per shard plus Security for security-relevant shard categories (every shard in the rigorous lane; none in the fast lane).
  - `diff-analyst` ×1 (Step 4a, gated) — predicate-trace (review-scope table).
  - `interaction-sweeper` ×1 (Step 4b, gated) — interaction sweep (`IX-<n>` blocks adopted as `I<n>` findings).
  - *(Step 4c, gated)* — gap-finder runs inline in the orchestrator (set arithmetic over coverage map; no agent).
  - `claim-verifier` ×1 (Step 6, always) — verification pass (grounds every reconciled finding at its cited `file:line`; tags Verified / Weakened / Falsified; Falsified dropped, Weakened demoted one tier).
