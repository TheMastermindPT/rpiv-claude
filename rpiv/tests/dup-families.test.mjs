// tests/dup-families.test.mjs — contract tests for
// skills/architectural-review/_helpers/dup-families.mjs: the step that turns a merged jscpd
// clone list into architecture-review seeds. Seam: the CLI, spawned on a fixture repository
// and a clone-list file, read back through the shared `---block---` parser.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../skills/architectural-review/_helpers/bounded-output.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(
	ROOT,
	"skills",
	"architectural-review",
	"_helpers",
	"dup-families.mjs",
);

const dirs = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fixture repo: { relPath: contents }. Returns its root. */
const repo = (files) => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-dup-families-"));
	dirs.push(root);
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), body);
	}
	return root;
};

/** A cpd clone between two [file, startLine, endLine] sides. */
const clone = ([a, aStart, aEnd], [b, bStart, bEnd], tokens = 60) => ({
	firstFile: { name: a, start: aStart, end: aEnd },
	secondFile: { name: b, start: bStart, end: bEnd },
	lines: aEnd - aStart + 1,
	tokens,
});

const CODE = Array.from(
	{ length: 12 },
	(_, i) => `const v${i} = compute(${i});`,
).join("\n");

const run = (root, duplicates, extra = []) => {
	const clones = join(root, "clones.json");
	writeFileSync(clones, JSON.stringify({ duplicates }));
	const r = spawnSync(
		process.execPath,
		[CLI, "--clones", clones, "--root", root, ...extra],
		{
			encoding: "utf-8",
		},
	);
	return { ...r, ...parseBlocks(r.stdout) };
};

describe("dup-families buckets", () => {
	it("sorts every clone into exactly one bucket and counts each in the header", () => {
		const root = repo({
			"lib/a.ts": CODE,
			"lib/b.ts": CODE,
			"app/c.ts": CODE,
			"lib/a.test.ts": CODE,
			"lib/b.test.ts": CODE,
			"lib/imports.ts":
				'import { a, b } from "./x";\nimport {\n  c,\n  d,\n} from "./y";\n',
			"app/imports.ts":
				'import { a, b } from "./x";\nimport {\n  c,\n  d,\n} from "./y";\n',
		});
		const r = run(root, [
			clone(["lib/a.test.ts", 1, 9], ["lib/b.test.ts", 1, 9]), // test<->test
			clone(["lib/a.test.ts", 1, 9], ["lib/a.ts", 1, 9]), // test<->prod
			clone(["lib/a.ts", 1, 5], ["lib/a.ts", 7, 11]), // same file
			clone(["lib/imports.ts", 1, 5], ["app/imports.ts", 1, 5]), // import-only
			clone(["lib/a.ts", 1, 9], ["app/c.ts", 1, 9]), // cross-file production
		]);
		expect(r.status).toBe(0);
		expect(r.headers).toMatchObject({
			clones: "5",
			test_test: "1",
			test_prod: "1",
			same_file: "1",
			import_only: "1",
			import_check_unreadable: "0",
			cross_file: "1",
			families: "1",
		});
		expect(r.blocks["dup-test-prod"]).toEqual([
			"lib/a.test.ts:1-9 <-> lib/a.ts:1-9\ttokens=60",
		]);
		expect(r.blocks["dup-same-file"]).toEqual([
			"lib/a.ts:1-5 <-> lib/a.ts:7-11\ttokens=60",
		]);
	});

	it("routes production code copied into a tests/ fixture to the test bucket", () => {
		const root = repo({
			"apps/h/src/coordinator.ts": CODE,
			"apps/h/tests/integration/create-fixture.ts": CODE,
		});
		const r = run(root, [
			clone(
				["apps/h/src/coordinator.ts", 1, 9],
				["apps/h/tests/integration/create-fixture.ts", 1, 9],
			),
		]);
		expect(r.headers).toMatchObject({
			test_prod: "1",
			cross_file: "0",
			families: "0",
		});
		expect(r.blocks["dup-test-prod"]).toEqual([
			"apps/h/tests/integration/create-fixture.ts:1-9 <-> apps/h/src/coordinator.ts:1-9\ttokens=60",
		]);
	});

	it("keeps a clone whose source file cannot be read, and says so", () => {
		const root = repo({ "lib/a.ts": CODE });
		const r = run(root, [clone(["lib/a.ts", 1, 9], ["lib/gone.ts", 1, 9])]);
		expect(r.headers.import_check_unreadable).toBe("1");
		expect(r.headers.cross_file).toBe("1");
		expect(r.blocks["dup-families"]).toHaveLength(1);
	});

	it("keeps an import block that also carries code", () => {
		const body =
			'import { a } from "./x";\nimport { b } from "./y";\nexport const total = a + b;\n';
		const root = repo({ "lib/p.ts": body, "app/q.ts": body });
		const r = run(root, [clone(["lib/p.ts", 1, 3], ["app/q.ts", 1, 3])]);
		expect(r.headers.import_only).toBe("0");
		expect(r.headers.families).toBe("1");
	});
});

