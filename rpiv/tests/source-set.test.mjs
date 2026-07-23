// tests/source-set.test.mjs — contract tests for the shared source/test vocabulary
// (skills/architectural-review/_helpers/source-set.mjs). Pins the 18-extension UNION
// (the drift fix: mutation.mjs's copy had silently dropped cts/mts) and the
// isSource/isTest classification the AR helpers share.

import { describe, expect, it } from "vitest";
import { SOURCE_EXT, isSource, isTest } from "../skills/architectural-review/_helpers/source-set.mjs";

describe("SOURCE_EXT is the 18-extension union", () => {
	it("contains the cts/mts members mutation.mjs had dropped", () => {
		expect(SOURCE_EXT.has("cts")).toBe(true);
		expect(SOURCE_EXT.has("mts")).toBe(true);
	});

	it("is exactly the 18-element union, in declaration order", () => {
		expect(SOURCE_EXT.size).toBe(18);
		expect([...SOURCE_EXT]).toEqual([
			"ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
			"py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "scala",
		]);
	});
});

describe("isSource and isTest classification", () => {
	it("classifies by extension", () => {
		expect(isSource("a/b.tsx")).toBe(true);
		expect(isSource("a/b.py")).toBe(true);
		expect(isSource("dir.v2/README")).toBe(false);
	});

	it("classifies test files by suffix and __tests__ dirs", () => {
		expect(isTest("x/y.test.mjs")).toBe(true);
		expect(isTest("x/__tests__/y.mjs")).toBe(true);
		expect(isTest("x/y.mjs")).toBe(false);
	});
});
