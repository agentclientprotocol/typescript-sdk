#!/usr/bin/env node

import { createClient } from "@hey-api/openapi-ts";
import {
  transformers,
  typescript as typescriptPlugin,
  zod as zodPlugin,
} from "@hey-api/openapi-ts/plugins";
import * as fs from "fs/promises";
import { dirname } from "path";
import * as prettier from "prettier";

const CURRENT_V1_SCHEMA_RELEASE = "schema-v1.21.0";
const CURRENT_V2_SCHEMA_RELEASE = "schema-v2.0.0-alpha.3";
const CHECK_GENERATED = process.argv.includes("--check");

// ── Extensible-union pipeline ────────────────────────────────────────────────
// Several schemas model forward compatibility as an "extensible union": known
// const-tagged variants plus a catch-all whose normative `not` clause reserves
// the known tags, and whose `additionalProperties`/`unevaluatedProperties:
// true` makes a custom variant's extra keys its payload. hey-api drops both
// halves of that contract, so this script reconstructs them in stages that
// must be understood together:
//   1. annotateExtensibleUnions reads each `not` clause and stamps
//      x-exclude-known-tags on the catch-all (x- attrs survive into hey-api's
//      IR), translating declared openness into `additionalProperties` so the
//      generated *types* carry the index signature.
//   2. The union/intersection $resolvers wrap the emitted zod validators:
//      excludeKnownTags on the catch-all member (reject malformed known
//      variants) and preserveCustomPayload around each annotated def (keep
//      vendor payloads). Both helpers live in src/schema-deserialize.ts.
//   3. emitExtensibleUnionGuards writes each lane's guards.gen.ts — validated,
//      declaration-merged type guards consumers use to narrow the unions.
// Drift protection, each assertion guarding a different failure mode:
//   - The lane's expectedExtensibleUnions list (below): detection missed a
//     union in the raw schema, or found an unexpected one.
//   - The marker-count checks in main(): the annotation was lost in hey-api's
//     IR, or a resolver misfired on a member it shouldn't touch.
//   - The guards re-export test in src/acp.test.ts: a generated guard isn't
//     reachable from the package entry.
const V1_EXTENSIBLE_UNIONS = [
  "CreateElicitationRequest",
  "CreateElicitationResponse",
  "ElicitationPropertySchema",
  "MultiSelectItems",
];

const V2_EXTENSIBLE_UNIONS = [
  "AuthMethod",
  "AvailableCommandInput",
  "ContentBlock",
  "CreateElicitationRequest",
  "CreateElicitationResponse",
  "DiffChange",
  "ElicitationPropertySchema",
  "McpServer",
  "MultiSelectItems",
  "NesSuggestion",
  "PlanUpdateContent",
  "ReplayFrom",
  "RequestPermissionOutcome",
  "RequestPermissionSubject",
  "SessionConfigOption",
  "SessionUpdate",
  "SetSessionConfigOptionRequest",
  "StateUpdate",
  "ToolCallContent",
];

const SCHEMA_CONFIGS = [
  {
    name: "v1",
    schemaPath: "./schema/schema.json",
    metadataPath: "./schema/meta.json",
    outputDir: "./src/schema",
    stagingDir: "./src/.schema-staging",
    previousDir: "./src/.schema-previous",
    schemaDeserializeImport: "../schema-deserialize.js",
    expectedExtensibleUnions: V1_EXTENSIBLE_UNIONS,
    openApiVersion: "1.0.0",
    releaseTag: CURRENT_V1_SCHEMA_RELEASE,
  },
  {
    name: "v2",
    schemaPath: "./schema/v2/schema.unstable.json",
    metadataPath: "./schema/v2/meta.unstable.json",
    outputDir: "./src/v2/schema",
    stagingDir: "./src/.schema-v2-staging",
    previousDir: "./src/.schema-v2-previous",
    schemaDeserializeImport: "../../schema-deserialize.js",
    expectedExtensibleUnions: V2_EXTENSIBLE_UNIONS,
    openApiVersion: "2.0.0",
    releaseTag: CURRENT_V2_SCHEMA_RELEASE,
  },
];

// The x- attribute recording a catch-all variant's `not` exclusion; x-
// attributes survive into hey-api's IR, where the union resolver reads it.
// Declared before `await main()` below — anything main() calls must already
// be initialized.
const EXCLUDE_KNOWN_TAGS_ATTR = "x-exclude-known-tags";

await main();

async function main() {
  if (!process.argv.includes("--skip-download")) {
    for (const config of SCHEMA_CONFIGS) {
      await downloadSchemas(config);
    }
  }

  for (const config of SCHEMA_CONFIGS) {
    await generateSchema(config, CHECK_GENERATED);
  }
}

