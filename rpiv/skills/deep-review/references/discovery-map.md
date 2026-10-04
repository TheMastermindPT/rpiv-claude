<!-- Read by code-review SKILL.md at Step 2, immediately before synthesizing the Discovery Map. Content moved verbatim from SKILL.md — the map template, clustering / role-tag / symbols rules, and the tool-gated structural-enrichment digest rules. Apply as written, do not reword. -->

# Discovery Map — template & synthesis rules

```
#### Discovery Map

Review type: {ReviewType}
Scope: {scope argument}
Commit/range: {git ref}
Manifest changed: {yes|no}
Lockstep self-review: {yes|no}
Capabilities: {preflight summary — local tools + MCP configured/unavailable; `{tool}: skipped: declared unused ({file:line})` per opted-out tool; `instruction files: unreadable ({path})` when preflight reports instructionErrors}
Review shards: {N patches; id — category — file count — context — bytes}
Prior same-branch review: {path | none}

Changed files ({N}):

  ## {cluster — shared directory prefix}
    path/file.ext (+A -B) {role-tag} — top 1–3 symbols touched
    ...

Auth-boundary crossings: {integration-scanner, file:line}
Inbound refs (files with ≥3 consumers): {integration-scanner}
Outbound deps: {integration-scanner}
Wiring/config: {integration-scanner}
Peer mirrors: {peer-mirror agent output verbatim — Missing/Diverged rows only; Mirrored and Intentionally-absent rows are summarised as counts}
Project standards: {R<n> — rule, one line — `source-file:line` — hard|preference; per §Project standards below} | none declared | sources unreadable ({path})
**Deterministic gates (Pre-Wave-1, authoritative):**
Typecheck gate: {N errors citing ChangedFiles (🔴, file:line) + M outside-diff (🟡 count)} | unavailable — lens fallback active
Lint gate ({biome|eslint}): {N errors (M warnings) on changed files — file:line — rule} | unavailable — lens fallback active
Architecture gate (depcruiser): {depcruise violations intersecting ChangedFiles — E errors, W warnings, file:line}
Knip audit: {N dead exports, M dead files touched by this diff, K dangling imports — knip report}
Advisory gate (osv/npm-audit): {GHSA/CVE ids on ADDED/BUMPED-TO deps — severity} | only when ManifestChanged; unavailable — CVE lens keeps full discovery
Duplication gate (jscpd): {N clones touching the diff — file:line ↔ file:line pairs — CANDIDATES} | omitted when jscpd absent
Companion candidates (review-range): {file — driver=changed file — support/conf rows — CANDIDATES, never findings} | omitted when the helper block is empty
Architectural smells (ast-grep): {N smell matches — sg output} | omitted when no matches
SQLFluff gate (migration changes): {N lint violations on changed migrations — sqlfluff output} | omitted when no migration changes
Security sink detection (ast-grep): {N structural sink matches — sg output} | omitted when no matches
Static-analysis sinks (opengrep, when present): {check_id  severity  file:line — CANDIDATE sinks; orchestrator-run, digested — NOT findings}
Grep sink candidates (diff-auditor, when opengrep absent): {file:line — pattern-id — matched idiom — CANDIDATE sinks; Wave-1 mechanical sweep, digested — NOT findings}
Dispatch/registration shapes (ast-grep, when present): {file:line — fire*/emit*/publish*/dispatch*/raise*/notify* calls + switch/match/when registration tables; orchestrator-run, digested}
Risk keywords (rg): {file:line — keyword — TODO|FIXME|HACK|XXX|debugger|console.log|...} | omitted when no hits
Code Health (CodeScene, when present): {per-file scores — `file`: score (smell) — prioritisation context, NOT findings; scope-aware dispatch: analyze_change_set (branch) | pre_commit_code_health_safeguard (working-tree) | per-file review (fallback); regressions — `file — failed gate | degraded | score old→new` — FINDINGS per §CodeScene regressions; declared threshold: {value — `source-file:line`} | none declared}
Boundary/cycle violations (dependency-cruiser, when configured): {file — rule-name (forbidden boundary | circular) intersecting ChangedFiles; orchestrator-run, digested — NOT findings}
```

