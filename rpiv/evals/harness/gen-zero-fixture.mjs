// gen-zero-fixture.mjs — construct the IS-3 zero-interaction fixture SYNTHETICALLY.
//
//   node gen-zero-fixture.mjs [--out <dir>]   (default: C:/Users/pedro/Documents/GymApp-evals/zero-fixture)
//
// Four curation rounds proved that a "no interactions here" negative set cannot be
// curated out of a living codebase — every hand-picked quintet concealed a real
// coupling the interaction-sweeper legitimately grounded. True independence must be
// CONSTRUCTED: five modules from disjoint invented domains (greenhouse irrigation,
// chess clock, invoice OCR, morse beacon, aquarium dosing), each carrying one
// plausible single-file defect. Independence is not a hope, it is CHECKED here:
// pairwise-disjoint identifier sets (beyond language keywords/builtins) and zero
// import statements anywhere. Against this fixture the original exact assertion is
// fair again: the only correct sweep output is the no-interaction block.
//
// Emits the fixture repo (git init + commit), prints the five finding rows with real
// line numbers + verbatims, and writes cases/interaction-sweeper/IS-3.prompt.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
const OUT = args.out ?? "C:/Users/pedro/Documents/GymApp-evals/zero-fixture";

// Tokens the disjointness check ignores: TS keywords, builtins, and structural nouns
// that carry no domain meaning.
const ALLOW = new Set(
	`export function const let return if else for of new type interface number string boolean true false null undefined Math round floor min max abs Map Set Array Record push get set has size length void this while break continue trim toUpperCase toLowerCase replace Number String`.split(
		/\s+/,
	),
);

// --- The five modules: disjoint vocabularies, one plausible defect each -------
const MODULES = {
	"src/irrigation/valve-scheduler.ts": `// Greenhouse irrigation: computes per-valve watering windows from soil telemetry.
type ValveTelemetry = { soilMoisturePct: number; canopyTempC: number; valveId: string };

const MOISTURE_FLOOR_PCT = 32;
const WATERING_BASE_MINUTES = 8;

export function planValveWindow(telemetry: ValveTelemetry) {
	const deficit = MOISTURE_FLOOR_PCT - telemetry.soilMoisturePct;
	if (deficit <= 0) {
		return { valveId: telemetry.valveId, minutes: 0, label: formatValveLabel(telemetry.valveId, 0) };
	}
	const heatBoost = telemetry.canopyTempC > 30 ? 1.4 : 1.0;
	const minutes = Math.round(WATERING_BASE_MINUTES + deficit * heatBoost);
	return { valveId: telemetry.valveId, minutes, label: formatValveLabel(telemetry.valveId, minutes) };
}

function formatValveLabel(valveId: string, minutes: number) {
	return "[" + valveId + "] irrigate " + minutes + "min";
}
`,
	"src/chessclock/increment-engine.ts": `// Chess clock: applies per-move increments and flag-fall detection.
type ClockSide = { remainingMs: number; incrementMs: number; movesPlayed: number };

export function applyMoveIncrement(side: ClockSide) {
	const bonus = side.movesPlayed >= 40 ? side.incrementMs * 2 : side.incrementMs;
	return { remainingMs: side.remainingMs + bonus, incrementMs: side.incrementMs, movesPlayed: side.movesPlayed + 1 };
}

export function hasFlagFallen(side: ClockSide) {
	return side.remainingMs <= 0;
}

export function estimateRoundsForPlayers(playerCount: number) {
	let rounds = 0;
	let bracket = 1;
	while (bracket < playerCount) {
		bracket = bracket * 2;
		rounds = rounds + 1;
	}
	return rounds;
}
`,
	"src/ocr/invoice-normalizer.ts": `// Invoice OCR post-processing: repairs scanned amount fields.
type ScannedInvoice = { rawAmount: string; vendorGlyphs: string };

export function repairScannedAmount(invoice: ScannedInvoice) {
	const digits = invoice.rawAmount.replace(/[oO]/g, "0").replace(/[lI]/g, "1");
	return Number(digits);
}

export function normalizeVendorGlyphs(invoice: ScannedInvoice) {
	return invoice.vendorGlyphs.trim().toUpperCase();
}
`,
	"src/radio/morse-beacon.ts": `// Morse beacon: encodes station callsigns for interval transmission.
// Dot-dash assignments: A=.-  B=-...  C=-.-.
const MORSE_TABLE: Record<string, string> = { A: ".-", B: "-...", C: "-.-." };

export function encodeCallsign(callsign: string) {
	let beaconPattern = "";
	for (const glyph of callsign) {
		beaconPattern = beaconPattern + (MORSE_TABLE[glyph] ?? "?") + " ";
	}
	return beaconPattern.trim();
}
`,
	"src/aquarium/ph-dosing.ts": `// Aquarium pH dosing: computes buffer dose from probe drift.
type ProbeReading = { phMeasured: number; tankLiters: number };

export function computeBufferDoseMl(reading: ProbeReading) {
	const drift = 7.0 - reading.phMeasured;
	if (drift <= 0.05) return 0;
	return Math.min(reading.tankLiters * 0.02 * drift * 10, 45);
}
`,
};

