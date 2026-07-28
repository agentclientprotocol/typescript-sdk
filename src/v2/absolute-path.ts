import type { AbsolutePath } from "./schema/types.gen.js";

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/;

/**
 * Returns whether a string is an absolute POSIX, Windows drive, or Windows UNC
 * filesystem path. The check is host-independent so ACP messages can be
 * validated while crossing operating-system boundaries.
 *
 * @experimental
 */
export function isAbsolutePath(value: string): value is AbsolutePath {
  if (value.includes("\0")) return false;
  return (
    value.startsWith("/") ||
    WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) ||
    WINDOWS_UNC_ABSOLUTE_PATH.test(value)
  );
}

/**
 * Validates and returns an absolute protocol path.
 *
 * @throws {TypeError} If `value` is not an absolute filesystem path.
 * @experimental
 */
export function absolutePath(value: string): AbsolutePath {
  if (!isAbsolutePath(value)) {
    throw new TypeError(
      `Expected an absolute filesystem path, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}
