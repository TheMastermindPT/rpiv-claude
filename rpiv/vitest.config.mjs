// vitest.config.mjs — vitest configuration for the rpiv plugin.
//
// STATUS (Action Item #2 scaffold): the existing suites are still plain-assert
// `node <file>.test.mjs` scripts, NOT vitest tests. Converting them is gated behind
// /research -> /rpiv:design (/vitest) -> Action Item #6. Until then this config points
// at the (currently empty) `tests/` tree and passes with no tests, so `npm run
// test:vitest` is green WITHOUT falsely implying the node suites were run (they are
// still run via `node <file>.test.mjs`, and via `npm test` once #6 flips it).
//
// Action Item #3 is RESOLVED: a FLAT `tests/` tree — all 31 suites move into `tests/`
// (unique basenames, no collisions), importing source via `../skills/...`; tests then
// live OUTSIDE plugin source (`^(skills|agents|hooks|.claude/hooks)/`) so they no longer
// ship with the plugin. The physical relocation + import rewrite + vitest conversion is
// Action Item #6 — and #6 must also rewrite each test's `HERE`-relative fixture/sibling
// paths (e.g. store.test.mjs's `join(HERE, "store.mjs")` and the fingerprint helper path).

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// DECIDED (Action Item #3 = flat tests/): converted vitest tests land directly in
		// `tests/`. Deliberately does NOT match the co-located `skills/**/*.test.mjs` node
		// scripts — they'd trip vitest's "No test suite found" until #6 relocates+converts.
		include: ["tests/**/*.{test,spec}.mjs"],
		exclude: ["**/node_modules/**", "**/.stryker-tmp/**", "**/reports/**"],
		environment: "node",
		// Green while no vitest tests exist yet (see STATUS). Remove once #6 has migrated
		// the suites, so an accidentally-empty run then fails loudly.
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
			// The plugin's real source modules (not the standalone-CLI dispatch tails or
			// the tests). store.mjs is the refactor + 90+ mutation target.
			include: ["skills/_shared/**/*.mjs", "skills/**/_helpers/**/*.mjs", "evals/harness/**/*.mjs"],
			exclude: ["**/*.test.mjs"],
		},
	},
});
