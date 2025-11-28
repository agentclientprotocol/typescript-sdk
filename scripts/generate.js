#!/usr/bin/env node

import { createClient, defineConfig } from "@hey-api/openapi-ts";
import * as fs from "fs/promises";
import { dirname } from "path";
import * as prettier from "prettier";

const CURRENT_SCHEMA_RELEASE = "v0.8.0";

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
      format: "prettier",
    },
    plugins: ["@hey-api/transformers", "@hey-api/typescript", "zod"],
  });

  const zodPath = "./src/schema/zod.gen.ts";
  const zodSrc = await fs.readFile(zodPath, "utf8");
  await fs.writeFile(
    zodPath,
    updateDocs(zodSrc.replace(`from "zod"`, `from "zod/v4"`)),
  );

  const tsPath = "./src/schema/types.gen.ts";
  const tsSrc = await fs.readFile(tsPath, "utf8");
  await fs.writeFile(
    tsPath,
    updateDocs(
      tsSrc.replace(
        `export type ClientOptions`,
        `// eslint-disable-next-line @typescript-eslint/no-unused-vars\ntype ClientOptions`,
      ),
    ),
  );

  const meta = await prettier.format(
    `export const AGENT_METHODS = ${JSON.stringify(metadata.agentMethods, null, 2)} as const;

export const CLIENT_METHODS = ${JSON.stringify(metadata.clientMethods, null, 2)} as const;

export const PROTOCOL_VERSION = ${metadata.version};
`,
    { parser: "typescript" },
  );
  const indexPath = "./src/schema/index.ts";
  const indexSrc = await fs.readFile(indexPath, "utf8");
  await fs.writeFile(indexPath, `${indexSrc}\n${meta}`);
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
