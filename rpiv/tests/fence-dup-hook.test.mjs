// tests/fence-dup-hook.test.mjs — contract test for the duplication hook's fence reading
// (slice S6-fence-rule, D26, B97, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// cpd never runs: RPIV_CPD_BIN names a missing file, so a SKIPPED line shows how many fences
// reached the check, and an INCOMPLETE line shows an unclosed fence.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, ".claude/hooks/fence-duplication-check.mjs");
const T = "```";
const F = "````";

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const runHook = (text) => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-fence-dup-"));
	dirs.push(root);
	const dir = join(root, ".rpiv", "artifacts", "designs");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "p.md");
	writeFileSync(file, text);
	const r = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({ tool_input: { file_path: file } }),
		encoding: "utf-8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			RPIV_CPD_BIN: join(root, "nope"),
		},
	});
	expect(r.status).toBe(0);
	return r.stderr;
};

const incomplete = (line) =>
	`[rpiv-hook] Duplication check INCOMPLETE for p.md: unterminated code fence opened at line ${line}. ` +
	"Fences after it were not checked — close the fence and re-save.\n";

describe("S6 duplication hook fences (B97)", () => {
	it("the duplication hook reads fences with the shared parser", () => {
		expect(runHook(`# P\n\n${F}md\n${T}js\nx\n${T}\n`)).toBe(incomplete(3));
		expect(runHook(`# P\n\n${T}js title=x\nconst a = 1;\n`)).toBe(
			incomplete(3),
		);
		expect(runHook(`# P\n\n${T}js title=x\nconst a = 1;\n${T}\n`)).toMatch(
			/SKIPPED for p\.md: .*1 code fence\(s\) went unchecked\.\n$/,
		);
		expect(runHook(`# P\n\n${F}md\n${T}js\nconst a = 1;\n${T}\n${F}\n`)).toBe(
			"",
		);
		expect(runHook(`# P\r\n\r\n${T}js\r\nconst a = 1;\r\n`)).toBe(
			incomplete(3),
		);
	});
});
