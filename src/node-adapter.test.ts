import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { AcpServer } from "./server.js";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "./node-adapter.js";
import { createTestAgentApp } from "./test-support/test-agent.js";

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import type { NodeWebSocketUpgradeServer } from "./node-adapter.js";
import type { WebSocketServerSocket } from "./ws-server.js";

interface RunningServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface RawHttpResponse {
  readonly statusCode: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe("createNodeHttpHandler", () => {
  it("forwards method, URL, headers, and body to AcpServer.handleRequest", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const seenRequests: Request[] = [];
    const seenBodies: string[] = [];
    acpServer.handleRequest = async (req) => {
      seenRequests.push(req);
      seenBodies.push(await req.text());
      return new Response("created", {
        status: 201,
        headers: {
          "X-Adapter-Test": "ok",
        },
      });
    };

    const server = await startNodeServer(acpServer);

    try {
      const response = await fetch(`${server.url}/acp?hello=world`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Test": "forwarded",
        },
        body: JSON.stringify({ ok: true }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Adapter-Test")).toBe("ok");
      expect(await response.text()).toBe("created");
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.method).toBe("POST");
      expect(seenRequests[0]?.url).toBe(`${server.url}/acp?hello=world`);
      expect(seenRequests[0]?.headers.get("Content-Type")).toBe(
        "application/json",
      );
      expect(seenRequests[0]?.headers.get("X-Client-Test")).toBe("forwarded");
      expect(seenBodies).toEqual([JSON.stringify({ ok: true })]);
    } finally {
      await server.close();
    }
  });

  it("aborts forwarded requests when the Node response closes before finishing", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const seenRequest = createDeferred<Request>();
    const pendingResponse = createDeferred<Response>();
    const response = new CapturingServerResponse();

    acpServer.handleRequest = (req) => {
      seenRequest.resolve(req);
      return pendingResponse.promise;
    };

    createNodeHttpHandler(acpServer)(
      fakeRequest(),
      response as unknown as ServerResponse,
    );

    const request = await seenRequest.promise;

    expect(request.signal.aborted).toBe(false);
    response.emit("close");
    expect(request.signal.aborted).toBe(true);

    pendingResponse.resolve(new Response("closed", { status: 499 }));
    await response.finished;

    expect(response.statusCode).toBe(499);
  });

  it("streams response bodies to ServerResponse", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    acpServer.handleRequest = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode("data: one\n\n"));
              controller.enqueue(encoder.encode("data: two\n\n"));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          },
        ),
      );

    const server = await startNodeServer(acpServer);

    try {
      const response = await fetch(server.url, { method: "POST" });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "text/event-stream",
      );
      expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    } finally {
      await server.close();
    }
  });

  it("handles empty response bodies", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    acpServer.handleRequest = () =>
      Promise.resolve(
        new Response(null, {
          status: 202,
          headers: {
            "X-Empty-Body": "yes",
          },
        }),
      );

    const server = await startNodeServer(acpServer);

    try {
      const response = await fetch(server.url, { method: "POST" });

      expect(response.status).toBe(202);
      expect(response.headers.get("X-Empty-Body")).toBe("yes");
      expect(await response.text()).toBe("");
    } finally {
      await server.close();
    }
  });

  it("preserves multiple Set-Cookie response headers", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    acpServer.handleRequest = () => {
      const headers = new Headers({
        "X-Adapter-Test": "cookies",
      });
      headers.append("Set-Cookie", "transport=alpha; Path=/");
      headers.append("Set-Cookie", "route=bravo; Path=/");

      return Promise.resolve(
        new Response("cookies", {
          status: 200,
          headers,
        }),
      );
    };

    const server = await startNodeServer(acpServer);

    try {
      const response = await rawHttpRequest(server.url);

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-adapter-test"]).toBe("cookies");
      expect(response.headers["set-cookie"]).toEqual([
        "transport=alpha; Path=/",
        "route=bravo; Path=/",
      ]);
      expect(response.body).toBe("cookies");
    } finally {
      await server.close();
    }
  });

  it("decodes request bodies across split UTF-8 chunks", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const seenBodies: string[] = [];
    const response = new CapturingServerResponse();
    const body = JSON.stringify({ prompt: "split 🚀 path" });
    const bodyBytes = new TextEncoder().encode(body);
    const splitIndex = new TextEncoder().encode(
      body.slice(0, body.indexOf("🚀")),
    ).length;

    acpServer.handleRequest = async (req) => {
      seenBodies.push(await req.text());
      return new Response("ok");
    };

    createNodeHttpHandler(acpServer)(
      fakeRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        bodyChunks: [
          bodyBytes.slice(0, splitIndex + 1),
          bodyBytes.slice(splitIndex + 1),
        ],
      }),
      response as unknown as ServerResponse,
    );

    await response.finished;

    expect(response.statusCode).toBe(200);
    expect(seenBodies).toEqual([body]);
  });

  it("rejects request bodies when Content-Length exceeds the configured limit", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    let forwarded = false;
    const response = new CapturingServerResponse();

    acpServer.handleRequest = () => {
      forwarded = true;
      return Promise.resolve(new Response("unexpected"));
    };

    const request = fakeOpenRequest({
      method: "POST",
      headers: {
        "content-length": "5",
      },
    });

    createNodeHttpHandler(acpServer, { maxRequestBodyBytes: 4 })(
      request,
      response as unknown as ServerResponse,
    );

    await response.finished;

    expect(response.statusCode).toBe(413);
    expect(response.chunks.join("")).toBe("Request body exceeds 4 bytes");
    expect(forwarded).toBe(false);
    expect(() => {
      request.emit("error", new Error("client reset"));
    }).not.toThrow();
    expect(request.listenerCount("error")).toBe(0);
  });

  it("rejects chunked request bodies when they exceed the configured limit", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    let forwarded = false;
    const response = new CapturingServerResponse();

    acpServer.handleRequest = () => {
      forwarded = true;
      return Promise.resolve(new Response("unexpected"));
    };

    const request = fakeRequest({
      method: "POST",
      bodyChunks: [
        new TextEncoder().encode("123"),
        new TextEncoder().encode("45"),
      ],
    });
    let requestClosedBeforeResponse = false;
    request.once("close", () => {
      requestClosedBeforeResponse = !response.writableEnded;
    });

    createNodeHttpHandler(acpServer, { maxRequestBodyBytes: 4 })(
      request,
      response as unknown as ServerResponse,
    );

    await response.finished;

    expect(response.statusCode).toBe(413);
    expect(response.chunks.join("")).toBe("Request body exceeds 4 bytes");
    expect(forwarded).toBe(false);
    expect(requestClosedBeforeResponse).toBe(false);
  });

  it("cancels streaming response bodies when the Node response closes while backpressured", async () => {
    const acpServer = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const responseCancelled = createDeferred<void>();
    const response = new BackpressuredServerResponse();

    acpServer.handleRequest = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            },
            cancel() {
              responseCancelled.resolve();
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          },
        ),
      );

    createNodeHttpHandler(acpServer)(
      fakeRequest(),
      response as unknown as ServerResponse,
    );

    await response.wroteChunk;
    response.close();
    await responseCancelled.promise;
    await flushMicrotasks();

    expect(response.ended).toBe(false);
  });
});