async function generateSchema(config, checkGenerated) {
  const metadata = JSON.parse(await fs.readFile(config.metadataPath, "utf8"));

  const schemaSrc = await fs.readFile(config.schemaPath, "utf8");
  const jsonSchema = JSON.parse(
    schemaSrc.replaceAll("#/$defs/", "#/components/schemas/"),
  );
  assertMetadataMatchesSchema(
    metadata,
    jsonSchema.$defs,
    config.name,
    Number.parseInt(config.openApiVersion, 10),
  );
  addExperimentalTags(jsonSchema);
  stripAnyOfDiscriminators(jsonSchema);
  const defExclusions = annotateExtensibleUnions(jsonSchema.$defs);
  const schemaDefs = jsonSchema.$defs;

  // Generate into a staging directory and swap into place only after every
  // step (including the drift assertions below) has succeeded: hey-api wipes
  // its output directory at the start of a run, so generating in place would
  // leave src/schema wiped or half-written whenever anything here throws.
  const schemaDir = config.outputDir;
  const stagingDir = config.stagingDir;
  const previousDir = config.previousDir;
  // Belt-and-braces: hey-api's default clean also wipes its output directory;
  // this covers leftovers if that default ever changes.
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.rm(previousDir, { recursive: true, force: true });

  await createClient({
    input: {
      openapi: "3.1.0",
      info: {
        title: "Agent Client Protocol",
        version: config.openApiVersion,
      },
      components: {
        schemas: jsonSchema.$defs,
      },
    },
    // No prettier postProcess: the spawned CLI would skip the staging dir
    // (it is .prettierignore'd so a failed run's leftovers don't break
    // format:check); formatStable below formats every file instead.
    output: {
      path: stagingDir,
    },
    plugins: [
      zodPlugin({
        compatibilityVersion: 4,
        // ACP date-time values stay as RFC 3339 wire strings. Offsets are
        // valid RFC 3339 and must be accepted alongside the UTC `Z` suffix.
        dates: { offset: true },
        $resolvers: createDeserializationResolvers(
          defExclusions,
          config.schemaDeserializeImport,
        ),
      }),
      transformers({ bigInt: false, dates: false }),
      typescriptPlugin(),
    ],
  });

  const zodPath = `${stagingDir}/zod.gen.ts`;
  const zodSrc = await fs.readFile(zodPath, "utf8");
  // Consumers reading the wrapped validators' docs need the SDK-specific
  // behavior that isn't in the schema descriptions: custom variants bypass
  // the lenient-field salvage known variants get.
  let zodDocs = updateDocs(zodSrc, schemaDefs);
  for (const [name, exclusion] of defExclusions) {
    zodDocs = appendDocNote(
      zodDocs,
      `export const z${name} =`,
      `Custom variants (unknown \`${exclusion.key}\` values) keep their extra\n` +
        `properties exactly as received; unlike known variants, those keys\n` +
        `bypass lenient-field salvage and arrive unvalidated.`,
    );
  }
  const zod = await formatStable(zodDocs);
  // The resolvers apply the catch-all exclusions and payload preservation
  // annotated from the schema's `not` clauses. Too few means the annotation
  // was lost in hey-api's IR (the union silently reverts to accepting
  // malformed known variants as custom); too many means a resolver misfired
  // on a member it shouldn't touch. Both directions fail here.
  for (const marker of ["excludeKnownTags", "preserveCustomPayload"]) {
    const found = (zod.match(new RegExp(`${marker}\\(`, "g")) ?? []).length;
    if (found !== config.expectedExtensibleUnions.length) {
      throw new Error(
        `[${config.name}] Expected exactly ${config.expectedExtensibleUnions.length} ` +
          `${marker} call sites in zod.gen.ts, found ${found}; the resolvers' ` +
          `extensible-union handling may have drifted from the schema`,
      );
    }
  }
  await fs.writeFile(zodPath, zod);

  const tsPath = `${stagingDir}/types.gen.ts`;
  const tsSrc = await fs.readFile(tsPath, "utf8");
  const ts = await formatStable(
    updateDocs(
      tsSrc.replace(
        `export type ClientOptions`,
        `// eslint-disable-next-line @typescript-eslint/no-unused-vars\ntype ClientOptions`,
      ),
      schemaDefs,
    ),
  );
  await fs.writeFile(tsPath, ts);

  // Always write the file: the staging swap replaces the whole directory, so
  // skipping the write here would silently delete guards.gen.ts.
  const guardsSrc = emitExtensibleUnionGuards(
    schemaDefs,
    config.expectedExtensibleUnions,
    config.name,
  );
  const guards = await formatStable(guardsSrc);
  await fs.writeFile(`${stagingDir}/guards.gen.ts`, guards);

  const meta = `export const AGENT_METHODS = ${JSON.stringify(metadata.agentMethods, null, 2)} as const;

export const CLIENT_METHODS = ${JSON.stringify(metadata.clientMethods, null, 2)} as const;

export const PROTOCOL_METHODS = ${JSON.stringify(metadata.protocolMethods, null, 2)} as const;

export const PROTOCOL_VERSION = ${metadata.version};
`;
  const indexPath = `${stagingDir}/index.ts`;
  const indexSrc = await fs.readFile(indexPath, "utf8");
  await fs.writeFile(
    indexPath,
    await formatStable(`${indexSrc.replace(/\s*ClientOptions,/, "")}\n${meta}`),
  );

  if (checkGenerated) {
    const drift = await compareGeneratedDirectories(schemaDir, stagingDir);
    await fs.rm(stagingDir, { recursive: true, force: true });
    if (drift.length > 0) {
      throw new Error(
        `[${config.name}] Generated sources are stale:\n` +
          `${drift.map((change) => `  ${change}`).join("\n")}\n` +
          "Run `npm run generate -- --skip-download` and commit the result.",
      );
    }
    return;
  }

  // Rename-aside swap: a valid src/schema exists at every instant, so an
  // interruption strands at worst an ignored dot-directory, never a missing
  // schema. (ENOENT: a fresh checkout may have no schema dir to set aside.)
  await fs.mkdir(dirname(schemaDir), { recursive: true });
  await fs.rename(schemaDir, previousDir).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.rename(stagingDir, schemaDir);
  await fs.rm(previousDir, { recursive: true, force: true });
}

