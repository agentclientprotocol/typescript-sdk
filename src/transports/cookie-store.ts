/**
 * Minimal ACP affinity cookie store.
 *
 * This helper stores cookie name/value pairs from `Set-Cookie` response
 * headers and applies them to outgoing `Cookie` request headers. It is meant
 * for ACP routing affinity across reconnects, not authentication or
 * authorization, and not as a general-purpose browser cookie jar: it
 * intentionally does not implement domain/path matching,
 * expiry, `Secure`, `HttpOnly`, or `SameSite` handling.
 */
export interface AcpCookieStore {
  /** Stores cookies from response headers. */
  store(headers: Headers): void;
  /** Applies stored cookies to outgoing request headers. */
  apply(headers: Headers): void;
  /** Clears all stored cookies. */
  clear(): void;
}

/** In-memory implementation of {@link AcpCookieStore}. */
export class MemoryAcpCookieStore implements AcpCookieStore {
  private readonly cookies = new Map<string, string>();

  store(headers: Headers): void {
    for (const value of setCookieHeaders(headers)) {
      const cookie = parseSetCookie(value);
      if (!cookie) {
        continue;
      }

      this.cookies.set(cookie.name, cookie.value);
    }
  }

  apply(headers: Headers): void {
    const merged = mergeCookieHeaders(
      this.cookieHeader(),
      headers.get("Cookie"),
    );
    if (merged) {
      headers.set("Cookie", merged);
    }
  }

  clear(): void {
    this.cookies.clear();
  }

  private cookieHeader(): string | undefined {
    return this.cookies.size === 0
      ? undefined
      : Array.from(this.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
  }
}

interface CookiePair {
  readonly name: string;
  readonly value: string;
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers).flatMap(splitSetCookieHeader);
  }

  const setCookie = headers.get("Set-Cookie");
  return setCookie ? splitSetCookieHeader(setCookie) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseSetCookie(header: string): CookiePair | undefined {
  const pair = header.split(";", 1)[0];
  const separator = pair.indexOf("=");

  if (separator <= 0) {
    return undefined;
  }

  const name = pair.slice(0, separator).trim();
  if (!name) {
    return undefined;
  }

  return {
    name,
    value: pair.slice(separator + 1).trim(),
  };
}

function mergeCookieHeaders(
  managedCookieHeader: string | undefined,
  callerCookieHeader: string | null,
): string | undefined {
  const cookies = new Map<string, string>();

  for (const cookie of parseCookieHeader(managedCookieHeader)) {
    cookies.set(cookie.name, cookie.value);
  }

  for (const cookie of parseCookieHeader(callerCookieHeader ?? undefined)) {
    cookies.set(cookie.name, cookie.value);
  }

  return cookies.size === 0
    ? undefined
    : Array.from(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

function parseCookieHeader(header: string | undefined): CookiePair[] {
  if (!header) {
    return [];
  }

  return header
    .split(";")
    .map(parseCookiePair)
    .filter((cookie): cookie is CookiePair => cookie !== undefined);
}

function parseCookiePair(value: string): CookiePair | undefined {
  const separator = value.indexOf("=");

  if (separator <= 0) {
    return undefined;
  }

  const name = value.slice(0, separator).trim();
  if (!name) {
    return undefined;
  }

  return {
    name,
    value: value.slice(separator + 1).trim(),
  };
}
