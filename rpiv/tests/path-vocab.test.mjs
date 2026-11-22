// tests/path-vocab.test.mjs — contract tests for the risk vocabulary owned by
// skills/_shared/source-vocab.mjs (slice S3-path-vocab, D15, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md), and for
// review-range.mjs using it.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isCiConfig,
	isContainerFile,
	isEnvFile,
	isFixture,
	isGenerated,
	isLaneConfig,
	isLockfile,
	isManifest,
	isMedia,
	isMigration,
	isPythonTest,
	isTest,
	isTestData,
} from "../skills/_shared/source-vocab.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_RANGE = join(ROOT, "skills/deep-review/_helpers/review-range.mjs");
const TEST_TIMEOUT = 120_000;

/** Paths for which `predicate` does not answer `want`. */
const mismatches = (predicate, paths, want) =>
	paths.filter((path) => predicate(path) !== want);

// The names review-range.mjs's MANIFEST_BASENAME_RE accepted at 053a238.
const OLD_BASENAME_MANIFESTS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"poetry.lock",
];

const MANIFESTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"deno.json",
	"deno.jsonc",
	"deno.lock",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"requirements.txt",
	"requirements-dev.txt",
	"poetry.lock",
	"Pipfile",
	"Pipfile.lock",
	"setup.py",
	"setup.cfg",
	"Gemfile",
	"Gemfile.lock",
	"composer.json",
	"composer.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"mix.exs",
	"mix.lock",
	"App.csproj",
	"packages.config",
	"paket.dependencies",
	"paket.lock",
	"apps/web/package.json",
	"PACKAGE.JSON",
];

const LOCKFILES = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"composer.lock",
	"mix.lock",
	"paket.lock",
];

const KINDS = {
	migration: {
		check: isMigration,
		yes: [
			"db/migrations/001_init.sql",
			"migration/x.ts",
			"schema.sql",
			String.raw`db\migrations\x.ts`, // S3 rev. 1 pin
		],
		no: ["src/migrate.ts"],
	},
	ci: {
		check: isCiConfig,
		yes: [
			".github/workflows/ci.yml",
			".github/workflows/release.yaml",
			".gitlab-ci.yml",
			".circleci/config.yml",
			"azure-pipelines.yml",
			"Jenkinsfile",
			".travis.yml",
			"bitbucket-pipelines.yml",
			".buildkite/pipeline.yml",
			"azure-pipelines.yaml", // S3 rev. 1
		],
		no: [".github/CODEOWNERS", "docs/ci.md"],
	},
	container: {
		check: isContainerFile,
		yes: [
			"Dockerfile",
			"Dockerfile.prod",
			"api.dockerfile",
			"Containerfile",
			"docker-compose.yml",
			"docker-compose.override.yaml",
			"compose.yaml",
			".dockerignore",
			"compose.override.yaml", // S3 rev. 1
			"compose.yml", // S3 rev. 1 pin
		],
		no: ["docs/docker.md"],
	},
	env: {
		check: isEnvFile,
		yes: [".env", ".env.local", ".env.production", "config/app.env"],
		no: [
			".env.example",
			".env.sample",
			".env.template",
			"src/environment.ts",
			".env.production.example", // S3 rev. 1
			".env.local.example", // S3 rev. 1
		],
	},
};

const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** review-range's category and manifest flag for a change to `file` alone. */
function reviewRangeOf(file) {
	const { kv, manifest } = reviewRangeRun(file);
	return `${manifest.shards[0]?.category}/${kv.manifest_changed}`;
}

/** review-range's shard categories and excluded files for a change to `file` alone. */
function reviewRangeSplitOf(file) {
	const { manifest } = reviewRangeRun(file);
	return {
		categories: manifest.shards.map((shard) => shard.category),
		excluded: manifest.excludedFiles,
	};
}

/** review-range's header fields and changed-files manifest for a working-tree
    change to `file` alone (force-added, so vendored paths are committed too). */
