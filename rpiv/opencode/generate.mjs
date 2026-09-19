import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateOpenCodeSkills } from "./adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const output = join(HERE, "generated", "skills");
const result = generateOpenCodeSkills(ROOT, output);

process.stdout.write(
	`[rpiv] generated ${result.count} OpenCode skills in ${result.output}\n`,
);
