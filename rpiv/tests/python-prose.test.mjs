// tests/python-prose.test.mjs — B34 of slice S3-preflight-python
// (.rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md): the prose
// tells a Python slice how to title, red and re-prove its tests (FR11, FR12).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const joined = (path) =>
	readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");

const IMPLEMENT = [
	"skills/implement/SKILL.md",
	"opencode/generated/skills/rpiv-implement/SKILL.md",
];
const AUTHORING = [
	"skills/_shared/test-contract-authoring.md",
	"opencode/generated/skills/_shared/test-contract-authoring.md",
];
const VALIDATE = [
	"skills/validate/SKILL.md",
	"opencode/generated/skills/rpiv-validate/SKILL.md",
];
const TITLE_AND_RED = [
	/`test_<id>_<what>`/,
	/`AssertionError`/,
	/`ImportError`\/`AttributeError` that names the new symbol/,
	/never xfail/i,
];
const NARROW_EXCEPTION =
	/import errors[^.]*do not qualify, except an `ImportError`\/`AttributeError` that names the new symbol/i;
const RUNNER = [
	/`\.venv\/bin\/python -m pytest --junitxml=\{junit\} \{tests\}`/,
	/`\.venv\/Scripts\/python\.exe` on Windows/,
	/`--link \.venv`/,
	/never with `-I` or `-S`/,
	/a Python run copies every file the slice changed under the test tree/i,
	/`result: broken: imported from the checkout: <path>`/,
];

/** [path, phrase] rows: every phrase each file must hold. */
const rows = (paths, phrases) =>
	paths.flatMap((path) => phrases.map((phrase) => [path, phrase]));

const ROWS = [
	...rows([...IMPLEMENT, ...AUTHORING], TITLE_AND_RED),
	...rows(
		[...IMPLEMENT, "agents/artifact-coverage-reviewer.md"],
		[NARROW_EXCEPTION],
	),
	...rows(VALIDATE, RUNNER),
];

describe("Python prose (S3-preflight-python)", () => {
	it("B34: implement, authoring, validate and the coverage reviewer tell a Python slice how to title, red and re-prove its tests", () => {
		for (const [path, phrase] of ROWS) {
			expect.soft(joined(path), path).toMatch(phrase);
		}
	});
});
