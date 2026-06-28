// metrics.mjs — deterministic quantified-metrics helper for the architectural-review skill.
//
// LLM-invoked (not render-time substituted). The skill resolves a target path
// (file, directory, or module) and runs:
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/metrics.mjs" "<target-path>"
//
// Purpose: anchor finding severity in NUMBERS instead of vibes. Every block below
// gives the review a measured signal the 10-dimension sweep would otherwise eyeball.
//
// Output (labeled key/value lines, then `---<block>---` sections):
//
//   target:       <repo-relative path>
//   file_count:   <N source files, tests excluded>
//   loc_total:    <sum of non-blank source LOC>
//   loc_median:   <median source-file LOC>
//   loc_p90:      <p90 source-file LOC>
//   churn_window: <e.g. 180d>
//   note:         <reason>            (only when something degraded)
//   ---size-outliers---     path \t loc \t x_median   (loc > max(3*median, 1.5*p90); raw LOC context only)
//   ---godfile-candidates--- path \t loc \t x_median \t cats=N \t coh=R \t reason   (the G gate: union of mixing + low-cohesion size)
//   ---low-cohesion---      path \t coh=R \t syms=N \t islands=K   (Lc lens: disjoint responsibilities at any size; excludes G candidates)
//   ---feature-envy-candidates--- path \t envies=<module> \t ext=N \t own=M \t ratio=R   (Fe pre-signal: file leans on one internal module > its own symbols)
//   ---churn-hotspots---    path \t commits            (commits in churn window, desc)
//   ---export-usage---      path \t exports=N \t inbound=M   (speculative-generality signal)
//   ---test-density---      path \t cases=N \t asserts=M \t ratio=R   (test-theater signal)
//   ---dup-candidates---    fileA | fileB \t shared=N \t overlap=R   (content-based parallel-impl pre-signal; shared normalized lines)
//   ---co-change-candidates--- fileA | fileB \t support=N \t conf=R   (hidden/temporal-coupling pre-signal)
//
// The co-change block is the temporal-coupling lens' deterministic feed: file PAIRS
// that change together across history (support = # shared commits; conf = support /
// fewer file's total changes) but share NO static import edge. Bulk commits are capped
// out; thin-history targets emit nothing. Non-authoritative — the synthesis layer judges.
//
// Design constraints (mirror code-review/_helpers/review-range.mjs):
//   - execFileSync only — no `sh -c`, no shell globbing, no heredocs (Windows-safe).
//   - ALWAYS exit 0 — every failure path collapses to a `note:` line + empty blocks,
//     so the skill body never receives a `[Shell error]` substitution.
//   - Output is bounded (caps below) so it stays manageable in the LLM context.
//   - Language-agnostic for LOC / churn / dup; export-count regex is JS/TS-shaped and
//     simply yields 0 for other languages (degrades, never crashes).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT_LINE_CAP = 200; // max rows per block
const OUT_BYTE_CAP = 40 * 1024; // total block-bytes budget
const CHURN_DAYS = 180;
const INBOUND_SCAN_CAP = 60; // bound git-grep calls for export-usage
const CO_CHANGE_COMMIT_CAP = 25; // commits touching > N source files are bulk/refactor noise — skipped
const CO_CHANGE_MIN_SUPPORT = 3; // a pair must change together at least this many times
const CO_CHANGE_MIN_CONF = 0.5; // support / (fewer file's total changes) must clear this
const CO_CHANGE_EXAMINE_CAP = 80; // bound import-link checks (file reads) over candidate pairs
const CO_CHANGE_OUT_CAP = 15; // max emitted co-change pairs
const SOURCE_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
	"py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "scala",
]);
const DUP_STOPWORDS = new Set([
	"index", "types", "type", "utils", "util", "helpers", "helper", "constants",
	"const", "lib", "src", "main", "core", "common", "shared", "base", "config",
	"test", "tests", "spec", "mod", "init", "app", "api", "client", "server",
]);

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		}).trim();
	} catch {
		return fb;
	}
};

