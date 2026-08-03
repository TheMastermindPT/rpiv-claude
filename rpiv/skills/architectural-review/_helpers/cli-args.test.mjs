// cli-args.test.mjs — unit tests for the shared `--flag` parser (both forms + bare
// flags + positionals). No dependencies; prints "OK" on success.
//
//   node skills/architectural-review/_helpers/cli-args.test.mjs
import assert from "node:assert/strict";
import { parseCliArgs } from "./cli-args.mjs";

assert.deepEqual(parseCliArgs(["--k", "v"]), { _: [], k: "v" }, "space form");
assert.deepEqual(parseCliArgs(["--k=v"]), { _: [], k: "v" }, "equals form");
assert.deepEqual(parseCliArgs(["--flag"]), { _: [], flag: true }, "bare flag is boolean true");
assert.deepEqual(parseCliArgs(["--a", "--b", "v"]), { _: [], a: true, b: "v" }, "flag followed by flag stays boolean");
assert.deepEqual(parseCliArgs(["--k=a=b"]), { _: [], k: "a=b" }, "value may contain =");
assert.deepEqual(parseCliArgs(["pos1", "--k", "v", "pos2"]), { _: ["pos1", "pos2"], k: "v" }, "positionals collected in _");
assert.deepEqual(
	parseCliArgs(["--model", "m.json", "--graph=g.json", "--max-undocumented", "3"]),
	{ _: [], model: "m.json", graph: "g.json", "max-undocumented": "3" },
	"mixed forms — the likec4 invocation shape",
);

console.log("OK (cli-args) — space/equals/bare forms + positionals.");
