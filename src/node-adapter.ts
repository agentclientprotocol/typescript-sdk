import { HEADER_CONNECTION_ID } from "./protocol.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AcpServer, PreparedWebSocketUpgrade } from "./server.js";
import type { WebSocketServerSocket } from "./ws-server.js";

type NodeWebSocketHeadersListener = (
  headers: string[],
  request: IncomingMessage,
) => void;

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
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleNodeRequest(server, req, res);
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
): Promise<void> {
  const requestAbort = nodeRequestAbortSignal(req, res);

  try {
    await writeNodeResponse(
      res,
      await server.handleRequest(await toWebRequest(req, requestAbort.signal)),
    );
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
    }

    res.end(error instanceof Error ? error.message : "Internal Server Error");
  } finally {
    requestAbort.cleanup();
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
): Promise<Request> {
  return new Request(nodeRequestUrl(req), {
    method: req.method ?? "GET",
    headers: nodeHeaders(req),
    body: hasRequestBody(req) ? await readRequestBody(req) : undefined,
    signal,
  });
}

function hasRequestBody(req: IncomingMessage): boolean {
  return req.method !== "GET" && req.method !== "HEAD";
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";

  for await (const chunk of req) {
    if (typeof chunk === "string") {
      body += decoder.decode();
      body += chunk;
      continue;
    }

    body += decoder.decode(chunk, { stream: true });
  }

  return body + decoder.decode();
}

function nodeRequestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
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
