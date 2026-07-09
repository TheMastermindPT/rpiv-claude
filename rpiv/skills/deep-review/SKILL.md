---
name: deep-review
description: "Conduct comprehensive code reviews of pending changes, a branch, or a PR using parallel specialist agents that audit the diff, compare against peer code, and verify every claim before reporting it. Use whenever the user asks to 'review this', wants pending changes, a PR, a branch, or a diff reviewed, or asks for a code review — even a quick one. Produces review documents in .rpiv/artifacts/reviews/."
argument-hint: "[scope]"
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

`$ARGUMENTS` — scope: `commit` | `staged` | `working` | a commit hash | `A..B` range | PR branch name. Empty defaults to feature-branch-vs-default-branch (first-parent).

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/now.mjs"
echo
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/git-context.mjs"
```

Scope resolution (default branch, range, ChangedFiles) is LLM-invoked at Step 1.1 via the bundled `_helpers/review-range.mjs` — it depends on `$ARGUMENTS` and on conversational clarification, which render-time substitution cannot capture.

## Flow

1. Input → 2. Wave-1 dispatch → 3. Wave-2 dispatch → 4. Wave-3 dispatch → 5. Reconcile → 6. Verify → 7. Write artifact → 8. Present → 9. Follow-ups

**File-orientation contract**: agents reason about *files* as coherent units. Hunks are evidence *within* a file's analysis, never the unit of analysis. The `-U30` patch (Step 1) inlines function-level context so agents rarely need extra `Read` calls.

Every Wave-2 agent prompt contains EXACTLY `Known Context:` + the Discovery Map verbatim, and the resolved `<patch_path>` — nothing else from Wave-1 (see "Wave-2 context isolation" in Step 3 for why). Wave-1 agents that don't consume the Discovery Map (precedents, dependencies, CVE) get `ChangedFiles` / manifest-diff only.

## Conventions

- **Citation contract** (every Wave-2+ agent, every step): every `file:line` citation MUST carry the literal line text in backticks — `file:line — \`<verbatim line>\` — <note>`. Omit any finding whose line you cannot quote verbatim.
- **Severity**: 🔴 fix before merge · 🟡 fix soon · 🔵 nice-to-have · 💭 discuss.
- **References** (progressive disclosure — read each file at the step its pointer names, never earlier; resolve paths against this skill's directory, i.e. `${CLAUDE_PLUGIN_ROOT}/skills/deep-review/`): `references/discovery-map.md` (Step 2, at map synthesis) · `references/quality-surfaces.md` + `references/security-sinks.md` (Step 3, at Wave-2 dispatch — inlined verbatim into the lens prompts) · `references/gated-prompts.md` (Waves 1–3, only when the owning gate fires) · `references/severity-model.md` (Step 5 start; also governs Step 6 tag application).

## Steps

### Step 1: Resolve Scope and Assemble the Diff

1. **Resolve scope via the bundled helper.** Determine the scope spec from the value the user supplied (visible in `## Input` above as the substituted argument). If empty, use the literal string `auto`; if ambiguous (prose, mixed list, unrecognised branch name), clarify via `ask_user_question` — options: (A) "review current branch vs default branch (first-parent)" → `auto`, (B) "review every tracked change vs HEAD (staged + unstaged)" → `modified`, (C) "review unstaged changes only" → `working`, (D) "restate scope" → free-text — then re-invoke. Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/_helpers/review-range.mjs" "<scope-spec>"
   ```

   The helper emits labeled key/value lines (`default_branch:`, `strategy:`, `oldest:`, `newest:`, `base:`, `tip:`, `range:`, `fp_flag:`, `patch_path:`) followed by a `---changed-files---` block. Read those as authoritative for the rest of Step 1. If `strategy: unrecognised` appears, the `note:` field explains why — clarify via `ask_user_question` and re-invoke with a valid spec.

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
   - `strategy: first-parent` (`auto` / PR branch / commit list) — use `<range>` AND `<fp_flag>` (which is `--first-parent`) in the subsequent git commands. `<base>` is the parent-of-first-feature-commit (helper computes via `merge-base`), so the range already includes OLDEST's own changes — do NOT add `^` anywhere.
   - `strategy: explicit-range` (single hash / `A..B`) — use `<range>` without `<fp_flag>` (it's empty for this strategy). `<base>` is OLDEST^ (so the range includes OLDEST itself, matching the original "user-inclusive endpoint" intent).
   - `strategy: working-tree` (`commit` / `staged` / `working`) — no `<range>`; use the working-tree commands listed in the next bullet.

   `--first-parent` is orthogonal to `--no-merges`: the former prunes second-parent subtrees from reachability, the latter drops merge commits themselves from the log. Both flags are independently controllable below.

3. **Assemble the UNION of changes** (not the net endpoint-diff — so reverted intermediate work stays visible). Save the patch to a tempfile once with generous context; do NOT re-run `git log --patch` to slice windows later. Substitute literal `<range>`, `<fp_flag>`, and `<patch_path>` values from the helper output (`<fp_flag>` is `--first-parent` or empty — omit the flag entirely when empty; `<patch_path>` is the worktree-safe diff tempfile — a literal `.git/…` path fails inside a worktree):
   - `ChangedFiles` — read from the helper's `---changed-files---` block. If a `(... N more files truncated ...)` footer appears, the change set exceeded the helper's 2000-line/40 KB cap; scope the review tighter or run the patch-tempfile command below to recover the full surface from disk.
   - `git log "<range>" <fp_flag> --stat --reverse` → per-commit size summary
   - `git log "<range>" <fp_flag> --patch --reverse --no-merges -U30 > <patch_path>` → union patches with **30 lines of surrounding context per hunk** (function-level context inline)
   - `git log "<range>" --reverse --format="%H %s%n%n%b%n---"` → commit-message context
   - **Working-tree branch** (`strategy: working-tree`, no `<range>`): for `staged` use `git diff --cached --stat` + `git diff --cached -U30 > <patch_path>`; for `working` use `git diff --stat` + `git diff -U30 > <patch_path>` (unstaged only); for `modified` use `git diff HEAD --stat` + `git diff HEAD -U30 > <patch_path>` (every tracked change vs HEAD — staged + unstaged, no untracked); for `commit` use `git show HEAD --stat` + `git show HEAD -U30 > <patch_path>`. Commit-message context is N/A for `staged` / `working` / `modified`; for `commit` use `git show HEAD --format="%H %s%n%n%b%n---" --no-patch`. ChangedFiles still comes from the helper.
   - **Patch-size fallback**: `-U30` produces ~2–3× the size of `-U0`. If the resulting patch exceeds ~1MB, drop to `-U10` for this run; never use `-U0` — it defeats the skill's design.

4. **Bail-out**: if `ChangedFiles` is empty, print `No changes in scope {scope}. Exiting.` and STOP. Do not write an artifact.

5. **Derive scope + flags** (orchestrator-side, used in later steps):
   - `InScopeFiles` — used by the Step 6 pre-filter. `ChangedFiles` reflects *tree-reachability* (inflated on branches that back-merged the default branch — each post-merge first-parent commit inherits the merge's tree, so `--name-only` includes every file the merge resolved); `InScopeFiles` reflects *commits' own diffs* and is what the developer actually authored. Derivation:
     - strategy=`first-parent` (`auto` / PR branch / commit-list inputs) → `InScopeFiles = ⋃ git diff-tree --no-commit-id --name-only -r <h>` over `git log "<range>" --first-parent --no-merges --pretty=%H` (each feature commit's own file delta; back-merge sidecars drop out even when the merge is on the first-parent line). For commit-list input, iterate over the user-named hashes instead of the first-parent walk to preserve non-contiguous-list intent.
     - strategy=`explicit-range` → `InScopeFiles = ChangedFiles` (user explicitly asked for range semantics; merges in the range are part of the intent).
     - strategy=`working-tree` → `InScopeFiles = ChangedFiles` (no merge surface).
   - **Invariant**: `InScopeFiles ⊆ ChangedFiles`. On back-merged feature branches, `InScopeFiles ⊊ ChangedFiles` is the primary mechanism by which sidecar findings get dropped at Step 6.
   - `ManifestChanged` = ChangedFiles intersects any dependency manifest or lockfile (e.g. `package.json`/lockfile, `Cargo.toml`/`Cargo.lock`, `go.mod`/`go.sum`, `pyproject.toml`/`requirements*.txt`/`poetry.lock`, `Gemfile*`, `*.csproj`, `pom.xml`/`build.gradle*`, `composer.json`, …) OR a peer/optional/dev-dependency field was touched.
   - `LockstepSelfReview` = repository root contains `scripts/sync-versions.js` AND every `packages/*/package.json` shares the same `version:` AND the diff touches `packages/*/package.json`.
   - `HasGatingPredicate` = diff adds or modifies a **status/enum-comparison predicate** (`Status == X`, `Status is X or Y`, `X.Contains(Status)`, pattern-match on a discriminator) OR introduces a new value into an enum referenced by existing gating predicates. NOT merely the presence of `if (!x) return`.
   - `ReviewType` = one of `commit | pr | staged | working`.
   - `PeerPairs` = `(new_file, peer_file)` tuples. `new_file` is in `git log "<range>" --diff-filter=A --name-only` (working-tree: `git diff --diff-filter=A --name-only [--cached]`). `peer_file` exists at HEAD (`git ls-tree HEAD`) and matches one heuristic:
     - **Stem similarity ≥ 60%** of the longer stem (e.g. `PhysicalProductSubscription` ↔ `Subscription`).
     - **Interface/impl pair**: `I<Name>` ↔ `<Name>`, `<Name>` ↔ `<Name>.impl`, `<Name>{Abstract,Base,Protocol}` ↔ `<Name>`.
     - **Shared suffix** from `{Handler, Service, Repository, Aggregate, Reducer, Controller, Resolver, Command, Query, Job, Processor, Strategy, Policy, Event, Listener, Subscriber, Publisher, Exception, Eligibility, Ability, QueryParam, Specification, Factory, Builder}`.

     Drop a pair only when the peer doesn't exist at HEAD, no heuristic matches, or both files were added in this diff. Empty list ⇒ skip the peer-mirror agent. Co-modified peers are KEPT — the agent Reads them at HEAD (post-diff tree state), so any invariant present at HEAD counts as peer evidence regardless of whether the peer was edited in this diff.

### Step 2: Dispatch Wave-1 — Integration + Precedents + Deps/CVE + Peer-Mirror

**Pre-Wave-1 deterministic gate** (runs BEFORE any agent dispatch). If ChangedFiles is non-empty, run these tools on the changed files FIRST; their output is authoritative ground truth — lens agents MUST NOT re-report what they found.

**Gate protocol (applies to every gate below).** Each command ends with `2>/dev/null || echo '{"error":"TOOL_FAILED"}'` — never a bare `2>&1`. If a gate's output starts with `{"error":"TOOL_FAILED"}`, the tool is absent/crashed: record `<gate>: unavailable — lens fallback active` in the Discovery Map and DROP that gate's downstream `MUST NOT re-report` / `Do NOT re-grep` prohibition so the lens resumes full coverage. This is load-bearing — a silently-failed gate plus a live prohibition makes violations invisible to both gate and lens. Each gate below states only its command and what a SUCCESSFUL result means.

**Architecture boundary gate (depcruiser).** When the repo has `.dependency-cruiser.js`:
```bash
npx depcruise src --output-type json 2>/dev/null || echo '{"error":"TOOL_FAILED"}'
```
Filter violations to those whose `from`/`to` path intersects ChangedFiles. A `severity: error` violation on a changed file is a 🔴 Pre-Wave-1 finding (review blocks); `severity: warn` → 🟡. Fold into the Discovery Map as `Architecture gate: {N} violations (E errors, W warnings)` with `file:line`. The Quality lens MUST NOT re-report these — it focuses on what the rules DON'T cover.

**Dead code audit (knip).** Run:
```bash
npx knip --reporter json 2>/dev/null || echo '{"error":"TOOL_FAILED"}'
```
Run TWO cross-references:
  - **Dead code touched by this diff**: any ChangedFile that knip reports as unused is a 🔴 finding (modifying dead code is itself a review concern). Any ChangedFile that knip reports as having unused exports → fold under `Knip audit: {N} dead exports, {M} dead files touched by this diff`. These inform severity weighting in Step 5 — a diff that modifies an already-orphaned file gets bumped one tier.
  - **Dangling import chain:** run `npx knip --dependencies 2>/dev/null` and cross-reference against ChangedFiles. Any file OUTSIDE ChangedFiles that imports a symbol REMOVED by this diff has a broken import chain the Quality lens can't see from the diff alone. Fold under `Knip audit: {K} dangling imports` — each is a 🟡 finding. This catches the "changed the export in file A, forgot to update the import in file B" class of errors at gate time instead of compile time. The Quality lens MUST NOT re-report knip findings.

**SQL migration gate (SQLFluff).** When ChangedFiles includes `supabase/migrations/`:
```bash
sqlfluff lint supabase/migrations/ --format json 2>/dev/null || echo '{"error":"TOOL_FAILED"}'
```
Filter to the changed migration files; fold under `SQLFluff gate: {N} lint violations`. `CP01`/`RF02`/`ST06` violations are 🟡 (anti-patterns are pre-existing bugs in waiting). The Quality lens MUST NOT re-report these — it focuses on semantic correctness the linter can't see.

**Security sink detection (ast-grep).** Run on ChangedFiles for precise structural sink matching:
```bash
sg scan --inline-rules '
id: security-sinks
language: typescript
severity: error
rule:
  any:
    - pattern: dangerouslySetInnerHTML
    - pattern: eval($$$)
    - pattern: Function($$$)
    - pattern: $_.innerHTML = $$$
    - pattern: document.write($$$)
' --json=stream 2>/dev/null || echo '{"error":"TOOL_FAILED"}'
```
Matches become 🟡 Pre-Wave-1 findings (promoted to 🔴 if reached from an auth-boundary file per the Discovery Map). These REPLACE the Security lens's own `grep`-based sink detection — ast-grep is structurally precise, zero false positives vs grep matching comments and strings. The Security lens keeps the judgment-level concerns ast-grep can't automate: traced source→sink reachability, path traversal, SSRF, secrets-in-diff, missing trust-boundary checks.

**Architectural smell detection (ast-grep).** Run on ChangedFiles for structural smell patterns that regex grep would miss (comments, string literals, false positives):
```bash
sg scan --inline-rules '
id: arch-smells
language: typescript
severity: warning
rule:
  any:
    - pattern: "try { $$$ } finally {  }"
    - pattern: "catch ($_) { /* empty */ }"
    - pattern: "catch ($_) { }"
    - pattern: "console.log($$$)"
    - pattern: "console.error($$$)"
    - pattern: "debugger"
' --json=stream 2>/dev/null || echo '{"error":"TOOL_FAILED"}'
```
Matches become the `Architectural smells: {N} matches` Discovery Map row. `console.log`/`debugger` in production code → 🟡 (observability leak); empty catch blocks → 🟡 (swallowed errors). Lenses START from these pre-tagged sites rather than grepping. For non-TypeScript files, add `--lang <l>` blocks per language present. (Smells are advisory, so on TOOL_FAILED this gate just degrades silently.)

---

Spawn ALL of the following in parallel at T=0 in a **single message with multiple Agent tool calls**. Do NOT wait for integration-scanner before dispatching precedents / dependencies / CVE — they do not consume Discovery-Map output, only `ChangedFiles` and the manifest diff (both orchestrator-produced in Step 1).

**Agent — Integration map:**
- subagent_type: `integration-scanner`
- Prompt: "Map inbound references, outbound dependencies, and infrastructure wiring for the following changed files: {ChangedFiles, one per line}. Flag any auth-boundary crossings (middleware, guards, interceptors, authorize-style decorators) and config/DI/event registration touching these paths. Do NOT analyse code quality — connections only, in your standard output format."

**Agent — Precedents** (always): use the `precedent-locator` prompt defined in Step 3 below — dispatch it here, not in Wave-2. Input it needs: `ChangedFiles` only.

**Agent — Dependencies** (only when `ManifestChanged`): use the `codebase-analyzer` Dependencies prompt defined in Step 3 below — dispatch here. Input it needs: touched manifest paths + `LockstepSelfReview` flag.

**Agent — CVE / advisory** (only when `ManifestChanged`): use the `web-search-researcher` prompt defined in Step 3 below — dispatch here. Input it needs: parsed `name@version` list from the manifest diff (orchestrator extracts and hands over directly).

**Agent — Peer-Mirror** (only when `len(PeerPairs) > 0`): `subagent_type: peer-comparator`. Input: the `PeerPairs` list verbatim, nothing else — no Discovery Map (it isn't built yet and the agent doesn't need it), no patch path (the work is peer-vs-new entity comparison, not diff analysis). Prompt: Read §Peer-Mirror in `references/gated-prompts.md` and use its fenced block byte-for-byte, substituting only the `{list of (new_file, peer_file) tuples}` placeholder.

**Agent — Sink-candidate sweep** (only when opengrep is unavailable — probe `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/tool-probe.mjs" "."` if not already run; when opengrep runs, SKIP — opengrep owns grep-tier recall): `subagent_type: diff-auditor`. Input: the resolved `<patch_path>` only — no Discovery Map (its candidates feed INTO the map). Prompt: Read §Sink-candidate sweep in `references/gated-prompts.md` and use its fenced block byte-for-byte, substituting `<patch_path>`. Digest returned rows into the Discovery Map's `Grep sink candidates` row — CANDIDATES the Security lens must trace, never findings.

While these agents run, the orchestrator produces the rest of the Discovery Map inline from Step 1's data:
- `ChangedFiles`, `ManifestChanged`, `LockstepSelfReview`, `ReviewType`
- **Semantic file map** (per file: `path (+A -B)` + role tag + top-level symbol names touched; see format and rules below)
- Commit-message context (if applicable)

**Wait for `integration-scanner` AND the peer-mirror agent AND the sink-candidate sweep (when dispatched)** before dispatching Wave-2. Wave-2 agents consume both via the Discovery Map (auth-boundary crossings, inbound refs, peer-mirror Missing/Diverged rows). Precedents / Dependencies / CVE continue running in the background; **Precedents MUST be awaited before Step 5 begins** (Reconciliation reads its follow-up-within-30-days counts to weight severity; see Step 5). Dependencies / CVE also merge in at Step 5 but may arrive later in the wait barrier.

**Pre-index the dependency neighborhood (ctx_index)** — runs AFTER integration-scanner returns, BEFORE Wave-2 dispatch. The Quality lens's Surface 3 (blast radius) and Surface 8 (cross-layer drift) depend on reading files outside ChangedFiles — inbound consumers, peer aggregates, upstream guards. Pre-index the outbound dependency files of ChangedFiles so lens agents query `ctx_search` instead of issuing Read calls:
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

Read `references/discovery-map.md` NOW — it holds the exact map template, the clustering / role-tag / symbols-touched-hint rules, and the tool-gated structural-enrichment digest rules (opengrep sinks, ast-grep dispatch shapes, rg risk keywords, CodeScene Code Health, SonarQube issues, dependency-cruiser boundary violations). Build the map exactly per that file before dispatching Wave-2.

### Step 3: Dispatch Wave-2 — Quality + Security Lenses

Spawn Quality + Security in parallel using the Agent tool. Each receives the Discovery Map block inline as `Known Context` above its task, and a pointer to `<patch_path>` for the diff itself. Precedents / Dependencies / CVE are already running from Wave-1 — do NOT re-dispatch them here; the prompts below document what those Wave-1 agents received, they are not re-issued.

**Wave-2 context isolation (LOAD-BEARING — violations cause silent quality collapse)**: Each Wave-2 agent receives EXACTLY two things, nothing else: (1) the Discovery Map (digested form) and (2) the resolved `<patch_path>` value.

**DO NOT paste into Wave-2 prompts**, under any circumstance, even if the orchestrator has already received them:
- raw integration-scanner output (the Discovery Map already summarises its auth/ref/wiring findings)
- precedent-locator output
- Dependencies lens output
- CVE lens output
- any prior Wave-2 or Wave-3 output from earlier runs in the same Pi session

**Why this is load-bearing**: summary context induces *narrativisation* — the agent treats the preamble as "the orchestrator already framed the findings, I just classify them" instead of independently reading the patch file. Observed failure signatures when this is violated: Quality drops from ~40 tool calls / 3M tokens / 500s to ~5-15 tool calls / 300k tokens / 100-200s, and returns hallucinated findings (invented statuses, mis-cited line numbers, claims that files are "missing from patch" when they are in fact present).

**Self-check before dispatching Wave-2**: read your outgoing Agent prompt. If it contains any content from Wave-1 agent RESULTS beyond the Discovery Map you synthesised, strip it. The Discovery Map is the contract; raw outputs are reconciliation-only.

**Quality lens** (`diff-analyst`) — **file-oriented**. Before dispatching: Read `references/quality-surfaces.md`, strip its leading `<!-- -->` comment, and substitute the remainder for the `{{QUALITY_SURFACES}}` line below — the dispatched prompt must carry the full 13-surface block verbatim, never the placeholder:
  ```
  Analyse changes file by file. For each file in ChangedFiles, read its diff region in `<patch_path>` (patch has `-U30` — full function context is already inline; rarely need an extra Read call), form a mental model of what the file does and what the diff changes about it, then apply the 13 surfaces below to the file as a whole. Cite `file:line` with verbatim line text (citation contract) for every finding. Omit findings not traceable to a diff-touched change. No severity.

  **File order strategy**: prioritise by role tag — `[boundary]` files first (security-sensitive), then `[persistence]` (durable-state surfaces), then `[hub]` (blast-radius amplifiers), then `[code]`, then `[config]`, then `[test]` last. Within the same tag, prioritise files with the largest diffs.

  **Per file**, write a short section (`### file/path.ext`) containing only the surfaces that APPLY to that file's changes. Use sub-headings for grouped evidence. A surface may be flagged across multiple files — report the evidence where it lives, and rely on cross-layer surfaces (8, 9) to tie them together.

  {{QUALITY_SURFACES}}

  **Economising Reads**: issue a `Read` only when (a) you need a file NOT in ChangedFiles (hub, peer, test), or (b) the changed function is longer than the `-U30` window can show. Never re-Read a file just to re-orient — that's what the symbols-touched hint is for. **When the orchestrator has pre-indexed dependency files (known via `ctx_search` availability), prefer `ctx_search(source: "deep-review-deps", queries: [...])` over `Read` for cross-file traces — it is cheaper on token budget.**
  ```

**Security lens** (`diff-analyst`) — **file-oriented**. Before dispatching: Read `references/security-sinks.md`, strip its leading `<!-- -->` comment, and substitute the remainder for the `{{SECURITY_SINKS}}` line below — the dispatched prompt must carry the full sink-class catalog + do-NOT-report list verbatim, never the placeholder:
  ```
  Analyse each changed file as a whole, looking for sinks in the classes below. **Prefer ast-grep over grep for sink detection:** the Pre-Wave-1 gate already ran `sg scan` for structural sinks — its findings are AUTHORITATIVE for `dangerouslySetInnerHTML`, `eval()`, `Function()`, `.innerHTML =`, and `document.write()` (zero false positives). Do NOT re-grep these patterns; start from the ast-grep matches and ADD your traced source→sink reachability analysis. For sink classes ast-grep didn't cover (command execution, path traversal, SSRF), start from the `Grep sink candidates` Discovery-Map row when present (the Wave-1 sweep's hits are CANDIDATES to trace, same contract as the Opengrep row); when that row is absent, fall back to grep on `<patch_path>` (patch has `-U30` — sink context is inline). For each hit provide the verbatim line (citation contract) plus 2 surrounding lines and `confidence: N/10` that user-controlled input can reach the sink under current deployment. Drop hits with confidence < 8. Cross-reference Discovery Map auth-boundary crossings and inbound refs — a sink in a file reached from an auth-boundary file is in scope even if the sink file itself doesn't cross the boundary. Also cross-reference the `Static-analysis sinks` Discovery-Map row (Opengrep candidates): each is a CANDIDATE to TRACE, not a finding — promote to a verified Security finding only with a concrete user-reachable source→sink trace (the `confidence: N/10 < 8` drop and the untraced-rejection at the severity-reconciliation step still gate). Opengrep supplies recall (breadth across the sink classes); you supply the trace + reachability. This stays complementary — never emit an Opengrep candidate that your trace did not confirm.

  **Sink detection hierarchy:** ast-grep (structural precision, no FPs) ▶ Opengrep (recall) ▶ grep (fallback). For every sink class, use the best available tool. ast-grep coverable sinks (`dangerouslySetInnerHTML`, `eval`, `Function()`, `innerHTML`, `document.write`) are already in the Discovery Map from Pre-Wave-1 — start there and add reachability.

  **File order strategy**: `[boundary]` files first (direct source→sink exposure); then `[persistence]` (query injection, unsafe deserialization); then `[code]` (command exec, SSRF, explicit-trust rendering); then `[hub]` / `[config]`; skip `[test]` unless a test helper touches a sink.

  IN-SCOPE RULE: only report findings whose sink line is inside a changed file's diff region (add/modify/adjacent-context rewrite). Pre-existing sinks in files the diff did not change are out of scope, UNLESS the diff changes how data flows TO the sink (e.g. new user-controlled source routed to an untouched sink) — then cite both locations. When in doubt, trace data flow from Discovery Map boundary crossings through the changed files.

  {{SECURITY_SINKS}}

  Name the sink class and the matched idiom. Evidence only. No CVE lookups.
  ```

**Dependencies lens** (`codebase-analyzer`, only when `ManifestChanged`; otherwise SKIP and omit `### Dependencies` in artifact): when the gate fires, Read §Dependencies in `references/gated-prompts.md` — it selects between the Knip-primary prompt (Knip ran at the Pre-Wave-1 gate) and the full fallback prompt; use the applicable fenced block byte-for-byte.

