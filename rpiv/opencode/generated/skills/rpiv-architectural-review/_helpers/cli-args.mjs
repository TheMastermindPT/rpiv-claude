// cli-args.mjs — the single owner of `--flag` parsing for the _helpers CLIs
// (shared-vocab-union: extracted when the likec4 pair's positional `--key value`
// parser was found silently corrupting on `--key=value` form — every argument
// after the `=` flag shifted by one). Accepts BOTH forms plus bare boolean flags:
//
//   --key value   -> { key: "value" }
//   --key=value   -> { key: "value" }
//   --flag        -> { flag: true }   (also when --flag is followed by another --flag)
//
// Non-flag tokens that are not consumed as a value are returned in `_` (positional).
// Importable: parseCliArgs.

/** Parse argv (already sliced past node+script) into { flags..., _: positionals }. */
export const parseCliArgs = (argv) => {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			args._.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		if (eq !== -1) {
			args[a.slice(2, eq)] = a.slice(eq + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
			args[a.slice(2)] = argv[i + 1];
			i += 1;
		} else {
			args[a.slice(2)] = true;
		}
	}
	return args;
};
