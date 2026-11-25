// tests/structural-status.test.mjs — skills/_shared/structural.mjs must tell a FAILED tool
// run apart from an empty answer (standing decision degrade-distinguishes-broken), and must
// pass patterns to Windows .cmd shims without a raw shell (a `>` in a pattern used to
// become a cmd.exe redirect that wrote a file into the scanned repo).
// The helper is spawned in throwaway git repositories under the OS temp folder.

import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/structural.mjs");
const TEST_TIMEOUT = 120_000;

const onPath = (bin) => {
	const r = crossSpawn.sync(bin, ["--version"], { stdio: "ignore" });
	return !r.error && r.status === 0;
};
const astGrep = onPath("ast-grep") || onPath("sg");
const rg = onPath("rg");
const opengrep = onPath("opengrep");

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A git repo holding one TypeScript file with an arrow function calling fetch. */
const sampleRepo = () => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-structural-"));
	dirs.push(repo);
	writeFileSync(
		join(repo, "a.ts"),
		"const f = () => fetch(1);\nfunction g() { return 2; }\n",
	);
	execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
	return repo;
};

const runHelper = (repo, args) => {
	const r = spawnSync(process.execPath, [HELPER, ...args], {
		cwd: repo,
		encoding: "utf-8",
	});
	return { out: r.stdout, code: r.status };
};

