import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Remove the build output. Node instead of `rm -rf`, which cmd.exe does not
// have, so `npm run build` works on Windows too.
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["dist", "tsconfig.tsbuildinfo"]) {
  rmSync(join(root, name), { recursive: true, force: true });
}
