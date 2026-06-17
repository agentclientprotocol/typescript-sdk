import { describe, expect, it, vi } from "vitest";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
} from "./protocol.js";
import { AcpServer } from "./server.js";
import { parseSseStream } from "./sse.js";
import { TestAgent } from "./test-support/test-agent.js";
import { startTestServer } from "./test-support/test-http-server.js";

import type { Agent, AgentSideConnection } from "./acp.js";
import type { AnyMessage } from "./jsonrpc.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {},
  },
};

const sessionNewRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: {
    cwd: "/tmp",
    mcpServers: [],
  },
};

const promptRequest = {
  jsonrpc: "2.0",
  id: 3,
  method: "session/prompt",
  params: {
    sessionId: "session-1",
    prompt: [{ type: "text", text: "Hello" }],
  },
};

describe("AcpServer", () => {
  it("handles initialize over HTTP and returns a connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await postJson(server.url, initializeRequest);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("uses the default factory for direct HTTP initialize requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(createdBy).toEqual(["default"]);
    } finally {
      await server.close();
    }
  });

  it("uses per-request factory overrides for direct HTTP initialize requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
        {
          createAgent: (conn) => {
            createdBy.push("override");
            return new TestAgent(conn);
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(createdBy).toEqual(["override"]);
    } finally {
      await server.close();
    }
  });

  it("does not leak HTTP factory overrides to later initialize requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      await server.handleRequest(jsonRequest(initializeRequest), {
        createAgent: (conn) => {
          createdBy.push("override");
          return new TestAgent(conn);
        },
      });
      await server.handleRequest(jsonRequest({ ...initializeRequest, id: 2 }));

      expect(createdBy).toEqual(["override", "default"]);
    } finally {
      await server.close();
    }
  });

  it("keeps concurrent HTTP initialize factory overrides isolated", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      const first = server.handleRequest(jsonRequest(initializeRequest), {
        createAgent: (conn) => {
          createdBy.push("first");
          return new TestAgent(conn);
        },
      });
      const second = server.handleRequest(
        jsonRequest({ ...initializeRequest, id: 2 }),
        {
          createAgent: (conn) => {
            createdBy.push("second");
            return new TestAgent(conn);
          },
        },
      );

      await Promise.all([first, second]);

      expect(createdBy).toEqual(expect.arrayContaining(["first", "second"]));
      expect(createdBy).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("waits for registry shutdowns before close resolves", async () => {
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => new TestAgent(conn),
    });
    const registry = (
      server as unknown as {
        registry: {
          closeAll(): Promise<void>;
        };
      }
    ).registry;
    const shutdownStarted = createDeferred<void>();
    const allowShutdown = createDeferred<void>();
    vi.spyOn(registry, "closeAll").mockImplementation(async () => {
      shutdownStarted.resolve();
      await allowShutdown.promise;
    });
    let closeResolved = false;

    const close = server.close().then(() => {
      closeResolved = true;
    });

    await shutdownStarted.promise;
    await flushMicrotasks();
    expect(closeResolved).toBe(false);

    allowShutdown.resolve();
    await close;
    expect(closeResolved).toBe(true);
  });

  it("discards HTTP initialize connections when the request aborts", async () => {
    const agentCreated = createDeferred<void>();
    const initializeStarted = createDeferred<void>();
    const initializeResponse = createDeferred<{
      protocolVersion: 1;
      agentCapabilities: { loadSession: false };
    }>();
    const connectionClosed = createDeferred<void>();
    const abortController = new AbortController();
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection): Agent => {
        queueMicrotask(() => {
          if (conn.signal.aborted) {
            connectionClosed.resolve();
            return;
          }

          conn.signal.addEventListener(
            "abort",
            () => {
              connectionClosed.resolve();
            },
            { once: true },
          );
        });
        agentCreated.resolve();

        return {
          initialize: () => {
            initializeStarted.resolve();
            return initializeResponse.promise;
          },
          newSession: () => Promise.resolve({ sessionId: "session-1" }),
          authenticate: () => Promise.resolve(),
          cancel: () => Promise.resolve(),
          prompt: () => Promise.resolve({ stopReason: "end_turn" }),
        };
      },
    });

    try {
      const responsePromise = server.handleRequest(
        jsonRequest(initializeRequest, {}, abortController.signal),
      );

      await agentCreated.promise;
      await withTimeout(initializeStarted.promise);
      abortController.abort();

      const response = await withTimeout(responsePromise);

      expect(response.status).toBe(499);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toBeNull();
      await withTimeout(connectionClosed.promise);

      initializeResponse.resolve({
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
      });
      await flushMicrotasks();
    } finally {
      await server.close();
    }
  });

  it("ignores HTTP factory overrides for existing-connection POST requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      const connectionId = await initializeDirect(server);
      const response = await server.handleRequest(
        jsonRequest(sessionNewRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
        }),
        {
          createAgent: (conn) => {
            createdBy.push("override");
            return new TestAgent(conn);
          },
        },
      );

      expect(response.status).toBe(202);
      expect(createdBy).toEqual(["default"]);
    } finally {
      await server.close();
    }
  });

  it("serializes concurrent POST writes for the same connection", async () => {
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => new TestAgent(conn),
    });

    try {
      const connectionId = await initializeDirect(server);
      const headers = { [HEADER_CONNECTION_ID]: connectionId };
      const first = server.handleRequest(
        jsonRequest(sessionNewRequest, headers),
      );
      const second = server.handleRequest(
        jsonRequest({ ...sessionNewRequest, id: 3 }, headers),
      );

      const responses = await Promise.all([first, second]);

      expect(responses.map((response) => response.status)).toEqual([202, 202]);

      const sseResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: EVENT_STREAM_MIME_TYPE,
            [HEADER_CONNECTION_ID]: connectionId,
          },
        }),
      );

      expect(sseResponse.status).toBe(200);
      const messages = await readSseMessages(sseResponse, 2);
      expect(
        messages.map((message) => ("id" in message ? message.id : undefined)),
      ).toEqual([2, 3]);
    } finally {
      await server.close();
    }
  });

  it("ignores HTTP factory overrides for GET and DELETE requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => {
        createdBy.push("default");
        return new TestAgent(conn);
      },
    });

    try {
      const connectionId = await initializeDirect(server);
      const createAgent = (conn: AgentSideConnection): TestAgent => {
        createdBy.push("override");
        return new TestAgent(conn);
      };
      const getResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: EVENT_STREAM_MIME_TYPE,
            [HEADER_CONNECTION_ID]: connectionId,
          },
        }),
        { createAgent },
      );

      expect(getResponse.status).toBe(200);
      await getResponse.body?.cancel();

      const deleteResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "DELETE",
          headers: { [HEADER_CONNECTION_ID]: connectionId },
        }),
        { createAgent },
      );

      expect(deleteResponse.status).toBe(202);
      expect(createdBy).toEqual(["default"]);
    } finally {
      await server.close();
    }
  });

  it("streams session/new responses over the connection SSE stream", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sseResponse = await openConnectionSse(server.url, connectionId);

      expect(sseResponse.status).toBe(200);
      expect(sseResponse.headers.get("Content-Type")).toContain(
        EVENT_STREAM_MIME_TYPE,
      );

      const accepted = await postJson(server.url, sessionNewRequest, {
        [HEADER_CONNECTION_ID]: connectionId,
      });

      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe("");
      expect(await readFirstSseMessage(sseResponse)).toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
    } finally {
      await server.close();
    }
  });

  it("replays buffered connection messages when SSE attaches after POST", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const accepted = await postJson(server.url, sessionNewRequest, {
        [HEADER_CONNECTION_ID]: connectionId,
      });

      expect(accepted.status).toBe(202);

      const sseResponse = await openConnectionSse(server.url, connectionId);

      expect(await readFirstSseMessage(sseResponse)).toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
    } finally {
      await server.close();
    }
  });

  it("does not drain outbound subscriptions faster than SSE body demand", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolvePromptDone: () => void = () => {};
    const promptDone = new Promise<void>((resolve) => {
      resolvePromptDone = resolve;
    });
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) =>
        createBackpressureAgent(conn, resolvePromptDone),
    });
    let iterator: AsyncIterator<AnyMessage> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;

    try {
      const connectionId = await initializeDirect(server);
      const sseResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: EVENT_STREAM_MIME_TYPE,
            [HEADER_CONNECTION_ID]: connectionId,
            [HEADER_SESSION_ID]: "session-1",
          },
        }),
      );
      body = sseResponse.body;

      expect(sseResponse.status).toBe(200);
      expect(body).toBeDefined();

      iterator = parseSseStream(body!)[Symbol.asyncIterator]();
      const firstMessage = iterator.next();

      const accepted = await server.handleRequest(
        jsonRequest(promptRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: "session-1",
        }),
      );

      expect(accepted.status).toBe(202);
      expect(chunkText(await firstMessage)).toBe("chunk-1");
      await promptDone;
      await waitFor(() => warnSpy.mock.calls.length > 0);

      const chunkNumbers = [1];
      for (let index = 0; index < 128; index++) {
        const chunk = chunkText(await iterator.next());
        chunkNumbers.push(Number(chunk.slice("chunk-".length)));
      }

      expect(hasGap(chunkNumbers)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "ACP outbound subscriber lagged; dropping oldest message",
      );
    } finally {
      await iterator?.return?.();
      await body?.cancel().catch(() => undefined);
      warnSpy.mockRestore();
      await server.close();
    }
  });

  it.each(["PUT", "PATCH"])("rejects %s requests", async (method) => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, { method });

      expect(response.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("rejects GET without Accept: text/event-stream", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "GET",
        headers: {
          [HEADER_CONNECTION_ID]: globalThis.crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(406);
    } finally {
      await server.close();
    }
  });

  it("rejects GET without a connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "GET",
        headers: {
          Accept: EVENT_STREAM_MIME_TYPE,
        },
      });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects GET with an unknown connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await openConnectionSse(
        server.url,
        globalThis.crypto.randomUUID(),
      );

      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("opens session-scoped GETs before session/load creates session state", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const response = await openSessionSse(
        server.url,
        connectionId,
        globalThis.crypto.randomUUID(),
      );

      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("returns 426 for WebSocket upgrade GETs", async () => {
    const server = new AcpServer({
      createAgent: (conn: AgentSideConnection) => new TestAgent(conn),
    });

    try {
      const response = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: EVENT_STREAM_MIME_TYPE,
            Upgrade: "websocket",
          },
        }),
      );

      expect(response.status).toBe(426);
    } finally {
      await server.close();
    }
  });

  it("deletes connections and closes SSE streams", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sseResponse = await openConnectionSse(server.url, connectionId);
      const reader = sseResponse.body?.getReader();

      expect(reader).toBeDefined();

      const deleted = await fetch(server.url, {
        method: "DELETE",
        headers: {
          [HEADER_CONNECTION_ID]: connectionId,
        },
      });

      expect(deleted.status).toBe(202);
      expect(await reader?.read()).toEqual({ done: true, value: undefined });
      reader?.releaseLock();

      const postAfterDelete = await postJson(server.url, sessionNewRequest, {
        [HEADER_CONNECTION_ID]: connectionId,
      });

      expect(postAfterDelete.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("rejects DELETE without a connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, { method: "DELETE" });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects DELETE with an unknown connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "DELETE",
        headers: {
          [HEADER_CONNECTION_ID]: globalThis.crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("accepts POST with application/json Content-Type parameters", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(initializeRequest),
      });

      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects POST without Content-Type", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, { method: "POST" });

      expect(response.status).toBe(415);
    } finally {
      await server.close();
    }
  });

  it.each([
    "text/plain",
    "application/jsonfoobar",
    "application/json-patch+json",
  ])("rejects POST with %s Content-Type", async (contentType) => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: JSON.stringify(initializeRequest),
      });

      expect(response.status).toBe(415);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid JSON", async () => {
    const server = await startTestServer();

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "Content-Type": JSON_MIME_TYPE,
        },
        body: "{ nope",
      });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects JSON-RPC batches", async () => {
    const server = await startTestServer();

    try {
      const response = await postJson(server.url, [initializeRequest]);

      expect(response.status).toBe(501);
    } finally {
      await server.close();
    }
  });

  it.each([
    null,
    "initialize",
    1,
    {},
    { jsonrpc: "1.0", method: "initialize" },
  ])("rejects invalid JSON-RPC messages", async (body) => {
    const server = await startTestServer();

    try {
      const response = await postJson(server.url, body);

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects non-initialize requests without a connection ID", async () => {
    const server = await startTestServer();

    try {
      const response = await postJson(server.url, sessionNewRequest);

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects initialize requests on existing connections", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const response = await postJson(server.url, initializeRequest, {
        [HEADER_CONNECTION_ID]: connectionId,
      });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects unknown connection IDs", async () => {
    const server = await startTestServer();

    try {
      const response = await postJson(server.url, sessionNewRequest, {
        [HEADER_CONNECTION_ID]: globalThis.crypto.randomUUID(),
      });

      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns an error response when agent creation fails", async () => {
    const server = await startTestServer(() => {
      throw new Error("agent factory failed");
    });

    try {
      const response = await postJson(server.url, initializeRequest);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toBeNull();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "Initialize failed",
          data: "agent factory failed",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns JSON-RPC initialize errors as the initialize response", async () => {
    class FailingInitializeAgent extends TestAgent {
      initialize() {
        return Promise.reject(new Error("initialize failed"));
      }
    }

    const server = await startTestServer(
      (conn: AgentSideConnection) => new FailingInitializeAgent(conn),
    );

    try {
      const response = await postJson(server.url, initializeRequest);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "Internal error",
        },
      });
    } finally {
      await server.close();
    }
  });
});

