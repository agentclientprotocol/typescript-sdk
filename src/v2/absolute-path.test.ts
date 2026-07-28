import { describe, expect, it } from "vitest";

import { absolutePath, isAbsolutePath } from "./absolute-path.js";
import { zAbsolutePath } from "./schema/zod.gen.js";
import type { AbsolutePath } from "./schema/types.gen.js";

const typedAbsolutePath: AbsolutePath = absolutePath("/workspace");
const parsedAbsolutePath: AbsolutePath = zAbsolutePath.parse("/workspace");
// @ts-expect-error Raw strings must be validated before use as protocol paths.
const unvalidatedAbsolutePath: AbsolutePath = "/workspace";
void typedAbsolutePath;
void parsedAbsolutePath;
void unvalidatedAbsolutePath;

describe("absolute protocol paths", () => {
  it.each([
    "/",
    "/tmp/project",
    "C:\\",
    "C:\\Users\\agent\\project",
    "D:/projects/acp",
    "\\\\server\\share",
    "\\\\server/share/directory",
    "//server/share/directory",
    "\\\\?\\C:\\long\\path",
  ])("accepts %s", (value) => {
    expect(isAbsolutePath(value)).toBe(true);
    expect(absolutePath(value)).toBe(value);
    expect(zAbsolutePath.parse(value)).toBe(value);
  });

  it.each([
    "",
    ".",
    "./project",
    "../project",
    "tmp/project",
    "C:relative",
    "\\rooted-without-drive",
    "~/project",
    "/tmp/\0project",
  ])("rejects %s", (value) => {
    expect(isAbsolutePath(value)).toBe(false);
    expect(() => absolutePath(value)).toThrow(TypeError);
    expect(zAbsolutePath.safeParse(value).success).toBe(false);
  });
});
