// tests/jscpd-python-prose.test.mjs — B43 of slice S6-metrics-jscpd
// (.rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md): the duplication
// prose runs jscpd's Python pass and names its partial state (FR15, D45).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const joined = (path) =>
	readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");

const PATHS = [
	"skills/architectural-review/references/tool-ingestion.md",
	"opencode/generated/skills/rpiv-architectural-review/references/tool-ingestion.md",
	"skills/architectural-review/templates/architecture-review.md",
	"opencode/generated/skills/rpiv-architectural-review/templates/architecture-review.md",
	"skills/deep-review/references/pre-wave-gates.md",
	"opencode/generated/skills/rpiv-deep-review/references/pre-wave-gates.md",
];
const ROWS = PATHS.flatMap((path) =>
	[/--format python/, /partial \(python pass/].map((phrase) => [path, phrase]),
);

describe("jscpd Python pass prose (S6-metrics-jscpd)", () => {
	it("B43: the duplication prose runs jscpd with --format python and names its partial state", () => {
		for (const [path, phrase] of ROWS) {
			expect.soft(joined(path), path).toMatch(phrase);
		}
	});
});
