<!-- Read by architectural-review SKILL.md at Step 5a, when assembling the Slop Map shared by both lens waves. Content moved verbatim from SKILL.md — the exact map template. Fill every row from the Step 2 outputs; apply as written, do not reword. -->

# Slop Map — template

```
Target: {target}   Layers: {layer table, one line each}
Metrics: median {loc_median} LOC, p90 {loc_p90}
Size outliers: {path  loc  x_median rows — raw LOC context}
God-file candidates (G gate): {path  loc  x_median  cats  coh  reason rows from ---godfile-candidates---}
Low-cohesion (Lc): {path  coh  syms  islands rows from ---low-cohesion--- — disjoint responsibilities, any size}
Complexity (context): {path  decisions  per100  loc rows from ---complexity--- — severity anchor for G/Lc, NOT a gate}
Export-usage flags: {path  exports  inbound rows where inbound is 0 or low; PLUS dead-exports-semantic rows when semantic.mjs ran (on `ran-partial` an empty block proves nothing — keep the inbound=0 rows)}
Test-density flags: {path  cases  asserts  ratio rows}
Dup-candidates: {jscpd clones when present = AUTHORITATIVE; ---dup-candidates--- = corroboration + structural-Type-2 supplement}
Co-change pairs (Tc): {fileA | fileB  support  conf rows — hidden coupling, no import edge}
Feature-envy (Fe): {feature-envy-semantic rows when semantic ran clean (warrant `semantic: ran`); on `ran-partial`, or when the semantic block is empty, ALSO the ---feature-envy-candidates--- rows; else ---feature-envy-candidates---}
Write-sites (S ownership): {write-sites-semantic rows when semantic ran clean and the block is non-empty; on `ran-partial` the union of write-sites-semantic and ---write-sites--- rows; else ---write-sites--- — writers>=2 = scattered write path}
Type fragmentation (C): {type-fragmentation-semantic rows when present — kind=drift / kind=same-shape; structural seed for the C lens. On `ran-partial` an empty block means C is UNMEASURED, not clean}
Catch-swallows (Fp): {path  swallows=N rows — deterministic failure-propagation seeds; the Fp lens rejects justified suppressions, then confirms}
Bus-factor: {path  commits  authors  top_share rows — knowledge-concentration weight for triage/Risk Rollup, NOT findings}
Tool ground-truth: depcruise {violations summary; per-folder instability Ca/Ce/I; circular; orphans}; stability {DC-sdp- SDP violations; cycles (sole cycle signal on the madge fallback path); volatile-hubs — prioritization weight, NOT findings}; layer-model {LM- breaches from the Step-3 generated config, when validated}; knip {dead-code summary}; coverage {per-file stmt/branch/fn% + branch-gaps}; mutation {per-file killed/survived/score% from ---mutation--- when present; scope line values: "full" = missing target files are clean (StrykerJS filtered no-executable-code files), "partial" = missing files were never mutated (unknown, NOT clean), "detected" = whole-repo target — the report IS the target, read like "full", "none"/"empty"/"parse-error" = no usable report — T lens runs on coverage + test-density alone}
Arch-lint (ast-grep): {AS- findings — file:line — rule-id — severity} | omitted when pack absent
Arch-lint (opengrep): {OG- taint findings — source→sink — rule-id — severity} | omitted when pack absent
CodeScene (CS-): {file — score — smell} | omitted when MCP unavailable
Standing decisions: {key — scope — rule, one per accepted `.rpiv/decisions/` entry from Step 2.4 — do NOT raise what a rule rules out for its scope} | omitted when none accepted
```
