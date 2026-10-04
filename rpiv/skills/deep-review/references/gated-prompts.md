<!-- Read by code-review SKILL.md ONLY when the owning gate fires (progressive disclosure — never read this file at skill start). Each § holds a dispatch-prompt body moved verbatim from SKILL.md: use the applicable fenced block byte-for-byte as the agent prompt, substituting only the {placeholders}. Do not reword. -->

# Gated dispatch prompts

## Peer-Mirror (Wave-1 — gate: `len(PeerPairs) > 0`; agent: `peer-comparator`)

  ```
  Peer-mirror check.

  PeerPairs (orchestrator-computed):
  {list of (new_file, peer_file) tuples}

  For each pair, Read BOTH files in full. Enumerate the peer's PUBLIC surface as rows:
  - every public method / exported function
  - every domain event / notification / message fired (language-agnostic: method calls named `fire*`, `emit*`, `publish*`, `dispatch*`, `raise*`, `notify*`, `AddDomainEvent`, or idiomatic equivalents)
  - every state transition (name + precondition guard + side-effects)
  - every constructor-injected / DI-supplied collaborator
  - every persisted field / column / serialised property
  - every registration this file contributes to a switch/map/table/route/handler registry elsewhere (match by type name appearing in a `switch`/`match`/`when`/dispatch table)

  For each row, check the new file. Emit ONE row per peer invariant:

    peer_site (file:line — `<verbatim line>`) | new_site (file:line — `<verbatim line>` OR `<absent>`) | status | one-sentence delta

  status ∈ {Mirrored, Missing, Diverged, Intentionally-absent}.

  "Intentionally-absent" requires an explicit cite — a comment in the new file, a commit-message line mentioning the omission, or a type-system constraint that makes the invariant inapplicable (e.g. the peer's `Trial*` methods are absent because the new entity's type says it doesn't support trials). Suspicion is not sufficient; when in doubt, emit Missing.

  Output format: markdown table per pair, heading `### Peer pair: <new_file> ↔ <peer_file>`. No prose outside the tables. No severity. No recommendations. Citation contract applies to every cell.
  ```

## Sink-candidate sweep (Wave-1 — gate: opengrep unavailable; agent: `diff-auditor`)

  ```
  Mechanical sink-candidate sweep. Patch: <patch_path> (bounded unified diff, -U30 or -U10).

  Match these pattern classes on added/modified lines only. Emit one row per hit in your standard format; pattern-id = the class name. Candidates only — no reachability, no confidence, no severity.

  - command-exec — process/shell spawn with a variable or interpolation in the command: `exec(`, `execSync(`, `spawn(` with `shell:`, `subprocess.run(`/`Popen(` with `shell=True`, `os.system(`, `Runtime.exec`, backtick or `$()` shell interpolation containing a variable.
  - path-traversal — filesystem API whose path argument concatenates or interpolates a variable: `readFile`/`writeFile`/`createReadStream`/`sendFile`/`open(` with `+` or `${...}` in the path argument, `path.join(` with a request/user/param-named variable.
  - ssrf — outbound request with a variable or interpolated URL/host: `fetch(`, `axios`, `http.get(`/`https.get(`, `request(`, `urllib`, `HttpClient` where the URL argument is not a plain string literal.
  - secrets-in-diff — literal credential material: assignment of a name containing KEY/SECRET/TOKEN/PASSWORD/PASSWD to a quoted literal of 12+ chars, `-----BEGIN ... PRIVATE KEY-----` blocks, connection strings carrying `://user:pass@`.
  ```

## Dependencies (Wave-1 — gate: `ManifestChanged`; agent: `codebase-analyzer`)

**Dependencies lens** (`codebase-analyzer`, only when `ManifestChanged`; otherwise SKIP and omit `### Dependencies` in artifact). **Prefer Knip for dependency audit:** When Knip ran at the Pre-Wave-1 gate AND `ManifestChanged`, use its output as the primary dependency signal:
  ```
  Knip dependency audit (Pre-Wave-1, authoritative):
  {paste knip --dependencies output: unused deps, unlisted deps, with file:line citations}

  Supplement with codebase-analyzer only for:
  1. License field changes in manifest or lockfile (Knip doesn't cover license changes).
  2. Lockstep=yes: flag intra-monorepo drift where a sibling pin diverges (Knip reports dep presence, not version drift).
  3. Ecosystem-specific concerns Knip doesn't parse (Cargo feature flags, Poetry extras, Maven scopes).

  Evidence only. No CVE lookups.
  ```

  When Knip did NOT run (absent at Pre-Wave-1), fall back to the full codebase-analyzer Dependencies lens:
  ```
  Lockstep self-review: {yes|no}

  Identify the ecosystem from touched manifests (npm, Cargo, Go modules, PyPI/Poetry, Bundler, NuGet, Maven/Gradle, …). Parse the changed manifest(s) and list:
  1. Added deps: `name@version` with `file:line`.
  2. Bumped deps: `name: old -> new` with `file:line`.
  3. Removed deps.
  4. Peer / optional / dev-scope changes (whatever the ecosystem calls them).
  5. License field changes in manifest or lockfile.
  6. Lockstep=yes: flag only intra-monorepo drift where a sibling pin diverges from the lockstep version. Treat wildcard peer pins as intentional.
  7. Lockstep=no: flag version conflicts between direct dep and lockfile resolution.

  Evidence only. No CVE lookups.
  ```

