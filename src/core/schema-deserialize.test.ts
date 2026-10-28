import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import {
  defaultOnNull,
  exactlyOneByRequiredKeys,
  excludeKnownTags,
  preserveCustomPayload,
  wideInt,
} from "./schema-deserialize.js";

describe("excludeKnownTags", () => {
  const catchAll = excludeKnownTags(z.object({ mode: z.string() }), "mode", [
    "form",
    "url",
  ]);

  it("accepts values with a custom tag", () => {
    expect(catchAll.safeParse({ mode: "_vendor" }).success).toBe(true);
  });

  it("rejects values whose tag is reserved by a known variant", () => {
    const result = catchAll.safeParse({ mode: "form" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The issue names the offending tag and points at the discriminant, so
      // union-level errors (which surface only this issue) stay actionable.
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({
        code: "custom",
        path: ["mode"],
      });
      expect(result.error.issues[0].message).toContain('"form"');
    }
  });
});

describe("preserveCustomPayload", () => {
  const inner = z.union([
    z.object({ mode: z.literal("form"), value: z.number() }),
    excludeKnownTags(z.object({ mode: z.string() }), "mode", ["form"]),
  ]);
  const schema = preserveCustomPayload(inner, "mode", ["form"]);

  it("re-attaches unevaluated keys for custom-tagged values", () => {
    const result = schema.parse({ mode: "_vendor", payload: { x: 1 } });
    expect(result).toEqual({ mode: "_vendor", payload: { x: 1 } });
  });

  it("re-attaches payload keys that shadow Object.prototype members", () => {
    // `in`-style presence checks see inherited members; the re-attach must
    // use an own-key check or these vendor keys silently vanish.
    const result = schema.parse(
      JSON.parse('{"mode":"_vendor","constructor":"tag","toString":"x"}'),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(result.constructor).toBe("tag");
    expect(result.toString).toBe("x");
  });

  it("never re-attaches __proto__", () => {
    const result = schema.parse(
      JSON.parse('{"mode":"_vendor","__proto__":{"polluted":true}}'),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect((result as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("does not re-attach keys for known-tagged values", () => {
    const result = schema.parse({ mode: "form", value: 1, extra: "dropped" });
    expect(result).toEqual({ mode: "form", value: 1 });
  });

  it("skips re-attachment when the tag is not a string", () => {
    const lax = preserveCustomPayload(z.object({ other: z.string() }), "mode", [
      "form",
    ]);
    expect(lax.parse({ other: "x", extra: 1 })).toEqual({ other: "x" });
  });

  it("passes non-object values through the inner schema untouched", () => {
    const passthrough = preserveCustomPayload(z.string(), "mode", ["form"]);
    expect(passthrough.parse("plain")).toBe("plain");
  });

  it("forwards the inner schema's issues with their paths on failure", () => {
    const result = schema.safeParse({ mode: "form", value: "not-a-number" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      const paths = result.error.issues.map((issue: z.core.$ZodIssue) =>
        issue.path.join("."),
      );
      expect(paths).toContain("mode");
    }
  });

  it("keeps keys the winning member evaluated, even when salvaged", () => {
    // Keys evaluated by the winning member keep their parsed results; keys
    // only a LOSING member would have salvaged arrive raw. This asymmetry is
    // faithful to the schema's unevaluatedProperties semantics — this test
    // pins it so a change is a conscious decision.
    const salvaging = preserveCustomPayload(
      z.union([
        z.object({ mode: z.literal("form"), meta: z.number().catch(0) }),
        excludeKnownTags(z.object({ mode: z.string() }), "mode", ["form"]),
      ]),
      "mode",
      ["form"],
    );
    expect(salvaging.parse({ mode: "form", meta: "bad" })).toEqual({
      mode: "form",
      meta: 0,
    });
    expect(salvaging.parse({ mode: "_vendor", meta: "raw" })).toEqual({
      mode: "_vendor",
      meta: "raw",
    });
  });
});

describe("defaultOnNull", () => {
  const schema = z.object({
    required: defaultOnNull(z.array(z.string()), () => []),
    optional: defaultOnNull(
      z.record(z.string(), z.string()),
      () => ({}),
    ).optional(),
  });

  it("parses null as the empty value", () => {
    expect(schema.parse({ required: null, optional: null })).toEqual({
      required: [],
      optional: {},
    });
  });

  it("keeps a missing required key an error and a missing optional key absent", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.parse({ required: ["a"] })).toEqual({ required: ["a"] });
  });

  it("still rejects malformed values", () => {
    expect(schema.safeParse({ required: "a" }).success).toBe(false);
  });
});

describe("wideInt", () => {
  it("rejects fractions but not integers beyond the safe range", () => {
    expect(wideInt().safeParse(1.5).success).toBe(false);
    expect(wideInt().parse(-1)).toBe(-1);
    expect(wideInt().parse(2 ** 63)).toBe(2 ** 63);
    expect(wideInt().gte(0).safeParse(-1).success).toBe(false);
  });
});

describe("exactlyOneByRequiredKeys", () => {
  const schema = exactlyOneByRequiredKeys(
    [z.object({ a: z.string() }), z.object({ b: z.number() })],
    [["a"], ["b"]],
  );

  it("selects the variant whose required key is present", () => {
    expect(schema.parse({ a: "x" })).toEqual({ a: "x" });
    expect(schema.parse({ b: 1 })).toEqual({ b: 1 });
  });

  it("rejects values carrying several or no variants' keys", () => {
    expect(schema.safeParse({ a: "x", b: 1 }).success).toBe(false);
    expect(schema.safeParse({ a: 1, b: 1 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse("a").success).toBe(false);
  });

  it("reports the selected variant's issues", () => {
    const result = schema.safeParse({ a: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["a"]);
    }
  });
});