function assertMetadataMatchesSchema(
  metadata,
  schemaDefs,
  lane,
  expectedVersion,
) {
  if (metadata.version !== expectedVersion) {
    throw new Error(
      `[${lane}] Expected metadata protocol version ${expectedVersion}, ` +
        `found ${JSON.stringify(metadata.version)}`,
    );
  }

  const schemaMethods = {
    agent: new Set(),
    client: new Set(),
    protocol: new Set(),
  };
  for (const [name, schema] of Object.entries(schemaDefs)) {
    const method = schema["x-method"];
    const side = schema["x-side"];
    if (method === undefined) continue;
    if (typeof method !== "string") {
      throw new Error(
        `[${lane}] ${name} has a non-string x-method: ${JSON.stringify(method)}`,
      );
    }

    if (side === "both") {
      schemaMethods.agent.add(method);
      schemaMethods.client.add(method);
    } else if (side in schemaMethods) {
      schemaMethods[side].add(method);
    } else {
      throw new Error(
        `[${lane}] ${name} has x-method ${JSON.stringify(method)} but an ` +
          `unsupported x-side: ${JSON.stringify(side)}`,
      );
    }
  }

  const metadataMethods = {
    agent: metadataMethodSet(metadata.agentMethods, lane, "agentMethods"),
    client: metadataMethodSet(metadata.clientMethods, lane, "clientMethods"),
    protocol: metadataMethodSet(
      metadata.protocolMethods,
      lane,
      "protocolMethods",
    ),
  };

  for (const side of Object.keys(schemaMethods)) {
    const missing = [...schemaMethods[side]]
      .filter((method) => !metadataMethods[side].has(method))
      .sort();
    const extra = [...metadataMethods[side]]
      .filter((method) => !schemaMethods[side].has(method))
      .sort();
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `[${lane}] ${side} method metadata does not match schema x-methods.` +
          `${missing.length > 0 ? `\n  missing: ${missing.join(", ")}` : ""}` +
          `${extra.length > 0 ? `\n  extra: ${extra.join(", ")}` : ""}`,
      );
    }
  }
}

function metadataMethodSet(value, lane, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[${lane}] Metadata ${field} must be an object`);
  }
  const methods = Object.values(value);
  if (!methods.every((method) => typeof method === "string")) {
    throw new Error(`[${lane}] Metadata ${field} values must all be strings`);
  }
  if (new Set(methods).size !== methods.length) {
    throw new Error(`[${lane}] Metadata ${field} contains duplicate methods`);
  }
  return new Set(methods);
}

async function compareGeneratedDirectories(expectedDir, generatedDir) {
  const expected = await readDirectoryFiles(expectedDir);
  const generated = await readDirectoryFiles(generatedDir);
  const paths = [...new Set([...expected.keys(), ...generated.keys()])].sort();
  const drift = [];

  for (const path of paths) {
    if (!expected.has(path)) {
      drift.push(`added: ${path}`);
    } else if (!generated.has(path)) {
      drift.push(`removed: ${path}`);
    } else if (!expected.get(path).equals(generated.get(path))) {
      drift.push(`changed: ${path}`);
    }
  }

  return drift;
}

async function readDirectoryFiles(root, relative = "") {
  const files = new Map();
  const entries = await fs.readdir(`${root}/${relative}`, {
    withFileTypes: true,
  });

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [childPath, contents] of await readDirectoryFiles(
        root,
        path,
      )) {
        files.set(childPath, contents);
      }
    } else if (entry.isFile()) {
      files.set(path, await fs.readFile(`${root}/${path}`));
    } else {
      throw new Error(
        `Unsupported generated filesystem entry: ${root}/${path}`,
      );
    }
  }

  return files;
}

// Formats until prettier reaches a fixed point. Prettier's member-chain
// heuristic keeps chains that arrive pre-broken, so formatting hey-api's raw
// output once can produce a string that `prettier --check` would still
// reformat; one more pass converges.
async function formatStable(source) {
  let current = source;
  for (let i = 0; i < 3; i++) {
    const formatted = await prettier.format(current, { parser: "typescript" });
    if (formatted === current) return formatted;
    current = formatted;
  }
  throw new Error(
    "prettier did not reach a formatting fixed point after 3 passes; " +
      "the generated output would fail format:check",
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
 * Downloads one protocol version's schema files from a GitHub release.
 * @param {object} config - The schema generation configuration.
 */
async function downloadSchemas(config) {
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${config.releaseTag}`;
  const files = [
    { url: `${baseUrl}/schema.unstable.json`, path: config.schemaPath },
    { url: `${baseUrl}/meta.unstable.json`, path: config.metadataPath },
  ];

  console.log(
    `Downloading ${config.name} schemas from release ${config.releaseTag}...`,
  );

  for (const file of files) {
    await downloadFile(file.url, file.path);
  }

  console.log(`${config.name} schema files downloaded successfully\n`);
}

function updateDocs(src, schemaDefs) {
  let result = src;

  // Inject missing doc comments from schema descriptions.
  // The code generator drops JSDoc for types that produce intersection types
  // (schemas using oneOf/anyOf combined with properties).
  if (schemaDefs) {
    for (const [name, def] of Object.entries(schemaDefs)) {
      if (!def.description) continue;

      result = injectDocIfMissing(
        result,
        `export type ${name} =`,
        def.description,
      );
      result = injectDocIfMissing(
        result,
        `export const z${name} =`,
        def.description,
      );
    }
  }

  return result;
}

// Pre-order recursive walk over a JSON schema document (objects and arrays).
function walkSchema(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkSchema(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) walkSchema(child, visit);
}

function addExperimentalTags(value) {
  walkSchema(value, (node) => {
    if (
      typeof node.description === "string" &&
      node.description.includes("**UNSTABLE**") &&
      !node.description.includes("@experimental")
    ) {
      node.description += "\n\n@experimental";
    }
  });
}

// hey-api treats `anyOf` + `discriminator` (without a `mapping`) as the OpenAPI
// allOf-inheritance pattern: any schema that references the discriminated schema
// via `allOf` gets the discriminator property injected with the *referencing*
// schema's name as its value (e.g. `CreateElicitationRequest & { mode?: "AgentRequest" }`),
// which breaks both the generated types and the Zod validators. The discriminator
// is redundant for these schemas — their variants carry inline `const` tags — so
// drop it before generation.
function stripAnyOfDiscriminators(value) {
  walkSchema(value, (node) => {
    if (node.anyOf && node.discriminator) {
      delete node.discriminator;
    }
  });
}

