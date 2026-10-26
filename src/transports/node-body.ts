import type { IncomingMessage } from "node:http";

// Shared request-body handling for Node HTTP integrations.

export function drainRejectedRequest(req: IncomingMessage): void {
  watchRejectedRequest(req, true);
}

export function watchRejectedRequest(
  req: IncomingMessage,
  drain = false,
): void {
  if (req.destroyed || req.readableEnded) {
    return;
  }

  const cleanup = (): void => {
    req.off("error", onError);
    req.off("end", cleanup);
    req.off("close", cleanup);
    req.off("aborted", cleanup);
  };

  const onError = (): void => {
    cleanup();
  };

  req.once("error", onError);
  req.once("end", cleanup);
  req.once("close", cleanup);
  req.once("aborted", cleanup);
  if (drain) {
    req.resume();
  }
}

export async function readRequestBody(
  req: IncomingMessage,
  maxRequestBodyBytes: number,
): Promise<string> {
  const contentLength = requestContentLength(req);

  if (contentLength !== undefined && contentLength > maxRequestBodyBytes) {
    watchRejectedRequest(req);
    throw new RequestBodyTooLargeError(maxRequestBodyBytes);
  }

  const decoder = new TextDecoder();

  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };

    const settleRejected = (error: unknown, cleanupNow = true): void => {
      if (settled) {
        if (cleanupNow) {
          cleanup();
        }

        return;
      }

      settled = true;
      if (cleanupNow) {
        cleanup();
      }

      reject(error);
    };

    const onData = (chunk: unknown): void => {
      if (settled) {
        return;
      }

      receivedBytes += requestBodyChunkByteLength(chunk);
      if (receivedBytes > maxRequestBodyBytes) {
        req.pause();
        settleRejected(
          new RequestBodyTooLargeError(maxRequestBodyBytes),
          false,
        );
        return;
      }

      if (typeof chunk === "string") {
        body +=
          chunk.length === 0
            ? decoder.decode(new Uint8Array(), { stream: true })
            : decoder.decode();
        body += chunk;
        return;
      }

      body += decoder.decode(requestBodyChunkBytes(chunk), { stream: true });
    };

    const onEnd = (): void => {
      cleanup();
      if (settled) {
        return;
      }

      settled = true;
      resolve(body + decoder.decode());
    };

    const onError = (error: Error): void => {
      settleRejected(error);
    };

    const onAborted = (): void => {
      settleRejected(new Error("Request aborted"));
    };

    const onClose = (): void => {
      settleRejected(new Error("Request closed"));
    };

    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    req.once("close", onClose);
    req.on("data", onData);
  });
}

function requestContentLength(req: IncomingMessage): number | undefined {
  const header = req.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;

  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const contentLength = Number(normalized);

  return Number.isSafeInteger(contentLength)
    ? contentLength
    : Number.POSITIVE_INFINITY;
}

function requestBodyChunkByteLength(chunk: unknown): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  return Buffer.byteLength(String(chunk));
}

function requestBodyChunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }

  return Buffer.from(String(chunk));
}

export class RequestBodyTooLargeError extends Error {
  constructor(maxRequestBodyBytes: number) {
    super(`Request body exceeds ${maxRequestBodyBytes} bytes`);
  }
}
