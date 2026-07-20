/** @type {import('dependency-cruiser').IConfiguration}
 *
 * dependency-cruiser config for the rpiv plugin.
 *
 * The plugin is a collection of standalone ESM `.mjs` CLIs — invoked via `node`
 * from SKILL.md markdown (e.g. `now.mjs`, `store.mjs`) — plus co-located
 * `*.test.mjs`. Sources have NO npm runtime dependencies: they import only Node
 * built-ins. The one external tool, `ts-morph`, is OPTIONAL and dynamically
 * probed (semantic.mjs / tool-probe.mjs load it via a guarded require and
 * degrade gracefully), so it is intentionally undeclared and excluded below.
 *
 * `no-orphans` is deliberately omitted: nearly every `.mjs` here is a standalone
 * CLI that is never `import`ed (only executed), so orphan-detection is all false
 * positives. The "is this file used?" question is owned by knip instead.
 */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment:
				"This dependency is part of a circular relationship. Break the cycle " +
				"(dependency inversion / single responsibility).",
			from: {},
			to: { circular: true },
		},
		{
			name: "not-to-unresolvable",
			severity: "error",
			comment:
				"This import resolves to nothing on disk — a broken relative path or a " +
				"missing (undeclared) package. Fix the path or declare the dependency.",
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: "no-import-of-test",
			severity: "error",
			comment:
				"Production/source code must never import a *.test.mjs / *.spec file — " +
				"tests are leaves. If something in a test is reusable, extract it to a helper.",
			from: { pathNot: "[.](?:spec|test)[.](?:m?js|cjs)$" },
			to: { path: "[.](?:spec|test)[.](?:m?js|cjs)$" },
		},
		{
			name: "skills-no-npm-deps",
			severity: "error",
			comment:
				"A skill/eval source imports an npm package. The plugin is zero-dependency " +
				"(Node built-ins only); the sole external, ts-morph, is optional + dynamically " +
				"probed and excluded from the cruise. Add a runtime dependency here only with intent.",
			from: {
				path: "^(skills|evals)",
				pathNot: "[.](?:spec|test)[.](?:m?js|cjs)$",
			},
			to: {
				dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
				dependencyTypesNot: ["type-only"],
			},
		},
	],
	options: {
		doNotFollow: { path: ["node_modules"] },
		exclude: {
			// ts-morph: OPTIONAL, dynamically-probed tool (semantic.mjs / tool-probe.mjs
			// load it via a guarded require and degrade gracefully when absent). It is
			// intentionally NOT a declared dependency — drop its edge so it doesn't trip
			// not-to-unresolvable / skills-no-npm-deps. Reversible: if ts-morph is later
			// added to package.json, this exclusion becomes a harmless no-op.
			path: ["(^|/)ts-morph($|/)"],
		},
		detectProcessBuiltinModuleCalls: true,
		skipAnalysisNotInRules: true,
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
			mainFields: ["module", "main", "types", "typings"],
		},
		reporterOptions: {
			text: { highlightFocused: true },
		},
	},
};
