// vitest.config.mjs — vitest configuration for the rpiv plugin.
//
// Two kinds of test file exist. The vitest suites are everything under `tests/`, plus
// the four `skills/_shared/*.test.ts` suites. The older suites are plain
// `node <file>.test.mjs` scripts beside their sources; vitest does not run those
// (they have no suites and would trip "No test suite found"). `npm test`
// (scripts/run-all-tests.mjs) runs both kinds.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Deliberately does NOT match the co-located `*.test.mjs` node scripts.
		include: ["tests/**/*.{test,spec}.mjs", "skills/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/.stryker-tmp/**",
			"**/reports/**",
			"opencode/generated/**",
		],
		environment: "node",
		// Many suites spawn git and node processes, and a few take close to a minute
		// alone. One worker per core starves those into their timeouts
		// (tests/path-vocab.test.mjs hit its 120 s limit), so use half the cores.
		maxWorkers: "50%",
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
