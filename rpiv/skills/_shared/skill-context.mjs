// Single-command wrapper for SKILL.md `!` metadata blocks.
//
// Claude Code's permission checker hard-fails compound shell commands whose
// parts aren't individually allowlisted, so metadata blocks that chained
// several `node` calls (now.mjs + git-context.mjs + list-recent.mjs ...)
// could never run. This wrapper exposes the same output behind ONE command:
//
//   node skill-context.mjs [now] [git] [changes] [subjects] [recent <dir> <n>]...
//
// Directives (any order; emitted in the order given):
//   now              — now.mjs line: <iso>\t<slug>
//   git              — git-context.mjs block (branch/commit/repo/root/...)
//   changes          — git-changes.mjs snapshot (commit skill)
//   subjects         — "---recent-subjects---" + last 20 commit subjects
//   recent <dir> <n> — list-recent.mjs for <dir>; repeatable; the
//                      "### recent" header is printed once before the first.
//
// Always exits 0 — metadata must never break a skill load.
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const run = (script, args = []) => {
	try {
		return execFileSync(process.execPath, [join(here, script), ...args], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
};

const endLine = (s) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
const write = (s) => process.stdout.write(s);

// Parse argv into ordered segments; consecutive `recent` directives group.
const argv = process.argv.slice(2);
const segments = [];
for (let i = 0; i < argv.length; i++) {
	const tok = argv[i];
	if (tok === "recent") {
		const dir = argv[++i] ?? ".";
		const n = argv[++i] ?? "10";
		const last = segments.at(-1);
		if (last?.kind === "recents") last.items.push({ dir, n });
		else segments.push({ kind: "recents", items: [{ dir, n }] });
	} else if (["now", "git", "changes", "subjects"].includes(tok)) {
		segments.push({ kind: tok });
	}
	// Unknown tokens are ignored — metadata must never break a skill load.
}

segments.forEach((seg, i) => {
	if (i > 0) write("\n"); // blank separator between top-level segments
	switch (seg.kind) {
		case "now":
			write(endLine(run("now.mjs")));
			break;
		case "git":
			write(endLine(run("git-context.mjs")));
			break;
		case "changes":
			write(endLine(run("git-changes.mjs")));
			break;
		case "subjects": {
			write("---recent-subjects---\n");
			try {
				write(
					endLine(
						execFileSync("git", ["log", "--pretty=%s", "-n", "20"], {
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "ignore"],
						}),
					),
				);
			} catch {
				// not a repo / no commits — print nothing, never fail
			}
			break;
		}
		case "recents": {
			write("### recent (read only in case of empty user input)\n");
			seg.items.forEach(({ dir, n }, j) => {
				if (j > 0) write("\n");
				write(`recent ${basename(dir)}:\n`);
				const out = run("list-recent.mjs", [dir, n]);
				if (out !== "") write(endLine(out));
			});
			break;
		}
	}
});
process.exitCode = 0;
