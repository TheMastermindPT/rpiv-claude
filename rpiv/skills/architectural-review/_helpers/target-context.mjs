// target-context.mjs — single owner of the git-toplevel -> cwd -> resolve-argv-target
// preamble shared byte-for-byte by coverage.mjs and mutation.mjs (and the safeGit/toPosix
// pair by semantic.mjs). Emitted paths relative to invocation cwd — identical to the git
// toplevel on a normal repo, correct when the project is nested. Importable-only.
//
// Importable: toPosix, safeGit, resolveTarget, relOf, underTarget.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const toPosix = (p) => p.replaceAll("\\", "/");

export const safeGit = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return fb;
	}
};

// Nearest package.json at/above the target, bounded by the git toplevel — the project
// root (reports/, coverage/ live here), which is not the git root when nested.
// Module-private: consumers go through resolveTarget().
const findProjectRoot = (startAbs, top) => {
	let dir = startAbs;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return toPosix(dir);
		if (toPosix(dir) === top) return top;
		const parent = dirname(dir);
		if (parent === dir) return top;
		dir = parent;
	}
};

export const relOf = (k, cwd) => {
	const p = toPosix(k);
	return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
};

export const underTarget = (rp, target) =>
	target === "." || rp === target || rp.startsWith(`${target}/`);

// Resolve a single argv target into the context every consumer needs, with cwd-bound
// relOf/underTarget closures so call sites stay `relOf(k)` / `underTarget(rp)`.
export const resolveTarget = (argv2) => {
	const root = toPosix(safeGit(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
	const cwd = toPosix(process.cwd());
	const targetArg = toPosix((argv2 ?? ".").replace(/^['"]|['"]$/g, "")) || ".";
	const targetAbs = isAbsolute(targetArg) ? toPosix(targetArg) : toPosix(resolve(process.cwd(), targetArg));
	const target = toPosix(relative(cwd, targetAbs)) || ".";
	const projectRoot = findProjectRoot(targetAbs, root);
	return {
		root, cwd, targetArg, targetAbs, target, projectRoot,
		relOf: (k) => relOf(k, cwd),
		underTarget: (rp) => underTarget(rp, target),
	};
};

// Resolve EVERY positional argv target (union semantics — dogfooding A: helpers read
// only argv[2] and silently dropped the rest, reviewing the first dir and presenting
// it as the whole scope). Flags (--x) are skipped; an empty tail resolves to ["."];
// duplicates (same targetAbs) collapse.
export const resolveTargets = (argvTail) => {
	const positional = (argvTail ?? []).filter((a) => a && !String(a).startsWith("--"));
	const list = (positional.length ? positional : ["."]).map(resolveTarget);
	const seen = new Set();
	const targets = list.filter((t) => (seen.has(t.targetAbs) ? false : seen.add(t.targetAbs)));
	const projectRoots = [...new Set(targets.map((t) => t.projectRoot))];
	return {
		targets,
		root: targets[0].root,
		cwd: targets[0].cwd,
		projectRoots,
		projectRoot: projectRoots[0],
		targetLabel: targets.map((t) => t.target).join(" "),
		relOf: targets[0].relOf, // cwd-bound; identical across targets (same process cwd)
		underAny: (rp) => targets.some((t) => t.underTarget(rp)),
	};
};