// The catch-all variant of an extensible union carries a normative `not`
// clause excluding the known variants' discriminant tags, and declares itself
// open to arbitrary extra properties — the custom variant's vendor payload —
// via `additionalProperties: true` or, for variants that flatten another enum
// (where schemars must use the draft 2020-12 keyword that sees through
// subschemas), `unevaluatedProperties: true`. hey-api drops `not` from its IR
// and understands neither openness keyword on objects with `properties`, so
// both halves of the catch-all's contract are lost. Record the `not`
// exclusion as an x- attribute for the union resolver, and translate declared
// openness into `additionalProperties: true` so the generated *types* carry
// the index signature (runtime preservation happens in preserveCustomPayload,
// applied per named def via the returned map).
function annotateExtensibleUnions(schemaDefs) {
  const defExclusions = new Map();
  for (const [name, def] of Object.entries(schemaDefs)) {
    const exclusion = annotateUnionNode(def);
    if (exclusion) defExclusions.set(name, exclusion);
    for (const child of Object.values(def)) {
      walkSchema(child, annotateUnionNode);
    }
  }
  return defExclusions;
}

function annotateUnionNode(node) {
  const variants = node.anyOf ?? node.oneOf;
  if (!Array.isArray(variants)) return undefined;

  let exclusion;
  for (const variant of variants) {
    const found = notClauseExclusion(variant.not);
    if (!found) continue;
    variant[EXCLUDE_KNOWN_TAGS_ATTR] = found;
    if (
      variant.properties &&
      (variant.additionalProperties === true ||
        variant.unevaluatedProperties === true)
    ) {
      variant.additionalProperties = true;
    }
    exclusion = found;
  }
  return exclusion;
}

// Reads a catch-all variant's `not` clause: an anyOf of matchers, each pinning
// the shared discriminant to one known variant's const tag.
function notClauseExclusion(not) {
  if (!not) return undefined;
  const clauses = not.anyOf ?? [not];
  let key;
  const tags = [];
  for (const clause of clauses) {
    for (const [prop, propSchema] of Object.entries(clause.properties ?? {})) {
      if (typeof propSchema?.const !== "string") continue;
      if (key && key !== prop) return undefined;
      key = prop;
      tags.push(propSchema.const);
    }
  }
  return key ? { key, tags: tags.sort() } : undefined;
}

// Several schemas model forward compatibility with an "extensible union": an
// `anyOf` of known, discriminant-tagged variants plus a catch-all variant
// (identified by its normative `not` clause — see annotateExtensibleUnions)
// whose discriminant is an untyped `string`. TypeScript
// cannot narrow these — a positive discriminant check (`x.action === "accept"`)
// never removes the catch-all, because its `action: string` is a supertype of the
// tested literal, and its `[key: string]: unknown` index signature then drags
// every property read down to `unknown`. There is no consumer-side check that
// fixes this (TS has no negated-literal types).
//
// A discriminant-only guard would also be *unsound*: responses are not validated
// by the SDK, so a malformed known variant (e.g. `{action:"accept"}` with a bad
// `content`) can reach consumers. Guards therefore validate the variant payload,
// not just its tag.
//
// For each such union we emit a companion value bound to the union's type name
// (declaration merging), exposing one validated guard per variant:
//
//   if (CreateElicitationResponse.isAccept(response)) {
//     response.content; // fully typed, not `unknown`
//   }
//
// `isCustom` narrows to the catch-all: a tag no known variant uses (with a valid
// payload where the catch-all carries structure). A malformed known variant
// matches no guard — the same classification the wire validators apply via
// excludeKnownTags (see createDeserializationResolvers' union resolver).
function emitExtensibleUnionGuards(schemaDefs, expectedUnions, lane) {
  const unions = [];
  for (const [name, def] of Object.entries(schemaDefs)) {
    const union = analyzeExtensibleUnion(name, def);
    if (union) unions.push(union);
  }

  const detected = unions.map((union) => union.name).sort();
  const expected = [...expectedUnions].sort();
  if (JSON.stringify(detected) !== JSON.stringify(expected)) {
    throw new Error(
      `[${lane}] Extensible-union detection drifted from its expected set.\n` +
        `  expected: ${expected.join(", ") || "(none)"}\n` +
        `  detected: ${detected.join(", ") || "(none)"}\n` +
        `If the schema legitimately changed, update the ${lane} schema config in ` +
        `scripts/generate.js and that lane's guard exports.`,
    );
  }
  if (unions.length === 0)
    return "// This file is auto-generated by scripts/generate.js\nexport {};\n";

  const hoisted = [];
  const namespaces = [];

  for (const union of unions) {
    const methods = [];

    for (const variant of union.known) {
      hoisted.push(`const ${variant.schemaConst} = ${variant.zodExpr};`);
      methods.push(
        `  /** Narrow to the \`${variant.label}\` variant, validating its payload. */\n` +
          `  is${variant.pascal}(value: types.${union.name}): value is ${variant.tsType} {\n` +
          `    return ${variant.checkExpr};\n` +
          `  },`,
      );
    }

    // isCustom mirrors wire validation: the catch-all variant excludes the
    // known variants' tags, so a malformed known variant (right tag, wrong
    // payload) matches no guard rather than being classified as custom.
    const customChecks = [
      `typeof tag === "string"`,
      `!${JSON.stringify(union.knownTags)}.includes(tag)`,
    ];
    const customZodParts = [union.catchAll.zodExpr, union.commonZodExpr].filter(
      Boolean,
    );
    const customZodExpr = customZodParts.length
      ? chainAnd(customZodParts)
      : null;
    if (customZodExpr) {
      const schemaConst = `zGuard${union.name}Custom`;
      hoisted.push(`const ${schemaConst} = ${customZodExpr};`);
      customChecks.push(`${schemaConst}.safeParse(value).success`);
    }
    methods.push(
      `  /**\n` +
        `   * Narrow to a custom or future variant: the \`${union.discriminant}\` tag matches no known variant` +
        `${customZodExpr ? ", with a valid payload" : ""}.\n` +
        `   *\n` +
        `   * TypeScript keeps the known variants in the narrowed union (they are\n` +
        `   * structural subtypes of the catch-all), so read vendor payload keys\n` +
        `   * via a widening cast: \`(value as Record<string, unknown>).someKey\`.\n` +
        `   */\n` +
        `  isCustom(value: types.${union.name}): value is ${union.catchAll.tsType} {\n` +
        `    const tag = tagOf(value, ${JSON.stringify(union.discriminant)});\n` +
        `    return (\n      ${customChecks.join(" &&\n      ")}\n    );\n` +
        `  },`,
    );

    const guardDoc =
      `Validated type guards for \`${union.name}\`'s known variants.\n\n` +
      `Each guard validates the variant's payload, not just its discriminant\n` +
      `tag: a malformed known variant (right tag, wrong payload) matches no\n` +
      `guard — mirroring wire validation, which rejects such values instead\n` +
      `of classifying them as custom.\n\n` +
      `Guards check the value as given: fields that wire deserialization\n` +
      `salvages to a default (e.g. a malformed \`_meta\`) are only normalized\n` +
      `by parsing, and for ambiguous raw shapes (a known tag combined with\n` +
      `another variant's payload) guards are conservative where wire parsing\n` +
      `may still accept the value — narrow wire-parsed values when exact\n` +
      `parity matters.` +
      (union.description?.includes("@experimental") ? `\n\n@experimental` : "");

    // Re-export the type next to the companion value so the two merge into one
    // name. acp.ts re-exports this pair explicitly; that explicit re-export
    // shadows the wildcard `export type *` of the same name, so the type must
    // originate here too (a same-module `export type *` + `export type {}` would
    // otherwise be a duplicate identifier). The alias carries the schema doc
    // because the shadowed types.gen.ts declaration's JSDoc doesn't follow it.
    namespaces.push(
      `${formatJsdoc(union.description)}export type ${union.name} = types.${union.name};\n` +
        `${formatJsdoc(guardDoc)}export const ${union.name} = {\n${methods.join("\n\n")}\n} as const;`,
    );
  }

  return (
    `// This file is auto-generated by scripts/generate.js\n\n` +
    `import * as z from "zod/v4";\n\n` +
    `import type * as types from "./types.gen.js";\n` +
    `import * as validate from "./zod.gen.js";\n\n` +
    // Each guard checks the discriminant tag before running the variant's zod
    // schema: it short-circuits non-matching variants cheaply, and it keeps
    // known variants that carry no tag (e.g. titled multi-select items, whose
    // schema would accept a custom-tagged value's extra keys) from swallowing
    // custom variants.
    `function tagOf(value: unknown, key: string): unknown {\n` +
    `  return typeof value === "object" && value !== null\n` +
    `    ? (value as Record<string, unknown>)[key]\n` +
    `    : undefined;\n` +
    `}\n\n` +
    `${hoisted.join("\n")}\n\n` +
    `${namespaces.join("\n\n")}\n`
  );
}

