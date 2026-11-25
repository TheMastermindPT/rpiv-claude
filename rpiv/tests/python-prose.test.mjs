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
	// odin#17: support code under the test tree keeps its base version, named.
	/except its support code: a `\.py` file there that is neither a test nor a `conftest\.py`[^)]*keeps its base version and is named in a `diagnostic: not overlaid:` line/i,
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

// odin#12: a raises behavior and an exception-mapping behavior have their own honest
// first red, accepted only in a narrow form, so an accidental crash still never counts.
// One wording everywhere the rule is stated (shared-vocab-union).
const RAISES_RED = [
	/`Failed: DID NOT RAISE <X>`, only when `<X>` is the exception the test expects/,
	/`Failed: DID NOT RAISE FixtureError`/,
	/the input exception escaping unmapped, only when the expected red reason named that type before the first run and it differs from the target exception/i,
	/the named `FileNotFoundError` escaping/,
	/An escaping exception the reason did not name, a `DID NOT RAISE` for another exception, or a generic setup crash \(a `TypeError` from a typo, a `NameError`\) never qualifies/,
];
const RAISES_ROWS = rows(
	[...IMPLEMENT, ...AUTHORING, "agents/artifact-coverage-reviewer.md"],
	RAISES_RED,
);

describe("Python raises and exception-mapping reds (odin#12)", () => {
	it("implement, authoring and the coverage reviewer accept DID NOT RAISE for the expected exception and a named escaping input exception, and nothing looser", () => {
		for (const [path, phrase] of RAISES_ROWS) {
			expect.soft(joined(path), path).toMatch(phrase);
		}
	});
});

// B50 of S9-reviewer-pitfalls: both reviewer agents carry the generic Python pitfalls
// (FR20, D58). Agents are not mirrored into opencode/generated/.
const PITFALLS = [
	/mutable default argument/i,
	/bare or silent `except`/i,
	/`conftest\.py` fixture scope/i,
	/`@pytest\.mark\.parametrize`/,
	/Hypothesis strateg/i,
	/`-m "not slow"`/,
];
const PITFALL_ROWS = rows(
	["agents/artifact-code-reviewer.md", "agents/artifact-coverage-reviewer.md"],
	PITFALLS,
);

describe("reviewer Python pitfalls (S9-reviewer-pitfalls)", () => {
	it("B50: both reviewer agents name the six generic Python pitfalls", () => {
		for (const [path, phrase] of PITFALL_ROWS) {
			expect.soft(joined(path), path).toMatch(phrase);
		}
	});
});