**Precedents lens** (`precedent-locator`):
  ```
  Code review of {scope}. Changed files: {ChangedFiles}.
  Find similar past changes touching these files or nearby. Per precedent: commit hash, blast radius, follow-up fixes within 30 days, one-sentence takeaway. Distil composite lessons.
  ```

**CVE/advisory lens** (`web-search-researcher`, only when `ManifestChanged`): when the gate fires, Read §CVE/advisory in `references/gated-prompts.md` and use its fenced block byte-for-byte, substituting the `{name@version per line}` placeholder (orchestrator-extracted).

**Wait for Quality + Security to complete** before proceeding. Precedents / Dependencies / CVE from Wave-1 may still be running; gather them before Step 5, not before Step 4.

### Step 4: Dispatch Wave-3 — Predicate-Trace + Interaction Sweep + Gap-Finder

Once Wave-2 (Quality + Security) completes, dispatch 4a and 4b as parallel agents **in a single message**; compute 4c inline (orchestrator-side set arithmetic — no agent). They do NOT consume each other's output:

- **Interaction Sweep (4b)** receives Quality's `Predicate-set coherence` table directly as its predicate-row source. Quality's table already flags mismatches — Predicate-Trace (4a) only *elaborates* them through consumers. Interaction Sweep's categories 1–6 don't need 4a at all; categories 7–9 (stranded-state, false-promise, co-tenant filter gap) operate on the same rows 4a would trace.
- **Gap-Finder (4c)** is coverage arithmetic: `{in-scope files} − {files with ≥1 Quality/Security finding} = {uncovered files}`. Orchestrator already holds both sets post-Wave-2 — an agent would discard context only to re-receive it via prompt. Inline is strictly cheaper and deterministic.
- If Predicate-Trace (4a) surfaces a row that was not visible in Quality's table, append it via a Step 9 follow-up — cheaper than a serial gate.

