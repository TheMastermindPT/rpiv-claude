// vitest.config.mjs — vitest configuration for the rpiv plugin.
//
// STATUS (Action Item #2 scaffold): the existing suites are still plain-assert
// `node <file>.test.mjs` scripts, NOT vitest tests. Converting them is gated behind
// /research -> /rpiv:design (/vitest) -> Action Item #6. Until then this config points
// at the (currently empty) `tests/` tree and passes with no tests, so `npm run
// test:vitest` is green WITHOUT falsely implying the node suites were run (they are
// still run via `node <file>.test.mjs`, and via `npm test` once #6 flips it).
//
// The `tests/` vs co-located `*.test.mjs` location is Action Item #3 (undecided). The
// `include` glob below is PROVISIONAL — the #3 decision + the #4 design finalize it.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// PROVISIONAL (Action Item #3): converted vitest tests land here. Deliberately
		// does NOT match the co-located `skills/**/*.test.mjs` files — those are still
		// plain node scripts and would trip vitest's "No test suite found" until #6.
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