describe("structural.mjs — broken runs are never an empty answer", () => {
	// Each row is a tool run that FAILS: it must answer `broken:` under the status
	// header, never a `matches:` count (and never `unavailable:`, which means absence).
	const BROKEN_RUNS = [
		{
			name: "an unsupported ast-grep --lang",
			present: astGrep,
			args: [
				"--tool",
				"ast-grep",
				"--pattern",
				"fetch($$$)",
				"--lang",
				"cobol",
				".",
			],
			expected: /^---structural-status---\nbroken: ast-grep exit 2: .*cobol/m,
		},
		{
			name: "a missing ast-grep rule config",
			present: astGrep,
			args: ["--tool", "ast-grep", "--config", "missing-rule.yml", "."],
			expected: /^broken: ast-grep exit \d+: /m,
		},
		{
			name: "an invalid rg regex",
			present: rg,
			args: ["--tool", "rg", "--pattern", "(", "."],
			expected: /^broken: rg exit 2: /m,
		},
		{
			name: "a missing LOCAL opengrep config",
			present: opengrep,
			args: ["--tool", "opengrep", "--config", "missing-rules.yml", "."],
			expected: /^broken: opengrep /m,
		},
	];

	it.for(BROKEN_RUNS)(
		"reports $name as broken, with no matches line",
		({ present, args, expected }, { skip }) => {
			if (!present) skip();
			const { out, code } = runHelper(sampleRepo(), args);
			expect(code).toBe(0);
			expect(out).toMatch(expected);
			expect(out).not.toMatch(/matches:|unavailable:/);
		},
		TEST_TIMEOUT,
	);

	it.skipIf(!astGrep)(
		"keeps a successful run with no hits as matches: 0 and no status line",
		() => {
			const { out } = runHelper(sampleRepo(), [
				"--tool",
				"ast-grep",
				"--pattern",
				"zzz($A)",
				"--lang",
				"ts",
				".",
			]);
			expect(out).toMatch(/^matches: 0$/m);
			expect(out).not.toMatch(/structural-status|warning:/);
		},
		TEST_TIMEOUT,
	);

	it.skipIf(!astGrep)(
		"surfaces an ast-grep complaint about the pattern as a warning header",
		() => {
			const { out } = runHelper(sampleRepo(), [
				"--tool",
				"ast-grep",
				"--pattern",
				"((",
				"--lang",
				"ts",
				".",
			]);
			expect(out).toMatch(/^matches: 0$/m);
			expect(out).toMatch(/^warning: .*ERROR node/m);
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps an unknown tool as unavailable (absence, not failure)",
		() => {
			const { out } = runHelper(sampleRepo(), ["--tool", "nope", "."]);
			expect(out).toMatch(/^unavailable: unknown --tool "nope"/m);
		},
		TEST_TIMEOUT,
	);
});

describe("structural.mjs — patterns reach the tool intact", () => {
	it.skipIf(!astGrep)(
		"matches an arrow-function pattern containing > and $ without writing into the repo",
		() => {
			const repo = sampleRepo();
			const before = readdirSync(repo).sort();
			const { out } = runHelper(repo, [
				"--tool",
				"ast-grep",
				"--pattern",
				"() => $B",
				"--lang",
				"ts",
				".",
			]);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(/^a\.ts:1\t\(\) => fetch\(1\)$/m);
			expect(readdirSync(repo).sort()).toEqual(before);
		},
		TEST_TIMEOUT,
	);

	it.skipIf(!rg)(
		"passes a pattern with spaces and shell metacharacters to rg as one argument",
		() => {
			const repo = sampleRepo();
			writeFileSync(join(repo, "b.ts"), "const s = 'a & b | c > d';\n");
			const before = readdirSync(repo).sort();
			const { out } = runHelper(repo, [
				"--tool",
				"rg",
				"--pattern",
				"a & b \\| c > d",
				".",
			]);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(/^b\.ts:1\t/m);
			expect(readdirSync(repo).sort()).toEqual(before);
		},
		TEST_TIMEOUT,
	);
});

describe("structural.mjs — review round 1 regressions", () => {
	// Two cuts: one whose leftover still matches (non-JSON output) and one whose leftover
	// matches nothing (empty output, exit 1) — the second used to read as a clean 0.
	it.skipIf(!astGrep).for(["$A\n> $B", "fetch(\n$A)"])(
		"never answers a clean matches: 0 for the multi-line ast-grep pattern %j",
		(pattern) => {
			const repo = sampleRepo();
			writeFileSync(join(repo, "m.ts"), "const x = a > b;\n");
			const { out } = runHelper(repo, [
				"--tool",
				"ast-grep",
				"--pattern",
				pattern,
				"--lang",
				"ts",
				".",
			]);
			// Either the tool got the whole pattern (a match) or the cut was refused (broken).
			expect(out).toMatch(
				/^matches: [1-9]|^broken: (a multi-line --pattern|ast-grep printed non-JSON)/m,
			);
			expect(out).not.toMatch(/^matches: 0$/m);
		},
		TEST_TIMEOUT,
	);

	it.skipIf(!rg)(
		"searches for an rg pattern that starts with a dash instead of reading it as a flag",
		() => {
			const repo = sampleRepo();
			writeFileSync(join(repo, "d.txt"), "hello -v world\n");
			const { out } = runHelper(repo, ["--tool", "rg", "--pattern", "-v", "."]);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(/^d\.txt:1\thello -v world$/m);
		},
		TEST_TIMEOUT,
	);

	const winRg = rg && process.platform === "win32";
	const denyRead = (file, on) =>
		spawnSync(
			"icacls",
			on
				? [file, "/deny", `${process.env.USERNAME}:(R)`]
				: [file, "/remove:d", process.env.USERNAME],
			{
				stdio: "ignore",
			},
		);

	it.skipIf(!winRg)(
		"keeps rg matches and warns when one file is unreadable (exit 2, partial scan)",
		() => {
			const repo = sampleRepo();
			writeFileSync(join(repo, "ok.txt"), "needle\n");
			writeFileSync(join(repo, "locked.txt"), "needle\n");
			denyRead(join(repo, "locked.txt"), true);
			try {
				const { out } = runHelper(repo, [
					"--tool",
					"rg",
					"--pattern",
					"needle",
					".",
				]);
				expect(out).toMatch(/^matches: 1$/m);
				expect(out).toMatch(/^warning: rg exit 2 \(partial scan\): /m);
				expect(out).toMatch(/^ok\.txt:1\tneedle$/m);
			} finally {
				denyRead(join(repo, "locked.txt"), false);
			}
		},
		TEST_TIMEOUT,
	);

	it.skipIf(!winRg)(
		"reports rg as broken when exit 2 comes with no match at all",
		() => {
			const repo = sampleRepo();
			writeFileSync(join(repo, "locked.txt"), "needle\n");
			denyRead(join(repo, "locked.txt"), true);
			try {
				const { out } = runHelper(repo, [
					"--tool",
					"rg",
					"--pattern",
					"needle",
					".",
				]);
				expect(out).toMatch(/^broken: rg exit 2: /m);
				expect(out).not.toMatch(/matches:/);
			} finally {
				denyRead(join(repo, "locked.txt"), false);
			}
		},
		TEST_TIMEOUT,
	);

	// A copy of the helper outside the plugin cannot load cross-spawn; on Windows an npm
	// ast-grep .cmd shim then cannot launch, which is a missing dependency, not a missing tool.
	// pnpm exports NODE_PATH (the plugin's node_modules) to child processes; drop it so the
	// copied helper resolves like a real copy outside the plugin.
	const { NODE_PATH: _np, ...ENV_NO_NODE_PATH } = process.env;
	const crossSpawnFromTemp =
		spawnSync(process.execPath, ["-e", "require.resolve('cross-spawn')"], {
			cwd: tmpdir(),
			env: ENV_NO_NODE_PATH,
			stdio: "ignore",
		}).status === 0;
	const shimOnly =
		process.platform === "win32" && astGrep && !crossSpawnFromTemp;

	it.skipIf(!shimOnly)(
		"reports an npm ast-grep shim that cannot launch without cross-spawn as broken, not absent",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "rpiv-structural-helper-"));
			dirs.push(dir);
			copyFileSync(HELPER, join(dir, "structural.mjs"));
			const r = spawnSync(
				process.execPath,
				[
					join(dir, "structural.mjs"),
					"--tool",
					"ast-grep",
					"--pattern",
					"fetch($$$)",
					"--lang",
					"ts",
					".",
				],
				{
					cwd: sampleRepo(),
					env: ENV_NO_NODE_PATH,
					encoding: "utf-8",
				},
			);
			expect(r.stdout).toMatch(
				/^broken: ast-grep is on PATH but cannot be launched without cross-spawn/m,
			);
		},
		TEST_TIMEOUT,
	);
});

