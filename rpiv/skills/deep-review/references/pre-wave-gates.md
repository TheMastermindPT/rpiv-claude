<!-- Read by deep-review SKILL.md at Step 2 after review-preflight.mjs. Run each applicable gate once and digest its result into the Discovery Map. -->

# Pre-Wave Gates

Use the preflight JSON as the capability source of truth. A local tool with `status=absent` or `installed-unconfigured` is unavailable for gates that require configuration. An MCP with status `configured` may be called and `disabled` is unavailable. In hosts that do not publish `RPIV_CAPABILITIES`, resolve `unknown` once against the active main-thread tool set; omit only when no matching tool exists. Record each unavailable capability once in the Discovery Map, then let the matching lens retain full coverage.

Tool failures are operational, not clean results. Non-zero output containing structured diagnostics is a successful gate with findings. Empty, malformed, or launch-failure output marks that gate unavailable.

## Compiler And Repository Contracts

- **Typecheck**: when the repository defines a typecheck script or compiler config, run its own command. Compiler diagnostics in changed files are critical; fold outside-diff diagnostics into one important row. A successful compiler run owns dangling-import detection.
- **Lint**: run the configured Biome or ESLint command on manifest `changedFiles` only. Fold errors as important findings. The Quality lens owns only behavior beyond configured lint rules.
- **Architecture**: when dependency-cruiser is `configured`, run it once from the repository root. Keep only violations whose `from` or `to` intersects `changedFiles`; errors are critical and warnings important.
- **Dead code**: when Knip is configured, run its JSON reporter. A changed dead file is critical; changed unused exports are important. If typecheck did not run, also inspect Knip dependency output for importers broken by removed exports.

## Dependencies And Duplication

- **Advisories**: only when `manifest_changed: yes`. Prefer OSV on changed lockfiles; use the ecosystem audit command as fallback. Keep advisories only for dependencies added or bumped-to by the diff. Critical/high are critical findings; moderate is important. The CVE agent verifies this known set rather than rediscovering it.
- **Duplication**: when jscpd is installed, run it over source roots and keep clones with at least one side in `changedFiles`. Treat rows as candidates for Quality to confirm; both-changed is intra-diff copy-paste, one-changed asks whether the untouched implementation should be reused.
- **SQL migrations**: when changed files contain Supabase migrations and SQLFluff is installed, lint those changed migrations. Fold violations into the map; Quality retains semantic migration review.

## Structural Security And Smells

- **AST security sinks**: when ast-grep is installed and changed JS/TS files exist, structurally scan for `dangerouslySetInnerHTML`, `eval($$$)`, `Function($$$)`, `$_.innerHTML = $$$`, and `document.write($$$)`. Fold matches as candidates; promote only after Security traces a user-reachable source to the sink.
- **Architectural smells**: when ast-grep is installed, scan changed JS/TS for empty catches, `console.log`, `console.error`, and `debugger`. Empty catches and production debug output are important findings. Other languages remain with the Quality lens.
- **Opengrep**: when installed, run the shared structural helper over changed on-disk files and digest only source-to-sink candidates. When absent, dispatch the gated `diff-auditor` sink sweep instead.
- **Risk keywords**: when ripgrep is installed, scan changed on-disk files for `TODO|FIXME|HACK|XXX|debugger|console.(log|error|warn)`. A changed production TODO or debug statement is important; deduplicate against AST-smell rows.

## MCP Quality Signals

- **CodeScene**: when configured, collect per-file Code Health for changed files with delta at least five, plus one scope-aware change-set or working-tree safeguard. Digest scores and verdicts, never raw output. Tool/auth failure leaves Quality as fallback.
- **SonarQube**: when configured, analyze changed files and digest `file:line`, rule, and severity. Quality and Security do not duplicate confirmed Sonar rows. Tool/auth failure leaves both lenses active.

Every successful gate contributes authoritative rows to the Discovery Map. Candidates remain candidates until a judgment lens confirms reachability or behavior. Never paste raw gate output into a lens prompt.
