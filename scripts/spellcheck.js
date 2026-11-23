import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run typos with the repository config. Node instead of a bash script, so
// `npm run spellcheck` works on Windows too. Extra arguments go to typos.
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  "typos",
  ["--config", join(root, "typos.toml"), ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" },
);

if (result.error?.code === "ENOENT") {
  console.error("Error: typos is not installed.");
  console.error("Please install it using one of the following methods:");
  console.error("");
  console.error("  Using Cargo:");
  console.error("    cargo install typos-cli");
  console.error("");
  console.error(
    "For more installation options, see: https://github.com/crate-ci/typos",
  );
  process.exit(1);
}
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
