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

const CURRENT_SCHEMA_RELEASE = "schema-v1.16.0";

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
  addExperimentalTags(jsonSchema);
  const schemaDefs = jsonSchema.$defs;

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
      zodPlugin({
        compatibilityVersion: 4,
        $resolvers: createDeserializationResolvers(),
      }),
      transformers({ bigInt: false }),
      typescriptPlugin(),
    ],
  });

  const zodPath = "./src/schema/zod.gen.ts";
  const zodSrc = await fs.readFile(zodPath, "utf8");
  const zod = await prettier.format(updateDocs(zodSrc, schemaDefs), {
    parser: "typescript",
  });
  await fs.writeFile(zodPath, zod);

  const tsPath = "./src/schema/types.gen.ts";
  const tsSrc = await fs.readFile(tsPath, "utf8");
  const ts = await prettier.format(
    updateDocs(
      tsSrc.replace(
        `export type ClientOptions`,
        `// eslint-disable-next-line @typescript-eslint/no-unused-vars\ntype ClientOptions`,
      ),
      schemaDefs,
    ),
    { parser: "typescript" },
  );
  await fs.writeFile(tsPath, ts);

  const meta = await prettier.format(
    `export const AGENT_METHODS = ${JSON.stringify(metadata.agentMethods, null, 2)} as const;

export const CLIENT_METHODS = ${JSON.stringify(metadata.clientMethods, null, 2)} as const;

export const PROTOCOL_METHODS = ${JSON.stringify(metadata.protocolMethods, null, 2)} as const;

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

function addExperimentalTags(value) {
  if (Array.isArray(value)) {
    for (const item of value) addExperimentalTags(item);
    return;
  }

  if (!value || typeof value !== "object") return;

  if (
    typeof value.description === "string" &&
    value.description.includes("**UNSTABLE**") &&
    !value.description.includes("@experimental")
  ) {
    value.description += "\n\n@experimental";
  }

  for (const child of Object.values(value)) {
    addExperimentalTags(child);
  }
}

function createDeserializationResolvers() {
  return {
    array(ctx) {
      const base = ctx.schema["x-deserialize-skip-invalid-items"]
        ? vecSkipErrorExpression(ctx)
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
        );

        shape.prop(
          name,
          property["x-deserialize-default-on-error"]
            ? defaultOnErrorExpression(
                ctx,
                finalExpression,
                property,
                isRequired,
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
  };
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

function propertyExpression(ctx, name, property, propertyResult, isRequired) {
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
        .$(schemaDeserializeSymbol(ctx.plugin, "vecSkipError"))
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

function vecSkipErrorExpression(ctx) {
  const vecSkipError = schemaDeserializeSymbol(ctx.plugin, "vecSkipError");

  if (ctx.childResults.length !== 1) {
    throw new Error(
      `Unable to apply x-deserialize-skip-invalid-items to ${jsonPointerPath(ctx.path)}`,
    );
  }

  return ctx
    .$(vecSkipError)
    .call(ctx.applyModifiers(ctx.childResults[0], { optional: false }).chain);
}

function defaultOnErrorExpression(ctx, schemaExpression, schema, isRequired) {
  const helper = schemaDeserializeSymbol(
    ctx.plugin,
    isRequired ? "requiredDefaultOnError" : "defaultOnError",
  );

  return ctx
    .$(helper)
    .call(
      schemaExpression,
      fallbackFunctionExpression(ctx, schema, isRequired),
    );
}

function schemaDeserializeSymbol(plugin, name) {
  return plugin.symbolOnce(name, {
    external: "../schema-deserialize.js",
  });
}

function fallbackFunctionExpression(ctx, schema, isRequired) {
  return ctx.$.func().do(
    ctx.$.return(fallbackValueExpression(ctx, schema, isRequired)),
  );
}

function fallbackValueExpression(ctx, schema, isRequired) {
  if (Object.hasOwn(schema, "default")) {
    return ctx.$.fromValue(schema.default);
  }

  if (isArraySchema(schema) && (isRequired || !isNullableSchema(schema))) {
    return ctx.$.array();
  }

  return ctx.$.id("undefined");
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

  const lines = description.split("\n");
  const jsdoc =
    "/**\n" + lines.map((l) => (l ? ` * ${l}` : " *")).join("\n") + "\n */\n";

  return src.slice(0, idx) + jsdoc + src.slice(idx);
}