**Clustering**: group files by longest shared directory prefix yielding clusters of 2+ files; singletons form their own cluster labelled with the filename. Emerges from the repo — no framework assumptions.

**Role-tag** (one tag per file, first match wins):
1. `[boundary]` — in integration-scanner's auth-boundary output
2. `[persistence]` — path contains `migration`/`schema`/`repository`/`dao`/`model`, or matches an ORM/migration convention visible in the repo
3. `[test]` — path contains `/test`/`/spec`/`__tests__`, or filename ends in a test suffix (`.test.*`, `.spec.*`, `_test.*`, `Test.*`)
4. `[config]` — in integration-scanner's wiring/config output, or is a manifest/lockfile/settings file
5. `[hub]` — in integration-scanner's inbound-refs with ≥3 consumers
6. `[code]` — default

**Symbols-touched hint**: extract top 1–3 top-level definitions from the diff's `+` lines using a heuristic appropriate to the file's language (class/function/def/fn/struct/trait/interface/type/export). Cap at ~80 chars. Leave blank if ambiguous — orientation, not completeness.

**Structural enrichment of the Discovery Map (tool-gated, read-only).** Use the Step-2 preflight snapshot; do not probe tools again. When ast-grep / opengrep are available, run them over the on-disk `manifest.changedFiles`, not the generated patch files (a unified diff is not parseable by an AST/rule engine), and fold only digested results into the map:
- Opengrep -> `Static-analysis sinks`: `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/structural.mjs" --tool opengrep --config auto <target>` (network stock security rules; if opengrep absent OR offline/no-JSON, OMIT the row — the Wave-1 sink-candidate sweep (`diff-auditor`) supplies the grep-tier recall instead, filling the `Grep sink candidates` row).
- ast-grep -> `Dispatch/registration shapes`: `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/structural.mjs" --tool ast-grep --pattern '<dispatch/registration shape>' --lang <l> <target>`, intersected to ChangedFiles.
- rg -> `Risk keywords` (always — rg is installed everywhere via tool-probe): `rg -n "TODO|FIXME|HACK|XXX|debugger|console\.(log|error|warn)" <ChangedFiles>` — one sweep over the on-disk files. Digest to `file:line — keyword` rows in the Discovery Map. A `TODO`/`FIXME` on a changed line is a 🟡 by itself (author intended to come back). A `console.log`/`debugger` left in changed production code is a 🟡 (observability leak — already caught by the architectural-smell ast-grep gate; this is the regex fallback for files ast-grep skips). Omit only if rg is absent (tool-probe shows absent — rare).
- CodeScene -> `Code Health` (per-file + scope-aware): when the `codescene_code_health_*` tools are available (CodeScene MCP connected), run TWO passes:
  - **Per-file baseline.** For normal scopes, score each changed source file with delta ≥ 5. For `large_change_set: yes`, score boundary/persistence/hub files plus the 20 largest remaining source diffs; the change-set call below still covers the full branch. Digest to `file: score`. For scores below 9.0, run `codescene_code_health_review` to name the smell and function/line. The Quality lens uses scores for file priority; unscored files retain normal lens coverage.
  - **Scope-aware dispatch** for the delta/verdict row:
    - **Branch/PR review** (scope resolves a base ref): run `analyze_change_set` once (`base_ref` = review base, `git_repository_path` = repo root). Digest to `file — improved | degraded | stable` + any failed `quality_gates`.
    - **Working-tree review** (`staged` / `working` / `modified`): run `pre_commit_code_health_safeguard` on the repo root. Catches files `git diff HEAD` may miss. Digest to `file — improved | degraded | stable` + failed `quality_gates`.
    - **Fallback** (MCP tools absent or scope is bare `commit` hash): run `code_health_review` on each changed file with delta ≥ 5. Slower but works anywhere.
  - **CodeScene regressions** (findings, not context): for each in-scope file the dispatch reports with a failed `quality_gates` entry, a `degraded` verdict, or a score below its base-ref score, the orchestrator emits ONE Quality finding citing the worst changed function's line (from `code_health_review`) with its verbatim text and the smell + `score old→new` in the note. Severity per `references/severity-model.md` §Quality. **Declared threshold**: read it from the target repo's agent instructions or the Project standards row (e.g. "Code Health must be 10", "keep score ≥ 9"), or from a CodeScene quality-gate config in the repo; cite its `file:line`. Never invent a threshold — no declaration means `none declared`. A file improved or stable stays context only.
  - If NO CodeScene tool is available, omit the row entirely — the Quality lens (diff-analyst) is the fallback. When CodeScene is declared unused, the row reads `skipped: declared unused ({file:line})` instead.