function reviewRangeRun(file) {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-s3-"));
	try {
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "s3@example.invalid");
		git(repo, "config", "user.name", "s3");
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		writeFileSync(join(repo, file), "v1\n");
		writeFileSync(join(repo, "README.md"), "x\n");
		git(repo, "add", "-f", ".");
		git(repo, "commit", "-q", "-m", "init");
		writeFileSync(join(repo, file), "v2\n");
		const out = execFileSync("node", [REVIEW_RANGE, "working"], {
			cwd: repo,
			encoding: "utf-8",
		});
		const head = out.split("---changed-files---\n")[0];
		const kv = Object.fromEntries(
			head
				.trim()
				.split("\n")
				.map((line) => line.match(/^(\w+):\s+(.*)$/))
				.filter(Boolean)
				.map((m) => [m[1], m[2]]),
		);
		const manifest = JSON.parse(
			readFileSync(resolve(repo, kv.changed_files_manifest), "utf8"),
		);
		return { kv, manifest };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/** stdout's last line of a node script under the repository root. */
const scriptResult = (script) =>
	execFileSync("node", [join(ROOT, script)], { encoding: "utf-8" })
		.trim()
		.split("\n")
		.at(-1);

describe("path vocabulary (S3)", () => {
	it("recognizes every manifest and lockfile of the union", () => {
		expect.soft(mismatches(isManifest, MANIFESTS, true)).toEqual([]);
		expect
			.soft(mismatches(isManifest, OLD_BASENAME_MANIFESTS, true))
			.toEqual([]);
		expect
			.soft(
				mismatches(
					isManifest,
					[
						"mypackage.json",
						"package.json.bak",
						"src/pom.xml.txt",
						"docs/requirements.md",
					],
					false,
				),
			)
			.toEqual([]);
		expect.soft(mismatches(isLockfile, LOCKFILES, true)).toEqual([]);
		expect
			.soft(
				mismatches(
					isLockfile,
					[
						"package.json",
						"Cargo.toml",
						"pom.xml",
						// S3 revision 1 pins
						"go.mod",
						"Pipfile",
						"deno.json",
						"uv.lock",
					],
					false,
				),
			)
			.toEqual([]);
		// S3 revision 1 pin: nothing beyond the union.
		expect.soft(isManifest("uv.lock")).toBe(false);
	});

	it("recognizes the root lane config and nothing that looks like it (S22)", () => {
		expect
			.soft(
				mismatches(
					isLaneConfig,
					[".rpiv-lanes.json", "./.rpiv-lanes.json", ".\\.rpiv-lanes.json"],
					true,
				),
			)
			.toEqual([]);
		expect
			.soft(
				mismatches(
					isLaneConfig,
					[
						"sub/.rpiv-lanes.json",
						"rpiv-lanes.json",
						".rpiv-lanes.json.bak",
						"docs/.rpiv-lanes.json.md",
					],
					false,
				),
			)
			.toEqual([]);
	});

	it("recognizes migrations, CI config, container files and env files", () => {
		for (const [kind, { check, yes, no }] of Object.entries(KINDS)) {
			expect.soft(mismatches(check, yes, true), `${kind} yes`).toEqual([]);
			expect.soft(mismatches(check, no, false), `${kind} no`).toEqual([]);
		}
	});

	it(
		"categorizes every manifest-only change as manifest",
		() => {
			const cases = {
				"pom.xml": "manifest/yes",
				"requirements.txt": "manifest/yes",
				"build.gradle": "manifest/yes",
				"package.json": "manifest/yes",
				"db/migrations/001.sql": "migration/no",
				Dockerfile: "other/no",
				".env": "other/no",
				// S3 revision 1 pins: ratified precedence.
				"setup.py": "source/yes",
				"docs/package.json": "docs/yes",
				"deno.json": "manifest/yes",
				Gemfile: "manifest/yes",
			};
			const wrong = Object.entries(cases)
				.map(([file, want]) => [file, want, reviewRangeOf(file)])
				.filter(([, want, got]) => got !== want)
				.map(([file, want, got]) => `${file}: got ${got}, want ${want}`);
			expect.soft(wrong).toEqual([]);
			expect
				.soft(scriptResult("skills/deep-review/_helpers/review-range.test.mjs"))
				.toBe("OK");
		},
		TEST_TIMEOUT,
	);

	it("keeps the existing source vocabulary", () => {
		expect(scriptResult("skills/_shared/source-vocab.test.mjs")).toBe("OK");
	});

	// S4 B34: the S3 residual test debt (s3-review-2-probe.txt) — pins only.
	it(
		"pins the S3 residual vocabulary cases",
		() => {
			expect.soft(reviewRangeOf("src/test/resources/pom.xml")).toBe("test/yes");
			expect
				.soft(
					mismatches(
						isEnvFile,
						[".env.production.sample", ".env.local.template"],
						false,
					),
				)
				.toEqual([]);
			expect.soft(isContainerFile("compose.override.yml")).toBe(true);
		},
		TEST_TIMEOUT,
	);

	// S5 B35 (D17): review-range's GENERATED_PATH_RE and MEDIA_EXT, moved unchanged.
	it(
		"owns the generated and media vocabulary",
		() => {
			const generated = [
				".rpiv/artifacts/designs/x.md",
				"opencode/generated/skills/a.md",
				"coverage/lcov.info",
				"dist/a.js",
				"pkg/build/out.js",
				"node_modules/x/index.js",
				"DIST/a.js",
				// The directory word at the end of the path (mutation hardening).
				"pkg/dist",
				// Tool-written files in target repos: migration metadata and codegen output.
				"drizzle/meta/0002_snapshot.json",
				"db/migrations/meta/_journal.json",
				"src/__generated__/schema.ts",
				"src/routeTree.gen.ts",
				"src/api.generated.ts",
				"vendor/jquery.min.js",
				"styles/site.MIN.css",
			];
			expect.soft(mismatches(isGenerated, generated, true)).toEqual([]);
			expect
				.soft(
					mismatches(
						isGenerated,
						[
							"src/distance.ts",
							"builder/x.ts",
							"src/a.ts",
							"distribution.md",
							"src/meta/x.ts",
							"migrations/0001_add_index.sql",
							"src/general.ts",
							"src/generator.ts",
							"src/admin.ts",
						],
						false,
					),
				)
				.toEqual([]);
			const media = [
				..."avif bmp gif ico jpeg jpg mov mp3 mp4 pdf png svg webm webp woff woff2"
					.split(" ")
					.map((ext) => `a.${ext}`),
				"img/A.PNG",
			];
			expect.soft(mismatches(isMedia, media, true)).toEqual([]);
			expect
				.soft(mismatches(isMedia, ["a.ts", "png", "a.png.ts", "a.tiff"], false))
				.toEqual([]);
			// Pins: review-range's exclusions as probed at bef8b72 (s5-brief-probe-rr.txt).
			for (const file of [
				"dist/a.js",
				"DIST/a.js",
				"pkg/build/out.js",
				".rpiv/artifacts/x.md",
				"opencode/generated/a.md",
				"coverage/lcov.info",
				"node_modules/x/i.js",
				"img/logo.png",
				"fonts/a.WOFF2",
			]) {
				expect
					.soft(reviewRangeSplitOf(file), file)
					.toEqual({ categories: [], excluded: [file] });
			}
			for (const [file, category] of [
				["src/distance.ts", "source"],
				["builder/x.ts", "source"],
				["a.tiff", "other"],
			]) {
				expect
					.soft(reviewRangeSplitOf(file), file)
					.toEqual({ categories: [category], excluded: [] });
			}
		},
		TEST_TIMEOUT,
	);
});

// S1-pytest-report (.rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md):
// the Python runner-test vocabulary reprove-red counts languages with.
describe("Python runner-test vocabulary (S1-pytest-report)", () => {
	// isTest and isFixture as answered at f364d72, before S1: [isTest, isFixture].
	const AT_BASE = {
		"tests/test_ok.py": [true, false],
		"a/b_test.py": [true, false],
		"test_x.py": [true, false],
		"tests/foo_tests.py": [true, false],
		"tests/x.test.py": [true, false],
		"tests/e2e/test_login.py": [true, true],
		"tests/test_utils/test_x.py": [true, false],
		"tests/test_ok.pyi": [false, false],
		"tests/test_ok.txt": [false, false],
		"src/test/resources/helper.py": [true, false],
		"src/test/resources/latest_data.py": [true, false],
		"tests/conftest.py": [false, false],
		"tests/testing.py": [false, false],
		"tests/test_utils/helper.py": [false, false],
		"tests/a.test.mjs": [true, false],
		"tests/fixtures/x.json": [false, true],
		"fixture/a.py": [false, true],
		"src/__fixtures__/a.ts": [false, true],
		"tests/fixtures/py/tests/test_ok.py": [true, true],
		"testing/test_x.py": [true, true],
		"mocks/x.py": [false, true],
		"__mocks__/a.ts": [false, true],
		"tests/fixtures.py": [false, false],
		"tests/my-fixtures/a.json": [false, false],
	};

	it("B11: isPythonTest and isTestData accept exactly their paths, and reprove-red takes both from source-vocab", () => {
		const PYTHON_TESTS = [
			"tests/test_ok.py",
			"a/b_test.py",
			"test_x.py",
			"tests/foo_tests.py",
			"tests/x.test.py",
			"tests/e2e/test_login.py",
			"tests/test_utils/test_x.py",
			"src/tests/test_x.py",
		];
		const NOT_PYTHON_TESTS = [
			"app/src/test/resources/helper.py",
			"tests/test_ok.pyi",
			"tests/test_ok.txt",
			"src/test/resources/helper.py",
			"src/test/resources/latest_data.py",
			"tests/conftest.py",
			"tests/testing.py",
			"tests/test_utils/helper.py",
			"tests/a.test.mjs",
		];
		const TEST_DATA = [
			"tests/fixtures/x.json",
			"fixture/a.py",
			"src/__fixtures__/a.ts",
			"tests/fixtures/py/tests/test_ok.py",
		];
		const NOT_TEST_DATA = [
			"tests/e2e/test_login.py",
			"testing/test_x.py",
			"mocks/x.py",
			"__mocks__/a.ts",
			"tests/fixtures.py",
			"tests/my-fixtures/a.json",
		];
		expect.soft(mismatches(isPythonTest, PYTHON_TESTS, true)).toEqual([]);
		expect.soft(mismatches(isPythonTest, NOT_PYTHON_TESTS, false)).toEqual([]);
		expect.soft(mismatches(isTestData, TEST_DATA, true)).toEqual([]);
		expect.soft(mismatches(isTestData, NOT_TEST_DATA, false)).toEqual([]);
		for (const [path, answers] of Object.entries(AT_BASE)) {
			expect.soft([isTest(path), isFixture(path)], path).toEqual(answers);
		}
		const reproveRed = readFileSync(
			join(ROOT, "skills/_shared/reprove-red.mjs"),
			"utf-8",
		);
		const fromVocab = reproveRed.match(
			/import\s*\{([^}]*)\}\s*from\s*"\.\/source-vocab\.mjs"/,
		);
		const names = (fromVocab?.[1] ?? "").split(",").map((name) => name.trim());
		expect.soft(names).toEqual(
			expect.arrayContaining(["isPythonTest", "isTestData"]),
		);
	});
});
