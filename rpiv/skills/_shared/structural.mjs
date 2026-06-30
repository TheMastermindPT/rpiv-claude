// structural.mjs — OPTIONAL read-only structural-search runner for the rpiv review/research skills.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/structural.mjs" --tool <ast-grep|opengrep|rg> [query] <target>
//
// A THIN GENERIC per-query runner: the orchestrator (which holds the lens-specific patterns)
// invokes it once per query. The helper runs ONE tool READ-ONLY, scans from the repo ROOT, filters
// hits to <target>, and normalizes the tool's JSON into the uniform `---<tool>---` block grammar
// (1-based file:line) the Slop Map already parses. Mirrors semantic.mjs's stdout contract:
//   ---<tool>---            <relpath>:<line> \t <key=val ...> \t <verbatim>
//   ---structural-status--- unavailable: <reason>   (binary absent / no query / no JSON)
//
// Per-tool queries:
//   --tool ast-grep --pattern '<PAT>' --lang <LANG>   (ast-grep run; structural AST match)
//   --tool ast-grep --config <sgconfig.yml>           (ast-grep scan; rule file/dir)
//   --tool opengrep --config <auto|p/...|path>        (opengrep scan; rule config)
//   --tool rg       --pattern '<REGEX>'               (ripgrep; line search)
//
// READ-ONLY: builds explicit arg arrays; NEVER passes a mutate flag (rewrite / update-all /
// interactive / autofix). Always exits 0 — every failure path collapses to a status line.

import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

const OUT_LINE_CAP = 200;
const OUT_BYTE_CAP = 40 * 1024;
const toPosix = (p) => p.replaceAll("\\", "/");

// --- parse argv -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ""; };
const tool = opt("--tool");
const pattern = opt("--pattern");
const lang = opt("--lang");
const config = opt("--config");
const flagged = new Set();
for (const n of ["--tool", "--pattern", "--lang", "--config"]) {
	const i = argv.indexOf(n);
	if (i >= 0) { flagged.add(i); flagged.add(i + 1); }
}
const positional = argv.filter((a, i) => !flagged.has(i) && !a.startsWith("--"));
const targetArg = positional[positional.length - 1] || ".";

// Run a binary; shell:false first (clean arg passing for real .exe binaries), fall back to
// shell:true on win32 ONLY if the launch itself failed (a .cmd/.bat shim needs a shell). NOTE:
// under that win32 shell:true fallback, space/metachar patterns may be re-split by cmd.exe — pass
// simple patterns when a tool resolves to a .cmd shim on Windows.
const spawn = (bin, args, cwd) => {
	let r = spawnSync(bin, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (r.error && process.platform === "win32") {
		r = spawnSync(bin, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, shell: true });
	}
	return r;
};
const top = spawn("git", ["rev-parse", "--show-toplevel"], process.cwd());
const root = top.status === 0 ? toPosix(top.stdout.trim()) : toPosix(process.cwd());
const targetAbs = toPosix(isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg));
const run = (bin, args) => spawn(bin, args, root);
const present = (names) => names.find((b) => { const r = run(b, ["--version"]); return !r.error && r.status === 0; }) || "";

const status = (msg) => { process.stdout.write(`---structural-status---\n${msg}\n`); process.exit(0); };
if (!tool) status("unavailable: no --tool given (expected ast-grep | opengrep | rg)");

const underTarget = (p) => { const abs = toPosix(isAbsolute(p) ? p : resolve(root, p)); return abs === targetAbs || abs.startsWith(`${targetAbs}/`); };
const relOf = (file) => toPosix(relative(root, resolve(root, file)));
const decode = (node) => node?.text ?? (node?.bytes ? Buffer.from(node.bytes, "base64").toString("utf-8") : "");

const rows = [];
let label = "";

if (tool === "ast-grep") {
	if (!pattern && !config) status("unavailable: ast-grep needs --pattern (+ --lang) or --config");
	label = "ast-grep";
	const bin = present(["ast-grep", "sg"]);
	if (!bin) status("unavailable: ast-grep not on PATH (install ast-grep)");
	const args = pattern
		? ["run", "--pattern", pattern, ...(lang ? ["--lang", lang] : []), "--json=stream", "."]
		: ["scan", "--config", config, "--json=stream", "."];
	const res = run(bin, args);
	for (const line of (res.stdout || "").split("\n")) {
		const s = line.trim();
		if (!s.startsWith("{")) continue;
		let m; try { m = JSON.parse(s); } catch { continue; }
		const file = m.file ?? "";
		if (!file || !underTarget(file)) continue;
		const lineNo = (m.range?.start?.line ?? 0) + 1; // ast-grep offsets are ZERO-based
		const text = String(m.text ?? m.lines ?? "").split("\n")[0].trim();
		rows.push(`${relOf(file)}:${lineNo}\t${text}`);
	}
} else if (tool === "opengrep") {
	if (!config) status("unavailable: opengrep needs --config (e.g. auto, p/security-audit, or a local path)");
	label = "opengrep";
	const bin = present(["opengrep", "semgrep"]);
	if (!bin) status("unavailable: opengrep not on PATH (install opengrep)");
	const res = run(bin, ["scan", "--config", config, "--json", "."]);
	const raw = res.stdout || "";
	const i = raw.indexOf("{");
	let parsed; try { parsed = JSON.parse(i >= 0 ? raw.slice(i) : raw); }
	catch { status(`unavailable: opengrep produced no JSON (config=${config}; registry configs like auto/p/* need network)`); }
	for (const r of parsed.results ?? []) {
		const file = r.path ?? "";
		if (!file || !underTarget(file)) continue;
		const lineNo = r.start?.line ?? 0; // opengrep lines are 1-based
		const sev = r.extra?.severity ?? "";
		const msg = String(r.extra?.message ?? "").split("\n")[0].trim();
		rows.push(`${relOf(file)}:${lineNo}\tcheck=${r.check_id ?? "?"}\tseverity=${sev}\t${msg}`);
	}
} else if (tool === "rg") {
	if (!pattern) status("unavailable: rg needs --pattern");
	label = "rg";
	if (!present(["rg"])) status("unavailable: rg not on PATH (install ripgrep)");
	const res = run("rg", ["--json", pattern, "."]);
	for (const line of (res.stdout || "").split("\n")) {
		const s = line.trim();
		if (!s.startsWith("{")) continue;
		let ev; try { ev = JSON.parse(s); } catch { continue; }
		if (ev.type !== "match") continue;
		const d = ev.data ?? {};
		const file = decode(d.path); // handles {text} and {bytes} (base64)
		if (!file || !underTarget(file)) continue;
		const lineNo = d.line_number ?? 0; // rg line numbers are 1-based
		const text = decode(d.lines).replace(/\r?\n$/, "").trim();
		rows.push(`${relOf(file)}:${lineNo}\t${text}`);
	}
} else {
	status(`unavailable: unknown --tool "${tool}" (expected ast-grep | opengrep | rg)`);
}

// --- emit (bounded) ---------------------------------------------------------
const head = [
	`target:  ${toPosix(relative(root, targetAbs)) || "."}`,
	`tool:    ${tool}`,
	`query:   ${pattern || config || "(none)"}`,
	`matches: ${rows.length}`,
];
let body = `${head.join("\n")}\n---${label}---\n`;
let count = 0;
for (const r of rows) {
	const next = `${r}\n`;
	if (body.length + next.length > OUT_BYTE_CAP || count >= OUT_LINE_CAP) break;
	body += next;
	count += 1;
}
if (count < rows.length) body += `(... ${rows.length - count} more truncated ...)\n`;
process.stdout.write(body);
process.exit(0);
