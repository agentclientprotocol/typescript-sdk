import { HEADER_CONNECTION_ID } from "./protocol.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AcpServer, PreparedWebSocketUpgrade } from "./server.js";
import type { WebSocketServerSocket } from "./ws-server.js";

type NodeWebSocketHeadersListener = (
  headers: string[],
  request: IncomingMessage,
) => void;

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface NodeHttpHandlerOptions {
  readonly maxRequestBodyBytes?: number;
}

export interface NodeWebSocketUpgradeServer {
  on(event: "headers", listener: NodeWebSocketHeadersListener): void;
  off(event: "headers", listener: NodeWebSocketHeadersListener): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (webSocket: WebSocketServerSocket) => void,
  ): void;
}

export function createNodeHttpHandler(
  server: AcpServer,
  options: NodeHttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxRequestBodyBytes = resolveMaxRequestBodyBytes(
    options.maxRequestBodyBytes,
  );

  return (req, res) => {
    void handleNodeRequest(server, req, res, maxRequestBodyBytes);
  };
}

export function createNodeWebSocketUpgradeHandler(
  server: AcpServer,
  webSocketServer: NodeWebSocketUpgradeServer,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    let upgrade: PreparedWebSocketUpgrade | undefined;
    let hasAccepted = false;

    const cleanup = (): void => {
      webSocketServer.off("headers", onHeaders);
      socket.off("close", onUpgradeFailed);
      socket.off("error", onUpgradeFailed);
    };

    const onHeaders = (headers: string[], request: IncomingMessage): void => {
      if (request !== req || !upgrade) {
        return;
      }

      headers.push(`${HEADER_CONNECTION_ID}: ${upgrade.connectionId}`);
    };

    const onUpgradeFailed = (): void => {
      if (hasAccepted) {
        return;
      }

      cleanup();
      upgrade?.reject();
    };

    try {
      upgrade = server.prepareWebSocketUpgrade();
      webSocketServer.on("headers", onHeaders);
      socket.once("close", onUpgradeFailed);
      socket.once("error", onUpgradeFailed);

      webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
        hasAccepted = true;
        cleanup();
        upgrade?.accept(webSocket);
      });
    } catch (error) {
      cleanup();
      upgrade?.reject();
      destroyUpgradeSocket(socket, error);
    }
  };
}

async function handleNodeRequest(
  server: AcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBodyBytes: number,
): Promise<void> {
  const requestAbort = nodeRequestAbortSignal(req, res);

  try {
    await writeNodeResponse(
      res,
      await server.handleRequest(
        await toWebRequest(req, requestAbort.signal, maxRequestBodyBytes),
      ),
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writePlainTextErrorResponse(res, 413, error.message);
      drainRejectedRequest(req);
      return;
    }

    writePlainTextErrorResponse(
      res,
      500,
      error instanceof Error ? error.message : "Internal Server Error",
    );
  } finally {
    requestAbort.cleanup();
  }
}

function writePlainTextErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "text/plain");
  }

  res.end(message);
}

function drainRejectedRequest(req: IncomingMessage): void {
  watchRejectedRequest(req, true);
}

