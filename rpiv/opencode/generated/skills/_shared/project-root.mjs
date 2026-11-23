// project-root.mjs — the one owner of the project-root walk (D33 of the Python-support
// design, S4-probe-roots). A target's project root is the nearest folder at or above
// it holding a project manifest (`package.json` or `pyproject.toml`), bounded by the
// git toplevel; with none, the toplevel. The walk only goes up, so a manifest below the
// target (a test fixture project) is never a root of it.
//
// Importable-only: no CLI, no isMain.
// Importable: PROJECT_MANIFESTS, findProjectRoot.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The files that make a folder a project root. */
export const PROJECT_MANIFESTS = ["package.json", "pyproject.toml"];

const toPosix = (path) => path.replaceAll("\\", "/");

/** The nearest folder at or above `startAbs` holding a project manifest, bounded by the
    git toplevel `top` (posix, absolute); `top` when none is found. Returned posix. */
export const findProjectRoot = (startAbs, top) => {
	let dir = startAbs;
	for (;;) {
		if (PROJECT_MANIFESTS.some((name) => existsSync(join(dir, name))))
			return toPosix(dir);
		if (toPosix(dir) === top) return top;
		const parent = dirname(dir);
		if (parent === dir) return top;
		dir = parent;
	}
};
