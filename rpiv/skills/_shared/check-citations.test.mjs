// check-citations.test.mjs — golden test for the ambiguous-citation gate.
//
//   node check-citations.test.mjs   (prints OK, or throws)
//
// Builds a throwaway repo with TWO files named service.ts (ambiguous) and one uniquely
// named file, then runs the gate over artifacts that mix good and bad cites.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-citations.mjs");
const tmp = mkdtempSync(join(tmpdir(), "check-cites-"));
const root = join(tmp, "repo");

// two service.ts (ambiguous), one unique file
mkdirSync(join(root, "a"), { recursive: true });
mkdirSync(join(root, "b"), { recursive: true });
writeFileSync(join(root, "a", "service.ts"), "export const a = 1;\n".repeat(400));
writeFileSync(join(root, "b", "service.ts"), "export const b = 1;\n".repeat(400));
writeFileSync(join(root, "a", "loadcap.ts"), "export const cap = 1;\n".repeat(50));

const run = (artifact) => spawnSync("node", [SCRIPT, artifact, "--root", root], { encoding: "utf-8" });

// 1. artifact with an ambiguous bare basename -> FAIL (exit 1)
const bad = join(tmp, "bad.md");
writeFileSync(bad, "## Findings\n- OUTPUT `service.ts:329` into aggregate\n- owner `a/loadcap.ts:12`\n");
const r1 = run(bad);
assert.equal(r1.status, 1, "ambiguous `service.ts:329` must fail");
assert.match(r1.stderr, /service\.ts:329/, "names the offending cite");
assert.match(r1.stderr, /2 files named service\.ts/, "reports the ambiguity count");

// 2. clean artifact: repo-relative service.ts + unique bare basename + new file -> OK
const good = join(tmp, "good.md");
writeFileSync(
	good,
	"## Findings\n- OUTPUT `a/service.ts:329` (path-qualified)\n- owner `loadcap.ts:12` (unique basename, greppable)\n- NEW `a/brand-new.ts:5` (0 matches, out of scope)\n",
);
const r2 = run(good);
assert.equal(r2.status, 0, "qualified + unique + new-file cites must pass");
assert.match(r2.stderr, /OK/, "prints OK on a clean artifact");

// 3. self-paths and template tokens are exempt
const exempt = join(tmp, "exempt.md");
writeFileSync(exempt, "## Findings\n- see `.rpiv/artifacts/foo.md:3`\n- template `{file}.ts:5`\n- url https://x.io/service.ts:1\n");
const r3 = run(exempt);
assert.equal(r3.status, 0, ".rpiv/ self-paths, template tokens, and URLs are exempt");

// 4. line-less ambiguous MENTION -> FAIL (the grader's CITE_RE counts mentions without
// :line, so the gate must too — the AR-1 88%-resolvable class)
const badMention = join(tmp, "bad-mention.md");
writeFileSync(badMention, "## System Model\n- ripple-group g1 (`service.ts`, `loadcap.ts`)\n");
const r4 = run(badMention);
assert.equal(r4.status, 1, "ambiguous line-less `service.ts` mention must fail");
assert.match(r4.stderr, /2 files named service\.ts/, "reports the mention's ambiguity count");

// 5. line-less UNIQUE mention stays fine
const okMention = join(tmp, "ok-mention.md");
writeFileSync(okMention, "## Notes\n- the `loadcap.ts` helper owns the cap\n- qualified `a/service.ts` mention\n");
const r5 = run(okMention);
assert.equal(r5.status, 0, "unique / qualified line-less mentions must pass");

rmSync(tmp, { recursive: true, force: true });
console.log("OK");