function watchRejectedRequest(req: IncomingMessage, drain = false): void {
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

function destroyUpgradeSocket(socket: Duplex, error: unknown): void {
  socket.destroy(error instanceof Error ? error : undefined);
}

interface NodeRequestAbortSignal {
  readonly signal: AbortSignal;
  cleanup(): void;
}

function nodeRequestAbortSignal(
  req: IncomingMessage,
  res: ServerResponse,
): NodeRequestAbortSignal {
  const abortController = new AbortController();
  let isFinished = false;

  const onFinish = (): void => {
    isFinished = true;
  };
  const onClose = (): void => {
    if (!isFinished) {
      abortController.abort(new Error("Node HTTP response closed"));
    }
  };

  req.once("aborted", onClose);
  res.once("finish", onFinish);
  res.once("close", onClose);

  return {
    signal: abortController.signal,
    cleanup: () => {
      req.off("aborted", onClose);
      res.off("finish", onFinish);
      res.off("close", onClose);
    },
  };
}

async function toWebRequest(
  req: IncomingMessage,
  signal: AbortSignal,
  maxRequestBodyBytes: number,
): Promise<Request> {
  return new Request(nodeRequestUrl(req), {
    method: req.method ?? "GET",
    headers: nodeHeaders(req),
    body: hasRequestBody(req)
      ? await readRequestBody(req, maxRequestBodyBytes)
      : undefined,
    signal,
  });
}

function hasRequestBody(req: IncomingMessage): boolean {
  return req.method !== "GET" && req.method !== "HEAD";
}

async function readRequestBody(
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

function resolveMaxRequestBodyBytes(value: number | undefined): number {
  const maxRequestBodyBytes = value ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 0) {
    throw new RangeError(
      "maxRequestBodyBytes must be a non-negative safe integer",
    );
  }

  return maxRequestBodyBytes;
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

class RequestBodyTooLargeError extends Error {
  constructor(maxRequestBodyBytes: number) {
    super(`Request body exceeds ${maxRequestBodyBytes} bytes`);
  }
}

function sanitizedRequestHost(req: IncomingMessage): string {
  const hostHeader = req.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;

  if (host === undefined) {
    return "localhost";
  }

  const normalized = host.trim();

  if (normalized.length === 0 || hasInvalidRequestHostCharacter(normalized)) {
    return "localhost";
  }

  try {
    const parsed = new URL(`http://${normalized}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return "localhost";
    }
  } catch {
    return "localhost";
  }

  return normalized;
}

function hasInvalidRequestHostCharacter(host: string): boolean {
  for (const char of host) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      char.trim() === "" ||
      char === "/" ||
      char === "?" ||
      char === "#" ||
      char === "@" ||
      char === "\\"
    ) {
      return true;
    }
  }

  return false;
}

function nodeRequestUrl(req: IncomingMessage): string {
  const host = sanitizedRequestHost(req);
  return `http://${host}${req.url ?? "/"}`;
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }

      continue;
    }

    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function writeNodeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;

  writeNodeHeaders(res, response.headers);

  res.flushHeaders();

  const responseBody = response.body;

  if (!responseBody) {
    res.end();
    return;
  }

  const reader = responseBody.getReader();
  let cancelReader: Promise<void> | undefined;

  const onClose = (): void => {
    cancelReader = reader
      .cancel(new NodeResponseClosedError())
      .catch(() => undefined);
  };

  res.once("close", onClose);

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        res.off("close", onClose);

        if (!isNodeResponseClosed(res)) {
          res.end();
        }

        return;
      }

      await writeChunk(res, result.value);
    }
  } catch (error) {
    if (error instanceof NodeResponseClosedError) {
      return;
    }

    throw error;
  } finally {
    res.off("close", onClose);
    await cancelReader;
    reader.releaseLock();
  }
}

function writeNodeHeaders(res: ServerResponse, headers: Headers): void {
  const setCookieHeaders = getSetCookieHeaders(headers);
  const fallbackSetCookieHeaders: string[] = [];

  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      if (!setCookieHeaders) {
        fallbackSetCookieHeaders.push(value);
      }

      return;
    }

    res.setHeader(name, value);
  });

  const cookieHeaders = setCookieHeaders ?? fallbackSetCookieHeaders;

  if (cookieHeaders.length > 0) {
    res.setHeader("Set-Cookie", cookieHeaders);
  }
}

function getSetCookieHeaders(headers: Headers): string[] | undefined {
  const getSetCookie = headers.getSetCookie;
  return typeof getSetCookie === "function"
    ? getSetCookie.call(headers)
    : undefined;
}

function writeChunk(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let isSettled = false;

    const settle = (callback: () => void): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      res.off("close", onClose);
      res.off("drain", onDrain);
      res.off("error", onError);
      callback();
    };

    const onError = (error: Error): void => {
      settle(() => {
        reject(error);
      });
    };

    const onDrain = (): void => {
      settle(resolve);
    };

    const onClose = (): void => {
      settle(() => {
        reject(new NodeResponseClosedError());
      });
    };

    if (isNodeResponseClosed(res)) {
      reject(new NodeResponseClosedError());
      return;
    }

    res.once("close", onClose);
    res.once("error", onError);

    if (res.write(chunk)) {
      settle(resolve);
      return;
    }

    res.once("drain", onDrain);
  });
}

function isNodeResponseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded;
}

class NodeResponseClosedError extends Error {
  constructor() {
    super("Node HTTP response closed");
  }
}