async function initializeDirect(server: AcpServer): Promise<string> {
  const response = await server.handleRequest(jsonRequest(initializeRequest));
  const connectionId = response.headers.get(HEADER_CONNECTION_ID);

  expect(response.status).toBe(200);
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

  return connectionId ?? "";
}

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request("http://127.0.0.1/acp", {
    method: "POST",
    headers: {
      "Content-Type": JSON_MIME_TYPE,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function initialize(url: string): Promise<string> {
  const response = await postJson(url, initializeRequest);
  const connectionId = response.headers.get(HEADER_CONNECTION_ID);

  expect(response.status).toBe(200);
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

  return connectionId ?? "";
}

function openConnectionSse(
  url: string,
  connectionId: string,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Accept: EVENT_STREAM_MIME_TYPE,
      [HEADER_CONNECTION_ID]: connectionId,
    },
  });
}

function openSessionSse(
  url: string,
  connectionId: string,
  sessionId: string,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Accept: EVENT_STREAM_MIME_TYPE,
      [HEADER_CONNECTION_ID]: connectionId,
      [HEADER_SESSION_ID]: sessionId,
    },
  });
}

async function readFirstSseMessage(response: Response): Promise<AnyMessage> {
  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  const iterator = parseSseStream(response.body)[Symbol.asyncIterator]();
  const result = await iterator.next();
  await iterator.return?.();
  await response.body.cancel();

  if (result.done) {
    throw new Error("Expected SSE message");
  }

  return result.value;
}

