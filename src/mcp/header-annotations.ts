import { isJsonObject } from "./core.js";

const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
];
const SCHEMA_VALUES = [
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "contentSchema",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/**
 * Removes transport-only `x-mcp-header` annotations from the schema
 * positions of each listed tool's `inputSchema`, leaving instance data such
 * as property names, defaults, enums and examples untouched.
 */
export function stripHeaderAnnotations(result: unknown): unknown {
  if (!isJsonObject(result) || !Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((tool: unknown) =>
      isJsonObject(tool) && tool.inputSchema !== undefined
        ? { ...tool, inputSchema: stripSchemaAnnotation(tool.inputSchema) }
        : tool,
    ),
  };
}

function stripSchemaAnnotation(schema: unknown): unknown {
  if (!isJsonObject(schema)) return schema;
  const out: Record<string, unknown> = { ...schema };
  delete out["x-mcp-header"];
  for (const key of SCHEMA_MAPS) {
    const children = out[key];
    if (isJsonObject(children)) {
      out[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [
          name,
          stripSchemaAnnotation(child),
        ]),
      );
    }
  }
  if (out.items !== undefined) {
    // Draft-07 tuple schemas use an array here; newer drafts use prefixItems.
    out.items = Array.isArray(out.items)
      ? out.items.map(stripSchemaAnnotation)
      : stripSchemaAnnotation(out.items);
  }
  for (const key of SCHEMA_VALUES) {
    if (out[key] !== undefined) out[key] = stripSchemaAnnotation(out[key]);
  }
  for (const key of SCHEMA_ARRAYS) {
    const children = out[key];
    if (Array.isArray(children)) {
      out[key] = children.map(stripSchemaAnnotation);
    }
  }
  return out;
}
