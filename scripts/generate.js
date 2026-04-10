#!/usr/bin/env node

import { createClient, defineConfig } from "@hey-api/openapi-ts";
import * as fs from "fs/promises";
import { dirname } from "path";
import * as prettier from "prettier";

const CURRENT_SCHEMA_RELEASE = "v0.11.5";

await main();

async function main() {
  if (!process.argv.includes("--skip-download")) {
    await downloadSchemas(CURRENT_SCHEMA_RELEASE);
  }

  const metadata = JSON.parse(await fs.readFile("./schema/meta.json", "utf8"));

  const schemaSrc = await fs.readFile("./schema/schema.json", "utf8");
  const jsonSchema = JSON.parse(
    schemaSrc.replaceAll("#/$defs/", "#/components/schemas/"),
  );
  await createClient({
    input: {
      openapi: "3.1.0",
      info: {
        title: "Agent Client Protocol",
        version: "1.0.0",
      },
      components: {
        schemas: jsonSchema.$defs,
      },
    },
    output: {
      path: "./src/schema",
      postProcess: ["prettier"],
    },
    plugins: [
      "zod",
      { bigInt: false, name: "@hey-api/transformers" },
      "@hey-api/typescript",
    ],
  });

  const zodPath = "./src/schema/zod.gen.ts";
  const zodSrc = await fs.readFile(zodPath, "utf8");
  const zod = await prettier.format(
    updateDocs(
      zodSrc
        .replace(`from "zod"`, `from "zod/v4"`)
        .replaceAll(/z\.object\(/g, "z.looseObject(")
        // Weird type issue
        .replaceAll(
          /z\.record\((?!z\.string\(\),\s*)([^)]+)\)/g,
          "z.record(z.string(), $1)",
        )
        .replaceAll(
          /z\.coerce\s*\.bigint\(\)\s*\.min\(BigInt\("-9223372036854775808"\),\s*\{\s*message:\s*"Invalid value: Expected int64 to be >= -9223372036854775808",\s*\}\s*\)\s*\.max\(BigInt\("9223372036854775807"\),\s*\{\s*message:\s*"Invalid value: Expected int64 to be <= 9223372036854775807",\s*\}\s*\)/gm,
          "z.number()",
        )
        .replaceAll(
          /z\.coerce\s*\.bigint\(\)\s*\.gte\(BigInt\(0\)\)\s*\.max\(BigInt\("18446744073709551615"\),\s*\{\s*message:\s*"Invalid value: Expected uint64 to be <= 18446744073709551615",\s*\}\s*\)/gm,
          "z.number()",
        )
        // Add missing JSDoc for zCreateElicitationResponse
        .replace(
          "\nexport const zCreateElicitationResponse =",
          "\n/**\n * **UNSTABLE**\n *\n * This capability is not part of the spec yet, and may be removed or changed at any point.\n *\n * Response from the client to an elicitation request.\n */\nexport const zCreateElicitationResponse =",
        )
        // Fix zCreateElicitationRequest: add mode discriminated union lost by codegen
        // Uses z.lazy() because zElicitationFormMode is declared later in the file
        .replace(
          /export const zCreateElicitationRequest = z\.intersection\(\s*z\.union\(\[([\s\S]*?)\]\),\s*z\.looseObject\(\{([\s\S]*?)\}\),\s*\);/,
          `/**
 * **UNSTABLE**
 *
 * This capability is not part of the spec yet, and may be removed or changed at any point.
 *
 * Requests structured user input via a form or URL.
 */
export const zCreateElicitationRequest = z.intersection(
  z.union([$1]),
  z.intersection(
    z.lazy(() => z.discriminatedUnion("mode", [
      z.looseObject({ mode: z.literal("form"), ...zElicitationFormMode.shape }),
      z.looseObject({ mode: z.literal("url"), ...zElicitationUrlMode.shape }),
    ])),
    z.looseObject({$2}),
  ),
);`,
        ),
    ),
    { parser: "typescript" },
  );
  await fs.writeFile(zodPath, zod);

  const tsPath = "./src/schema/types.gen.ts";
  const tsSrc = await fs.readFile(tsPath, "utf8");
  const ts = await prettier.format(
    updateDocs(
      tsSrc
        .replace(
          `export type ClientOptions`,
          `// eslint-disable-next-line @typescript-eslint/no-unused-vars\ntype ClientOptions`,
        )
        // Fix CreateElicitationRequest: add mode discriminator (oneOf) lost by codegen
        .replace(
          /(\nexport type CreateElicitationRequest = \([\s\S]*?\n\)) & \{/,
          `$1 & (\n  | (ElicitationFormMode & { mode: "form" })\n  | (ElicitationUrlMode & { mode: "url" })\n) & {`,
        )
        // Add missing JSDoc for CreateElicitationRequest (codegen drops it on anyOf+oneOf schemas)
        .replace(
          "\nexport type CreateElicitationRequest =",
          "\n/**\n * **UNSTABLE**\n *\n * This capability is not part of the spec yet, and may be removed or changed at any point.\n *\n * Requests structured user input via a form or URL.\n */\nexport type CreateElicitationRequest =",
        )
        // Add missing JSDoc for CreateElicitationResponse (codegen drops it on discriminator schemas)
        .replace(
          "\nexport type CreateElicitationResponse =",
          "\n/**\n * **UNSTABLE**\n *\n * This capability is not part of the spec yet, and may be removed or changed at any point.\n *\n * Response from the client to an elicitation request.\n */\nexport type CreateElicitationResponse =",
        ),
    ),
    { parser: "typescript" },
  );
  await fs.writeFile(tsPath, ts);

  const meta = await prettier.format(
    `export const AGENT_METHODS = ${JSON.stringify(metadata.agentMethods, null, 2)} as const;

export const CLIENT_METHODS = ${JSON.stringify(metadata.clientMethods, null, 2)} as const;

export const PROTOCOL_VERSION = ${metadata.version};
`,
    { parser: "typescript" },
  );
  const indexPath = "./src/schema/index.ts";
  const indexSrc = await fs.readFile(indexPath, "utf8");
  await fs.writeFile(
    indexPath,
    `${indexSrc.replace(/\s*ClientOptions,/, "")}\n${meta}`,
  );
}

/**
 * Downloads a file from a URL to a local path
 * @param {string} url - The URL to download from
 * @param {string} outputPath - The local path to save the file
 */
async function downloadFile(url, outputPath) {
  await fs.mkdir(dirname(outputPath), { recursive: true });

  const response = await fetch(url);

  if (response.status === 302 || response.status === 301) {
    // Follow redirects
    await downloadFile(response.headers.location, outputPath);
    return;
  }

  if (response.status !== 200) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  await fs.writeFile(outputPath, response.body);
}

/**
 * Downloads schema files from a GitHub release
 * @param {string} tag - The GitHub release tag (e.g., "v0.5.0")
 */
async function downloadSchemas(tag) {
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;
  const files = [
    { url: `${baseUrl}/schema.unstable.json`, path: "./schema/schema.json" },
    { url: `${baseUrl}/meta.unstable.json`, path: "./schema/meta.json" },
  ];

  console.log(`Downloading schemas from release ${tag}...`);

  for (const file of files) {
    await downloadFile(file.url, file.path);
  }

  console.log("Schema files downloaded successfully\n");
}

function updateDocs(src) {
  let result = src;

  // Replace UNSTABLE comments with @experimental at the end of the comment block
  result = result.replace(
    /(\/\*\*[\s\S]*?\*\*UNSTABLE\*\*[\s\S]*?)(\n\s*)\*\//g,
    "$1$2*$2* @experimental$2*/",
  );

  return result;
}