const stripOuterQuotes = (s) =>
	s.replace(/^['"]/, "").replace(/['"]$/, "").trim();

const toPosix = (p) => p.replaceAll("\\", "/");
const extOf = (p) => {
	const b = p.slice(p.lastIndexOf("/") + 1);
	const dot = b.lastIndexOf(".");
	return dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
};
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const isTest = (p) => /\.(test|spec)\.[a-z]+$/i.test(baseOf(p)) || /(^|\/)__tests__\//.test(p);
const isDecl = (p) => /\.d\.ts$/i.test(p);
// Generated/vendored files (path-pattern detection) are excluded like tests/.d.ts
// so a generated schema/types file stops tripping size-based lenses skill-wide.
const isGenerated = (p) => {
	const b = baseOf(p);
	return (
		/\.(?:gen|generated)\.[a-z0-9]+$/i.test(b) ||
		/(?:^|[._-])pb2?\.[a-z0-9]+$/i.test(b) ||
		/\.pb\.go$/i.test(b)
	);
};
const JS_TS_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts"]);
const isJsTs = (p) => JS_TS_EXT.has(extOf(p));

// Concern-category dictionary for the god-file responsibility-mixing signal.
// Heuristic + tunable (JS/TS-first): a file pulling imports from many DISTINCT
// infra categories is mixing responsibilities regardless of its LOC. Counts
// distinct categories only — uncategorised "business logic" imports are benign;
// the spread ACROSS infra categories is the signal.
const MIX_CATEGORY_MIN = 4; // distinct concern categories => mixing flag (LOC-independent)
const COHESION_LOW = 0.4; // a LOC outlier flags only when its cohesion is below this
const COHESION_LENS_MAX = 0.4; // Lc lens: flag files below this cohesion (tunable apart from COHESION_LOW)
const LCOM_MIN_SYMBOLS = 6; // Lc lens: need this many BEHAVIORAL symbols (fns/classes) — a const/type bag is exempt
const ENVY_MIN_REFS = 5; // Fe lens: a module must be referenced at least this many times to count
const ENVY_MIN_RATIO = 0.6; // Fe lens: external refs / (external + own) must clear this
const ENVY_INTERNAL_ONLY = true; // Fe lens: only flag envy toward relative/alias imports (not 3rd-party libs)
const ENVY_INTERNAL_RE = /^(?:\.|~|@\/|@app\/|@lib\/)/; // what counts as an internal module specifier
const DUP_MIN_LINES = 8; // D lens: a pair must share at least this many normalized lines
const DUP_OVERLAP_MIN = 0.4; // D lens: shared / min(|A|,|B|) must clear this
const DUP_FILE_MIN_LINES = 8; // D lens: skip files with fewer interesting lines (too small to judge)
const DUP_LINE_FANOUT_CAP = 6; // D lens: a line shared by > this many files is boilerplate, ignored
const CONCERN_RULES = [
	["persistence", /(?:^|[/@.-])(?:db|database|sql|sqlite|postgres|mysql|mongo|mongoose|redis|ioredis|prisma|supabase|sequelize|knex|typeorm|drizzle|dynamodb|repositor)/i],
	["network", /(?:^|[/@.-])(?:axios|node-fetch|undici|got|ky|superagent|graphql-request|api-client|http-client|xmlhttp)/i],
	["ui", /(?:^|[/@.-])(?:react|react-dom|preact|vue|svelte|solid-js|angular|next\/|styled-components|emotion|tailwind|components?|\.css|\.scss|\.module)/i],
	["validation", /(?:^|[/@.-])(?:zod|yup|joi|ajv|superstruct|valibot|class-validator|validator|schema-?validat)/i],
	["auth", /(?:^|[/@.-])(?:bcrypt|bcryptjs|argon2|scrypt|jsonwebtoken|jose|jwt|passport|oauth|next-auth|crypto|session)/i],
	["fs-io", /(?:^|[/@.-])(?:node:fs|node:child_process|fs-extra|graceful-fs|chokidar|rimraf|mkdirp)|^fs$|^glob$/i],
	["logging", /(?:^|[/@.-])(?:winston|pino|bunyan|log4js|loglevel|sentry|datadog|opentelemetry|logger|debug)/i],
	["config-env", /(?:^|[/@.-])(?:dotenv|env-var|convict|cosmiconfig)|(?:^|[/@.-])config$/i],
	["serialization", /(?:^|[/@.-])(?:js-yaml|yaml|xml2js|fast-xml|papaparse|csv-parse|csv-stringify|protobufjs|msgpack|marked|remark|cheerio|parser)/i],
	["messaging", /(?:^|[/@.-])(?:amqplib|kafkajs|bullmq|bull|nats|mqtt|rabbitmq|pubsub|sqs|kinesis)/i],
];

const result = {
	target: "",
	file_count: 0,
	loc_total: 0,
	loc_median: 0,
	loc_p90: 0,
	churn_window: `${CHURN_DAYS}d`,
	note: "",
	sizeOutliers: [],
	churnHotspots: [],
	exportUsage: [],
	testDensity: [],
	dupCandidates: [],
	coChange: [],
	godfileCandidates: [],
	lowCohesion: [],
	featureEnvy: [],
};

const argv = process.argv[2] ?? "";
const target = toPosix(stripOuterQuotes(argv)) || ".";
result.target = target;

const root = toPosix(safe(["rev-parse", "--show-toplevel"]));
if (!root) {
	result.note = "not a git repository (or git unavailable)";
	emit();
}

// --- Enumerate tracked files under the target -------------------------------
const lsRaw = safe(["ls-files", "-z", "--", target]);
const tracked = lsRaw ? lsRaw.split("\0").filter(Boolean).map(toPosix) : [];
if (tracked.length === 0) {
	result.note = `no tracked files under target: ${target}`;
	emit();
}

const sourceFiles = tracked.filter(
	(p) => SOURCE_EXT.has(extOf(p)) && !isTest(p) && !isDecl(p) && !isGenerated(p),
);
const testFilesUnder = tracked.filter((p) => isTest(p) && SOURCE_EXT.has(extOf(p)));

// Test-theater also wants tests that mirror the target by its last path segment
// (e.g. target `lib/generation` -> tests under `tests/**/generation/**`).
const segment = target.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
let mirrorTests = [];
if (segment && segment !== ".") {
	const allTestsRaw = safe([
		"ls-files", "-z", "--",
		"*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx",
		"*.test.js", "*.spec.js",
	]);
	const allTests = allTestsRaw ? allTestsRaw.split("\0").filter(Boolean).map(toPosix) : [];
	mirrorTests = allTests.filter(
		(p) => p.split("/").includes(segment) && !testFilesUnder.includes(p),
	);
}
const testFiles = [...testFilesUnder, ...mirrorTests];

if (sourceFiles.length === 0) {
	result.note = `no source files under target: ${target} (tracked: ${tracked.length})`;
	emit();
}

// --- LOC per source file ----------------------------------------------------
const readText = (rel) => {
	try {
		return readFileSync(join(root, rel), "utf-8");
	} catch {
		return null;
	}
};
const nonBlankLoc = (text) => {
	let n = 0;
	for (const line of text.split(/\r?\n/)) if (line.trim()) n += 1;
	return n;
};

const locByFile = new Map();
for (const f of sourceFiles) {
	const text = readText(f);
	if (text === null) continue;
	locByFile.set(f, nonBlankLoc(text));
}
result.file_count = locByFile.size;
const locValues = [...locByFile.values()].sort((a, b) => a - b);
result.loc_total = locValues.reduce((a, b) => a + b, 0);

const quantile = (sorted, q) => {
	if (sorted.length === 0) return 0;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
};
result.loc_median = quantile(locValues, 0.5);
result.loc_p90 = quantile(locValues, 0.9);

// --- Size outliers ----------------------------------------------------------
const median = result.loc_median || 1;
const threshold = Math.max(3 * median, Math.round(1.5 * result.loc_p90));
result.sizeOutliers = [...locByFile.entries()]
	.filter(([, loc]) => loc > threshold)
	.map(([f, loc]) => ({ f, loc, x: (loc / median).toFixed(1) }))
	.sort((a, b) => b.loc - a.loc);

// --- Concern-category fingerprint + cohesion (JS/TS-first) ------------------
// The two deterministic signals the god-file gate adds on top of raw LOC.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectSpecifiers = (text) => {
	const specs = new Set();
	const add = (re) => {
		let m;
		while ((m = re.exec(text)) !== null) specs.add(m[1]);
	};
	add(/\bfrom\s*['"]([^'"]+)['"]/g);
	add(/\bimport\s*['"]([^'"]+)['"]/g);
	add(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
	add(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
	return specs;
};

// Import-category fingerprint: distinct concern categories the file pulls in.
const concernCategoryCount = (text) => {
	const cats = new Set();
	for (const spec of collectSpecifiers(text)) {
		for (const [name, re] of CONCERN_RULES) if (re.test(spec)) cats.add(name);
	}
	return cats.size;
};

// Top-level declared symbols (functions/classes/const/let/var/interface/type/enum).
// Shared by the cohesion (Lc) and feature-envy (Fe) signals. Bounded at 150.
// `behavioral` marks functions/classes and function/arrow-valued consts — the
// symbols that carry responsibility, vs value/type declarations (a const/type bag
// is legitimately low-cohesion and must NOT be an Lc finding).
const topLevelSymbols = (text) => {
	const declRe = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
	const syms = [];
	let m;
	while ((m = declRe.exec(text)) !== null) {
		const kw = m[1];
		const head = text.slice(m.index, m.index + 160);
		const behavioral =
			kw === "class" ||
			kw.startsWith("function") ||
			/=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(head);
		syms.push({ name: m[2], start: m.index, behavioral });
		if (syms.length >= 150) break; // bound the O(n^2) cohesion graph below
	}
	return syms;
};

// LCOM-style cohesion in [0,1]: 1 = top-level symbols form one connected
// reference graph (one cohesive thing); ~0 = disjoint islands (N modules glued).
// Returns { cohesion, symbols, behavioral, components }; cohesion null when < 2 symbols.
const cohesionScore = (text, syms = topLevelSymbols(text)) => {
	const behavioral = syms.filter((s) => s.behavioral).length;
	if (syms.length < 2) return { cohesion: null, symbols: syms.length, behavioral, components: syms.length };
	for (let i = 0; i < syms.length; i += 1) {
		syms[i].end = i + 1 < syms.length ? syms[i + 1].start : text.length;
		syms[i].body = text.slice(syms[i].start, syms[i].end);
	}
	const parent = syms.map((_, i) => i);
	const find = (x) => {
		let r = x;
		while (parent[r] !== r) r = parent[r];
		while (parent[x] !== r) {
			const n = parent[x];
			parent[x] = r;
			x = n;
		}
		return r;
	};
	const nameRe = syms.map((s) => new RegExp(`\\b${escapeRe(s.name)}\\b`));
	for (let i = 0; i < syms.length; i += 1) {
		for (let j = 0; j < syms.length; j += 1) {
			if (i === j) continue;
			if (nameRe[j].test(syms[i].body)) {
				const ri = find(i);
				const rj = find(j);
				if (ri !== rj) parent[ri] = rj;
			}
		}
	}
	const components = new Set(syms.map((_, i) => find(i))).size;
	return {
		cohesion: 1 - (components - 1) / (syms.length - 1),
		symbols: syms.length,
		behavioral,
		components,
	};
};

// Local names bound by each import/require, with the module specifier and
// whether it is internal (relative / alias). Feeds the feature-envy (Fe) signal.
const importBindings = (text) => {
	const out = [];
	const push = (clause, module) => {
		const names = [];
		let c = clause.trim();
		if (c === "type" || c.startsWith("type ")) return; // `import type {...}` — types aren't behavioral collaborators
		c = c.replace(/\btype\s+/g, ""); // strip inline `{ type X, Y }` markers
		const ns = c.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
		if (ns) names.push(ns[1]);
		const def = c.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
		if (def) names.push(def[1]);
		const braces = c.match(/\{([^}]*)\}/);
		if (braces) {
			for (const part of braces[1].split(",")) {
				const t = part.trim();
				if (!t) continue;
				const asM = t.match(/\bas\s+([A-Za-z_$][\w$]*)/);
				names.push(asM ? asM[1] : t.split(/\s+/)[0]);
			}
		}
		if (names.length) out.push({ module, names, internal: ENVY_INTERNAL_RE.test(module) });
	};
	let m;
	const esm = /import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
	while ((m = esm.exec(text)) !== null) push(m[1], m[2]);
	const req = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
	while ((m = req.exec(text)) !== null) push(m[1], m[2]);
	return out;
};

// Feature-envy pre-signal: does the file lean on ONE other module's bound names
// far more than on its own top-level symbols? Coarse + file-level — the Fe lens
// agent confirms at function granularity. Returns the dominant module or null.
const envyOf = (text, syms) => {
	const bindings = importBindings(text);
	if (bindings.length === 0) return null;
	// Count BEHAVIORAL references only — `name(` (call) or `name.` (member access).
	// This is what feature envy means (using another module's methods/members) and
	// excludes type-annotation positions (`x: SomeType`) that bare-identifier counts
	// would wrongly inflate. Import lines (`{ name }`) are not followed by `(`/`.`.
	const refCount = (name) => {
		const re = new RegExp(`\\b${escapeRe(name)}\\b(?=\\s*[.(])`, "g");
		return (text.match(re) ?? []).length;
	};
	let own = 0;
	for (const s of syms) own += refCount(s.name);
	let best = null;
	for (const b of bindings) {
		if (ENVY_INTERNAL_ONLY && !b.internal) continue;
		let ext = 0;
		for (const name of b.names) ext += refCount(name);
		if (!best || ext > best.ext) best = { module: b.module, ext };
	}
	if (!best) return null;
	const ratio = best.ext / ((best.ext + own) || 1);
	if (best.ext < ENVY_MIN_REFS || ratio < ENVY_MIN_RATIO) return null;
	return { module: best.module, ext: best.ext, own, ratio };
};

const catByFile = new Map();
const cohByFile = new Map(); // f -> { cohesion, symbols, components } | null
for (const f of sourceFiles) {
	if (!isJsTs(f)) {
		catByFile.set(f, 0);
		cohByFile.set(f, null);
		continue;
	}
	const text = readText(f);
	if (text === null) {
		catByFile.set(f, 0);
		cohByFile.set(f, null);
		continue;
	}
	const syms = topLevelSymbols(text);
	catByFile.set(f, concernCategoryCount(text));
	cohByFile.set(f, cohesionScore(text, syms));
	const envy = envyOf(text, syms);
	if (envy) result.featureEnvy.push({ f, ...envy });
}
result.featureEnvy.sort((a, b) => b.ratio - a.ratio || b.ext - a.ext);

// --- God-file gate (union + bidirectional cohesion) -------------------------
// (a) high concern-mixing flags regardless of LOC -> small tangles surface.
// (b) a LOC outlier flags only when ALSO low-cohesion (fragmented); a large
//     high-cohesion, few-concern file (parser/schema) is rescued/demoted.
// Non-JS/TS files have null cohesion -> treated as low so the legacy LOC path
// is preserved (degrade to neutral).
for (const [f, loc] of locByFile.entries()) {
	const cats = catByFile.get(f) ?? 0;
	const cohInfo = cohByFile.get(f) ?? null;
	const coh = cohInfo ? cohInfo.cohesion : null;
	const isLocOutlier = loc > threshold;
	const mixing = cats >= MIX_CATEGORY_MIN;
	const lowCohesion = coh === null ? true : coh < COHESION_LOW;
	let reason = "";
	if (mixing && isLocOutlier && lowCohesion) reason = "mixing+size";
	else if (mixing) reason = "mixing";
	else if (isLocOutlier && lowCohesion) reason = coh === null ? "size" : "size+low-cohesion";
	if (!reason) continue; // rescued large cohesive files land here
	result.godfileCandidates.push({ f, loc, x: (loc / median).toFixed(1), cats, coh, reason });
}
const reasonRank = (c) => (c.reason.startsWith("mixing") ? 0 : 1);
result.godfileCandidates.sort(
	(a, b) => reasonRank(a) - reasonRank(b) || b.cats - a.cats || b.loc - a.loc,
);

// --- Low-cohesion lens (Lc): disjoint responsibilities at ANY size ----------
// Top-level symbols that form multiple islands (never reference each other) =
// several modules glued into one file, regardless of LOC. Excludes god-file
// candidates so it does not double-report what the G gate already caught.
const godfileSet = new Set(result.godfileCandidates.map((c) => c.f));
for (const [f, info] of cohByFile.entries()) {
	if (!info || info.cohesion === null) continue;
	if (info.cohesion >= COHESION_LENS_MAX || info.behavioral < LCOM_MIN_SYMBOLS) continue;
	if (godfileSet.has(f)) continue;
	result.lowCohesion.push({ f, coh: info.cohesion, syms: info.symbols, islands: info.components });
}
result.lowCohesion.sort((a, b) => a.coh - b.coh);

// --- Churn hotspots ---------------------------------------------------------
const churnRaw = safe([
	"log", `--since=${CHURN_DAYS}.days`, "--name-only", "--pretty=format:", "--", target,
]);
if (churnRaw) {
	const counts = new Map();
	for (const line of churnRaw.split("\n")) {
		const p = toPosix(line.trim());
		if (!p) continue;
		if (!SOURCE_EXT.has(extOf(p))) continue;
		counts.set(p, (counts.get(p) ?? 0) + 1);
	}
	result.churnHotspots = [...counts.entries()]
		.map(([f, c]) => ({ f, c }))
		.sort((a, b) => b.c - a.c)
		.filter((r) => r.c >= 2);
}

// --- Export / usage (speculative-generality signal) -------------------------
// Count `export`-shaped declarations per file; for files with many exports,
// approximate inbound usage by counting other files that reference the stem.
const exportRe = /^\s*export\s+(?:default\s+|async\s+)?(?:const|let|var|function|class|interface|type|enum|abstract\s+class)\b|^\s*export\s*\{/gm;
const exportCounts = new Map();
for (const f of sourceFiles) {
	const text = readText(f);
	if (text === null) continue;
	const m = text.match(exportRe);
	exportCounts.set(f, m ? m.length : 0);
}
const exportCandidates = [...exportCounts.entries()]
	.filter(([, n]) => n >= 5)
	.sort((a, b) => b[1] - a[1])
	.slice(0, INBOUND_SCAN_CAP);
for (const [f, n] of exportCandidates) {
	const stem = baseOf(f).replace(/\.[a-z]+$/i, "");
	// A stopword stem (types, constants, service, ...) is too generic to grep
	// usefully — report inbound as unknown (`?`) rather than a misleading 0.
	let inbound = null;
	if (stem && !DUP_STOPWORDS.has(stem.toLowerCase())) {
		const hits = safe(["grep", "-l", "--fixed-strings", stem, "--", "*.ts", "*.tsx", "*.js", "*.jsx"]);
		const files = new Set((hits ? hits.split("\n") : []).map(toPosix).filter(Boolean));
		files.delete(f);
		inbound = files.size;
	}
	result.exportUsage.push({ f, exports: n, inbound });
}
// Surface speculative generality first: many exports, low KNOWN inbound.
// Unknown inbound (stopword stems) sorts last so it never tops the dead list.
const inboundRank = (v) => (v === null ? Number.POSITIVE_INFINITY : v);
result.exportUsage.sort(
	(a, b) => inboundRank(a.inbound) - inboundRank(b.inbound) || b.exports - a.exports,
);

// --- Test density (test-theater signal) -------------------------------------
const caseRe = /\b(?:it|test)\s*\(/g;
const assertRe = /\b(?:expect|assert)\s*\(|\.(?:toBe|toEqual|toMatch|toThrow|toHaveBeenCalled)\b/g;
for (const f of testFiles) {
	const text = readText(f);
	if (text === null) continue;
	const cases = (text.match(caseRe) ?? []).length;
	const asserts = (text.match(assertRe) ?? []).length;
	if (cases === 0) continue;
	const ratio = asserts / cases;
	if (ratio < 1) {
		result.testDensity.push({ f, cases, asserts, ratio: ratio.toFixed(2) });
	}
}
result.testDensity.sort((a, b) => Number(a.ratio) - Number(b.ratio));

// --- Duplication candidates (parallel-impl / copy-paste pre-signal) ----------
// Content-based: file PAIRS that share many normalized source lines. An inverted
// index over interesting-line hashes yields candidate pairs without O(n^2) reads;
// overlap = shared / min(|A|,|B|) so a small file copied into a larger one still
// scores high. Name coincidence alone never flags a pair (that was the old slop).
const dupHash = (s) => {
	let h = 2166136261;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
};
const dupInteresting = (l) =>
	l.length >= 12 &&
	!/^(?:import\b|export\s+\{|export\s+\*|export\s+type\b|\/\/|\/\*|\*|@)/.test(l) &&
	!/^[)}\];,{(]+$/.test(l);
const dupLineSets = new Map(); // f -> Set<lineHash>
for (const f of sourceFiles) {
	const text = readText(f);
	if (text === null) continue;
	const set = new Set();
	for (const raw of text.split(/\r?\n/)) {
		const l = raw.trim().replace(/\s+/g, " ");
		if (dupInteresting(l)) set.add(dupHash(l));
	}
	if (set.size >= DUP_FILE_MIN_LINES) dupLineSets.set(f, set);
}
const dupIndex = new Map(); // lineHash -> [files]
for (const [f, set] of dupLineSets) {
	for (const h of set) {
		const arr = dupIndex.get(h);
		if (arr) arr.push(f);
		else dupIndex.set(h, [f]);
	}
}
const dupPairShared = new Map(); // "a|b" -> shared interesting-line count
for (const fs of dupIndex.values()) {
	if (fs.length < 2 || fs.length > DUP_LINE_FANOUT_CAP) continue; // boilerplate shared widely
	for (let i = 0; i < fs.length; i += 1) {
		for (let j = i + 1; j < fs.length; j += 1) {
			const key = fs[i] < fs[j] ? `${fs[i]}|${fs[j]}` : `${fs[j]}|${fs[i]}`;
			dupPairShared.set(key, (dupPairShared.get(key) ?? 0) + 1);
		}
	}
}
for (const [key, shared] of dupPairShared) {
	if (shared < DUP_MIN_LINES) continue;
	const [a, b] = key.split("|");
	const overlap = shared / Math.min(dupLineSets.get(a).size, dupLineSets.get(b).size);
	if (overlap < DUP_OVERLAP_MIN) continue;
	result.dupCandidates.push({ a, b, shared, overlap });
}
result.dupCandidates.sort((x, y) => y.overlap - x.overlap || y.shared - x.shared);
result.dupCandidates = result.dupCandidates.slice(0, 15);

// --- Co-change candidates (hidden / temporal-coupling pre-signal) ------------
// File pairs that change together across history but share no static import edge.
// Same `git log` source as churn-hotspots, but commit boundaries are preserved
// (one record per commit, sentinel-delimited) so we can build a co-occurrence matrix.
const COMMIT_DELIM = "@@@COMMIT@@@"; // no source filename starts with this
const sourceSet = new Set(locByFile.keys());
const coRaw = safe([
	"log", `--since=${CHURN_DAYS}.days`, "--name-only", "--find-renames", `--pretty=format:${COMMIT_DELIM}`, "--", target,
]);
if (coRaw) {
	const pairSupport = new Map(); // "a\u0000b" (sorted) -> shared-commit count
	const fileChanges = new Map(); // file -> total commits it appears in (within source set)
	let current = null;
	const flush = (files) => {
		if (!files || files.length === 0) return;
		if (files.length > CO_CHANGE_COMMIT_CAP) return; // bulk/refactor commit — not coupling signal
		const uniq = [...new Set(files)];
		for (const f of uniq) fileChanges.set(f, (fileChanges.get(f) ?? 0) + 1);
		for (let i = 0; i < uniq.length; i += 1) {
			for (let j = i + 1; j < uniq.length; j += 1) {
				const key = uniq[i] < uniq[j] ? `${uniq[i]}\u0000${uniq[j]}` : `${uniq[j]}\u0000${uniq[i]}`;
				pairSupport.set(key, (pairSupport.get(key) ?? 0) + 1);
			}
		}
	};
	for (const line of coRaw.split("\n")) {
		if (line.startsWith(COMMIT_DELIM)) { flush(current); current = []; continue; } // COMMIT_DELIM line begins a new commit record
		const p = toPosix(line.trim());
		if (!p || !sourceSet.has(p)) continue;
		current?.push(p);
	}
	flush(current); // final commit

	// Import-link heuristic: a pair is NOT hidden coupling if either file references
	// the other's stem (an explicit, known dependency). Stopword/short stems are too
	// generic to test reliably, so a pair resting only on those is treated as unlinked.
	const textCache = new Map();
	const cachedText = (f) => {
		if (!textCache.has(f)) textCache.set(f, (readText(f) ?? "").toLowerCase());
		return textCache.get(f);
	};
	const stemOf = (p) => baseOf(p).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
	const refsStem = (text, stem) =>
		stem.length >= 4 && !DUP_STOPWORDS.has(stem) && text.includes(stem);
	const importLinked = (a, b) =>
		refsStem(cachedText(a), stemOf(b)) || refsStem(cachedText(b), stemOf(a));

	const scored = [];
	for (const [key, support] of pairSupport) {
		if (support < CO_CHANGE_MIN_SUPPORT) continue;
		const [a, b] = key.split("\u0000");
		const denom = Math.min(fileChanges.get(a) ?? support, fileChanges.get(b) ?? support) || support;
		const conf = support / denom;
		if (conf < CO_CHANGE_MIN_CONF) continue;
		scored.push({ a, b, support, conf });
	}
	scored.sort((x, y) => y.support - x.support || y.conf - x.conf);
	for (const s of scored.slice(0, CO_CHANGE_EXAMINE_CAP)) {
		if (importLinked(s.a, s.b)) continue; // explicit dependency — not hidden
		result.coChange.push(s);
		if (result.coChange.length >= CO_CHANGE_OUT_CAP) break;
	}
}

emit();

// --- Emit -------------------------------------------------------------------
function emit() {
	const head = [
		`target:       ${result.target}`,
		`file_count:   ${result.file_count}`,
		`loc_total:    ${result.loc_total}`,
		`loc_median:   ${result.loc_median}`,
		`loc_p90:      ${result.loc_p90}`,
		`churn_window: ${result.churn_window}`,
	];
	if (result.note) head.push(`note:         ${result.note}`);

	let body = `${head.join("\n")}\n`;
	const budget = { bytes: body.length };

	const block = (label, rows) => {
		let out = `---${label}---\n`;
		let count = 0;
		for (const row of rows) {
			const next = `${row}\n`;
			if (budget.bytes + out.length + next.length > OUT_BYTE_CAP) break;
			if (count >= OUT_LINE_CAP) break;
			out += next;
			count += 1;
		}
		if (count < rows.length) out += `(... ${rows.length - count} more truncated ...)\n`;
		budget.bytes += out.length;
		body += out;
	};

	block("size-outliers", result.sizeOutliers.map((r) => `${r.f}\t${r.loc}\t${r.x}x`));
	block("godfile-candidates", result.godfileCandidates.map((r) => `${r.f}\t${r.loc}\t${r.x}x\tcats=${r.cats}\tcoh=${r.coh === null ? "?" : r.coh.toFixed(2)}\t${r.reason}`));
	block("low-cohesion", result.lowCohesion.map((r) => `${r.f}\tcoh=${r.coh.toFixed(2)}\tsyms=${r.syms}\tislands=${r.islands}`));
	block("feature-envy-candidates", result.featureEnvy.map((r) => `${r.f}\tenvies=${r.module}\text=${r.ext}\town=${r.own}\tratio=${r.ratio.toFixed(2)}`));
	block("churn-hotspots", result.churnHotspots.map((r) => `${r.f}\t${r.c}`));
	block("export-usage", result.exportUsage.map((r) => `${r.f}\texports=${r.exports}\tinbound=${r.inbound === null ? "?" : r.inbound}`));
	block("test-density", result.testDensity.map((r) => `${r.f}\tcases=${r.cases}\tasserts=${r.asserts}\tratio=${r.ratio}`));
	block("dup-candidates", result.dupCandidates.map((r) => `${r.a} | ${r.b}\tshared=${r.shared}\toverlap=${r.overlap.toFixed(2)}`));
	block("co-change-candidates", result.coChange.map((r) => `${r.a} | ${r.b}\tsupport=${r.support}\tconf=${r.conf.toFixed(2)}`));

	process.stdout.write(body);
	process.exit(0);
}