async function readSseMessages(
  response: Response,
  count: number,
): Promise<AnyMessage[]> {
  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  const iterator = parseSseStream(response.body)[Symbol.asyncIterator]();

  try {
    const messages: AnyMessage[] = [];

    for (const __unused of Array.from({ length: count })) {
      void __unused;
      const result = await iterator.next();

      if (result.done) {
        throw new Error("Expected SSE message");
      }

      messages.push(result.value);
    }

    return messages;
  } finally {
    await iterator.return?.();
    await response.body.cancel();
  }
}

function chunkText(result: IteratorResult<AnyMessage>): string {
  if (result.done) {
    throw new Error("Expected SSE message");
  }

  const text = (
    result.value as {
      params?: { update?: { content?: { text?: unknown } } };
    }
  ).params?.update?.content?.text;

  if (typeof text !== "string") {
    throw new Error("Expected session update chunk text");
  }

  return text;
}

function hasGap(values: readonly number[]): boolean {
  return values.some((value, index) => {
    if (index === 0) {
      return false;
    }

    return value !== values[index - 1] + 1;
  });
}

function createBackpressureAgent(
  connection: AgentSideConnection,
  onPromptDone: () => void,
): Agent {
  return {
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      }),
    newSession: () => Promise.resolve({ sessionId: "session-1" }),
    authenticate: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    prompt: async (params) => {
      for (let index = 0; index < 1_100; index++) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `chunk-${index + 1}`,
            },
          },
        });
      }

      onPromptDone();
      return { stopReason: "end_turn" };
    },
  };
}

async function waitFor(callback: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!callback()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for promise"));
        }, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": JSON_MIME_TYPE,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
