import { z } from "zod/v4";

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

export function vecSkipError<ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
) {
  return z
    .array(itemSchema.catch(skippedItem as never))
    .transform((items): Array<z.output<ItemSchema>> =>
      items.filter((item) => item !== skippedItem),
    );
}
