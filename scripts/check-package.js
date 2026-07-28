#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const { stdout } = await execFileAsync(
  process.env.npm_execpath ?? "npm",
  ["pack", "--dry-run", "--json"],
  {
    env: {
      ...process.env,
      npm_config_loglevel: "silent",
    },
    maxBuffer: 10 * 1024 * 1024,
  },
);
const packs = JSON.parse(stdout);
if (!Array.isArray(packs) || packs.length !== 1) {
  throw new Error(`Expected one npm pack result, received ${packs.length}`);
}

const files = new Set(packs[0].files.map(({ path }) => path));
const forbidden = [...files].filter(
  (path) =>
    path.startsWith("dist/examples/") ||
    path.startsWith("dist/test-support/") ||
    /\.test\.(?:d\.ts|js|js\.map)$/.test(path),
);
if (forbidden.length > 0) {
  throw new Error(
    `The package contains test-only files:\n${forbidden
      .sort()
      .map((path) => `  ${path}`)
      .join("\n")}`,
  );
}

const required = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  packageJson.main,
  packageJson.types,
  ...exportTargets(packageJson.exports),
]);
const missing = [...required].filter((path) => !files.has(path)).sort();
if (missing.length > 0) {
  throw new Error(
    `The package is missing public entrypoints:\n${missing
      .map((path) => `  ${path}`)
      .join("\n")}`,
  );
}

const unexpected = [...files]
  .filter(
    (path) =>
      !path.startsWith("dist/") &&
      !path.startsWith("schema/") &&
      path !== "LICENSE" &&
      path !== "README.md" &&
      path !== "package.json",
  )
  .sort();
if (unexpected.length > 0) {
  throw new Error(
    `The package contains files outside its public allowlist:\n${unexpected
      .map((path) => `  ${path}`)
      .join("\n")}`,
  );
}

console.log(
  `Package contents verified: ${files.size} files, ${packs[0].unpackedSize} bytes unpacked`,
);

function exportTargets(exports) {
  const targets = [];
  visit(exports);
  return targets;

  function visit(value) {
    if (typeof value === "string") {
      targets.push(value.replace(/^\.\//, ""));
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  }
}
