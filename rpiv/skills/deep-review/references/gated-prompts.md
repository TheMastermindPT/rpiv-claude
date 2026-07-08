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

  Dependencies:
  {name@version per line — orchestrator-extracted}
  ```

## Predicate-Trace (Step 4a — gate: `HasGatingPredicate` AND ≥2 Predicate-set coherence rows; agent: `codebase-analyzer`)

  ```
  Coherence rows (Quality — Predicate-set coherence): {paste verbatim}
  Gating predicates in diff: {`file:line` list}

  Per predicate, return: `predicate file:line | inputs | promise (what TRUE/matching branch implies) | consumer file:line | consumer filter | fulfils? | gap`.

  Flag:
  - *False promise* — matching branch depends on a consumer/filter elsewhere that excludes this entity's source/type/state.
  - *Stranded state* — entity reaches state X via one conditional, but every conditional that operates on this entity elsewhere excludes X (no exit path).

  Evidence only. Citation contract applies.
  ```