describe("dup-families families and ranking", () => {
	it("joins clones of one copied block into one family", () => {
		const root = repo({ "lib/a.ts": CODE, "lib/b.ts": CODE, "lib/c.ts": CODE });
		const r = run(root, [
			clone(["lib/a.ts", 1, 9], ["lib/b.ts", 1, 9]),
			clone(["lib/b.ts", 1, 9], ["lib/c.ts", 1, 9]),
			clone(["lib/a.ts", 1, 9], ["lib/c.ts", 1, 9], 80),
		]);
		expect(r.headers.families).toBe("1");
		expect(r.blocks["dup-families"]).toEqual([
			"F1\tareas=1\tfolders=1\tfiles=3\tcopies=3\tmax_tokens=80\tlib/a.ts:1-9 | lib/b.ts:1-9 | lib/c.ts:1-9",
		]);
	});

	it("ranks a family spanning more areas above a bigger family inside one area", () => {
		const root = repo({
			"lib/a.ts": CODE,
			"lib/b.ts": CODE,
			"lib/c.ts": CODE,
			"lib/d.ts": CODE,
			"lib/e.ts": CODE,
			"app/f.ts": CODE,
		});
		const r = run(root, [
			clone(["lib/a.ts", 1, 9], ["lib/b.ts", 1, 9]),
			clone(["lib/a.ts", 1, 9], ["lib/c.ts", 1, 9]),
			clone(["lib/a.ts", 1, 9], ["lib/d.ts", 1, 9]),
			clone(["lib/e.ts", 1, 9], ["app/f.ts", 1, 9]),
		]);
		const [first, second] = r.blocks["dup-families"];
		expect(first).toMatch(/^F1\tareas=2\t.*lib\/e\.ts:1-9 \| app\/f\.ts:1-9$/);
		expect(second).toMatch(/^F2\tareas=1\tfolders=1\tfiles=4\tcopies=4\t/);
	});

	it("names areas by workspace package, skipping src", () => {
		const root = repo({
			"package.json": "{}",
			"packages/kernel/package.json": "{}",
			"packages/kernel/src/ledger/a.ts": CODE,
			"packages/kernel/src/store/b.ts": CODE,
			"apps/desktop/package.json": "{}",
			"apps/desktop/src/main/c.ts": CODE,
			"apps/harness/package.json": "{}",
			"apps/harness/src/d.ts": CODE,
		});
		const r = run(root, [
			clone(
				["packages/kernel/src/ledger/a.ts", 1, 9],
				["packages/kernel/src/store/b.ts", 1, 9],
			),
			clone(
				["packages/kernel/src/ledger/a.ts", 1, 9],
				["apps/desktop/src/main/c.ts", 1, 9],
			),
			clone(
				["apps/desktop/src/main/c.ts", 1, 9],
				["apps/harness/src/d.ts", 1, 9],
			),
		]);
		expect(r.blocks["dup-families"][0]).toMatch(
			/^F1\tareas=4\tfolders=4\tfiles=4\tcopies=4\t/,
		);
		// a file directly in a package's src/ names the package alone, not `apps/harness:.`
		expect(r.blocks["dup-areas"]).toEqual([
			"F1\tapps/desktop:main, apps/harness, packages/kernel:ledger, packages/kernel:store",
		]);
	});

	it("reads Windows and absolute paths as the same repo-relative files", () => {
		const root = repo({ "lib/a.ts": CODE, "app/b.ts": CODE });
		const r = run(root, [
			clone([join(root, "lib", "a.ts"), 1, 9], ["app\\b.ts", 1, 9]),
		]);
		expect(r.blocks["dup-families"][0]).toMatch(
			/\tlib\/a\.ts:1-9 \| app\/b\.ts:1-9$/,
		);
	});
});

describe("dup-families broken input", () => {
	const root = repo({});
	const call = (...args) =>
		spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });

	it.each([
		[
			"a missing clone list",
			() => join(root, "nope.json"),
			/BROKEN .*nope\.json: no such file/,
		],
		[
			"malformed JSON",
			() => {
				const p = join(root, "bad.json");
				writeFileSync(p, "{");
				return p;
			},
			/BROKEN .*bad\.json: unreadable/,
		],
		[
			"JSON with no duplicates array",
			() => {
				const p = join(root, "x.json");
				writeFileSync(p, "{}");
				return p;
			},
			/BROKEN .*x\.json: not a clone list/,
		],
	])("reports %s as BROKEN with no stdout", (_label, makePath, message) => {
		const r = call("--clones", makePath(), "--root", root);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(message);
	});

	it("rejects a call missing --clones or --root", () => {
		expect(call("--root", root).status).toBe(2);
		expect(call("--clones", join(root, "x.json")).stderr).toMatch(/usage/);
	});
});
