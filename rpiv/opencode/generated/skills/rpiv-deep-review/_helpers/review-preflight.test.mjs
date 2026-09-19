import assert from "node:assert/strict";

import { buildPreflight, parseToolProbe } from "./review-preflight.mjs";

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

console.log(
	"OK — review preflight normalizes local, MCP, and process capabilities once.",
);
