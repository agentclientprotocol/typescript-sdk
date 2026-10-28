import * as z from "zod/v4";

type Fallback<Output> = () => Output;
const skippedItem = Symbol("skippedItem");

export function defaultOnError<Schema extends z.ZodType>(
  schema: Schema,
  fallback: Fallback<z.output<Schema>>,
) {
  return schema.catch(fallback as () => never);
}

export function requiredDefaultOnError<Schema extends z.ZodType>(
  schema: Schema,
  fallback: Fallback<z.output<Schema>>,
): z.ZodType<z.output<Schema>, z.input<Schema>> {
  const schemaWithCatch = schema.catch(fallback as () => never);

  return z.unknown().transform((value, context): z.output<Schema> => {
    if (value !== undefined) return schemaWithCatch.parse(value);
    context.addIssue({
      code: "custom",
      message: "Required value is missing",
    });
    return z.NEVER;
  }) as z.ZodType<z.output<Schema>, z.input<Schema>>;
}

/**
 * A wire value's discriminant tag, when present as a string. excludeKnownTags
 * and preserveCustomPayload are always applied as a pair, so what counts as
 * "the tag" is single-sourced here.
 */
function stringTag(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const tag = (value as Record<string, unknown>)[key];
  return typeof tag === "string" ? tag : undefined;
}

/**
 * Restores the JSON Schema `not` semantics of an extensible union's catch-all
 * variant, which the code generator drops: the catch-all formally excludes the
 * known variants' discriminant tags, so a malformed known variant (right tag,
 * wrong payload) must fail validation instead of parsing as a custom variant.
 *
 * When this fires inside a union, zod surfaces only this issue (the catch-all
 * is the closest match), so the message names the offending tag; the known
 * variant's own field-level issues are not available here.
 * TODO: re-run the matching known variant's schema and forward its issues so
 * consumers can see which field actually failed.
 */
export function excludeKnownTags<Schema extends z.ZodType>(
  schema: Schema,
  key: string,
  knownTags: ReadonlyArray<string>,
): Schema {
  return schema.superRefine((value, context) => {
    const tag = stringTag(value, key);
    if (tag !== undefined && knownTags.includes(tag)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message:
          `${key} ${JSON.stringify(tag)} is reserved by a known variant, ` +
          `but the value does not match that variant's schema`,
      });
    }
  });
}

/**
 * Restores the `unevaluatedProperties`/`additionalProperties: true` semantics
 * of an extensible union's custom catch-all variant, which the generated
 * object schemas drop: a custom variant's extra properties are its payload,
 * so after a normal (stripping) parse the raw keys the subschemas didn't
 * produce are re-attached. Keys the winning variant evaluated — including
 * invalid values salvaged to defaults — keep their parsed results; keys it
 * did NOT evaluate arrive raw, even ones a losing variant would have salvaged
 * (e.g. a malformed `_meta` on a custom multi-select item).
 */
export function preserveCustomPayload<Schema extends z.ZodType>(
  schema: Schema,
  key: string,
  knownTags: ReadonlyArray<string>,
): z.ZodType<z.output<Schema>, z.input<Schema>> {
  return z.unknown().transform((value, context): z.output<Schema> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        // Finished issues carry everything a raw issue needs except `input`.
        context.addIssue({ ...issue, input: value } as z.core.$ZodRawIssue);
      }
      return z.NEVER;
    }

    const output = result.data as Record<string, unknown>;
    const tag = stringTag(value, key);
    if (tag !== undefined && !knownTags.includes(tag)) {
      const raw = value as Record<string, unknown>;
      for (const [property, rawValue] of Object.entries(raw)) {
        // Own-key check: `in` would see inherited Object.prototype members
        // and silently drop payload keys named `constructor`, `toString`,
        // etc. `__proto__` must never be re-attached — the computed
        // assignment would rewrite the output object's prototype.
        if (property === "__proto__") continue;
        if (!Object.hasOwn(output, property)) output[property] = rawValue;
      }
    }
    return output as z.output<Schema>;
  }) as z.ZodType<z.output<Schema>, z.input<Schema>>;
}

