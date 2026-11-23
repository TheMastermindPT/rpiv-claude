// python-semantic.mjs — pyright-backed semantic signals for Python (FR19; D59–D63 of the
// Python-support design, S10-python-semantic): the Python counterparts of semantic.mjs's
// `dead-exports-semantic` and `feature-envy-semantic` blocks, in the same row shapes, so
// warrant.mjs reads them unchanged.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/python-semantic.mjs" "<target>"
//
// It starts `pyright-langserver --stdio` from the project root's `.venv`, else from PATH
// (the binary Claude Code's pyright LSP plugin uses), and asks `textDocument/references`
// once per public top-level symbol (`def`, `class`, `UPPER_CASE =`, not `_`-prefixed) of
// the tracked non-test `.py` files under the target. Read-only: no file is opened for
// editing or written. rpiv adds no dependency; with no langserver it is `unavailable`.
//
// From the same references:
//   ---dead-exports-semantic---  <file>:<name> \t kind=<function|class|constant> \t extRefs=0
//       no reference from another file, apart from names in the module's `__all__`. A
//       candidate, never a finding: a library's public API is often used only outside it.
//   ---feature-envy-semantic---  <file> \t envies=<module file> \t ext=N \t own=M \t ratio=R
//                                \t behavioralRefs=B \t dataRefs=D
//       a file's references to one module's symbols (behavioral: def/class; data: a
//       constant) against references to its own symbols, with semantic.mjs's gates.
//       References on `import`/`from` lines are skipped.
//
// Output always ends with `---semantic-status---` before the blocks: `ran-partial: python
// via pyright — …` on a run, or `unavailable: <why>` / `broken: <why>` with no block. It
// never prints the write-sites, type-fragmentation or projection blocks, which warrant
// would read as measured and clean. Always exits 0.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { venvTool } from "./import-contracts.mjs";
import { ENVY_MIN_BEH, ENVY_MIN_RATIO, ENVY_MIN_REFS, isTest } from "./source-set.mjs";
import { resolveTargets, toPosix } from "./target-context.mjs";

const MAX_FILES = 4000; // like semantic.mjs's SEMANTIC_MAX_FILES
const MAX_SYMBOLS = 5000; // references requests per run
const REQUEST_MS = 30_000;

const status = (line) => {
	process.stdout.write(`---semantic-status---\n${line}\n`);
	process.exit(0);
};

/** The langserver command: the root's `.venv` one, else one on PATH (D59). */
const langserver = (root) => {
	const venv = venvTool(root, "pyright-langserver");
	if (venv) return { command: venv, args: ["--stdio"], from: ".venv" };
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const js = join(dir, "node_modules", "pyright", "langserver.index.js");
		if (existsSync(js)) return { command: process.execPath, args: [js, "--stdio"], from: "PATH" };
		const bin = join(dir, "pyright-langserver");
		if (process.platform !== "win32" && existsSync(bin)) return { command: bin, args: ["--stdio"], from: "PATH" };
	}
	return null;
};

/** A minimal LSP client over the server's stdio: `request`, `notify`, `close`. */
const lspClient = ({ command, args }, onExit) => {
	const server = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
	let buf = Buffer.alloc(0);
	let nextId = 1;
	const waiting = new Map();
	const send = (msg) => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
		server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		server.stdin.write(body);
	};
	const answer = (msg) => {
		// Server-to-client requests get defaults: null settings for each configuration item.
		const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null;
		send({ id: msg.id, result });
	};
	const handle = (msg) => {
		if (msg.method !== undefined && msg.id !== undefined) answer(msg);
		else if (msg.id !== undefined && waiting.has(msg.id)) {
			waiting.get(msg.id)(msg.result ?? null);
			waiting.delete(msg.id);
		}
	};
	server.stdout.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			const headEnd = buf.indexOf("\r\n\r\n");
			if (headEnd < 0) return;
			const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, headEnd).toString())?.[1] ?? 0);
			if (buf.length < headEnd + 4 + len) return;
			handle(JSON.parse(buf.subarray(headEnd + 4, headEnd + 4 + len).toString()));
			buf = buf.subarray(headEnd + 4 + len);
		}
	});
	server.on("error", (e) => onExit(String(e.message)));
	server.on("exit", (code) => onExit(`pyright-langserver exited ${code}`));
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				waiting.delete(id);
				reject(new Error(`${method} timed out`));
			}, REQUEST_MS);
			waiting.set(id, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
			send({ id, method, params });
		});
	const notify = (method, params) => send({ method, params });
	const close = () => {
		server.removeAllListeners("exit");
		server.kill();
	};
	return { request, notify, close };
};