#### Step 4a: Predicate-Trace

**Gate**: SKIP this sub-step (do not dispatch 4a) unless `HasGatingPredicate` is true AND the Quality lens returned ≥2 rows in its `Predicate-set coherence` table referencing the same enum/type. If skipped, 4b and 4c still dispatch.

Otherwise spawn ONE `codebase-analyzer` in parallel with 4b — Read §Predicate-Trace in `references/gated-prompts.md` and use its fenced block byte-for-byte as the prompt, substituting the coherence-rows and gating-predicates placeholders.

Do NOT wait — 4b (Interaction Sweep) dispatches in the same message as 4a; 4c runs inline in the orchestrator.

#### Step 4b: Interaction Sweep

**Gate**: SKIP this sub-step (do not dispatch 4b) when EITHER `len(ChangedFiles) < 2` OR the Quality lens returned fewer than 4 total observations across all files. Emergent interactions need surface area; tiny diffs cannot structurally produce them.

Otherwise spawn ONE `codebase-analyzer` in parallel with 4a:
  ```
  Quality Evidence: {verbatim}
  Security Evidence: {verbatim}
  Predicate-set coherence rows (verbatim from Quality's table — full Step 4a output is NOT required and is NOT awaited): {verbatim | "not applicable"}
  Precedents: {verbatim if Wave-1 finished; else "deferred to Step 5"}

  Group evidence by shared entity, state machine, workflow, data flow path, API boundary, background process, or producer-consumer contract.

  Per group, check for emergent defects:
  1. contradictory assumptions between components/layers,
  2. unreachable, stuck, or non-terminal states,
  3. retry/reprocess mechanisms made inert by another behavior,
  4. duplicate-processing / idempotency gaps from ordering or missing guards,
  5. guards in one layer invalidating transitions in another,
  6. one finding masking, amplifying, or permanently triggering another,
  7. stranded state — state X reachable via one conditional but every conditional operating on this entity elsewhere excludes X,
  8. false-promise predicate — matching branch's consumer excludes this entity's source/type/state,
  9. co-tenant filter gap — shared discriminator filter where a new or terminal value the diff touches falls through every consumer's filter.

  Return only findings with ≥2 concrete `file:line` facts from different files/components, each quoted verbatim per the citation contract. No recommendations. No single-location repeats.

  For findings involving ordering/races/concurrency across processes or handlers, name the ordering primitive that would prevent the race (distributed lock, exclusive-key wrapper, ordered partition, transaction, idempotency key, etc.) and explain why it does NOT apply here. Drop the finding if the primitive exists in the diff or nearby and your argument against it is speculative.
  ```