- SonarQube -> `Sonar issues`: skip when preflight `declaredUnused.sonarqube` is confirmed (row reads `skipped: declared unused ({file:line})`). Otherwise, when `mcp__sonarqube__*` tools are available (SonarQube MCP connected) or the repo carries a `sonar-project.properties` with `sonarqube-cli` installed, pull the open issues intersecting ChangedFiles (MCP per-file analysis, or CLI issue search filtered to the changed paths). Digest to `file:line — rule — severity` rows in the Discovery Map as ground truth — the Quality and Security lenses MUST NOT re-report these; they focus on what Sonar's rules do not cover. When neither surface exists, omit the row entirely.
- dependency-cruiser -> `Boundary/cycle violations`: when the `dependency-cruiser` row from the probe is `configured` (the repo has a `.dependency-cruiser.*` config), run it ONCE root-scoped — the repo's own deps script if present (e.g. `npm run deps`), else `npx depcruise <root-scope> --config <config> --output-type json` — then keep ONLY violations whose `from`/`to` module intersects ChangedFiles. Surfaces a PR that introduces a cycle or crosses a forbidden architectural boundary (the boundary-erosion signal diff-analyst can't see from the diff alone). Digest to `file — rule-name` rows. Run from the repo ROOT (a scoped scan under-counts cross-boundary imports). If depcruise is `absent`/`installed-unconfigured`, or the change set is docs/trivial-only, OMIT the row — CI's own `deps` gate + the Quality lens are the fallback.
Digested rows ONLY — NEVER paste raw tool output into a Wave-2 prompt (the Wave-2 isolation rule below: raw dumps cause silent quality collapse). Both are read-only; never pass a mutate flag.

## Project standards

Extract the target repository's own prose rules ONCE, orchestrator-side, while Wave-1 runs, and fold them into the `Project standards` row as a compact numbered list (`R1..Rn`, cap ~25; most diff-relevant first). Sources, in order — each only when present:
1. Agent instructions: root `AGENTS.md` / `CLAUDE.md` (plus files they import, e.g. `@AGENTS.md`), and the nearest `AGENTS.md` / `CLAUDE.md` / `.rpiv/guidance/**/architecture.md` above each changed directory.
2. Standing decisions / ADRs: `.rpiv/decisions/*.md` and `docs/adr/*.md` (or the directory the instructions name) — the decision's rule sentence, not its rationale; include only decisions whose subject the diff touches.
3. Domain vocabulary: `CONTEXT.md` (or the glossary the instructions name) — canonical terms and their forbidden aliases, as one rule per term the diff names.

**Keep** only rules a diff can violate in code, tests, names, or file placement. **Drop** process and communication rules (tone, git workflow, which agent to call), and **drop every rule already enforced by a configured tool** — a lint/compiler/depcruise/knip setting or a gate that ran successfully above owns it (e.g. "no default exports" when the linter config bans them); note `R<n> enforced by {tool}` only if the drop is non-obvious. Mark each kept rule `hard` (must / never / always / a standing decision) or `preference` (prefer / avoid / should). Every rule carries the `source-file:line` of its sentence — a rule without a citable line is not a rule. When no source exists, write `none declared`; when a source exists but cannot be read, write `sources unreadable ({path})` — never collapse the two.
