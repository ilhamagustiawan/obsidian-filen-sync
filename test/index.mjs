// Discovers test files so new suites run without editing package.json.
// `node --test` glob support needs Node 21+; this keeps Node 20 working.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = [
	"test/run-tests.mjs",
	...readdirSync("test")
		.filter((name) => name.endsWith(".test.mjs"))
		.sort()
		.map((name) => `test/${name}`),
];

const result = spawnSync(process.execPath, ["--test", ...files, ...process.argv.slice(2)], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
