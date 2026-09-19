import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "../../_shared/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_PROBE = join(HERE, "..", "..", "_shared", "tool-probe.mjs");

/** Parse the stable text contract emitted by tool-probe.mjs. */
export function parseToolProbe(output) {
	const local = {};
	const reports = {};
	let section = "head";
	let ecosystem = "unknown";
	for (const line of output.split("\n")) {
		if (line === "---tool-coverage---") {
			section = "tools";
			continue;
		}
		if (line === "---report-status---") {
			section = "reports";
			continue;
		}
		if (line.startsWith("ecosystem:"))
			ecosystem = line.slice(line.indexOf(":") + 1).trim();
		if (section === "tools" && line.includes("\t")) {
			const [name, ...fields] = line.split("\t");
			local[name] = Object.fromEntries(
				fields.map((field) => {
					const split = field.indexOf("=");
					return split < 0
						? [field, true]
						: [field.slice(0, split), field.slice(split + 1)];
				}),
			);
		}
		if (section === "reports" && line.includes(":")) {
			const split = line.indexOf(":");
			reports[line.slice(0, split)] = line.slice(split + 1).trim();
		}
	}
	return { ecosystem, local, reports };
}

/** Merge local detection with the OpenCode runtime snapshot. */
export function buildPreflight({ probeOutput, runtimeJson }) {
	let runtime = {};
	try {
		runtime = JSON.parse(runtimeJson || "{}");
	} catch {
		runtime = {};
	}
	if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime))
		runtime = {};
	const parsed = probeOutput
		? parseToolProbe(probeOutput)
		: { ecosystem: "unknown", local: {}, reports: {} };
	return {
		version: 1,
		localStatus: probeOutput ? "available" : "unknown",
		ecosystem: parsed.ecosystem,
		local: parsed.local,
		reports: parsed.reports,
		mcp: {
			codescene: runtime.mcp?.codescene ?? "unknown",
			sonarqube: runtime.mcp?.sonarqube ?? "unknown",
			contextMode: runtime.mcp?.contextMode ?? "unknown",
		},
		processes: {
			nodeHook: runtime.processes?.nodeHook ?? "unknown",
			sonarHook: runtime.processes?.sonarHook ?? "unknown",
		},
	};
}

if (isMain(import.meta.url)) {
	let probeOutput = "";
	try {
		probeOutput = execFileSync(
			"node",
			[
				TOOL_PROBE,
				...(process.argv.slice(2).length ? process.argv.slice(2) : ["."]),
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		probeOutput = "";
	}
	process.stdout.write(
		`${JSON.stringify(buildPreflight({ probeOutput, runtimeJson: process.env.RPIV_CAPABILITIES }), null, 2)}\n`,
	);
}
