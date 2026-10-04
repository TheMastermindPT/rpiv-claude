import assert from "node:assert/strict";

import {
	buildPreflight,
	findDeclaredUnused,
	parseToolProbe,
} from "./review-preflight.mjs";

const probe = `root:      C:/repo
ecosystem: js-ts
---tool-coverage---
dependency-cruiser\tlens=L\tstatus=configured\tconfig=.dependency-cruiser.cjs
opengrep\tlens=L/M\tstatus=absent\thint=install
rg\tlens=search\tstatus=installed\tbin=rg
---report-status---
coverage: absent
mutation: present
`;

const parsed = parseToolProbe(probe);
assert.equal(parsed.local["dependency-cruiser"].status, "configured");
assert.equal(parsed.local.opengrep.status, "absent");
assert.equal(parsed.reports.mutation, "present");

const snapshot = buildPreflight({
	probeOutput: probe,
	runtimeJson: JSON.stringify({
		mcp: {
			codescene: "configured",
			sonarqube: "disabled",
			contextMode: "configured",
		},
		processes: { nodeHook: "available", sonarHook: "available" },
	}),
});
assert.equal(snapshot.version, 1);
assert.equal(snapshot.mcp.codescene, "configured");
assert.equal(snapshot.mcp.sonarqube, "disabled");
assert.equal(snapshot.local.rg.status, "installed");

const degraded = buildPreflight({ probeOutput: "", runtimeJson: "not-json" });
assert.equal(degraded.mcp.codescene, "unknown");
assert.equal(degraded.processes.sonarHook, "unknown");
assert.equal(degraded.localStatus, "unknown");

for (const runtimeJson of ["null", "[]", '"configured"']) {
	const nonObject = buildPreflight({ probeOutput: "", runtimeJson });
	assert.equal(nonObject.mcp.codescene, "unknown");
	assert.equal(nonObject.processes.nodeHook, "unknown");
}

// Declared-unused tools: a project's agent instructions can opt a gate out.
const instructions = [
	{
		path: "AGENTS.md",
		text: "- Refactor until CodeScene reports a score of 10. SonarQube is not used (user decision).\n- Do not use Knip ignores to hide dead code.\n- Knip reports unused exports.",
	},
	{ path: "CLAUDE.md", text: "intro\nopengrep: not used here" },
];
assert.deepEqual(
	findDeclaredUnused(instructions, [
		"sonarqube",
		"codescene",
		"knip",
		"opengrep",
		"rg",
	]),
	{ sonarqube: "AGENTS.md:1", opengrep: "CLAUDE.md:2" },
);

const optedOut = buildPreflight({
	probeOutput: probe,
	runtimeJson: JSON.stringify({ mcp: { sonarqube: "configured" } }),
	instructionFiles: instructions,
});
assert.equal(optedOut.mcp.sonarqube, "configured");
assert.equal(optedOut.declaredUnused.sonarqube, "AGENTS.md:1");
assert.equal(optedOut.declaredUnused.opengrep, "CLAUDE.md:2");
assert.equal(optedOut.declaredUnused.codescene, undefined);
assert.equal(optedOut.declaredUnused["dependency-cruiser"], undefined);
assert.deepEqual(optedOut.instructionErrors, []);

// An unreadable instruction file is broken, never "nothing declared".
const unreadable = buildPreflight({
	probeOutput: probe,
	runtimeJson: "{}",
	instructionFiles: [{ path: "AGENTS.md", error: "EACCES" }],
});
assert.deepEqual(unreadable.declaredUnused, {});
assert.deepEqual(unreadable.instructionErrors, [
	{ path: "AGENTS.md", error: "EACCES" },
]);
assert.deepEqual(degraded.declaredUnused, {});
assert.deepEqual(degraded.instructionErrors, []);

console.log(
	"OK — review preflight normalizes local, MCP, process capabilities, and declared-unused tools once.",
);
