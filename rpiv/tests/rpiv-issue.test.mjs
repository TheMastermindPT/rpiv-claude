// tests/rpiv-issue.test.mjs — contract tests for rpiv issue drafts (slice
// S20-rpiv-issue-reports, D43, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md): the helper
// skills/_shared/rpiv-issue.mjs and the SessionStart hook
// .claude/hooks/rpiv-issue-pending.mjs, spawned in throwaway repositories.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills", "_shared", "rpiv-issue.mjs");
const PENDING_HOOK = join(ROOT, ".claude", "hooks", "rpiv-issue-pending.mjs");
const TEST_TIMEOUT = 60_000;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const VERSION = JSON.parse(
	readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
).version;

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-s20-"))).replaceAll(
	"\\",
	"/",
);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let count = 0;
const fresh = (name) => `${TMP}/${name}${count++}`;

/** A repository on main and a linked worktree on `feat/x`. */
function fixture() {
	const repo = initRepo(fresh("repo"));
	const wt = fresh("wt");
	git(repo, "worktree", "add", "-q", "-b", "feat/x", wt);
	return { repo, wt };
}

const commonDir = (dir) =>
	git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
const issuesDir = (dir) => `${commonDir(dir)}/rpiv/issues`;

function issue(cwd, args, env = {}) {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 30_000,
		env: { ...process.env, ...env },
	});
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

const sha8 = (text) =>
	createHash("sha256").update(text).digest("hex").slice(0, 8);
const draftedId = (stdout) => stdout.match(/drafted (\S+) /)?.[1];

/** The id of a minimal draft made in `cwd`. */
const make = (cwd, trigger, title) =>
	draftedId(
		issue(cwd, [
			"draft",
			"--trigger",
			trigger,
			"--component",
			"c",
			"--title",
			title,
			"--what",
			"w",
			"--repro",
			"r",
		]).stdout,
	);