describe("createNodeWebSocketUpgradeHandler", () => {
  it("destroys the upgrade socket when WebSocket preparation throws", async () => {
    const error = new Error("factory failed");
    const acpServer = new AcpServer({
      createAgent: () => {
        throw error;
      },
    });
    const webSocketServer = new FakeNodeWebSocketUpgradeServer();
    const socket = new FakeUpgradeSocket();
    const handler = createNodeWebSocketUpgradeHandler(
      acpServer,
      webSocketServer,
    );

    try {
      expect(() =>
        handler(fakeRequest(), socket as unknown as Duplex, Buffer.alloc(0)),
      ).not.toThrow();

      expect(webSocketServer.handleUpgradeCalls).toBe(0);
      expect(socket.destroyed).toBe(true);
      expect(socket.destroyError).toBe(error);
    } finally {
      await acpServer.close();
    }
  });
});

class FakeNodeWebSocketUpgradeServer implements NodeWebSocketUpgradeServer {
  handleUpgradeCalls = 0;

  on(
    _event: "headers",
    _listener: (headers: string[], request: IncomingMessage) => void,
  ): void {}

  off(
    _event: "headers",
    _listener: (headers: string[], request: IncomingMessage) => void,
  ): void {}

  handleUpgrade(
    _req: IncomingMessage,
    _socket: Duplex,
    _head: Buffer,
    _callback: (webSocket: WebSocketServerSocket) => void,
  ): void {
    this.handleUpgradeCalls += 1;
  }
}

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  destroyError: Error | undefined;

  destroy(error?: Error): this {
    this.destroyed = true;
    this.destroyError = error;
    this.emit("close");
    return this;
  }
}

class CapturingServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  readonly chunks: string[] = [];

  private readonly finishDeferred = createDeferred<void>();
  readonly finished = this.finishDeferred.promise;

  setHeader(): void {}

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: Uint8Array | string): boolean {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }

  end(chunk?: Uint8Array | string): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }

    this.writableEnded = true;
    this.finishDeferred.resolve();
  }
}

class BackpressuredServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  ended = false;

  private readonly writeDeferred = createDeferred<void>();
  readonly wroteChunk = this.writeDeferred.promise;

  setHeader(): void {}

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(): boolean {
    this.writeDeferred.resolve();
    return false;
  }

  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }

  close(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function fakeRequest(
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly bodyChunks?: readonly Uint8Array[];
  } = {},
): IncomingMessage {
  const request = Object.assign(Readable.from(options.bodyChunks ?? []), {
    method: options.method ?? "GET",
    url: "/acp",
    headers: {
      host: "127.0.0.1",
      ...options.headers,
    },
  });

  return request as unknown as IncomingMessage;
}

function fakeOpenRequest(
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
  } = {},
): IncomingMessage {
  const request = Object.assign(new PassThrough(), {
    method: options.method ?? "GET",
    url: "/acp",
    headers: {
      host: "127.0.0.1",
      ...options.headers,
    },
  });

  return request as unknown as IncomingMessage;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function startNodeServer(acpServer: AcpServer): Promise<RunningServer> {
  const server = http.createServer(createNodeHttpHandler(acpServer));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("Node test server did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function rawHttpRequest(url: string): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body,
        });
      });
    });

    req.on("error", reject);
  });
}