#### Step 4c: Gap-Finder (orchestrator-side coverage arithmetic)

**Gate**: SKIP when `len(ChangedFiles) < 2`. Tiny diffs cannot structurally have coverage gaps.

No agent dispatch. Compute inline while 4a / 4b run:

1. **Coverage map** — parse Quality + Security outputs; for each finding row extract its `file:line` citation and map `file → {finding-id}`. Files with ≥1 row are covered; files with none are uncovered.
2. **In-scope filter** — keep files tagged `[boundary]`, `[persistence]`, `[code]`, or `[hub]` AND whose diff delta (sum of added + removed lines) is ≥ 5. Drop `[test]` and `[config]` entirely; drop files with tiny deltas.
3. **Emit gap findings** — walk uncovered in-scope files in role-tag priority `[boundary]` → `[persistence]` → `[hub]` → `[code]`. For each, open its diff region in `<patch_path>` and pick ONE risk-bearing line (first non-comment `+` line, or the function-declaration header if a whole function was added). Emit:

   `G<ordinal> — file:line — \`<verbatim line>\` — {role-tag} — <risk class in 3-6 words>`

   Risk-bearing behavior class (diff introduces one of): state mutation | I/O (DB/network/file) | error path | conditional on mutable state | concurrent/shared-state access | public API surface change. Maximum **5** gap findings; stop once reached. Citation contract applies.

