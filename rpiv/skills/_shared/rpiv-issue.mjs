// rpiv-issue.mjs — rpiv issue drafts (S20-rpiv-issue-reports, D43). When an agent
// hits a problem with rpiv itself, it drafts an issue for rpiv's own repository;
// `/rpiv:issue` files it only after the developer approves the exact text.
//
// CLI: `node rpiv-issue.mjs draft --trigger <broken|rejected-prompt|contradiction|judgment>
// --component <name> --title <t> --what <text> --repro <text> [--diagnostic <text>]`
// writes `<git-common-dir>/rpiv/issues/<id>.json` and `<id>.md` (shared by every
// worktree, never committed) and prints `rpiv-issue: drafted <id> (…)`.
// A bad call prints `rpiv-issue: broken: <detail>` on stderr and exits 2, writing
// nothing.
//
// Importable: runCli, issuesDir.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeadBranch } from "./cycles.mjs";
import { isMain } from "./is-main.mjs";

const RPIV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRIGGERS = ["broken", "rejected-prompt", "contradiction", "judgment"];
const DRAFT_REQUIRED = ["trigger", "component", "title", "what", "repro"];
const DRAFT_OPTIONS = new Set([...DRAFT_REQUIRED, "diagnostic"]);

/** The draft queue of the repository whose absolute git common dir is `common`. */
export const issuesDir = (common) => `${common}/rpiv/issues`;

/** git's `{ status, out, err }` in `cwd` (English messages); throws when git
    could not run. */
function gitResult(cwd, args) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, LC_ALL: "C" },
		windowsHide: true,
	});
	if (res.error) throw new Error(`git could not run (${res.error.message})`);
	return {
		status: res.status,
		out: (res.stdout ?? "").trim(),
		err: (res.stderr ?? "").trim(),
	};
}

/** git's trimmed stdout in `cwd` when its exit status is one of `ok`, else null
    for another listed status; any other failure throws a broken detail. */
function git(cwd, args, ok = [0], quiet = []) {
	const res = gitResult(cwd, args);
	if (quiet.includes(res.status)) return null;
	if (!ok.includes(res.status))
		throw new Error(`git ${args[0]} failed: ${res.err.split("\n")[0]}`);
	return res.out;
}

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const PATH_FLAGS = process.platform === "win32" ? "gi" : "g";
const PATH_CHARS = "[^\\s\"'`<>|]";

/** `path` written with either slash, as regex alternatives (longest first). */
function pathForms(path) {
	const forms = new Set([
		path,
		path.replaceAll("\\", "/"),
		path.replaceAll("/", "\\"),
	]);
	return [...forms]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp)
		.join("|");
}

/** `path` as a whole path segment (any case on Windows): `<top>-x` is not `<top>`. */
const pathPattern = (path) =>
	new RegExp(`(?:${pathForms(path)})(?![\\w-]|\\.\\w)`, PATH_FLAGS);

/** A path that starts like `path` but is not inside it (`<top>-secrets/x`). */
const siblingPattern = (path) =>
	new RegExp(
		`(?:${pathForms(path)})(?=[\\w-]|\\.\\w)${PATH_CHARS}*`,
		PATH_FLAGS,
	);

const SECRET_RULES = [
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		"<secret>",
	],
	[
		/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[a-z]-[\w-]{10,})\b/g,
		"<secret>",
	],
	[
		/\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|token|api_key|apikey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'<>]+)/gi,
		(_match, key, value) => {
			const quote = /^["']/.test(value) ? value[0] : "";
			return `${key}${quote}<secret>${quote}`;
		},
	],
	[/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, "<email>"],
];

/** The repository URL without `.git` or a trailing slash, lower case. */
const bareUrl = (url) =>
	url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();

/** The project's remote, replaced whole before any other rule can split it. */
function remoteRules(scope) {
	if (!scope.remote || bareUrl(scope.remote) === bareUrl(scope.rpivUrl ?? ""))
		return [];
	return [
		[
			new RegExp(`${escapeRegExp(bareUrl(scope.remote))}(?:\\.git)?/?`, "gi"),
			"<project-remote>",
		],
	];
}