## CVE/advisory (Wave-1 — gate: `ManifestChanged`; agent: `web-search-researcher`)

**CVE/advisory lens** (`web-search-researcher`, only when `ManifestChanged`):
  ```
  Look up CVEs / GitHub Advisories / OSS Index entries for the target versions. Return LINKS. Per vulnerability: severity (Critical/High/Moderate/Low), affected range, whether bumped-to version is fixed.

  Advisory-gate rows (deterministic OSV/audit lookup — when present these are the KNOWN set):
  {folded Advisory-gate ids | "gate unavailable — full discovery is yours"}

  When gate rows are present: VERIFY each id (link, affected range, bumped-to fixed?) and search only for advisories newer than or missed by the database — do NOT re-discover the folded set from scratch.

  Dependencies:
  {name@version per line — orchestrator-extracted}
  ```

## Predicate-Trace (Step 4a — gate: `HasGatingPredicate` AND ≥2 Predicate-set coherence rows; agent: `diff-analyst`)

  ```
  Coherence rows (Quality — Predicate-set coherence): {paste verbatim}
  Gating predicates in diff: {`file:line` list}

  Emit ONE review-scope table (your Step-4 contract — a named section at review scope, not per-file tables), heading `### Predicate-Trace`, one row per predicate: `predicate file:line | inputs | promise (what TRUE/matching branch implies) | consumer file:line | consumer filter | fulfils? | gap`.

  Flag:
  - *False promise* — matching branch depends on a consumer/filter elsewhere that excludes this entity's source/type/state.
  - *Stranded state* — entity reaches state X via one conditional, but every conditional that operates on this entity elsewhere excludes X (no exit path).

  Evidence only. Citation contract applies.
  ```

## Spec Conformance (Wave-1 — gate: linked issue resolved AND `gh` works; agent: `diff-analyst`)

Optional intent check against the **external issue** the change claims to implement. It is a separate, unranked `## Spec Conformance` section: its rows never enter the severity map, never get Q/S/I/G IDs, never count toward `blockers_count`, and are never pasted into a Wave-2 prompt. Conformance against approved rpiv briefs/designs/slices is `/rpiv:validate`'s job — do not duplicate it here; when the branch also has an rpiv brief, add the line `rpiv contract conformance: run /rpiv:validate <brief>`.

**Resolve the issue** (orchestrator, before Wave-1 dispatch; stop at the first source that yields refs; cap 3 issues):
1. PR: `gh pr view --json number,body,closingIssuesReferences` for the reviewed branch — `closingIssuesReferences`, then `#N` / issue URLs in the body.
2. Branch name: a number segment such as `123-foo`, `issue-123`, `gh-123`, `feat/123-foo`.
3. Commits in scope: `Closes|Fixes|Resolves|Refs|Part of #N`, `Issue: #N` trailers, `owner/repo#N`, issue URLs.
When the target repo's agent instructions name an issue-tracker convention (a doc describing reference format or tracker), follow it. Then `gh issue view <N> --json number,title,body,url,state`.

**Status line — always emitted, one of** (never silently omit the section):
- `no linked issue found (searched: PR body, branch name, commit messages)`
- `gh unavailable ({not installed | not authenticated})` — refs, if any, listed unresolved
- `gh failed for #N: {first stderr line}` — per ref; a non-GitHub tracker lands here, it is not "no issue"
- `issue #N has no checkable requirements (empty or discussion-only body)`
- `checked #N "{title}" — {M} met · {P} partial · {X} missing · {C} contradicted · {E} extra`

When the gate fires, dispatch ONE `diff-analyst` in Wave-1 with the issue text and the patch paths only (no Discovery Map):
  ```
  Spec conformance against an external issue. Patches: {every ReviewPatch path}
  Issue #{N} — {title}:
  {issue body verbatim, trimmed to requirement-bearing text; acceptance criteria and checklists kept whole}

  Split the issue into atomic requirements (acceptance criteria and checklist items first, then imperative sentences). For each, decide from the patches whether the change implements it. Then list behaviour the change adds that no requirement asks for.

  Emit ONE review-scope table, heading `### Spec Conformance`, columns: `SC<n> | requirement (verbatim issue quote) | status | evidence`.
  status ∈ {Met, Partial, Missing, Contradicted, Extra}. Met/Partial/Contradicted/Extra evidence is `file:line — <verbatim line>`; Missing evidence is `<absent>` plus where you looked. Extra rows quote `(not in issue)` as the requirement.

  Evidence only. No severity. Do not judge code quality. Citation contract applies to every evidence cell.
  ```

Render the status line plus the table (omit the table when no agent ran) as the `## Spec Conformance` section in `review.sections`, placed before `## Recommendation`.