**Wait for ALL of 4a / 4b AND the Precedents agent from Wave-1 to complete** before proceeding to Step 5 (Reconciliation). Precedents is a **hard gate** — severity weighting in Step 5 reads its follow-up-within-30-days counts. Dependencies / CVE (when dispatched) also merge in here but are not individually hard-gated; wait for them too unless they clearly exceed the review SLA, in which case omit `## Dependencies` and note it in the artifact. 4c has no wait — it completes synchronously with the orchestrator.

### Step 5: Reconcile Findings

**Barrier**: Step 5 MUST NOT begin until the Precedents agent has returned. Severity weighting depends on historical follow-up counts; starting reconciliation without them produces mis-weighted severities that the verification pass (Step 6) cannot correct.

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
   - Run a dimension-sweep modeled on `skills/design/SKILL.md:83-116`: Data model / API surface / Integration / Scope / Verification / Performance.
   - For every finding, ask: does another finding contradict this severity given the Discovery Map? If yes, note the tension.
   - Record every severity move as a title-line annotation on the affected finding (`[precedent-weighted]`, `[cascade: <kind>]`, `[subsumed-by <ID>]`). No standalone reconciliation section.

5. **Emit the reconciled severity map** — authoritative severity per finding, carrying the advisor's guidance when present. Keep the per-pass grouping (do NOT tag each finding with its originating lens in prose; the H2 it sits under is the tag).
   - Interaction findings carry `I<n>` IDs and appear under the severity H2 that matches their final tier (`## 🔴 Critical`, `## 🟡 Important`). The old `### Cross-Finding Interactions` sub-heading is retired — severity is the top-level grouping.
   - When an interaction finding subsumes a local finding at the root-cause level, keep the local finding only if its evidence is independently actionable; annotate the local finding's title line `[subsumed-by I<n>]`.
   - Distinct structural defects MUST remain distinct findings even when related. Specifically: a *stranded state* (entity reaches X, no exit path) and a *false-promise predicate* (TRUE branch promises unreachable behavior) are separate defects even when they arise in the same subsystem — do NOT collapse them. Collapse only when the narrative, fix, and evidence locations are identical.
   - **Cascade detection** (load-bearing — missed cascades are the biggest historical quality regression): apply §Cascade detection from `references/severity-model.md` verbatim — scan findings for its three defect triples and emit a 🔴 Cross-Finding bullet if any fires; it also mandates the prior-review cascade-reproduction check.

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

