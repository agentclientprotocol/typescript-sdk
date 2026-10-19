#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";
import { promisify } from "node:util";
import * as ts from "typescript";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const npmCli = process.env.npm_execpath;
const { stdout } = await promisify(execFile)(
  npmCli ? process.execPath : "npm",
  npmCli ? [npmCli, ...npmArgs] : npmArgs,
  { maxBuffer: 10 * 1024 * 1024 },
);
const packs = JSON.parse(stdout);
if (!Array.isArray(packs) || packs.length !== 1) {
  throw new Error("Expected one npm pack result");
}

const files = new Set(packs[0].files.map(({ path }) => path));
const required = new Set([
  "LICENSE",
  "README.md",
  "MIGRATION_STABLE_UNSTABLE.md",
  "package.json",
  packageJson.main,
  packageJson.types,
  ...exportTargets(packageJson.exports),
]);
const missing = [...required].filter((file) => !files.has(file));
if (missing.length) {
  throw new Error(
    `The package is missing public files:\n${missing.sort().join("\n")}`,
  );
}

const rootFiles = new Set([
  "LICENSE",
  "README.md",
  "MIGRATION_STABLE_UNSTABLE.md",
  "package.json",
]);
const unexpected = [...files].filter(
  (file) =>
    !rootFiles.has(file) &&
    !/^schema\/v[12]\/schema(?:\.unstable)?\.json$/.test(file) &&
    !(
      file.startsWith("dist/") &&
      /\.(?:js|js\.map|d\.ts)$/.test(file) &&
      !/(?:^|\/)(?:examples|test-support)\//.test(file) &&
      !/\.(?:test|spec)\./.test(file)
    ),
);
if (unexpected.length) {
  throw new Error(
    `The package contains unexpected files:\n${unexpected.sort().join("\n")}`,
  );
}

// Check the packed graph, not just the public entrypoints. A source import can
// pull an excluded test helper into tsc's output even when it is not a root file.
for (const file of files) {
  if (!file.startsWith("dist/") || !/\.(?:js|d\.ts)$/.test(file)) continue;
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(".")
    ) {
      let target = path.normalize(
        path.join(path.dirname(file), specifier.text),
      );
      if (file.endsWith(".d.ts")) target = target.replace(/\.js$/, ".d.ts");
      if (!files.has(target)) {
        throw new Error(`Packed ${file} references missing ${target}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

console.log(
  `Package contents verified: ${files.size} files, ${packs[0].unpackedSize} bytes unpacked`,
);

function exportTargets(value) {
  if (typeof value === "string") return [value.replace(/^\.\//, "")];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(exportTargets);
  return [];
}