/** The replacement rules for project paths and the branch (D43, revision 1). */
function projectRules(scope) {
	const rules = [
		[siblingPattern(scope.top), "<path>"],
		[pathPattern(scope.top), "<project>"],
		[siblingPattern(scope.home), "<path>"],
		[pathPattern(scope.home), "<home>"],
		[new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]${PATH_CHARS}*`, "g"), "<path>"],
		[new RegExp(`(?<![\\w])~[\\\\/]${PATH_CHARS}*`, "g"), "<path>"],
		[
			/(?<![\w.\\<>~-])(?<!:\/)\/[^\s"'`<>|/\\]+(?:\/[^\s"'`<>|/\\]+)+/g,
			"<path>",
		],
	];
	if (scope.branch && !["main", "master"].includes(scope.branch))
		rules.push([
			new RegExp(
				`(?<![\\w.-])${escapeRegExp(scope.branch)}(?![\\w/-]|\\.\\w)`,
				"g",
			),
			"<branch>",
		]);
	return rules;
}

/** Applies `rules` to `text`, adding each replacement to `counts[key]`. */
function applyRules(text, rules, counts, key) {
	let out = text;
	for (const [pattern, replacement] of rules)
		out = out.replace(pattern, (...match) => {
			if (key) counts[key]++;
			return typeof replacement === "function"
				? replacement(...match)
				: replacement;
		});
	return out;
}

/** `text` with project and secret-like values replaced by placeholders (D43). */
function scrub(text, scope, counts) {
	const remoteOut = applyRules(text, remoteRules(scope), counts, "project");
	const secretsOut = applyRules(remoteOut, SECRET_RULES, counts, "secrets");
	const rpivOut = applyRules(
		applyRules(
			secretsOut,
			[[siblingPattern(scope.rpivRoot), "<path>"]],
			counts,
			"project",
		),
		[[pathPattern(scope.rpivRoot), "<rpiv>"]],
		counts,
		null,
	);
	return applyRules(rpivOut, projectRules(scope), counts, "project");
}

/** The values a draft must not leak, read from `cwd`'s repository. */
function privacyScope(cwd, manifest) {
	const head = readHeadBranch(
		gitResult(cwd, ["symbolic-ref", "--quiet", "HEAD"]),
	);
	if (head.problem) throw new Error(head.problem);
	return {
		rpivRoot: RPIV_ROOT,
		rpivUrl:
			typeof manifest.repository === "string" ? manifest.repository : null,
		remote: git(cwd, ["remote", "get-url", "origin"], [0], [2]),
		top: git(cwd, ["rev-parse", "--show-toplevel"]),
		home: homedir(),
		branch: head.branch,
	};
}

/** `--name value` pairs into an object; an unknown or valueless option throws. */
function readOptions(words, allowed) {
	const opts = {};
	for (let i = 0; i < words.length; i += 2) {
		const name = words[i];
		if (!name.startsWith("--") || !allowed.has(name.slice(2)))
			throw new Error(`unknown option: ${name}`);
		if (words[i + 1] === undefined) throw new Error(`${name} needs a value`);
		opts[name.slice(2)] = words[i + 1];
	}
	return opts;
}

function readManifest() {
	const path =
		process.env.RPIV_PLUGIN_MANIFEST ??
		join(RPIV_ROOT, ".claude-plugin", "plugin.json");
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`cannot read plugin.json (${err?.code ?? err?.message})`);
	}
}

/** The issue body (D43): what happened, where, the diagnostic, the repro. */
function issueBody(opts, version, stripped) {
	const judged = opts.trigger === "judgment" ? " (agent-judged)" : "";
	const parts = [
		`## What happened\n${opts.what}\n`,
		`## Where\n- rpiv ${version}, \`${opts.component}\`\n`,
	];
	if (opts.diagnostic !== undefined)
		parts.push(`## Diagnostic\n~~~\n${opts.diagnostic}\n~~~\n`);
	parts.push(`## Minimal repro\n${opts.repro}\n`);
	parts.push(
		`---\nTrigger: ${opts.trigger}${judged}. Privacy: ${stripped.project} project value(s) and ${stripped.secrets} secret-like value(s) were replaced with placeholders.\n`,
	);
	return parts.join("\n");
}

/** `YYYYMMDD-HHMMSS` of `date` in UTC. */
const stamp = (date) =>
	date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

const commonDir = (cwd) =>
	git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