**Citation-path gate (deterministic, before the flip)**: run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/check-citations.mjs" <the artifact path> --root .`. It exits non-zero and lists every **ambiguous bare-basename** cite (`service.ts:329` in a repo with several `service.ts`) — the un-greppable form that breaks the verify/drift tooling. For each, grep the basename, pick the file the finding means, rewrite the cite repo-relative from the repository root, and re-run until it exits 0. Do not flip status while it fails.

**Gate**: after verification and the citation-path gate, set `blockers_count` = remaining 🔴 + 🟡 findings and `status: ready` in the artifact frontmatter. Emit no verdict — the review reports the count, nothing more.

**Do not skip this step** — it is the only mechanism that stops confident-but-unread lens assertions from reaching the artifact.

### Step 7: Write the Review Document

1. **Determine metadata** (from the Metadata block at the top of this skill):
   - Filename: `.rpiv/artifacts/reviews/<slug>_<scope-kebab>.md` — `<slug>` is the second tab-separated field on line 1 of the Metadata block above.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels (fallbacks `no-branch` / `no-commit` already substituted).
   - `date:` ← `<iso>` (first tab-separated field on line 1 of the Metadata block above, offset verbatim).
   - Reviewer: `author:` from the Metadata block (fallback: `unknown`).

2. **Write the artifact** using the Write tool (no Edit — this skill writes once per run).

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