const SYMBOL = /^(?:(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)|class[ \t]+([A-Za-z]\w*)|([A-Z][A-Z0-9_]*)[ \t]*=(?!=))/gm;

/** The names a module lists in `__all__` (declared public API). */
const allOf = (text) => {
	const list = /^__all__[ \t]*=[ \t]*[[(]([^\])]*)[\])]/m.exec(text)?.[1] ?? "";
	return new Set([...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
};

/** A file's public top-level symbols with their 0-based positions. */
const symbolsOf = (file) => {
	const text = file.text;
	const exported = allOf(text);
	const out = [];
	for (const m of text.matchAll(SYMBOL)) {
		const name = m[1] ?? m[2] ?? m[3];
		const kind = m[1] ? "function" : m[2] ? "class" : "constant";
		// A def/class match ends at its name; a constant match starts with it.
		const at = m.index + (m[3] ? 0 : m[0].length - name.length);
		const before = text.slice(0, at);
		const line = before.split("\n").length - 1;
		out.push({ file, name, kind, line, character: at - (before.lastIndexOf("\n") + 1), public: exported.has(name) });
	}
	return out;
};

/** The tracked `.py` files of the root: absolute path, run-folder path, text, lines. */
const programOf = (root, relOf) => {
	const res = spawnSync("git", ["ls-files", "-z", "--", "*.py"], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (res.status !== 0) return [];
	return res.stdout
		.split("\0")
		.filter(Boolean)
		.map((p) => {
			const abs = toPosix(join(root, p));
			const text = readFileSync(abs, "utf-8");
			return { abs, rel: relOf(abs), text, lines: text.split(/\r?\n/) };
		});
};

const keyOf = (path) => toPosix(path).toLowerCase();
const IMPORT_LINE = /^\s*(?:from|import)\s/;

/** Count each reference of `symbol` into the dead check, `own` and `lean`. */
const countReferences = (symbol, refs, byKey, tally) => {
	let outside = 0;
	for (const ref of refs) {
		const from = byKey.get(keyOf(fileURLToPath(ref.uri)));
		if (!from) continue; // outside the program (site-packages, stubs)
		if (IMPORT_LINE.test(from.lines[ref.range.start.line] ?? "")) {
			if (from !== symbol.file) outside += 1; // an import still uses the name
			continue;
		}
		if (from === symbol.file) {
			tally.own.set(from.rel, (tally.own.get(from.rel) ?? 0) + 1);
			continue;
		}
		outside += 1;
		const lean = tally.lean.get(from.rel) ?? new Map();
		const bucket = lean.get(symbol.file.rel) ?? { beh: 0, data: 0 };
		bucket[symbol.kind === "constant" ? "data" : "beh"] += 1;
		lean.set(symbol.file.rel, bucket);
		tally.lean.set(from.rel, lean);
	}
	return outside;
};

/** semantic.mjs's envy row for one file, or null below its gates. */
const envyRow = (f, lean, own) => {
	let best = null;
	for (const [mod, { beh, data }] of lean) {
		if (!best || beh > best.beh || (beh === best.beh && beh + data > best.ext)) best = { mod, beh, data, ext: beh + data };
	}
	if (!best || best.beh < ENVY_MIN_BEH || best.ext < ENVY_MIN_REFS) return null;
	const ratio = best.ext / (best.ext + own || 1);
	return ratio >= ENVY_MIN_RATIO ? { f, ...best, own, ratio } : null;
};

const main = async () => {
	const { projectRoot: root, relOf, underAny } = resolveTargets(process.argv.slice(2));
	const server = langserver(root);
	if (!server) status("unavailable: no pyright-langserver (project .venv or PATH)");
	const program = programOf(root, relOf);
	if (program.length > MAX_FILES) status(`unavailable: project too large (${program.length} files > ${MAX_FILES})`);
	const targetFiles = program.filter((f) => underAny(f.rel) && !isTest(f.rel));
	if (!targetFiles.length) status("unavailable: no Python files under the target");
	const symbols = targetFiles.flatMap(symbolsOf);
	const capped = symbols.length > MAX_SYMBOLS;
	const byKey = new Map(program.map((f) => [keyOf(f.abs), f]));

	let crashed = "";
	const lsp = lspClient(server, (why) => {
		crashed = why;
	});
	const rootUri = pathToFileURL(root).href;
	await lsp.request("initialize", {
		processId: process.pid,
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: "project" }],
		capabilities: { workspace: { configuration: true } },
	});
	lsp.notify("initialized", {});
	// pyright searches only the files it has loaded: without opening every program file,
	// references come back partial (found in the S10 build; the spike's no-open runs
	// undercounted). didOpen hands it the text in memory; nothing is written.
	for (const f of program) {
		lsp.notify("textDocument/didOpen", {
			textDocument: { uri: pathToFileURL(f.abs).href, languageId: "python", version: 1, text: f.text },
		});
	}

	const tally = { own: new Map(), lean: new Map() };
	const dead = [];
	let skipped = 0;
	for (const symbol of symbols.slice(0, MAX_SYMBOLS)) {
		if (crashed) break;
		try {
			const refs = await lsp.request("textDocument/references", {
				textDocument: { uri: pathToFileURL(symbol.file.abs).href },
				position: { line: symbol.line, character: symbol.character },
				context: { includeDeclaration: false },
			});
			const outside = countReferences(symbol, refs ?? [], byKey, tally);
			if (outside === 0 && !symbol.public) dead.push(symbol);
		} catch {
			skipped += 1;
		}
	}
	lsp.close();
	if (crashed) status(`broken: ${crashed}`);

	const envy = targetFiles
		.map((f) => envyRow(f.rel, tally.lean.get(f.rel) ?? new Map(), tally.own.get(f.rel) ?? 0))
		.filter(Boolean)
		.sort((a, b) => b.beh - a.beh || b.ext - a.ext || a.f.localeCompare(b.f));
	dead.sort((a, b) => a.file.rel.localeCompare(b.file.rel) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const out = [
		`semantic_engine:  pyright-langserver (${server.from})`,
		`files_in_program: ${program.length}`,
		`files_in_target:  ${targetFiles.length}`,
		`dead_export_scan: examined=${Math.min(symbols.length, MAX_SYMBOLS)} capped=${capped} skipped_on_error=${skipped}`,
		"---semantic-status---",
		"ran-partial: python via pyright — dead exports and feature envy only (no write-sites, type-fragmentation or projection signals for Python)",
		"---feature-envy-semantic---",
		...envy.map((r) => `${r.f}\tenvies=${r.mod}\text=${r.ext}\town=${r.own}\tratio=${r.ratio.toFixed(2)}\tbehavioralRefs=${r.beh}\tdataRefs=${r.data}`),
		"---dead-exports-semantic---",
		...dead.map((s) => `${s.file.rel}:${s.name}\tkind=${s.kind}\textRefs=0`),
	];
	process.stdout.write(`${out.join("\n")}\n`);
	process.exit(0);
};

main().catch((e) => status(`broken: ${String(e?.message ?? e).split("\n")[0]}`));
