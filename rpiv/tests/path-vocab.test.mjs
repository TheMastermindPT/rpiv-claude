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
	isLockfile,
	isManifest,
	isMigration,
	sensitiveWords,
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

const SENSITIVE = [
	["src/auth/index.ts", ["auth"]],
	["src/authService.ts", ["auth"]],
	["lib/oauth-client.js", ["auth"]],
	["AuthenticationController.cs", ["auth"]],
	["src/JWTToken.ts", ["jwt", "token"]],
	["utils/passwd.py", ["password"]],
	["src/encryption/aes.go", ["crypto"]],
	["scripts/migrate_users.py", ["migration"]],
	["electron/preload-ipc.ts", ["ipc", "preload"]],
	["app/sessions/permissions.rb", ["permission", "session"]],
	["tls/certificates.pem", ["cert"]],
	["src/author.ts", []],
	["blog/authored-posts.md", []],
	["lib/tokenizer.ts", []],
	["db/schemaless.ts", []],
	["secretary/notes.md", []],
	["src/service.ts", []],
	// S3 revision 1: derived forms and acronym plurals.
	["src/middleware/authenticated.ts", ["auth"]],
	["lambda/authorizer.ts", ["auth"]],
	["src/guards/Authorized.tsx", ["auth"]],
	["lib/authenticator.ts", ["auth"]],
	["lib/encrypted-storage.ts", ["crypto"]],
	["services/decryption.go", ["crypto"]],
	["utils/decrypted.ts", ["crypto"]],
	["src/cryptographic/hash.rs", ["crypto"]],
	["secured/area.ts", ["security"]],
	["db/migrator.ts", ["migration"]],
	["db/migrated.ts", ["migration"]],
	["src/utils/parseJWTs.ts", ["jwt"]],
	["src/IPCs.ts", ["ipc"]],
	// S3 revision 1 pins: every remaining word and form, and the rule's edges.
	["security/policy.md", ["security"]],
	["config/secrets.yaml", ["secret"]],
	["aws/credentials", ["credential"]],
	["billing/payments.ts", ["payment"]],
	["db/schema.prisma", ["schema"]],
	["deploy/ssh_config", ["ssh"]],
	["creds.json", ["credential"]],
	["perm/check.ts", ["permission"]],
	["perms.ts", ["permission"]],
	["authn.go", ["auth"]],
	["authz.go", ["auth"]],
	["authorization.ts", ["auth"]],
	["authenticate.ts", ["auth"]],
	["authorize.ts", ["auth"]],
	["secure-store.ts", ["security"]],
	["crypt.c", ["crypto"]],
	["cryptography.py", ["crypto"]],
	["encrypt.ts", ["crypto"]],
	["decrypt.ts", ["crypto"]],
	["sshes.ts", ["ssh"]],
	["auth/authService.ts", ["auth"]],
	[String.raw`src\auth\x.ts`, ["auth"]],
	["my secret notes.md", ["secret"]],
	["lib/x509cert.pem", ["cert"]],
	["src/oauth2client.js", ["auth"]],
];

const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** review-range's category and manifest flag for a change to `file` alone. */
function reviewRangeOf(file) {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-s3-"));
	try {
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "s3@example.invalid");
		git(repo, "config", "user.name", "s3");
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		writeFileSync(join(repo, file), "v1\n");
		writeFileSync(join(repo, "README.md"), "x\n");
		git(repo, "add", ".");
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
		return `${manifest.shards[0]?.category}/${kv.manifest_changed}`;
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

	it("recognizes migrations, CI config, container files and env files", () => {
		for (const [kind, { check, yes, no }] of Object.entries(KINDS)) {
			expect.soft(mismatches(check, yes, true), `${kind} yes`).toEqual([]);
			expect.soft(mismatches(check, no, false), `${kind} no`).toEqual([]);
		}
	});

	it("finds sensitive path words as whole tokens", () => {
		const wrong = SENSITIVE.filter(
			([path, want]) =>
				JSON.stringify(sensitiveWords(path)) !== JSON.stringify(want),
		).map(
			([path, want]) =>
				`${path}: got ${JSON.stringify(sensitiveWords(path))}, want ${JSON.stringify(want)}`,
		);
		expect.soft(wrong).toEqual([]);
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
});