**What is NOT emitted to the artifact**: verification outcomes in prose (frontmatter `verification` string is the only channel), advisor availability / dispatch path / tool failures (skill trace, not review content), `last_updated` / `last_updated_by` (git mtime + git author carry this for a write-once artifact).

**Advisor prose**, when advisor ran, is pasted verbatim as a blockquote at the top of `## Recommendation`, not as a standalone section.

**Template shape**: Read the full template at `templates/review.md` (house pattern per `.rpiv/guidance/skills/architecture.md:66` — `templates/` subfolder, runtime-read, never inlined). At emission time: Read `templates/review.md`, fill every `{placeholder}` with reconciled-and-verified values from Steps 5 and 6, apply the section-omission rules above (delete the whole section AND its trailing separator line when its input is empty), strip the leading `<!-- -->` comment, and Write the result to the target path.

### Step 8: Present Summary

```
Review written to:
`.rpiv/artifacts/reviews/{filename}.md`

Severity:     {C} critical · {I} important · {S} suggestions
Lenses:       {Q} quality · {Se} security · {D} dependencies
Verification: {V} verified · {W} weakened · {F} falsified (dropped)
Advisor:      {adjudicated | inline}
Blockers:     {B} unresolved (🔴 + 🟡) · status ready

Top items:
1. {ID} — `file:line` — {headline}
2. {ID} — `file:line` — {headline}
3. {ID} — `file:line` — {headline}

Ask follow-ups, or chain forward.

---

💬 Follow-up: describe the question in chat to append a timestamped Follow-up section. Retired IDs stay retired; re-run `/rpiv:deep-review` for a fresh review.

**Next step:** `/rpiv:design "Address findings from .rpiv/artifacts/reviews/{filename}.md"` — run the design phase over the review document to produce a fix plan.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

### Step 9: Handle Follow-ups

- **Append, never rewrite.** Edit the artifact to add a `## Follow-up {ISO 8601 timestamp}` section. The section heading's timestamp is the append-time record — no frontmatter update needed.
- **Re-dispatch narrowly.** Spawn a single targeted `codebase-analyzer` on the area in question (1 agent max).
- **Retired IDs stay retired.** Findings dropped at Step 6 (Falsified) do not re-enter follow-ups; new findings introduce new IDs with the same lens-prefix scheme (next ordinal).
- **When to re-invoke instead.** If the diff itself changed (new commits, scope shift, different branch), re-run `/rpiv:deep-review` for a fresh review. The previous block's `Next step:` stays valid for the existing review.

