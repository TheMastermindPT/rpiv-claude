// structural.mjs — OPTIONAL read-only structural-search runner for the rpiv review/research skills.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/structural.mjs" --tool <ast-grep|opengrep|rg> [query] <target>
//
// A THIN GENERIC per-query runner: the orchestrator (which holds the lens-specific patterns)
// invokes it once per query. The helper runs ONE tool READ-ONLY from the repo ROOT (opengrep
// takes <target> as its scan root; ast-grep and rg scan "."), filters hits to <target>, and normalizes the tool's JSON into the uniform `---<tool>---` block grammar
// (1-based file:line) the Slop Map already parses. Mirrors semantic.mjs's stdout contract:
//   ---<tool>---            <relpath>:<line> \t <key=val ...> \t <verbatim>
//   ---structural-status--- unavailable: <reason>   (binary absent / no query / registry offline)
//   ---structural-status--- broken: <reason>        (the tool ran and FAILED — bad lang, bad
//                                                    rule, crash, unreadable output). NEVER
//                                                    "matches: 0": a failed run is not an answer.
//   warning: <first stderr line>   (header line; the run succeeded but the tool complained,
//                                   e.g. a pattern ast-grep parsed with an ERROR node)
//
// Per-tool queries:
//   --tool ast-grep --pattern '<PAT>' --lang <LANG>   (ast-grep run; structural AST match)
//   --tool ast-grep --config <sgconfig.yml|rule.yml>  (ast-grep scan; an sgconfig with ruleDirs
//                                                     goes to --config, a single rule file to --rule)
//   --tool opengrep --config <auto|p/...|path>        (opengrep scan; rule config)
//   --tool rg       --pattern '<REGEX>'               (ripgrep; line search)
//
// READ-ONLY: builds explicit arg arrays; NEVER passes a mutate flag (rewrite / update-all /
// interactive / autofix). Always exits 0 — every failure path collapses to a status line.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

const OUT_LINE_CAP = 200;
const OUT_BYTE_CAP = 40 * 1024;
const toPosix = (p) => p.replaceAll("\\", "/");

// --- parse argv -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
};
const tool = opt("--tool");
const pattern = opt("--pattern");
const lang = opt("--lang");
const config = opt("--config");
const flagged = new Set();
for (const n of ["--tool", "--pattern", "--lang", "--config"]) {
	const i = argv.indexOf(n);
	if (i >= 0) {
		flagged.add(i);
		flagged.add(i + 1);
	}
}
const positional = argv.filter(
	(a, i) => !flagged.has(i) && !a.startsWith("--"),
);
const targetArg = positional[positional.length - 1] || ".";