// --- Independence checks (fail loudly — a leaked token invalidates the eval) --
const tokensOf = (body) => {
	// Disjointness governs CODE identifiers: strip comments and string contents first
	// (English prose glue like "computes"/"per" is not domain coupling).
	const code = body.replace(/\/\/[^\n]*/g, "").replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
	const ids = new Set();
	for (const m of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
		const t = m[0];
		if (!ALLOW.has(t) && t.length > 1) ids.add(t.toLowerCase());
	}
	return ids;
};
const entries = Object.entries(MODULES);
for (const [path, body] of entries) {
	if (/^\s*import /m.test(body)) throw new Error(`independence violated: ${path} contains an import`);
}
for (let i = 0; i < entries.length; i += 1) {
	for (let j = i + 1; j < entries.length; j += 1) {
		const a = tokensOf(entries[i][1]);
		const shared = [...tokensOf(entries[j][1])].filter((t) => a.has(t));
		if (shared.length) throw new Error(`independence violated: ${entries[i][0]} <-> ${entries[j][0]} share ${shared.join(", ")}`);
	}
}

// --- Materialize the repo -----------------------------------------------------
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
for (const [path, body] of entries) {
	mkdirSync(join(OUT, dirname(path)), { recursive: true });
	writeFileSync(join(OUT, path), body);
}
writeFileSync(join(OUT, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }, null, 2));
const run = execFileSync;
run("git", ["-C", OUT, "init", "-q"]);
run("git", ["-C", OUT, "add", "-A"]);
run("git", ["-C", OUT, "commit", "-q", "-m", "zero-interaction fixture", "--no-gpg-sign"], {
	env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@local", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@local" },
});

// --- Build the finding rows (real line numbers + verbatims) -------------------
const ROWS = [
	{ id: "Z1", lens: "Lc", path: "src/irrigation/valve-scheduler.ts", marker: "return { valveId: telemetry.valveId, minutes, label", what: "window arithmetic mixed with display-label formatting in one unit" },
	{ id: "Z2", lens: "G", path: "src/chessclock/increment-engine.ts", marker: "export function estimateRoundsForPlayers", what: "unrelated tournament-pairing arithmetic accreted into the clock file" },
	{ id: "Z3", lens: "A", path: "src/ocr/invoice-normalizer.ts", marker: "export function normalizeVendorGlyphs", what: "speculative export with no production caller" },
	{ id: "Z4", lens: "D", path: "src/radio/morse-beacon.ts", marker: "const MORSE_TABLE", what: "encoding table restated in the comment above it (drift risk)" },
	{ id: "Z5", lens: "C", path: "src/aquarium/ph-dosing.ts", marker: "const drift = 7.0 - reading.phMeasured", what: "dosing thresholds hard-coded at the call site instead of a named profile" },
].map((r) => {
	const lines = MODULES[r.path].split("\n");
	const idx = lines.findIndex((l) => l.includes(r.marker));
	if (idx === -1) throw new Error(`marker not found for ${r.id}`);
	return `${r.id} | ${r.lens} | ${r.path}:${idx + 1} | \`${lines[idx].trim()}\` | Med | ${r.what}`;
});

const inner = `Target: zero-fixture sample (five standalone modules)   Layers:
L0 — src/irrigation (valve scheduling)
L1 — src/chessclock (move timing)
L2 — src/ocr (invoice repair)
L3 — src/radio (beacon encoding)
L4 — src/aquarium (dosing)

Verified finding set (each: id | lens | file:line | \`verbatim line\` | severity | one-line what-it-is):
${ROWS.join("\n")}

Co-change pairs (hidden coupling, no import edge):
(none — no pair cleared the threshold)

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 \`file:line\` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.`;

const wrapper = `Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:interaction-sweeper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
${inner}
</agent-prompt>`;
writeFileSync(join(HERE, "..", "cases", "interaction-sweeper", "IS-3.prompt.md"), wrapper);

console.log(`fixture: ${OUT} (independence checks passed)`);
for (const r of ROWS) console.log("  " + r);
console.log("prompt written: cases/interaction-sweeper/IS-3.prompt.md");