function draft(words, cwd) {
	const opts = readOptions(words, DRAFT_OPTIONS);
	for (const name of DRAFT_REQUIRED)
		if (opts[name] === undefined) throw new Error(`draft needs --${name}`);
	if (!TRIGGERS.includes(opts.trigger))
		throw new Error(
			"trigger must be broken, rejected-prompt, contradiction or judgment",
		);
	const common = commonDir(cwd);
	const manifest = readManifest();
	const scope = privacyScope(cwd, manifest);
	const stripped = { project: 0, secrets: 0 };
	for (const name of ["component", "title", "what", "repro", "diagnostic"])
		if (opts[name] !== undefined)
			opts[name] = scrub(opts[name], scope, stripped);
	const body = issueBody(opts, manifest.version, stripped);
	const now = new Date();
	const id = `${stamp(now)}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
	const dir = issuesDir(common);
	mkdirSync(dir, { recursive: true });
	const meta = {
		v: 1,
		id,
		created: now.toISOString(),
		trigger: opts.trigger,
		agentJudged: opts.trigger === "judgment",
		component: opts.component,
		title: opts.title,
		stripped,
	};
	writeFileSync(`${dir}/${id}.md`, body, { flag: "wx" });
	writeFileSync(`${dir}/${id}.json`, `${JSON.stringify(meta, null, 2)}\n`);
	return `rpiv-issue: drafted ${id} (${stripped.project} project value(s), ${stripped.secrets} secret-like value(s) removed)\n`;
}

/** The pending drafts' metadata, oldest first; a missing queue is empty. */
function pendingDrafts(dir) {
	let names;
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw new Error(`cannot read ${dir} (${err?.code ?? err?.message})`);
	}
	return names
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => readDraft(`${dir}/${entry.name}`))
		.sort(
			(a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id),
		);
}

function readDraft(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`malformed draft: ${path}`);
	}
}

function list(words, cwd) {
	readOptions(words, new Set());
	const drafts = pendingDrafts(issuesDir(commonDir(cwd)));
	const lines = drafts.map((d) => `${d.id} | ${d.trigger} | ${d.title}\n`);
	return `${lines.join("")}drafts: ${drafts.length}\n`;
}

const ID_SHAPE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

/** The queue folder and metadata of the pending draft `id`; throws when none. */
function pendingDraft(id, cwd) {
	const dir = issuesDir(commonDir(cwd));
	if (!ID_SHAPE.test(id ?? "") || !existsSync(`${dir}/${id}.json`))
		throw new Error(`no pending draft: ${id}`);
	return { dir, meta: readDraft(`${dir}/${id}.json`) };
}

const GITHUB_REPO =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

function show([id, ...words], cwd) {
	readOptions(words, new Set());
	const { dir, meta } = pendingDraft(id, cwd);
	const match = GITHUB_REPO.exec(readManifest().repository ?? "");
	if (!match) throw new Error("plugin.json has no GitHub repository URL");
	return `repo: ${match[1]}/${match[2]}\ntitle: ${meta.title}\nbody-file: ${dir}/${id}.md\n`;
}

const OUTCOMES = ["filed", "commented", "dropped"];

function close([id, ...words], cwd) {
	const opts = readOptions(words, new Set(["outcome", "url"]));
	if (!OUTCOMES.includes(opts.outcome))
		throw new Error("outcome must be filed, commented or dropped");
	if (opts.outcome !== "dropped" && opts.url === undefined)
		throw new Error("--url is required for filed and commented");
	const { dir, meta } = pendingDraft(id, cwd);
	const closed = `${dir}/closed`;
	mkdirSync(closed, { recursive: true });
	const record = {
		...meta,
		outcome: opts.outcome,
		url: opts.url ?? null,
		closed: new Date().toISOString(),
	};
	writeFileSync(`${closed}/${id}.json`, `${JSON.stringify(record, null, 2)}\n`);
	renameSync(`${dir}/${id}.md`, `${closed}/${id}.md`);
	unlinkSync(`${dir}/${id}.json`);
	return `closed: ${id} (${opts.outcome})\n`;
}

const COMMANDS = { draft, list, show, close };

/** The helper's stdout for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const command = COMMANDS[argv[0]];
	if (!Object.hasOwn(COMMANDS, argv[0] ?? ""))
		throw new Error(`unknown command: ${argv[0]}`);
	return command(argv.slice(1), cwd);
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(`rpiv-issue: broken: ${err?.message ?? err}\n`);
		process.exitCode = 2;
	}
}