function analyzeExtensibleUnion(name, def) {
  const variants = def.anyOf ?? def.oneOf;
  if (!Array.isArray(variants)) return undefined;

  // The catch-all is the variant annotateExtensibleUnions marked from its
  // normative `not` clause, which also names the discriminant and the tags the
  // known variants reserve. A schema change that stops the annotation from
  // applying skips the union here — and the lane's expected-union
  // assertion turns that skip into a generation failure.
  const catchAllVariant = variants.find((v) => v[EXCLUDE_KNOWN_TAGS_ATTR]);
  if (!catchAllVariant) return undefined;
  const { key: discriminant, tags: knownTags } =
    catchAllVariant[EXCLUDE_KNOWN_TAGS_ATTR];

  const commonKeys = Object.keys(def.properties ?? {});
  const commonPick = commonKeys.length
    ? ` & Pick<types.${name}, ${commonKeys.map((k) => JSON.stringify(k)).join(" | ")}>`
    : "";
  // The guards' predicate types claim the def-level common properties via
  // commonPick, so required (non-salvaged) ones must be validated too — a
  // guard returning true for a `message`-less request while narrowing to
  // `{ message: string }` would be unsound.
  const commonZodExpr = requiredCommonPropsExpr(name, def);

  const known = variants
    .filter((variant) => variant !== catchAllVariant)
    .map((variant) => {
      const refs = allOfRefs(variant);
      const constValue = variant.properties?.[discriminant]?.const;
      const label =
        constValue !== undefined
          ? String(constValue)
          : (variant.title ?? refs[0] ?? discriminant);

      if (constValue === undefined && variant.properties?.[discriminant]) {
        throw new Error(
          `${name}: known variant "${label}" declares "${discriminant}" ` +
            `without a const tag; analyzeExtensibleUnion cannot emit a sound guard for it`,
        );
      }
      // The `not` clause is the source of truth for which tags are reserved;
      // a const-tagged variant it doesn't cover would make wire validation
      // and the guards disagree about what counts as custom.
      if (constValue !== undefined && !knownTags.includes(constValue)) {
        throw new Error(
          `${name}: known variant tag ${JSON.stringify(constValue)} is not ` +
            `excluded by the catch-all's \`not\` clause (${knownTags.join(", ")})`,
        );
      }

      const typeParts = refs.map((ref) => `types.${ref}`);
      const zodParts = refs.map((ref) => `validate.z${ref}`);
      if (constValue !== undefined) {
        typeParts.push(`{ ${discriminant}: ${JSON.stringify(constValue)} }`);
        zodParts.push(
          `z.object({ ${discriminant}: z.literal(${JSON.stringify(constValue)}) })`,
        );
      }
      const inlineRequired = requiredInlineProps(`${name}.${label}`, variant, [
        discriminant,
      ]);
      if (inlineRequired) {
        typeParts.push(inlineRequired.tsType);
        zodParts.push(inlineRequired.zodExpr);
      }
      if (zodParts.length === 0) {
        throw new Error(
          `${name}: known variant "${label}" has neither allOf $refs nor ` +
            `a const-tagged "${discriminant}"; nothing to validate against`,
        );
      }
      if (commonZodExpr) zodParts.push(commonZodExpr);

      const pascal = pascalCase(label);
      const schemaConst = `zGuard${name}${pascal}`;
      // Known variants without a const tag (e.g. titled multi-select items)
      // are identified by the *absence* of the discriminant — their zod schema
      // alone would also accept custom-tagged values, since z.object ignores
      // unknown keys.
      const tagLiteral =
        constValue !== undefined ? JSON.stringify(constValue) : "undefined";

      return {
        label,
        pascal,
        schemaConst,
        tsType: `(${typeParts.join(" & ")})${commonPick}`,
        zodExpr: chainAnd(zodParts),
        checkExpr:
          `tagOf(value, ${JSON.stringify(discriminant)}) === ${tagLiteral} &&\n` +
          `      ${schemaConst}.safeParse(value).success`,
      };
    });

  // Reconstruct the catch-all's TS type so `isCustom`'s predicate stays assignable
  // to the union, plus a zod expression for its payload when it carries structure
  // beyond an open bag of properties (e.g. a nested scope union).
  const catchAll = analyzeCatchAll(name, catchAllVariant, discriminant);
  catchAll.tsType += commonPick;

  return {
    name,
    description: def.description,
    discriminant,
    knownTags,
    known,
    catchAll,
    commonZodExpr,
  };
}

