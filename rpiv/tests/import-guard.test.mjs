// tests/import-guard.test.mjs — contract tests for skills/_shared/import-guard.mjs, the
// record reader and checkout test of a Python re-run (slice S2-scratch-copy of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md), called directly.

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkoutFolders,
	importVerdict,
	realOf,
} from "../skills/_shared/import-guard.mjs";
import { cleanup, put, tempDir } from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

const slash = (path) => path.replaceAll("\\", "/");
const CHECKOUT = "result: broken: imported from the checkout: ";

/** A checkout folder, its scratch copy (under the git dir), a guard folder, a folder
    outside every checkout, and the records folder the guard writes into. */
const world = () => {
	const top = realOf(tempDir());
	const scratch = join(top, ".git/rpiv/reprove-red/abc");
	mkdirSync(scratch, { recursive: true });
	const guard = realOf(tempDir());
	const records = join(guard, "records");
	mkdirSync(records);
	const outside = realOf(tempDir());
	return { top, scratch, guard, records, outside };
};

/** One record file's text: `start:`, the package and module lines, `end:`. */
const record = ({ modules = [], packages = [], pid = 10, eol = "\n" }) =>
	[
		`start: ${pid}`,
		...packages.map((path) => `package: ${path}`),
		...modules.map((path) => `module: ${path}`),
		`end: ${pid}`,
		"",
	].join(eol);

/** The verdict on `files` (`{ name: text }`) written into the world's records folder. */
const verdictOn = (w, files, { checkouts = [w.top], links = [] } = {}) => {
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(w.records, name), text);
	}
	return importVerdict({
		recordsDir: w.records,
		checkouts,
		exempt: [w.scratch, w.guard, ...links],
		top: w.top,
	});
};

const SRC_INIT = `${CHECKOUT}src/demo/__init__.py`;
// B18: [label, the row's inputs in a fresh world, expected verdict (undefined: S1's line)]
const B18_ROWS = [
	[
		"checkout, first in reading order",
		(w) => ({
			modules: [
				join(w.top, "src/demo/util.py"),
				join(w.top, "src/demo/__init__.py"),
			],
		}),
		`${CHECKOUT}src/demo/util.py`,
	],
	[
		"checkout",
		(w) => ({ modules: [join(w.top, "src/demo/__init__.py")] }),
		SRC_INIT,
	],
	[
		"scratch",
		(w) => ({ modules: [join(w.scratch, "src/demo/__init__.py")] }),
		undefined,
	],
	[
		"guard",
		(w) => ({ modules: [join(w.guard, "sitecustomize.py")] }),
		undefined,
	],
	[
		"link target",
		(w) => ({
			modules: [join(w.top, ".venv/Lib/site-packages/x.py")],
			links: [join(w.top, ".venv")],
		}),
		undefined,
	],
	[
		"package folder inside the checkout",
		(w) => ({
			modules: [join(w.top, ".venv/Lib/site-packages/x.py")],
			packages: [join(w.top, ".venv/Lib/site-packages")],
		}),
		undefined,
	],
	[
		"checkout beside an inner package folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [join(w.top, ".venv/Lib/site-packages")],
		}),
		SRC_INIT,
	],
	[
		"a venv made in the top folder",
		(w) => ({
			modules: [join(w.top, "Lib/site-packages/_pytest/x.py")],
			packages: [join(w.top, "Lib/site-packages")],
		}),
		undefined,
	],
	[
		"package folder equal to the top folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [w.top],
		}),
		SRC_INIT,
	],
	[
		"package folder holding the top folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [dirname(w.top)],
		}),
		SRC_INIT,
	],
	["sibling folder", (w) => ({ modules: [`${w.top}2/x.py`] }), undefined],
	[
		"outside the repository",
		(w) => ({ modules: [join(w.outside, "x.py")] }),
		undefined,
	],
	[
		"a folder named ..cache in the checkout",
		(w) => ({ modules: [join(w.top, "..cache/x.py")] }),
		`${CHECKOUT}..cache/x.py`,
	],
];

const DID_NOT_RUN = "result: broken: import guard did not run";
const INCOMPLETE = "result: broken: import record incomplete";
// B19: [label, the row's record files in a fresh world, expected verdict]
const B19_ROWS = [
	["none", () => ({}), DID_NOT_RUN],
	["one empty file", () => ({ a: "" }), INCOMPLETE],
	["only start", () => ({ a: "start: 10\n" }), INCOMPLETE],
	[
		"a clean file and one with no end",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }),
			b: `start: 11\nmodule: ${join(w.scratch, "y.py")}\n`,
		}),
		INCOMPLETE,
	],
	[
		"garbage before end",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }).replace(
				"end: 10",
				"garbage\nend: 10",
			),
		}),
		INCOMPLETE,
	],
	["end with another pid", () => ({ a: "start: 10\nend: 11\n" }), INCOMPLETE],
	[
		"an unfinished file naming a checkout module",
		(w) => ({
			a: `start: 10\nmodule: ${join(w.top, "src/demo/__init__.py")}\n`,
		}),
		SRC_INIT,
	],
	[
		"two clean files, same pid",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }),
			b: record({ modules: [join(w.scratch, "y.py")] }),
		}),
		undefined,
	],
	[
		"a clean file with CRLF lines",
		(w) => ({ a: record({ modules: [join(w.scratch, "x.py")], eol: "\r\n" }) }),
		undefined,
	],
];

describe("import guard: record reader and checkout test (S2-scratch-copy)", () => {
	it("B18: a module from any checkout folder makes the run broken; the scratch copy, the guard, links, inner package folders, siblings and outside files do not", () => {
		for (const [label, inputs, want] of B18_ROWS) {
			const w = world();
			const { modules, packages = [w.outside], links = [] } = inputs(w);
			expect
				.soft(
					verdictOn(w, { a: record({ modules, packages }) }, { links }),
					label,
				)
				.toBe(want);
		}

		// Another worktree of the same repository: an absolute path with `/`.
		const w = world();
		const other = realOf(tempDir());
		expect
			.soft(
				verdictOn(
					w,
					{
						a: record({
							modules: [join(other, "src/demo/__init__.py")],
							packages: [w.outside],
						}),
					},
					{ checkouts: [w.top, other] },
				),
				"another worktree",
			)
			.toBe(`${CHECKOUT}${slash(other)}/src/demo/__init__.py`);

		// A path reaching the checkout through a symlink (Windows: a junction) outside it.
		const j = world();
		put(j.top, "src/demo/__init__.py", "");
		const link = join(j.outside, "linked-demo");
		symlinkSync(join(j.top, "src/demo"), link, "junction");
		expect
			.soft(
				verdictOn(j, {
					a: record({
						modules: [join(link, "__init__.py")],
						packages: [j.outside],
					}),
				}),
				"through a link",
			)
			.toBe(`${CHECKOUT}src/demo/__init__.py`);
	});

	it("B18: a failing git worktree list is a broken call naming the git error", () => {
		expect(() => checkoutFolders(tempDir())).toThrow(
			/^git worktree failed: fatal: not a git repository/,
		);
	});

	it("B19: no record file reads import guard did not run, an incomplete one reads import record incomplete, and a checkout module wins over both", () => {
		for (const [label, files, want] of B19_ROWS) {
			const w = world();
			expect.soft(verdictOn(w, files(w)), label).toBe(want);
		}
	});
});
