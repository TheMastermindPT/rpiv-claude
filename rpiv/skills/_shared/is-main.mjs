// is-main.mjs — the single owner of CLI-entrypoint detection for _shared's importable-
// and-runnable modules. Replaces two divergent checks: regen-decisions-index's realpath-
// normalised IIFE (whose catch returned false, silently skipping the --check gate on ANY
// realpath failure — L0-04/IX-4) and validate-artifact's plain compare (symlink-blind).
// realpathSync per SIDE (the repo is consumed through a symlinked plugin cache, where
// argv[1] and import.meta.url can differ only by link), with a per-side raw-path fallback
// instead of a whole-check swallow: a realpath failure degrades to the raw path with a
// visible diagnostic — never to "not main". Nothing here throws or exits; the comparison
// always completes. (If argv[1] did not exist, node could not be running it as the
// entrypoint, so the raw compare stays correct in the fallback case.)
//
// Importable: isMain.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tryReal = (p) => {
	try {
		return realpathSync(p);
	} catch (e) {
		// Broken != absent (M2): normalization failure is announced, then degrades to
		// the raw path — the gate decision is never silently skipped.
		process.stderr.write(`is-main: realpath failed for ${p} (${e?.code ?? e}) — using raw path\n`);
		return p;
	}
};

/** True when the module at importMetaUrl is the process entrypoint. */
export const isMain = (importMetaUrl) =>
	tryReal(fileURLToPath(importMetaUrl)) === tryReal(resolve(process.argv[1] ?? ""));