/** The pending-drafts hook run on a SessionStart event in `cwd` (or raw stdin). */
function start(cwd, stdin) {
	const res = spawnSync(process.execPath, [PENDING_HOOK], {
		input:
			stdin ??
			JSON.stringify({
				hook_event_name: "SessionStart",
				source: "startup",
				cwd,
			}),
		encoding: "utf-8",
		timeout: 30_000,
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

/** The additionalContext of a hook run that printed one. */
function contextOf(out) {
	expect(out.status).toBe(0);
	const parsed = JSON.parse(out.stdout);
	expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
	return parsed.hookSpecificOutput.additionalContext;
}

const BASIC = [
	"draft",
	"--trigger",
	"broken",
	"--component",
	"lane.mjs",
	"--title",
	"lane breaks on X",
	"--what",
	"It printed a broken line.",
	"--repro",
	"Run lane.mjs --paths a.",
];

describe("rpiv issue drafts (S20)", () => {
	it(
		"draft writes the issue body to the common dir",
		() => {
			const { repo } = fixture();
			const res = issue(repo, [...BASIC, "--diagnostic", "lane: broken: boom"]);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			const id = draftedId(res.stdout);
			expect(id).toMatch(ID);
			expect(res.stdout).toBe(
				`rpiv-issue: drafted ${id} (0 project value(s), 0 secret-like value(s) removed)\n`,
			);
			const body = readFileSync(`${issuesDir(repo)}/${id}.md`, "utf8");
			expect(body).toBe(
				`## What happened\nIt printed a broken line.\n\n## Where\n- rpiv ${VERSION}, \`lane.mjs\`\n\n## Diagnostic\n~~~\nlane: broken: boom\n~~~\n\n## Minimal repro\nRun lane.mjs --paths a.\n\n---\nTrigger: broken. Privacy: 0 project value(s) and 0 secret-like value(s) were replaced with placeholders.\n`,
			);
			expect(id.endsWith(sha8(body))).toBe(true);
			const meta = JSON.parse(
				readFileSync(`${issuesDir(repo)}/${id}.json`, "utf8"),
			);
			expect(meta).toEqual({
				v: 1,
				id,
				created: expect.stringMatching(ISO),
				trigger: "broken",
				agentJudged: false,
				component: "lane.mjs",
				title: "lane breaks on X",
				stripped: { project: 0, secrets: 0 },
			});

			const plain = issue(repo, BASIC);
			const plainBody = readFileSync(
				`${issuesDir(repo)}/${draftedId(plain.stdout)}.md`,
				"utf8",
			);
			expect(plainBody).not.toContain("## Diagnostic");
			expect(plainBody).toContain("## Where\n- rpiv");

			const judged = issue(
				repo,
				BASIC.map((word) => (word === "broken" ? "judgment" : word)),
			);
			const judgedId = draftedId(judged.stdout);
			expect(
				readFileSync(`${issuesDir(repo)}/${judgedId}.md`, "utf8"),
			).toContain(
				"\n---\nTrigger: judgment (agent-judged). Privacy: 0 project value(s) and 0 secret-like value(s) were replaced with placeholders.\n",
			);
			expect(
				JSON.parse(readFileSync(`${issuesDir(repo)}/${judgedId}.json`, "utf8"))
					.agentJudged,
			).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"draft replaces project and secret-like values with placeholders",
		() => {
			const repo = initRepo(fresh("repo"));
			git(repo, "switch", "-q", "-c", "feat/secret-plan");
			git(repo, "remote", "add", "origin", "https://example.com/acme/app.git");
			const top = git(repo, "rev-parse", "--show-toplevel");
			const home = homedir().replaceAll("\\", "/");
			const rpivRoot = ROOT.replaceAll("\\", "/");
			const values = [
				`${top}/src/app.ts`,
				`${top.replaceAll("/", "\\")}\\src\\app.ts`,
				`${home}/notes.txt`,
				"C:\\Other\\x.txt",
				"/srv/data/x.txt",
				"~/x.txt",
				"feat/secret-plan",
				"https://example.com/acme/app.git",
				`ghp_${"a".repeat(36)}`,
				"token=abc123",
				"me@example.com",
				`${rpivRoot}/skills/_shared/lane.mjs`,
				"skills/_shared/lane.mjs",
				"/rpiv:implement",
				"https://github.com/TheMastermindPT/rpiv-claude/issues/1",
			].join(" ");
			const scrubbed =
				"<project>/src/app.ts <project>\\src\\app.ts <home>/notes.txt <path> <path> <path> <branch> <project-remote> <secret> token=<secret> <email> <rpiv>/skills/_shared/lane.mjs skills/_shared/lane.mjs /rpiv:implement https://github.com/TheMastermindPT/rpiv-claude/issues/1";
			const res = issue(repo, [
				"draft",
				"--trigger",
				"broken",
				"--component",
				values,
				"--title",
				values,
				"--what",
				values,
				"--repro",
				values,
				"--diagnostic",
				values,
			]);
			expect(res.stderr).toBe("");
			const id = draftedId(res.stdout);
			// Each of the five fields carries 8 project and 3 secret-like values.
			expect(res.stdout).toBe(
				`rpiv-issue: drafted ${id} (40 project value(s), 15 secret-like value(s) removed)\n`,
			);
			const body = readFileSync(`${issuesDir(repo)}/${id}.md`, "utf8");
			expect(body).toContain(`## What happened\n${scrubbed}\n`);
			expect(body).toContain(`- rpiv ${VERSION}, \`${scrubbed}\``);
			expect(body).toContain(`~~~\n${scrubbed}\n~~~`);
			expect(body).toContain(`## Minimal repro\n${scrubbed}\n`);
			expect(body).toContain(
				"Privacy: 40 project value(s) and 15 secret-like value(s) were replaced with placeholders.",
			);
			const meta = JSON.parse(
				readFileSync(`${issuesDir(repo)}/${id}.json`, "utf8"),
			);
			expect(meta.title).toBe(scrubbed);
			expect(meta.component).toBe(scrubbed);
			expect(meta.stripped).toEqual({ project: 40, secrets: 15 });

			const one = issue(repo, [
				...BASIC.slice(0, 6),
				"t",
				"--what",
				values,
				"--repro",
				"r",
			]);
			expect(one.stdout).toMatch(
				/\(8 project value\(s\), 3 secret-like value\(s\) removed\)\n$/,
			);
			const oneId = draftedId(one.stdout);
			expect(readFileSync(`${issuesDir(repo)}/${oneId}.md`, "utf8")).toContain(
				"Privacy: 8 project value(s) and 3 secret-like value(s) were replaced",
			);

			if (process.platform === "win32") {
				const upper = issue(repo, [
					...BASIC.slice(0, 7),
					"--what",
					`${top.toUpperCase()}/src/app.ts`,
					"--repro",
					"r",
				]);
				const upperId = draftedId(upper.stdout);
				expect(
					readFileSync(`${issuesDir(repo)}/${upperId}.md`, "utf8"),
				).toContain("## What happened\n<project>/src/app.ts\n");
			}

			const onMain = initRepo(fresh("repo"));
			const kept = issue(onMain, [
				...BASIC.slice(0, 7),
				"--what",
				"main is fine",
				"--repro",
				"r",
			]);
			expect(kept.stdout).toMatch(/\(0 project value\(s\), 0 secret-like/);
			expect(
				readFileSync(
					`${issuesDir(onMain)}/${draftedId(kept.stdout)}.md`,
					"utf8",
				),
			).toContain("## What happened\nmain is fine\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"draft closes the privacy gaps found in review",
		() => {
			const whatOf = (cwd, what) => {
				const res = issue(cwd, [
					...BASIC.slice(0, 7),
					"--what",
					what,
					"--repro",
					"r",
				]);
				expect(res.stderr).toBe("");
				const id = draftedId(res.stdout);
				const meta = JSON.parse(
					readFileSync(`${issuesDir(cwd)}/${id}.json`, "utf8"),
				);
				const body = readFileSync(`${issuesDir(cwd)}/${id}.md`, "utf8");
				return { what: body.split("\n")[1], stripped: meta.stripped };
			};
			const repo = initRepo(fresh("repo"));
			git(repo, "switch", "-q", "-c", "feat/secret-plan");
			git(repo, "remote", "add", "origin", "git@github.com:acme/app.git");
			const top = git(repo, "rev-parse", "--show-toplevel");
			const gaps = [
				"DB_PASSWORD=hunter2",
				"GITHUB_TOKEN=x1",
				"client_secret=abc",
				'token = "abc 123"',
				"password: 'p w'",
				"xoxe-1234567890ab",
				"xoxc-1234567890ab",
				"git@github.com:acme/app.git",
				"file:///opt/acme/x.mjs",
				"PATH=/usr/bin:/srv/app/bin",
				"on feat/secret-plan.",
				"origin/feat/secret-plan",
				"refs/heads/feat/secret-plan",
				"vitest@3.2.4",
				`${top}-secrets/x.txt`,
				"https://github.com/TheMastermindPT/rpiv-claude/issues/1",
			].join(" ");
			expect(whatOf(repo, gaps)).toEqual({
				what: "DB_PASSWORD=<secret> GITHUB_TOKEN=<secret> client_secret=<secret> token = \"<secret>\" password: '<secret>' <secret> <secret> <project-remote> file://<path> PATH=<path> on <branch>. origin/<branch> refs/heads/<branch> vitest@3.2.4 <path> https://github.com/TheMastermindPT/rpiv-claude/issues/1",
				stripped: { project: 7, secrets: 7 },
			});

			const credentialed = initRepo(fresh("repo"));
			const url = "https://user:tok3n@example.com/acme/app.git";
			git(credentialed, "remote", "add", "origin", url);
			expect(whatOf(credentialed, `see ${url}`)).toEqual({
				what: "see <project-remote>",
				stripped: { project: 1, secrets: 0 },
			});
		},
		TEST_TIMEOUT,
	);

	it(
		"drafts are listed, shown and closed from any worktree",
		() => {
			const { repo, wt } = fixture();
			expect(issue(repo, ["list"])).toEqual({
				status: 0,
				stdout: "drafts: 0\n",
				stderr: "",
			});
			const a = make(wt, "broken", "A");
			const b = make(repo, "contradiction", "B");
			const both = `${a} | broken | A\n${b} | contradiction | B\ndrafts: 2\n`;
			expect(issue(repo, ["list"]).stdout).toBe(both);
			expect(issue(wt, ["list"]).stdout).toBe(both);

			expect(issue(wt, ["show", a])).toEqual({
				status: 0,
				stdout: `repo: TheMastermindPT/rpiv-claude\ntitle: A\nbody-file: ${issuesDir(repo)}/${a}.md\n`,
				stderr: "",
			});

			const url = "https://github.com/TheMastermindPT/rpiv-claude/issues/9";
			expect(
				issue(wt, ["close", a, "--outcome", "filed", "--url", url]),
			).toEqual({ status: 0, stdout: `closed: ${a} (filed)\n`, stderr: "" });
			const closed = `${issuesDir(repo)}/closed`;
			expect(existsSync(`${closed}/${a}.md`)).toBe(true);
			expect(existsSync(`${issuesDir(repo)}/${a}.json`)).toBe(false);
			expect(existsSync(`${issuesDir(repo)}/${a}.md`)).toBe(false);
			expect(
				JSON.parse(readFileSync(`${closed}/${a}.json`, "utf8")),
			).toMatchObject({
				id: a,
				title: "A",
				outcome: "filed",
				url,
				closed: expect.stringMatching(ISO),
			});
			expect(issue(repo, ["list"]).stdout).toBe(
				`${b} | contradiction | B\ndrafts: 1\n`,
			);

			expect(issue(repo, ["close", b, "--outcome", "dropped"]).stdout).toBe(
				`closed: ${b} (dropped)\n`,
			);
			expect(
				JSON.parse(readFileSync(`${closed}/${b}.json`, "utf8")),
			).toMatchObject({ outcome: "dropped", url: null });
			expect(issue(repo, ["list"]).stdout).toBe("drafts: 0\n");
			expect(readdirSync(closed).sort()).toEqual(
				[`${a}.json`, `${a}.md`, `${b}.json`, `${b}.md`].sort(),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"bad rpiv-issue calls are broken and write nothing",
		() => {
			const { repo } = fixture();
			const id = draftedId(issue(repo, BASIC).stdout);
			const queue = issuesDir(repo);
			const snapshot = () =>
				readdirSync(queue, { recursive: true }).sort().join("|");
			const before = snapshot();
			const without = (name) => {
				const at = BASIC.indexOf(name);
				return [...BASIC.slice(0, at), ...BASIC.slice(at + 2)];
			};
			const noRepo = join(TMP, "no-repo.json");
			writeFileSync(noRepo, JSON.stringify({ name: "rpiv", version: "1" }));
			const cases = [
				[["send"], "unknown command: send"],
				[[], "unknown command: undefined"],
				[
					BASIC.map((w) => (w === "broken" ? "maybe" : w)),
					"trigger must be broken, rejected-prompt, contradiction or judgment",
				],
				[without("--title"), "draft needs --title"],
				[without("--component"), "draft needs --component"],
				[without("--what"), "draft needs --what"],
				[without("--repro"), "draft needs --repro"],
				[without("--trigger"), "draft needs --trigger"],
				[[...BASIC, "--bogus", "x"], "unknown option: --bogus"],
				[[...without("--title"), "--title"], "--title needs a value"],
				[["list", "--all", "x"], "unknown option: --all"],
				[["show", "nope"], "no pending draft: nope"],
				[["close", "nope", "--outcome", "dropped"], "no pending draft: nope"],
				[
					["close", id, "--outcome", "filed"],
					"--url is required for filed and commented",
				],
				[
					["close", id, "--outcome", "commented"],
					"--url is required for filed and commented",
				],
				[
					["close", id, "--outcome", "lost"],
					"outcome must be filed, commented or dropped",
				],
				[["show", id], "plugin.json has no GitHub repository URL", noRepo],
			];
			for (const [args, detail, manifest] of cases) {
				const env = manifest ? { RPIV_PLUGIN_MANIFEST: manifest } : {};
				expect(issue(repo, args, env), args.join(" ")).toEqual({
					status: 2,
					stdout: "",
					stderr: `rpiv-issue: broken: ${detail}\n`,
				});
				expect(snapshot(), args.join(" ")).toBe(before);
			}

			const outside = fresh("outside");
			mkdirSync(outside);
			const res = issue(outside, BASIC);
			expect(res.status).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr.startsWith("rpiv-issue: broken: ")).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"session start shows pending rpiv issue drafts",
		() => {
			const { repo, wt } = fixture();
			expect(start(wt)).toEqual({ status: 0, stdout: "" });
			const a = draftedId(issue(repo, BASIC).stdout);
			expect(contextOf(start(wt))).toBe(
				"[rpiv] 1 rpiv issue draft pending — /rpiv:issue",
			);
			const b = draftedId(
				issue(
					wt,
					BASIC.map((w) => (w === "broken" ? "judgment" : w)),
				).stdout,
			);
			expect(contextOf(start(repo))).toBe(
				"[rpiv] 2 rpiv issue drafts pending — /rpiv:issue",
			);
			issue(repo, ["close", a, "--outcome", "dropped"]);
			expect(contextOf(start(wt))).toBe(
				"[rpiv] 1 rpiv issue draft pending — /rpiv:issue",
			);
			issue(repo, ["close", b, "--outcome", "dropped"]);
			expect(start(wt)).toEqual({ status: 0, stdout: "" });

			const outside = fresh("outside");
			mkdirSync(outside);
			expect(start(outside)).toEqual({ status: 0, stdout: "" });

			expect(contextOf(start(wt, "{oops"))).toBe(
				"[rpiv-hook] issue drafts not checked: the hook event is not valid JSON",
			);

			const fileQueue = initRepo(fresh("repo"));
			mkdirSync(`${commonDir(fileQueue)}/rpiv`, { recursive: true });
			writeFileSync(issuesDir(fileQueue), "not a folder");
			expect(
				contextOf(start(fileQueue)).startsWith(
					"[rpiv-hook] issue drafts not checked: ",
				),
			).toBe(true);

			const dangling = fresh("dangling");
			mkdirSync(dangling);
			writeFileSync(
				join(dangling, ".git"),
				`gitdir: ${TMP}/missing/.git/worktrees/x\n`,
			);
			expect(
				contextOf(start(dangling)).startsWith(
					"[rpiv-hook] issue drafts not checked: git refused ",
				),
			).toBe(true);
		},
		TEST_TIMEOUT,
	);
});

describe("rpiv issue prose (S20)", () => {
	const readBoth = (source, generated) =>
		[source, generated].map((path) => [
			path,
			existsSync(join(ROOT, path))
				? readFileSync(join(ROOT, path), "utf8")
				: "",
		]);

	it("the issue skill asks before filing and the workflow says when to draft", () => {
		for (const [path, text] of readBoth(
			"skills/issue/SKILL.md",
			"opencode/generated/skills/rpiv-issue/SKILL.md",
		)) {
			// The generator names the OpenCode copy rpiv-<skill> and its question
			// tool `question` (S20 revision 1, approved B203 correction).
			const generated = path.startsWith("opencode/");
			const name = generated ? "rpiv-issue" : "issue";
			const tool = generated ? "question" : "ask_user_question";
			expect(text, path).toMatch(new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
			for (const phrase of [
				/rpiv-issue\.mjs" list/,
				/rpiv-issue\.mjs" show <id>/,
				/gh issue list -R <repo> --state open --search/,
				/gh issue create -R <repo> --title '<title>' --body-file <body-file>/,
				/gh issue comment <number> -R <repo> --body-file <body-file>/,
				new RegExp(
					`one \`${tool}\` that shows the exact title, body and command`,
					"i",
				),
				/the approval hook asks again/i,
				/a declined approval prompt is a stop/i,
				/rpiv-issue\.mjs" close <id> --outcome <filed\|commented\|dropped>/,
				/never the project being worked in/i,
			])
				expect(text, `${path} ${phrase}`).toMatch(phrase);
		}
		for (const [path, text] of readBoth(
			"skills/_shared/candidate-workflow.md",
			"opencode/generated/skills/_shared/candidate-workflow.md",
		))
			for (const phrase of [
				/rpiv-issue\.mjs" draft --trigger <broken\|rejected-prompt\|contradiction\|judgment>/,
				/drafting is local; filing happens only through `\/rpiv:issue`/i,
				/never carries project code/i,
			])
				expect(text, `${path} ${phrase}`).toMatch(phrase);
	});
});

describe("rpiv issue quoting and reach (S20 revision 1)", () => {
	const text = (path) =>
		existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : "";

	it("skills single-quote agent-written values", () => {
		for (const path of [
			"skills/issue/SKILL.md",
			"opencode/generated/skills/rpiv-issue/SKILL.md",
			"skills/_shared/candidate-workflow.md",
			"opencode/generated/skills/_shared/candidate-workflow.md",
		]) {
			expect(text(path), path).toMatch(/single-quote each value/i);
			expect(text(path), path).toMatch(/--title '<title>'/);
			expect(text(path), path).not.toMatch(/--title "<title>"/);
		}
		for (const path of [
			"skills/_shared/candidate-workflow.md",
			"opencode/generated/skills/_shared/candidate-workflow.md",
		]) {
			expect(text(path), path).toMatch(/--what '<what happened>'/);
			expect(text(path), path).toMatch(/--repro '<minimal steps/);
		}
	});
	it("the commit skill points to the rpiv Problems section", () => {
		for (const path of [
			"skills/commit/SKILL.md",
			"opencode/generated/skills/rpiv-commit/SKILL.md",
		]) {
			expect(text(path), path).toMatch(/rpiv Problems/);
			expect(text(path), path).toMatch(
				/rpiv-issue\.mjs" draft --trigger rejected-prompt/,
			);
		}
	});

	it("the filing question has four options", () => {
		for (const path of [
			"skills/issue/SKILL.md",
			"opencode/generated/skills/rpiv-issue/SKILL.md",
		]) {
			for (const phrase of [
				/with four options/i,
				/comment on the best open match/i,
				/edit when no match was found/i,
				/free-text answer/i,
			])
				expect(text(path), `${path} ${phrase}`).toMatch(phrase);
			expect(text(path), path).not.toMatch(/one option per listed open issue/i);
		}
	});
});