## Important Notes

- **Frontmatter**: `allowed-tools` is intentionally omitted — the skill inherits `Agent`, `ask_user_question`, `advisor`, `Write`, `web_search`, `todo`. Do NOT re-add the line.
- **Security-lens precision stance**: prefer false negatives. Evidence must carry `confidence ≥ 8`; 🔴 requires an explicit source→sink trace. Missing hardening without a traced sink is NOT a finding.
- **Load-bearing invariants** (each is enforced in the cited step; this is the do-not-break checklist):
  - Wave-1 fans out at T=0; integration-scanner + peer-mirror gate Wave-2; Precedents is a **hard gate on Step 5** (drives severity weighting); Dependencies + CVE soft-gate Step 5 (Steps 2, 5).
  - Wave-3: 4a + 4b dispatch in parallel after Wave-2, 4c is inline arithmetic; wait for 4a/4b + Precedents before Step 5. 4b evaluates categories 7–9 whenever Quality returns ≥2 mismatched predicate rows (Step 4).
  - Patches use `-U30` (never `-U0`; `-U10` fallback >1MB); findings organise per file, not per hunk (Step 1, lenses).
  - **Wave-2 isolation**: lens prompts carry Discovery Map + patch path ONLY — no Wave-1 raw output. Violation → narrativisation (~5× speedup, hallucinated/mis-cited findings) (Step 3).
  - Step 6 verification runs between reconcile and write — never skip it; it also validates `resolved-by` via `git merge-base --is-ancestor` (Step 6).
  - Advisor: emit `## Pre-Adjudication Findings` to the main branch before `advisor()` (reads `getBranch()`, main-thread-only, `advisor.ts:336`); probe availability first (`advisor.ts:463-472`); NEVER call from a sub-agent or parse its prose (paste verbatim).
  - PRESERVE severity emoji + frontmatter keys verbatim — `artifacts-locator`/`artifacts-analyzer` grep these. Scope is orchestrator-owned; agent contracts (`claim-verifier.md:11-30`) stay scope-blind.
  - **References are load-bearing**: read each `references/*.md` at the step its pointer names (see Conventions); the placeholders `{{QUALITY_SURFACES}}` / `{{SECURITY_SINKS}}` must NEVER reach a dispatched prompt — substitute the reference file's contents verbatim (leading `<!-- -->` comment stripped), never a paraphrase (Steps 2, 3, 5).
- **Row-only specialists** at narrativisation-prone sites: `diff-analyst` (Wave-2 Q+S — judgment tier, row output), `diff-auditor` (Wave-1 sink sweep — mechanical recall tier), `peer-comparator` (Wave-1 PM), `claim-verifier` (Step 6). See `.rpiv/guidance/agents/architecture.md`.
- **Agent roles**:
  - `integration-scanner` (Wave-1) — inbound/outbound refs, auth-boundary crossings.
  - `precedent-locator` (Wave-1) — git history + `.rpiv/artifacts/`.
  - `codebase-analyzer` ×1 (Wave-1, `ManifestChanged`) — dependencies parse.
  - `web-search-researcher` (Wave-1, `ManifestChanged`) — CVE/advisory lookups with LINKS.
  - `peer-comparator` ×1 (Wave-1, gated on `len(PeerPairs) > 0`) — peer-mirror check; tags Mirrored/Missing/Diverged/Intentionally-absent.
  - `diff-auditor` ×1 (Wave-1, gated on opengrep absent) — mechanical sink-candidate sweep; rows digest into the Discovery Map.
  - `diff-analyst` ×2 (Wave-2) — Quality, Security (judgment tier).
  - `codebase-analyzer` ×1 (Step 4a, gated) — predicate-trace.
  - `codebase-analyzer` ×1 (Step 4b, gated) — interaction sweep.
  - *(Step 4c, gated)* — gap-finder runs inline in the orchestrator (set arithmetic over coverage map; no agent).
  - `claim-verifier` ×1 (Step 6, always) — verification pass (grounds every reconciled finding at its cited `file:line`; tags Verified / Weakened / Falsified; Falsified dropped, Weakened demoted one tier).