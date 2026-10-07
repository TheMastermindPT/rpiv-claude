// tests/fence-rule.test.mjs — contract tests for validate-artifact's fence checks
// (slice S6-fence-rule, D26, B94–B96, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// The CLI is spawned on artifacts written under a throwaway `.rpiv/artifacts/<kind>/` tree.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATE = join(ROOT, "skills/_shared/validate-artifact.mjs");
const T = "```";
const F = "````";

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** 9 frontmatter lines, then `# D` and a blank line: a fence opening next sits at line 12. */
const fm = (status = "in-progress") =>
	`---\ndate: x\nauthor: x\ncommit: x\nbranch: x\nrepository: x\ntopic: x\nstatus: ${status}\n---\n# D\n\n`;

/** Writes `text` under `<tmp>/.rpiv/artifacts/<kind>/a.md` (no kind: `<tmp>/a.md`). */
const artifact = (kind, text) => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-fence-rule-"));
	dirs.push(root);
	const dir = kind ? join(root, ".rpiv", "artifacts", kind) : root;
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "a.md");
	writeFileSync(file, text);
	return { root, file };
};

const validate = ({ root, file }, ...flags) => {
	const r = spawnSync(
		process.execPath,
		[VALIDATE, file, "--root", root, ...flags],
		{ encoding: "utf-8" },
	);
	return { status: r.status, stderr: r.stderr };
};

const fence = (n, open = `${T}js`, close = T) =>
	`${open}\n${"x\n".repeat(n)}${close}\n`;

describe("S6 fence size rule (B94)", () => {
	it("rejects a fence over 10 lines in designs and plans at finalization", () => {
		const eleven = artifact("designs", fm() + fence(11));
		const r = validate(eleven, "--finalizing");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			": code fence over 10 lines at line 12: 11 lines",
		);

		expect(
			validate(artifact("designs", fm() + fence(10)), "--finalizing").status,
		).toBe(0);
		expect(validate(eleven).status).toBe(0);
		expect(validate(artifact("designs", fm("ready") + fence(11))).status).toBe(
			0,
		);

		const plan = validate(artifact("plans", fm() + fence(11)), "--finalizing");
		expect(plan.status).toBe(1);
		expect(plan.stderr).toContain(
			": code fence over 10 lines at line 12: 11 lines",
		);

		for (const kind of ["research", "reviews", ""]) {
			expect(
				validate(artifact(kind, fm() + fence(11)), "--finalizing").status,
			).toBe(0);
		}

		const nested = `${F}md\n${T}js\n${"x\n".repeat(10)}${T}\n${F}\n`;
		const n = validate(artifact("designs", fm() + nested), "--finalizing");
		expect(n.status).toBe(1);
		expect(n.stderr.match(/code fence over 10 lines/g)).toHaveLength(1);
		expect(n.stderr).toContain(
			": code fence over 10 lines at line 12: 12 lines",
		);

		const crlf = validate(
			artifact("designs", (fm() + fence(11)).replaceAll("\n", "\r\n")),
			"--finalizing",
		);
		expect(crlf.status).toBe(1);
		expect(crlf.stderr).toContain(
			": code fence over 10 lines at line 12: 11 lines",
		);

		const two = validate(
			artifact("designs", `${fm()}${fence(11)}\n${fence(12)}`),
			"--finalizing",
		);
		expect(two.status).toBe(1);
		expect(two.stderr).toContain(
			": code fence over 10 lines at line 12: 11 lines",
		);
		expect(two.stderr).toContain(
			": code fence over 10 lines at line 26: 12 lines",
		);
	});
});

describe("S6 unterminated fence rule (B95)", () => {
	it("rejects an unterminated fence at finalization without hiding prose", () => {
		const open = artifact("designs", `${fm()}${T}js\nconst a = 1;\n`);
		const r = validate(open, "--finalizing");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(": unterminated code fence at line 12");

		expect(validate(open).status).toBe(0);
		expect(
			validate(
				artifact("research", `${fm()}${T}js\nconst a = 1;\n`),
				"--finalizing",
			).status,
		).toBe(0);

		const todo = artifact(
			"designs",
			`${fm()}${T}js\nconst a = 1;\nTODO after\n`,
		);
		expect(validate(todo).stderr).toContain("placeholder left in prose: TODO");
		const fin = validate(todo, "--finalizing");
		expect(fin.stderr).toContain("placeholder left in prose: TODO");
		expect(fin.stderr).toContain(": unterminated code fence at line 12");
	});
});

describe("S6 shared parser in prose checks (B96)", () => {
	it("reads nested and CRLF fences with the shared parser", () => {
		const nested = validate(
			artifact(
				"designs",
				`${fm()}${F}md\n${T}js\nx\n${T}\nTODO inside\n${F}\n`,
			),
		);
		expect(nested.status).toBe(0);
		expect(nested.stderr).toBe("");

		const empty = `${fm()}${T}ts\n\n${T}\n`;
		expect(validate(artifact("designs", empty)).stderr).toContain(
			`empty code fence (${T}ts)`,
		);
		expect(
			validate(artifact("designs", empty.replaceAll("\n", "\r\n"))).stderr,
		).toContain(`empty code fence (${T}ts)`);

		const fenced = validate(
			artifact("designs", `${fm()}${T}\n{token}\n${T}\n`),
			"--finalizing",
		);
		expect(fenced.status).toBe(0);
		const prose = validate(
			artifact("designs", `${fm()}a {token} here\n`),
			"--finalizing",
		);
		expect(prose.stderr).toContain("unfilled template token in prose: {token}");

		// Calibration guard: double-backtick spans holding ``` keep their content out of prose.
		const line = "see `` ```js `` and `TODO after` and `` `{token}` ``\n";
		const spans = validate(artifact("designs", fm() + line), "--finalizing");
		expect(spans.status).toBe(0);
	});
});