// A shared optional discriminator must be salvaged before selecting a union
// branch, not only inside the common-properties half of an intersection.
// Normalize only malformed tags; valid strings still select their own branch,
// so this cannot turn a malformed known payload into a different variant.
export function defaultOnErrorOptionalStringTag<Schema extends z.ZodType>(
  schema: Schema,
  key: string,
) {
  return z.preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    const tag = record[key];
    if (tag === undefined || tag === null || typeof tag === "string") {
      return value;
    }
    const normalized = { ...record };
    delete normalized[key];
    return normalized;
  }, schema);
}

export function vecSkipError<ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
) {
  return z
    .array(itemSchema.catch(skippedItem as never))
    .transform((items): Array<z.output<ItemSchema>> =>
      items.filter((item) => item !== skippedItem),
    );
}

/**
 * Mirrors serde_with's `DefaultOnNull`: an explicit `null` deserializes as the
 * field's empty value, while every other input — including a missing key — is
 * validated by `schema` unchanged, so a required field still rejects an
 * omitted key.
 */
export function defaultOnNull<Schema extends z.ZodType>(
  schema: Schema,
  empty: Fallback<z.output<Schema>>,
): z.ZodType<z.output<Schema>, z.input<Schema> | null> {
  return z.preprocess(
    (value) => (value === null ? empty() : value),
    schema,
  ) as unknown as z.ZodType<z.output<Schema>, z.input<Schema> | null>;
}

/**
 * A JSON integer for an `i64`/`u64` wire field. Fractions are rejected, but
 * unlike `z.int()` there is no safe-integer bound: a 64-bit peer may send
 * values beyond `Number.MAX_SAFE_INTEGER` (already rounded by `JSON.parse`),
 * and those were accepted before integer checks were emitted.
 */
export function wideInt() {
  return z.number().refine(Number.isInteger, {
    error: "Invalid input: expected int, received number",
  });
}

/**
 * Restores JSON Schema `oneOf` exclusivity for a non-discriminated union of
 * object variants with disjoint required keys (e.g. an elicitation scope:
 * exactly one of `sessionId` / `requestId`). The variant is selected by which
 * required keys are present — a key whose value is `null` or malformed still
 * counts as present, as in the Rust deserializer — and the value is then
 * validated against that variant only. No candidate, or several, fails
 * instead of zod's first-match union silently picking one.
 */
export function exactlyOneByRequiredKeys<
  const Options extends ReadonlyArray<z.ZodType>,
>(
  options: Options,
  requiredKeys: ReadonlyArray<ReadonlyArray<string>>,
): z.ZodType<z.output<Options[number]>, z.input<Options[number]>> {
  if (options.length !== requiredKeys.length) {
    throw new Error("exactlyOneByRequiredKeys: options/keys length mismatch");
  }
  const expected = requiredKeys
    .map((keys) => keys.map((key) => `\`${key}\``).join(" + "))
    .join(" or ");
  return z.unknown().transform((value, context) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      context.addIssue({
        code: "invalid_type",
        expected: "object",
        input: value,
      } as z.core.$ZodRawIssue);
      return z.NEVER;
    }
    const record = value as Record<string, unknown>;
    const candidates = requiredKeys.flatMap((keys, index) =>
      keys.every(
        (key) => Object.hasOwn(record, key) && record[key] !== undefined,
      )
        ? [index]
        : [],
    );
    if (candidates.length !== 1) {
      context.addIssue({
        code: "custom",
        message: `Expected exactly one of ${expected}, found ${candidates.length}`,
      });
      return z.NEVER;
    }
    const result = options[candidates[0]].safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, input: value } as z.core.$ZodRawIssue);
      }
      return z.NEVER;
    }
    return result.data as z.output<Options[number]>;
  }) as unknown as z.ZodType<
    z.output<Options[number]>,
    z.input<Options[number]>
  >;
}