// Zod for the def-level common properties that are required and not salvaged
// by deserialization defaults (e.g. CreateElicitationRequest's `message`).
// Salvaged (x-deserialize-default-on-error) props are deliberately excluded:
// wire parsing is lenient about them too, so a guard skipping them matches
// post-parse reality — the generated guard doc covers this. Only shapes the
// current schema uses get a mapping; anything else must fail loudly rather
// than emit a guard laxer than the wire schema (e.g. z.number() where the
// wire uses z.int()).
function requiredCommonPropsExpr(name, def) {
  return requiredInlineProps(name, def)?.zodExpr ?? null;
}

// Type and Zod expressions for required inline object properties. Referenced
// payloads are handled separately by analyzeExtensibleUnion/analyzeCatchAll;
// this covers fields declared directly on a union variant or catch-all.
function requiredInlineProps(name, schema, excluded = []) {
  const required = (schema.required ?? []).filter(
    (prop) =>
      !excluded.includes(prop) &&
      !schema.properties?.[prop]?.["x-deserialize-default-on-error"],
  );
  if (required.length === 0) return null;

  const typeProps = [];
  const props = required.map((prop) => {
    const propertySchema = schema.properties?.[prop];
    const singleAllOfRef =
      propertySchema?.allOf?.length === 1
        ? propertySchema.allOf[0]?.$ref
        : undefined;
    const ref = propertySchema?.$ref ?? singleAllOfRef;
    const expressions = ref
      ? {
          type: `types.${refName(ref)}`,
          zod: `validate.z${refName(ref)}`,
        }
      : propertySchema?.type === "string"
        ? { type: "string", zod: "z.string()" }
        : propertySchema?.type === "boolean"
          ? { type: "boolean", zod: "z.boolean()" }
          : isUnconstrainedSchema(propertySchema)
            ? { type: "unknown", zod: "z.unknown()" }
            : undefined;
    if (!expressions) {
      throw new Error(
        `${name}: required property "${prop}" has an unsupported shape for guard emission`,
      );
    }
    typeProps.push(`${prop}: ${expressions.type}`);
    return `${prop}: ${expressions.zod}`;
  });
  return {
    tsType: `{ ${typeProps.join("; ")} }`,
    zodExpr: `z.object({ ${props.join(", ")} })`,
  };
}

function isUnconstrainedSchema(schema) {
  if (!schema) return false;
  return Object.keys(schema).every(
    (key) =>
      key === "description" ||
      key === "title" ||
      key === "$comment" ||
      key.startsWith("x-"),
  );
}

function analyzeCatchAll(name, variant, discriminant) {
  const inlineRequired = requiredInlineProps(name, variant, [discriminant]);
  const nested = variant.anyOf ?? variant.oneOf;
  const refUnion = Array.isArray(nested) ? nested.flatMap(allOfRefs) : [];
  const directRefs = allOfRefs(variant);

  if (directRefs.length === 0 && refUnion.length === 0) {
    // Open bag of properties — matches the generated index-signature variant,
    // and the discriminant check in isCustom validates its tag.
    const openBag = `({ ${discriminant}: string; [key: string]: unknown })`;
    return {
      tsType: inlineRequired
        ? `(${openBag} & ${inlineRequired.tsType})`
        : openBag,
      zodExpr: inlineRequired?.zodExpr ?? null,
    };
  }

  const tsRefs =
    refUnion.length > 0
      ? `(${refUnion.map((ref) => `types.${ref}`).join(" | ")})`
      : directRefs.map((ref) => `types.${ref}`).join(" & ");
  const zodParts =
    refUnion.length > 0
      ? [`z.union([${refUnion.map((ref) => `validate.z${ref}`).join(", ")}])`]
      : directRefs.map((ref) => `validate.z${ref}`);
  if (inlineRequired) zodParts.push(inlineRequired.zodExpr);
  return {
    // The index signature matches the generated union member: a custom
    // variant's extra keys are its payload and survive parsing.
    tsType:
      `(${tsRefs} & { ${discriminant}: string; [key: string]: unknown }` +
      `${inlineRequired ? ` & ${inlineRequired.tsType}` : ""})`,
    zodExpr: chainAnd(zodParts),
  };
}