// Run a binary WITHOUT a raw shell. On Windows an npm-installed tool is a .cmd shim, which
// needs cmd.exe; a plain `shell: true` passes the pattern unquoted, so cmd.exe reads `>` as a
// redirect (writing a file into the scanned repo) and splits on spaces. cross-spawn resolves
// the shim and escapes every argument for cmd.exe. Without cross-spawn we never fall back to a
// raw shell: a .cmd shim then fails to launch and reports as not launchable.
const require = createRequire(import.meta.url);
const loadCrossSpawn = () => {
	try {
		return require("cross-spawn").sync;
	} catch {
		return null;
	}
};
const crossSpawn = loadCrossSpawn();
const spawnImpl = crossSpawn ?? spawnSync;
const spawn = (bin, args, cwd) =>
	spawnImpl(bin, args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
const firstLine = (text) =>
	String(text ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean) ?? "";
// A run FAILED when it could not launch, was killed, or exited outside the tool's
// success codes (ast-grep and rg: 0 = matches, 1 = no matches, >= 2 = error).
const failureOf = (res, okCodes) => {
	if (res.error) return res.error.message;
	if (res.status === null) return `killed by ${res.signal ?? "a signal"}`;
	if (okCodes.includes(res.status)) return "";
	return `exit ${res.status}: ${firstLine(res.stderr) || "(no stderr)"}`;
};
const top = spawn("git", ["rev-parse", "--show-toplevel"], process.cwd());
const root =
	top.status === 0 ? toPosix(top.stdout.trim()) : toPosix(process.cwd());
// Target resolution: try cwd-relative first (the historical contract), then
// repo-root-relative. Without the fallback, a root-relative target passed from
// a subdirectory doubles the prefix (rpiv/rpiv/...) and silently filters every
// hit — matches: 0 as a LIE, not an answer.
const resolveTarget = (arg) => {
	if (isAbsolute(arg)) return toPosix(arg);
	const fromCwd = toPosix(resolve(process.cwd(), arg));
	if (existsSync(fromCwd)) return fromCwd;
	const fromRoot = toPosix(resolve(root, arg));
	if (existsSync(fromRoot)) return fromRoot;
	return fromCwd;
};
const targetAbs = resolveTarget(targetArg);
const targetRel = toPosix(relative(root, targetAbs)) || ".";
const run = (bin, args) => spawn(bin, args, root);
const present = (names) =>
	names.find((b) => {
		const r = run(b, ["--version"]);
		return !r.error && r.status === 0;
	}) || "";
// On Windows, without cross-spawn a .cmd shim (npm-installed ast-grep) cannot launch at all.
// That is a missing plugin dependency, not a missing tool: say so instead of "not on PATH".
const onPathButUnlaunchable = (names) =>
	!crossSpawn &&
	process.platform === "win32" &&
	names.some(
		(b) => spawnSync("where", [b], { encoding: "utf-8" }).status === 0,
	);
const requireTool = (names, absentMsg) => {
	const bin = present(names);
	if (bin) return bin;
	if (onPathButUnlaunchable(names))
		status(
			`broken: ${names[0]} is on PATH but cannot be launched without cross-spawn (run pnpm install in the plugin)`,
		);
	status(`unavailable: ${absentMsg}`);
	return "";
};

const status = (msg) => {
	process.stdout.write(`---structural-status---\n${msg}\n`);
	process.exit(0);
};
if (!tool)
	status("unavailable: no --tool given (expected ast-grep | opengrep | rg)");
// A target that does not exist (a typo) would filter every hit away: a failed call, not "0".
if (!existsSync(targetAbs))
	status(`broken: target does not exist: ${targetArg}`);

const isRegistryConfig = (c) =>
	c === "auto" || /^(p|r|s)\//.test(c) || /^https?:\/\//.test(c);

const underTarget = (p) => {
	const abs = toPosix(isAbsolute(p) ? p : resolve(root, p));
	return abs === targetAbs || abs.startsWith(`${targetAbs}/`);
};
const relOf = (file) => toPosix(relative(root, resolve(root, file)));
const decode = (node) =>
	node?.text ??
	(node?.bytes ? Buffer.from(node.bytes, "base64").toString("utf-8") : "");

const rows = [];
const warnings = [];
let label = "";
let unparsed = 0;
let nonJson = 0;
// JSON-lines output: a line that starts like JSON but does not parse is a DROPPED
// candidate, counted so it surfaces as a warning instead of vanishing. A non-blank line
// that is not JSON at all is counted too: it means the tool never got its --json flag
// (e.g. cmd.exe cut a multi-line pattern at the newline and dropped the rest).
const jsonLines = (stdout) => {
	const out = [];
	for (const line of (stdout || "").split("\n")) {
		const s = line.trim();
		if (!s) continue;
		if (!s.startsWith("{")) {
			nonJson += 1;
			continue;
		}
		try {
			out.push(JSON.parse(s));
		} catch {
			unparsed += 1;
		}
	}
	return out;
};
const warnFromStderr = (res) => {
	const w = firstLine(res.stderr);
	if (w) warnings.push(w);
};

// Windows: does `bin` resolve only to a .cmd/.bat shim (no real .exe on PATH)?
const launchesThroughCmd = (bin) => {
	if (process.platform !== "win32") return false;
	const found = spawnSync("where", [bin], { encoding: "utf-8" }).stdout ?? "";
	const hits = found.split(/\r?\n/).filter(Boolean);
	return !hits.some((h) => /\.exe$/i.test(h)) && hits.some((h) => /\.(cmd|bat)$/i.test(h));
};
// `--config` takes an sgconfig file (with `ruleDirs:`); a single RULE file passed there
// loads zero rules and silently matches nothing, so a rule file goes through `--rule`.
const configArgs = (c) => {
	const abs = resolveTarget(c);
	const isRuleFile =
		existsSync(abs) &&
		statSync(abs).isFile() &&
		!/^ruleDirs\s*:/m.test(readFileSync(abs, "utf-8"));
	return isRuleFile ? ["--rule", abs] : ["--config", c];
};
const SCAN_SUMMARY =
	/^\s*(Error: \d+ error\(s\) found in code\.|Warning: \d+ warning\(s\) found in code\.|Help: Scan succeeded.*)\s*$/;
const withoutScanSummary = (stderr) =>
	String(stderr ?? "")
		.split("\n")
		.filter((l) => !SCAN_SUMMARY.test(l))
		.join("\n");

if (tool === "ast-grep") {
	if (!pattern && !config)
		status("unavailable: ast-grep needs --pattern (+ --lang) or --config");
	label = "ast-grep";
	const bin = requireTool(
		["ast-grep", "sg"],
		"ast-grep not on PATH (install ast-grep)",
	);
	// cmd.exe ends a command line at the first newline, so a multi-line pattern sent to the
	// npm .cmd shim loses the rest of the pattern AND every later flag; when the leftover
	// matches nothing the output is simply empty. Refuse it up front instead of guessing.
	if (pattern && /[\r\n]/.test(pattern) && launchesThroughCmd(bin))
		status(
			"broken: a multi-line --pattern cannot pass through the Windows .cmd shim (cmd.exe cuts it at the newline) — use a single-line pattern or a --config rule file",
		);
	const args = pattern
		? [
				"run",
				"--pattern",
				pattern,
				...(lang ? ["--lang", lang] : []),
				"--json=stream",
				".",
			]
		: ["scan", ...configArgs(config), "--json=stream", "."];
	const res = run(bin, args);
	const failed = failureOf(res, [0, 1]);
	if (failed) status(`broken: ast-grep ${failed}`);
	// `scan` reports error-severity hits on stderr ("Error: N error(s) found in code.") and
	// exits 1 even on success; that summary is the answer, not a complaint about the query.
	warnFromStderr({ ...res, stderr: withoutScanSummary(res.stderr) });
	const matches = jsonLines(res.stdout);
	if (nonJson > 0 && matches.length === 0)
		status(
			"broken: ast-grep printed non-JSON output, so its arguments were cut (a multi-line pattern through the Windows .cmd shim?) — use a single-line pattern or a --config rule file",
		);
	for (const m of matches) {
		const file = m.file ?? "";
		if (!file || !underTarget(file)) continue;
		const lineNo = (m.range?.start?.line ?? 0) + 1; // ast-grep offsets are ZERO-based
		const text = String(m.text ?? m.lines ?? "")
			.split("\n")[0]
			.trim();
		rows.push(`${relOf(file)}:${lineNo}\t${text}`);
	}
} else if (tool === "opengrep") {
	if (!config)
		status(
			"unavailable: opengrep needs --config (e.g. auto, p/security-audit, or a local path)",
		);
	label = "opengrep";
	const bin = requireTool(
		["opengrep", "semgrep"],
		"opengrep not on PATH (install opengrep)",
	);
	// The target is the scan root (odin#15): scanning "." and filtering afterwards made
	// every call pay for the whole repo and carried unrelated files' parse errors and
	// timeouts into every target's warnings. cwd stays the repo root, so the rule
	// config and .semgrepignore still resolve as before.
	const res = run(bin, ["scan", "--config", config, "--json", targetRel]);
	const raw = res.stdout || "";
	const i = raw.indexOf("{");
	let parsed;
	try {
		parsed = JSON.parse(i >= 0 ? raw.slice(i) : raw);
	} catch {
		// A registry config (auto, p/..., r/..., a URL) needs the network: no JSON there
		// is an absent registry. A LOCAL config that yields no JSON is a failed run.
		if (isRegistryConfig(config))
			status(
				`unavailable: opengrep produced no JSON (config=${config}; registry configs need network)`,
			);
		status(
			`broken: opengrep produced no JSON (config=${config}; ${failureOf(res, [0, 1]) || firstLine(res.stderr) || "empty output"})`,
		);
	}
	const results = parsed.results ?? [];
	// An error tied to a file outside the target is not this target's problem; a
	// pathless one (a bad rule, a crash) still is.
	const errors = (parsed.errors ?? []).filter(
		(e) => !e?.path || underTarget(e.path),
	);
	const failed = failureOf(res, [0, 1]);
	if (failed && results.length === 0) {
		const first = errors.length
			? ` (first error: ${firstLine(errors[0]?.message)})`
			: "";
		status(`broken: opengrep ${failed}${first}`);
	}
	if (errors.length)
		warnings.push(
			`${errors.length} opengrep scan error(s); first: ${firstLine(errors[0]?.message) || "?"}`,
		);
	for (const r of results) {
		const file = r.path ?? "";
		if (!file || !underTarget(file)) continue;
		const lineNo = r.start?.line ?? 0; // opengrep lines are 1-based
		const sev = r.extra?.severity ?? "";
		const msg = String(r.extra?.message ?? "")
			.split("\n")[0]
			.trim();
		rows.push(
			`${relOf(file)}:${lineNo}\tcheck=${r.check_id ?? "?"}\tseverity=${sev}\t${msg}`,
		);
	}
} else if (tool === "rg") {
	if (!pattern) status("unavailable: rg needs --pattern");
	label = "rg";
	requireTool(["rg"], "rg not on PATH (install ripgrep)");
	// `-e` keeps a pattern that starts with "-" from being read as an rg flag.
	const res = run("rg", ["--json", "-e", pattern, "--", "."]);
	// rg exits 2 for ANY error, including one unreadable file in an otherwise good scan:
	// keep the matches it did find and warn; with no match at all, the run is broken.
	const failed = failureOf(res, [0, 1, 2]);
	if (failed) status(`broken: rg ${failed}`);
	const events = jsonLines(res.stdout).filter((ev) => ev.type === "match");
	if (res.status === 2) {
		if (events.length === 0)
			status(`broken: rg exit 2: ${firstLine(res.stderr) || "(no stderr)"}`);
		warnings.push(
			`rg exit 2 (partial scan): ${firstLine(res.stderr) || "(no stderr)"}`,
		);
	} else warnFromStderr(res);
	for (const ev of events) {
		const d = ev.data ?? {};
		const file = decode(d.path); // handles {text} and {bytes} (base64)
		if (!file || !underTarget(file)) continue;
		const lineNo = d.line_number ?? 0; // rg line numbers are 1-based
		const text = decode(d.lines)
			.replace(/\r?\n$/, "")
			.trim();
		rows.push(`${relOf(file)}:${lineNo}\t${text}`);
	}
} else {
	status(
		`unavailable: unknown --tool "${tool}" (expected ast-grep | opengrep | rg)`,
	);
}

// --- emit (bounded) ---------------------------------------------------------
const head = [
	`target:  ${targetRel}`,
	`tool:    ${tool}`,
	`query:   ${pattern || config || "(none)"}`,
	`matches: ${rows.length}`,
	...warnings.map((w) => `warning: ${w}`),
	...(unparsed
		? [`warning: ${unparsed} output line(s) could not be parsed (dropped)`]
		: []),
];
let body = `${head.join("\n")}\n---${label}---\n`;
let count = 0;
for (const r of rows) {
	const next = `${r}\n`;
	if (body.length + next.length > OUT_BYTE_CAP || count >= OUT_LINE_CAP) break;
	body += next;
	count += 1;
}
if (count < rows.length)
	body += `(... ${rows.length - count} more truncated ...)\n`;
process.stdout.write(body);
process.exit(0);