/**
 * Puts a fake `name` tool first on PATH. It answers `--version` and otherwise prints
 * `stdout`, writes `stderr` and exits `code` — to drive helper paths no real tool reaches.
 */
const stubTool = (name, { stdout = "", stderr = "", code = 0 }) =>
	stubScript(
		name,
		`process.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${code});\n`,
	);
/** Like stubTool, but the fake runs `body` (CommonJS) after answering `--version`. */
const stubScript = (name, body) => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-stub-"));
	dirs.push(dir);
	const script = join(dir, `${name}-stub.cjs`);
	writeFileSync(
		script,
		`if (process.argv[2] === "--version") { console.log("stub 1.0"); process.exit(0); }\n${body}`,
	);
	if (process.platform === "win32") {
		writeFileSync(
			join(dir, `${name}.cmd`),
			`@"${process.execPath}" "${script}" %*\r\n`,
		);
	} else {
		writeFileSync(
			join(dir, name),
			`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
			{ mode: 0o755 },
		);
	}
	const sep = process.platform === "win32" ? ";" : ":";
	return {
		...process.env,
		PATH: `${dir}${sep}${process.env.PATH}`,
		Path: `${dir}${sep}${process.env.PATH ?? process.env.Path}`,
	};
};
const runWithEnv = (repo, args, env) =>
	spawnSync(process.execPath, [HELPER, ...args], {
		cwd: repo,
		env,
		encoding: "utf-8",
	}).stdout;

describe("structural.mjs — review round 2 regressions", () => {
	it.skipIf(!astGrep)(
		"reports a target that does not exist as broken",
		() => {
			const { out } = runHelper(sampleRepo(), [
				"--tool",
				"ast-grep",
				"--pattern",
				"fetch($$$)",
				"--lang",
				"ts",
				"no-such-dir",
			]);
			expect(out).toMatch(/^broken: target does not exist: no-such-dir$/m);
		},
		TEST_TIMEOUT,
	);

	const writeRule = (repo) => {
		mkdirSync(join(repo, "rules"), { recursive: true });
		writeFileSync(
			join(repo, "rules/no-fetch.yml"),
			"id: no-fetch\nlanguage: TypeScript\nseverity: error\nmessage: no fetch\nrule:\n  pattern: fetch($$$)\n",
		);
		writeFileSync(join(repo, "sgconfig.yml"), "ruleDirs:\n  - rules\n");
	};

	it.skipIf(!astGrep).for(["sgconfig.yml", "rules/no-fetch.yml"])(
		"scans with --config %s, finds the error-severity hit, and adds no false warning",
		(config) => {
			const repo = sampleRepo();
			writeRule(repo);
			const { out } = runHelper(repo, [
				"--tool",
				"ast-grep",
				"--config",
				config,
				".",
			]);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(/^a\.ts:1\tfetch\(1\)$/m);
			expect(out).not.toMatch(/warning:|structural-status/);
		},
		TEST_TIMEOUT,
	);

	it(
		"reports a LOCAL opengrep config that yields no JSON as broken, and a registry one as unavailable",
		() => {
			const env = stubTool("opengrep", { stderr: "Fatal: boom\n", code: 2 });
			const repo = sampleRepo();
			expect(
				runWithEnv(
					repo,
					["--tool", "opengrep", "--config", "rules.yml", "."],
					env,
				),
			).toMatch(
				/^broken: opengrep produced no JSON \(config=rules\.yml; exit 2: Fatal: boom\)$/m,
			);
			expect(
				runWithEnv(
					repo,
					["--tool", "opengrep", "--config", "p/security-audit", "."],
					env,
				),
			).toMatch(
				/^unavailable: opengrep produced no JSON \(config=p\/security-audit; registry configs need network\)$/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps parsed rg matches and warns about a truncated JSON line instead of dropping it silently",
		() => {
			const match = JSON.stringify({
				type: "match",
				data: {
					path: { text: "./a.ts" },
					line_number: 1,
					lines: { text: "const f = () => fetch(1);\n" },
				},
			});
			const env = stubTool("rg", {
				stdout: `${match}\n{"type":"match","data":{"path":\n`,
				code: 0,
			});
			const out = runWithEnv(
				sampleRepo(),
				["--tool", "rg", "--pattern", "fetch", "."],
				env,
			);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(
				/^warning: 1 output line\(s\) could not be parsed \(dropped\)$/m,
			);
			expect(out).not.toMatch(/broken:/);
		},
		TEST_TIMEOUT,
	);
});

describe("structural.mjs — opengrep scans only the target (odin#15)", () => {
	// A fake opengrep that scans like the real one: every positional argument after
	// `--json` is a scan root, and it reports a parse error for docs/proto.js and a
	// finding in src/a.ts only when a root covers that file. It records its argv.
	const FAKE_OPENGREP = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const roots = args.slice(args.indexOf("--json") + 1).map((r) => r.replace(/\\\\/g, "/").replace(/\\/$/, ""));
const covers = (file) => roots.some((r) => r === "." || file === r || file.startsWith(r + "/"));
const results = covers("src/a.ts")
	? [{ check_id: "no-fetch", path: "src/a.ts", start: { line: 1 }, extra: { severity: "ERROR", message: "no fetch" } }]
	: [];
const errors = covers("docs/proto.js")
	? [{ level: "warn", message: "Syntax error at line docs/proto.js:1: unexpected token", path: "docs/proto.js" }]
	: [];
process.stdout.write(JSON.stringify({ results, errors }));
process.exit(results.length ? 1 : 0);
`;
	const repoWithProto = () => {
		const repo = sampleRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		mkdirSync(join(repo, "docs"), { recursive: true });
		writeFileSync(join(repo, "src/a.ts"), "fetch(1);\n");
		writeFileSync(join(repo, "docs/proto.js"), "const = ;\n");
		return repo;
	};

	it.for(["src/a.ts", "src"])(
		"passes %s as the scan root and never reports the unrelated docs/ parse error",
		(target) => {
			const repo = repoWithProto();
			const argsFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-args.json`);
			dirs.push(argsFile);
			const env = { ...stubScript("opengrep", FAKE_OPENGREP), FAKE_ARGS_FILE: argsFile };
			const out = runWithEnv(
				repo,
				["--tool", "opengrep", "--config", "rules.yml", target],
				env,
			);
			const argv = JSON.parse(readFileSync(argsFile, "utf-8"));
			expect(argv.slice(argv.indexOf("--json") + 1)).toEqual([target]);
			expect(out).toMatch(/^matches: 1$/m);
			expect(out).toMatch(/^src\/a\.ts:1\tcheck=no-fetch\t/m);
			expect(out).not.toMatch(/proto\.js|scan error/);
		},
		TEST_TIMEOUT,
	);

	it(
		"drops an error tied to a file outside the target but keeps a pathless one",
		() => {
			const env = stubTool("opengrep", {
				stdout: JSON.stringify({
					results: [],
					errors: [
						{ message: "Timeout on docs/proto.js", path: "docs/proto.js" },
						{ message: "Invalid rule schema" },
					],
				}),
				code: 0,
			});
			const out = runWithEnv(
				repoWithProto(),
				["--tool", "opengrep", "--config", "rules.yml", "src"],
				env,
			);
			expect(out).toMatch(
				/^warning: 1 opengrep scan error\(s\); first: Invalid rule schema$/m,
			);
			expect(out).not.toMatch(/proto\.js/);
		},
		TEST_TIMEOUT,
	);

	it(
		"still reports a parse error inside the target, once",
		() => {
			const repo = repoWithProto();
			const argsFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-args.json`);
			dirs.push(argsFile);
			const env = { ...stubScript("opengrep", FAKE_OPENGREP), FAKE_ARGS_FILE: argsFile };
			const out = runWithEnv(
				repo,
				["--tool", "opengrep", "--config", "rules.yml", "docs"],
				env,
			);
			expect(out).toMatch(/^matches: 0$/m);
			expect(out.match(/^warning: 1 opengrep scan error\(s\); first: Syntax error at line docs\/proto\.js:1/gm)).toHaveLength(1);
		},
		TEST_TIMEOUT,
	);
});