function allOfRefs(schema) {
  return (schema.allOf ?? [])
    .map((entry) => entry.$ref)
    .filter(Boolean)
    .map(refName);
}

function chainAnd(zodParts) {
  return (
    zodParts[0] +
    zodParts
      .slice(1)
      .map((part) => `.and(${part})`)
      .join("")
  );
}

function refName(ref) {
  return ref.split("/").pop();
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function createDeserializationResolvers(
  defExclusions,
  schemaDeserializeImport,
) {
  return {
    array(ctx) {
      const base = ctx.schema["x-deserialize-skip-invalid-items"]
        ? vecSkipErrorExpression(ctx, schemaDeserializeImport)
        : ctx.nodes.base(ctx);

      ctx.chain.current = base;
      const lengthResult = ctx.nodes.length(ctx);
      if (lengthResult) {
        ctx.chain.current = lengthResult;
      } else {
        const minLengthResult = ctx.nodes.minLength(ctx);
        if (minLengthResult) ctx.chain.current = minLengthResult;
        const maxLengthResult = ctx.nodes.maxLength(ctx);
        if (maxLengthResult) ctx.chain.current = maxLengthResult;
      }

      return ctx.chain.current;
    },

    number(ctx) {
      if (!shouldEmitNumberForBigIntFormat(ctx.schema.format)) {
        return undefined;
      }

      ctx.chain.current = ctx.$(ctx.plugin.imports.z).attr("number").call();
      return ctx.chain.current;
    },

    object(ctx) {
      if (!hasDefaultOnErrorProperties(ctx.schema)) return undefined;

      const shape = ctx.$.object().pretty();
      for (const name in ctx.schema.properties) {
        const property = ctx.schema.properties[name];
        const isRequired = ctx.schema.required?.includes(name) === true;
        const propertyResult = ctx.walk(
          property,
          childContext(
            { path: ctx.path, plugin: ctx.plugin },
            "properties",
            name,
          ),
        );
        ctx._childResults.push(propertyResult);

        const finalExpression = propertyExpression(
          ctx,
          name,
          property,
          propertyResult,
          isRequired,
          schemaDeserializeImport,
        );

        shape.prop(
          name,
          property["x-deserialize-default-on-error"]
            ? defaultOnErrorExpression(
                ctx,
                finalExpression,
                property,
                isRequired,
                schemaDeserializeImport,
              )
            : finalExpression,
        );
      }

      const defaultShape = ctx.nodes.shape;
      ctx.nodes.shape = () => shape;
      const base = ctx.nodes.base(ctx);
      ctx.nodes.shape = defaultShape;
      return base;
    },

    // Restores the catch-all exclusion recorded by annotateExtensibleUnions:
    // without it the emitted union is laxer than the schema, and a malformed
    // known variant (right tag, wrong payload) would parse via the catch-all
    // as a "custom" variant. When the union IS an annotated named def (a pure
    // union like MultiSelectItems), also wrap it in preserveCustomPayload so
    // a custom variant's vendor payload survives the stripping parse.
    union(ctx) {
      let excluded = false;
      ctx.schemas.forEach((member, index) => {
        const exclusion = memberExclusion(member);
        if (!exclusion) return;
        const child = ctx.childResults[index];
        child.chain = deserializeWrap(
          ctx,
          "excludeKnownTags",
          child.chain,
          exclusion,
          schemaDeserializeImport,
        );
        excluded = true;
      });

      const defLevel = annotatedDefExclusion(ctx, defExclusions);
      if (!excluded && !defLevel) return undefined;

      ctx.chain.current = ctx.nodes.base(ctx);
      if (defLevel) {
        ctx.chain.current = deserializeWrap(
          ctx,
          "preserveCustomPayload",
          ctx.chain.current,
          defLevel,
          schemaDeserializeImport,
        );
      }
      return ctx.chain.current;
    },

    // Annotated defs that hey-api emits as intersections (a variant union
    // combined with shared properties, e.g. CreateElicitationRequest) get
    // their payload preservation here, at the def's outermost expression.
    // Preservation must wrap the WHOLE def: re-attaching raw keys inside a
    // union member would make zod's intersection merge throw on keys that a
    // sibling schema parses to a different value (e.g. a salvaged `_meta`).
    intersection(ctx) {
      const defLevel = annotatedDefExclusion(ctx, defExclusions);
      if (!defLevel) return undefined;

      ctx.chain.current = deserializeWrap(
        ctx,
        "preserveCustomPayload",
        ctx.nodes.base(ctx),
        defLevel,
        schemaDeserializeImport,
      );
      return ctx.chain.current;
    },
  };
}

// The exclusion annotation on a union member in hey-api's IR. When the
// catch-all composes a payload with its tag (allOf), the IR splits it into an
// `and` composite and copies peripheral attributes onto the items.
function memberExclusion(member) {
  if (member[EXCLUDE_KNOWN_TAGS_ATTR]) return member[EXCLUDE_KNOWN_TAGS_ATTR];
  if (member.logicalOperator === "and" && Array.isArray(member.items)) {
    return member.items.find((item) => item[EXCLUDE_KNOWN_TAGS_ATTR])?.[
      EXCLUDE_KNOWN_TAGS_ATTR
    ];
  }
  return undefined;
}

// The exclusion for the extensible union a resolver is emitting, but only
// when it is the named def itself (path `components/schemas/<Name>`) — nested
// occurrences of the same shapes reference the def by $ref and must not be
// double-wrapped.
function annotatedDefExclusion(ctx, defExclusions) {
  const segments = fromRef(ctx.path) ?? ctx.path;
  if (!Array.isArray(segments) || segments.length !== 3) return undefined;
  if (segments[0] !== "components" || segments[1] !== "schemas") {
    return undefined;
  }
  return defExclusions.get(segments[2]);
}

// Both schema-deserialize helpers share the (schema, key, knownTags) contract.
function deserializeWrap(
  ctx,
  helperName,
  expression,
  exclusion,
  schemaDeserializeImport,
) {
  return ctx
    .$(schemaDeserializeSymbol(ctx.plugin, helperName, schemaDeserializeImport))
    .call(
      expression,
      ctx.$.fromValue(exclusion.key),
      ctx.$.fromValue(exclusion.tags),
    );
}

function shouldEmitNumberForBigIntFormat(format) {
  return format === "int64" || format === "uint64";
}

function childContext(ctx, ...segments) {
  return {
    path: ref([...fromRef(ctx.path), ...segments]),
    plugin: ctx.plugin,
  };
}

function ref(path) {
  return { "~ref": path };
}

function fromRef(ref) {
  return ref?.["~ref"];
}

function jsonPointerPath(ref) {
  return `#/${fromRef(ref).map(jsonPointerSegment).join("/")}`;
}

function jsonPointerSegment(segment) {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function hasDefaultOnErrorProperties(schema) {
  return Object.values(schema.properties ?? {}).some(
    (property) => property["x-deserialize-default-on-error"],
  );
}

function propertyExpression(
  ctx,
  name,
  property,
  propertyResult,
  isRequired,
  schemaDeserializeImport,
) {
  if (!property["x-deserialize-skip-invalid-items"]) {
    return ctx.applyModifiers(propertyResult, { optional: !isRequired }).chain;
  }

  const itemSchema = getArrayItemSchema(property);
  if (!itemSchema) {
    throw new Error(
      `Unable to apply x-deserialize-skip-invalid-items to ${jsonPointerPath(childContext(ctx, "properties", name).path)}`,
    );
  }

  const itemResult = ctx.walk(
    itemSchema,
    childContext(
      { path: ctx.path, plugin: ctx.plugin },
      "properties",
      name,
      "items",
      0,
    ),
  );

  return ctx.applyModifiers(
    {
      chain: ctx
        .$(
          schemaDeserializeSymbol(
            ctx.plugin,
            "vecSkipError",
            schemaDeserializeImport,
          ),
        )
        .call(ctx.applyModifiers(itemResult, { optional: false }).chain),
      meta: propertyResult.meta,
    },
    { optional: !isRequired },
  ).chain;
}

function getArrayItemSchema(schema) {
  if (schema.type === "array" && schema.items) {
    return Array.isArray(schema.items) ? schema.items[0] : schema.items;
  }

  const items = Array.isArray(schema.items) ? schema.items : [];
  for (const item of items) {
    const itemSchema = getArrayItemSchema(item);
    if (itemSchema) return itemSchema;
  }

  return undefined;
}

function vecSkipErrorExpression(ctx, schemaDeserializeImport) {
  const vecSkipError = schemaDeserializeSymbol(
    ctx.plugin,
    "vecSkipError",
    schemaDeserializeImport,
  );

  if (ctx.childResults.length !== 1) {
    throw new Error(
      `Unable to apply x-deserialize-skip-invalid-items to ${jsonPointerPath(ctx.path)}`,
    );
  }

  return ctx
    .$(vecSkipError)
    .call(ctx.applyModifiers(ctx.childResults[0], { optional: false }).chain);
}

function defaultOnErrorExpression(
  ctx,
  schemaExpression,
  schema,
  isRequired,
  schemaDeserializeImport,
) {
  const helper = schemaDeserializeSymbol(
    ctx.plugin,
    isRequired ? "requiredDefaultOnError" : "defaultOnError",
    schemaDeserializeImport,
  );

  return ctx
    .$(helper)
    .call(
      schemaExpression,
      fallbackFunctionExpression(ctx, schema, isRequired),
    );
}

function schemaDeserializeSymbol(plugin, name, external) {
  return plugin.symbolOnce(name, {
    external,
  });
}

function fallbackFunctionExpression(ctx, schema, isRequired) {
  return ctx.$.func().do(
    ctx.$.return(fallbackValueExpression(ctx, schema, isRequired)),
  );
}

function fallbackValueExpression(ctx, schema, isRequired) {
  if (Object.hasOwn(schema, "default")) {
    const value = ctx.$.fromValue(schema.default);
    return isPrimitiveLiteral(schema.default)
      ? ctx.$(value).as("const")
      : value;
  }

  if (isArraySchema(schema) && (isRequired || !isNullableSchema(schema))) {
    return ctx.$.array();
  }

  return ctx.$.id("undefined");
}

function isPrimitiveLiteral(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isArraySchema(schema) {
  return schema.type === "array";
}

function isNullableSchema(schema) {
  return schema.nullable === true;
}

function injectDocIfMissing(src, exportStr, description) {
  const idx = src.indexOf(exportStr);
  if (idx === -1) return src;

  const before = src.substring(0, idx);
  if (/\*\/\s*$/.test(before)) return src;

  return src.slice(0, idx) + formatJsdoc(description) + src.slice(idx);
}

function formatJsdoc(description) {
  if (!description) return "";
  const lines = description.split("\n");
  return (
    "/**\n" + lines.map((l) => (l ? ` * ${l}` : " *")).join("\n") + "\n */\n"
  );
}

// Appends a note to the doc block directly preceding `exportStr`, creating
// the block when none exists.
function appendDocNote(src, exportStr, note) {
  const idx = src.indexOf(exportStr);
  if (idx === -1) return src;

  const before = src.slice(0, idx);
  if (!/\*\/\s*$/.test(before)) return injectDocIfMissing(src, exportStr, note);

  const closing = before.lastIndexOf("*/");
  const lines = note.split("\n").map((l) => (l ? ` * ${l}` : " *"));
  return `${src.slice(0, closing)}*\n${lines.join("\n")}\n ${src.slice(closing)}`;
}
