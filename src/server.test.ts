import { describe, expect, it, vi } from "vitest";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  agent as createAgentApp,
  methods,
} from "./acp.js";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
} from "./protocol.js";
import { AcpServer } from "./server.js";
import { parseSseStream } from "./sse.js";
import { createTestAgentApp, TestAgent } from "./test-support/test-agent.js";
import { startTestServer } from "./test-support/test-http-server.js";
import { until } from "./test-support/until.js";

import type { ConnectionRegistry, ConnectionState } from "./connection.js";
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

  it("accepts an agent app for direct HTTP initialize requests", async () => {
    const appAgent = createAgentApp({ name: "http-app-agent" }).onRequest(
      methods.agent.initialize,
      (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: {
          loadSession: false,
        },
        authMethods: [],
      }),
    );
    const server = new AcpServer({ agent: appAgent });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get(HEADER_CONNECTION_ID)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
          },
          authMethods: [],
        },
      });
    } finally {
      await server.close();
    }
  });

  it("runs agent app connect hooks after direct HTTP initialize", async () => {
    const appAgent = createAgentApp({ name: "http-connect-hook-agent" })
      .onConnect((connection) =>
        connection.client.notify("vendor/connect-ready", { ready: true }),
      )
      .onRequest(methods.agent.initialize, (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: {
          loadSession: false,
        },
        authMethods: [],
      }));
    const server = new AcpServer({ agent: appAgent });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );
      const body = await response.json();
      const connectionId = response.headers.get(HEADER_CONNECTION_ID) ?? "";

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });

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
      await expect(readFirstSseMessage(sseResponse)).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "vendor/connect-ready",
        params: { ready: true },
      });
    } finally {
      await server.close();
    }
  });

  it("forwards deferred connect hooks through HTTP agent factories", async () => {
    let connectHookRuns = 0;
    const server = new AcpServer({
      createAgent: () =>
        createAgentApp({ name: "http-factory-connect-hook-agent" })
          .onConnect((connection) => {
            connectHookRuns += 1;
            return connection.client.notify("vendor/connect-ready", {
              source: "factory",
            });
          })
          .onRequest(methods.agent.initialize, (c) => ({
            protocolVersion: c.params.protocolVersion,
            agentCapabilities: {
              loadSession: false,
            },
            authMethods: [],
          })),
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );
      const body = await response.json();
      const connectionId = response.headers.get(HEADER_CONNECTION_ID) ?? "";

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(connectHookRuns).toBe(1);

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
      await expect(readFirstSseMessage(sseResponse)).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "vendor/connect-ready",
        params: { source: "factory" },
      });
    } finally {
      await server.close();
    }
  });

  it("removes HTTP connections when connect hooks close the handle", async () => {
    const server = new AcpServer({
      agent: createAgentApp({ name: "http-connect-hook-close-agent" })
        .onConnect((connection) => {
          connection.close(new Error("connect hook closed"));
        })
        .onRequest(methods.agent.initialize, (c) => ({
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: {
            loadSession: false,
          },
          authMethods: [],
        })),
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );
      const body = await response.json();
      const connectionId = response.headers.get(HEADER_CONNECTION_ID) ?? "";

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });

      await waitForConnectionNotFound(server, connectionId);
    } finally {
      await server.close();
    }
  });

  it("removes HTTP connections when async connect hooks reject", async () => {
    let connectHookRuns = 0;
    const server = new AcpServer({
      agent: createAgentApp({ name: "http-connect-hook-reject-agent" })
        .onConnect(() => {
          connectHookRuns += 1;
          return Promise.reject(new Error("connect hook rejected"));
        })
        .onRequest(methods.agent.initialize, (c) => ({
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: {
            loadSession: false,
          },
          authMethods: [],
        })),
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
      );
      const body = await response.json();
      const connectionId = response.headers.get(HEADER_CONNECTION_ID) ?? "";

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(connectHookRuns).toBe(1);

      await waitForConnectionNotFound(server, connectionId);
    } finally {
      await server.close();
    }
  });

  it("accepts a deprecated legacy agent factory for direct HTTP initialize requests", async () => {
    const connections: AgentSideConnection[] = [];
    const server = new AcpServer({
      createLegacyAgent: (conn) => {
        connections.push(conn);
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
      expect(connections).toHaveLength(1);
      expect(connections[0]).toBeInstanceOf(AgentSideConnection);
    } finally {
      await server.close();
    }
  });

  it("uses the default factory for direct HTTP initialize requests", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
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
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
      },
    });

    try {
      const response = await server.handleRequest(
        jsonRequest(initializeRequest),
        {
          createAgent: () => {
            createdBy.push("override");
            return createTestAgentApp();
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
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
      },
    });

    try {
      await server.handleRequest(jsonRequest(initializeRequest), {
        createAgent: () => {
          createdBy.push("override");
          return createTestAgentApp();
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
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
      },
    });

    try {
      const first = server.handleRequest(jsonRequest(initializeRequest), {
        createAgent: () => {
          createdBy.push("first");
          return createTestAgentApp();
        },
      });
      const second = server.handleRequest(
        jsonRequest({ ...initializeRequest, id: 2 }),
        {
          createAgent: () => {
            createdBy.push("second");
            return createTestAgentApp();
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
      createAgent: () => createTestAgentApp(),
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
    const abortController = new AbortController();
    const server = new AcpServer({
      createAgent: () => {
        agentCreated.resolve();
        return createTestAgentApp({
          initialize: () => {
            initializeStarted.resolve();
            return initializeResponse.promise;
          },
          newSession: () => ({ sessionId: "session-1" }),
        });
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
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
      },
    });

    try {
      const connectionId = await initializeDirect(server);
      const response = await server.handleRequest(
        jsonRequest(sessionNewRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
        }),
        {
          createAgent: () => {
            createdBy.push("override");
            return createTestAgentApp();
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
      createAgent: () => createTestAgentApp(),
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
      createAgent: () => {
        createdBy.push("default");
        return createTestAgentApp();
      },
    });

    try {
      const connectionId = await initializeDirect(server);
      const createAgent = () => {
        createdBy.push("override");
        return createTestAgentApp();
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

  it("allows one active receiver per route and preserves queued messages across handoff", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const open = (connectionId: string, sessionId?: string) =>
      server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: EVENT_STREAM_MIME_TYPE,
            [HEADER_CONNECTION_ID]: connectionId,
            ...(sessionId ? { [HEADER_SESSION_ID]: sessionId } : {}),
          },
        }),
      );
    const bodies: Array<ReadableStream<Uint8Array> | null> = [];

    try {
      const connectionId = await initializeDirect(server);
      const connectionStream = await open(connectionId);
      bodies.push(connectionStream.body);
      expect(connectionStream.status).toBe(200);
      expect((await open(connectionId)).status).toBe(409);

      const firstSession = await open(connectionId, "session-1");
      bodies.push(firstSession.body);
      expect(firstSession.status).toBe(200);
      expect((await open(connectionId, "session-1")).status).toBe(409);

      const secondSession = await open(connectionId, "session-2");
      bodies.push(secondSession.body);
      expect(secondSession.status).toBe(200);

      await connectionStream.body?.cancel();
      const accepted = await server.handleRequest(
        jsonRequest(sessionNewRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
        }),
      );
      expect(accepted.status).toBe(202);

      const resumed = await open(connectionId);
      bodies.push(resumed.body);
      expect(resumed.status).toBe(200);
      expect(await readFirstSseMessage(resumed)).toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
    } finally {
      await Promise.all(
        bodies.map((body) => body?.cancel().catch(() => undefined)),
      );
      await server.close();
    }
  });

  it("preserves an outbound burst for a slow SSE receiver", async () => {
    let resolvePromptDone: () => void = () => {};
    const promptDone = new Promise<void>((resolve) => {
      resolvePromptDone = resolve;
    });
    const server = new AcpServer({
      createAgent: () => createBackpressureAgent(resolvePromptDone),
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

      const chunkNumbers = [1];
      for (let index = 1; index < 1_100; index++) {
        const chunk = chunkText(await iterator.next());
        chunkNumbers.push(Number(chunk.slice("chunk-".length)));
      }

      expect(chunkNumbers).toEqual(
        Array.from({ length: 1_100 }, (_unused, index) => index + 1),
      );
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          jsonrpc: "2.0",
          id: promptRequest.id,
          result: { stopReason: "end_turn" },
        },
      });
    } finally {
      await iterator?.return?.();
      await body?.cancel().catch(() => undefined);
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
      createAgent: () => createTestAgentApp(),
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
    const server = await startTestServer(() =>
      createTestAgentApp({
        initialize: () => Promise.reject(new Error("initialize failed")),
      }),
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

describe("AcpServer connection limits", () => {
  it("does not keep session streams after their receivers leave", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });

    try {
      const connectionId = await initializeDirect(server);

      for (let index = 0; index < 100; index++) {
        const response = await server.handleRequest(
          sseRequest(connectionId, `unknown-session-${index}`),
        );
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }

      expect(connectionState(server, connectionId).sessionStreams.size).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("does not track routes for messages the agent never answers", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });

    try {
      const connectionId = await initializeDirect(server);
      const unanswered = [
        { id: "bare-id" },
        { jsonrpc: "2.0", id: "no-result" },
        {
          jsonrpc: "2.0",
          id: "result-and-error",
          result: {},
          error: { code: -32603, message: "Internal error" },
        },
        {
          id: "no-version",
          method: "session/cancel",
          params: { sessionId: "session-1" },
        },
      ];

      for (const message of unanswered) {
        const response = await server.handleRequest(
          jsonRequest(message, sessionHeaders(connectionId, "session-1")),
        );
        expect(response.status).toBe(202);
      }

      expect(connectionState(server, connectionId).pendingRoutes.size).toBe(0);
    } finally {
      error.mockRestore();
      await server.close();
    }
  });

  it("rejects session IDs and request IDs longer than maxIdLength", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxIdLength: 8,
    });

    try {
      const connectionId = await initializeDirect(server);
      const tooLong = "s".repeat(9);

      const stream = await server.handleRequest(
        sseRequest(connectionId, tooLong),
      );
      const prompt = await server.handleRequest(
        jsonRequest(
          promptRequestFor(4, tooLong),
          sessionHeaders(connectionId, tooLong),
        ),
      );
      const longRequestId = await server.handleRequest(
        jsonRequest(
          { ...sessionNewRequest, id: tooLong },
          { [HEADER_CONNECTION_ID]: connectionId },
        ),
      );
      expect(stream.status).toBe(400);
      expect(prompt.status).toBe(400);
      expect(longRequestId.status).toBe(400);
      expect(await longRequestId.text()).toBe(
        "Request ID exceeds maxIdLength (8)",
      );

      const allowed = await server.handleRequest(
        sseRequest(connectionId, "s".repeat(8)),
      );
      expect(allowed.status).toBe(200);
      await allowed.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("closes the connection when the agent issues an over-long session ID", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () =>
        createTestAgentApp({
          newSession: () => ({ sessionId: "s".repeat(9) }),
        }),
      maxIdLength: 8,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);
      const stream = await server.handleRequest(sseRequest(connectionId));
      if (!stream.body) {
        throw new Error("Expected SSE response body");
      }
      const reader = stream.body.getReader();

      await server.handleRequest(
        jsonRequest(sessionNewRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
        }),
      );

      await expect(withTimeout(reader.read())).rejects.toThrow(
        "Session ID exceeds maxIdLength (8)",
      );
      await withTimeout(connection.closed);
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connectionId}:`,
        "Session ID exceeds maxIdLength (8)",
      );
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("closes only the connection that buffers too many session streams", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxBufferedSessionStreams: 2,
    });

    try {
      const connectionId = await initializeDirect(server);
      const otherConnectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);

      // Nothing receives these sessions' streams, so their output buffers.
      for (const [index, sessionId] of ["a", "b", "c"].entries()) {
        await server.handleRequest(
          jsonRequest(
            promptRequestFor(10 + index, sessionId),
            sessionHeaders(connectionId, sessionId),
          ),
        );
      }

      await withTimeout(connection.closed);
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connectionId}:`,
        "Connection exceeds maxBufferedSessionStreams (2)",
      );

      const other = await server.handleRequest(sseRequest(otherConnectionId));
      expect(other.status).toBe(200);
      await other.body?.cancel();
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("closes a connection whose clients leave too many session streams with output queued", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxBufferedSessionStreams: 2,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);
      const sessionIds = ["a", "b", "c"];

      // Open streams are not limited, and these read none of their output.
      const streams: Response[] = [];
      for (const [index, sessionId] of sessionIds.entries()) {
        streams.push(
          await server.handleRequest(sseRequest(connectionId, sessionId)),
        );
        await server.handleRequest(
          jsonRequest(
            promptRequestFor(10 + index, sessionId),
            sessionHeaders(connectionId, sessionId),
          ),
        );
      }
      await until(() =>
        sessionIds.every(
          (sessionId) =>
            connection.sessionStreams.get(sessionId)?.hasQueuedMessages,
        ),
      );
      expect(streams.map((stream) => stream.status)).toEqual([200, 200, 200]);
      expect(connection.isClosed).toBe(false);

      // Leaving them buffers their output, one session too many.
      for (const stream of streams) {
        await stream.body?.cancel();
      }

      await withTimeout(connection.closed);
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connectionId}:`,
        "Connection exceeds maxBufferedSessionStreams (2)",
      );
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("closes a full connection whose output no client takes for maxOutputStallMs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxBufferedBytes: 1024,
      maxOutputStallMs: 50,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);

      // Nothing receives the connection stream, so its output never drains.
      for (let index = 0; index < 50 && !connection.isClosed; index++) {
        await server.handleRequest(
          jsonRequest(
            { ...sessionNewRequest, id: 100 + index },
            { [HEADER_CONNECTION_ID]: connectionId },
          ),
        );
      }

      await withTimeout(connection.closed);
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connectionId}:`,
        "Connection output stalled for maxOutputStallMs (50)",
      );
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("delivers a burst queued before the client opens its session stream", async () => {
    const server = new AcpServer({
      createAgent: () => createBurstAgent(50, 1000),
      maxBufferedBytes: 4096,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);
      await server.handleRequest(
        jsonRequest(
          promptRequestFor(10, "session-1"),
          sessionHeaders(connectionId, "session-1"),
        ),
      );
      await until(() => connection.hasOutboundBacklog);

      const stream = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      expect(await readSseMessages(stream, 51)).toHaveLength(51);
      expect(connection.isClosed).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("keeps a full connection open while its receiver reconnects", async () => {
    const server = new AcpServer({
      createAgent: () => createBurstAgent(50, 1000),
      maxBufferedBytes: 4096,
    });

    try {
      const connectionId = await initializeDirect(server);
      const first = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      await server.handleRequest(
        jsonRequest(
          promptRequestFor(10, "session-1"),
          sessionHeaders(connectionId, "session-1"),
        ),
      );
      await until(
        () => connectionState(server, connectionId).hasOutboundBacklog,
      );
      await first.body?.cancel();

      const second = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      if (!second.body) {
        throw new Error("Expected SSE response body");
      }
      const messages = parseSseStream(second.body)[Symbol.asyncIterator]();
      for (;;) {
        const next = await withTimeout(messages.next());
        if (next.done) {
          throw new Error("Expected the prompt response");
        }
        if ((next.value as { id?: unknown }).id === 10) {
          break;
        }
      }
      await messages.return?.();
      expect(connectionState(server, connectionId).isClosed).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("leaves nothing waiting for requests aborted while held back", async () => {
    const server = new AcpServer({
      createAgent: () => createBurstAgent(50, 1000),
      maxBufferedBytes: 4096,
    });

    try {
      const connectionId = await initializeDirect(server);
      const stream = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      await server.handleRequest(
        jsonRequest(
          promptRequestFor(10, "session-1"),
          sessionHeaders(connectionId, "session-1"),
        ),
      );
      const connection = connectionState(server, connectionId);
      await until(() => connection.hasOutboundBacklog);

      // Held-back requests wait alongside the router, which is paused.
      const waiters = (): number =>
        (connection as unknown as { progressWaiters: Set<unknown> })
          .progressWaiters.size;
      const waitersBefore = waiters();
      for (let index = 0; index < 20; index++) {
        const abort = new AbortController();
        const response = server.handleRequest(
          jsonRequest(
            promptRequestFor(100 + index, "session-1"),
            sessionHeaders(connectionId, "session-1"),
            abort.signal,
          ),
        );
        await delay(1);
        abort.abort();
        expect((await withTimeout(response)).status).toBe(499);
      }

      expect(waiters()).toBe(waitersBefore);
      await stream.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("delivers an agent burst larger than maxBufferedBytes to a client that reads it", async () => {
    const server = new AcpServer({
      createAgent: () => createBurstAgent(50, 1000),
      maxBufferedBytes: 4096,
    });

    try {
      const connectionId = await initializeDirect(server);
      const stream = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      if (!stream.body) {
        throw new Error("Expected SSE response body");
      }
      const messages = parseSseStream(stream.body)[Symbol.asyncIterator]();

      await server.handleRequest(
        jsonRequest(
          promptRequestFor(10, "session-1"),
          sessionHeaders(connectionId, "session-1"),
        ),
      );

      for (let index = 0; index < 50; index++) {
        const next = await withTimeout(messages.next());
        expect(next.value).toMatchObject({ method: "session/update" });
      }
      expect((await withTimeout(messages.next())).value).toMatchObject({
        id: 10,
        result: { stopReason: "end_turn" },
      });

      await messages.return?.();
      expect(connectionState(server, connectionId).isClosed).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("holds back agent output and client requests while a receiver is behind", async () => {
    const sent: number[] = [];
    const server = new AcpServer({
      createAgent: () =>
        createBurstAgent(50, 1000, (index) => {
          sent.push(index);
        }),
      maxBufferedBytes: 4096,
    });

    try {
      const connectionId = await initializeDirect(server);
      const stream = await server.handleRequest(
        sseRequest(connectionId, "session-1"),
      );
      if (!stream.body) {
        throw new Error("Expected SSE response body");
      }

      await server.handleRequest(
        jsonRequest(
          promptRequestFor(10, "session-1"),
          sessionHeaders(connectionId, "session-1"),
        ),
      );
      await until(
        () => connectionState(server, connectionId).hasOutboundBacklog,
      );
      await delay(20);

      // Nothing has read the stream, so the agent is waiting on its sends
      // and another request waits too.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.length).toBeLessThan(10);
      let isNextPromptAccepted = false;
      const nextPrompt = server
        .handleRequest(
          jsonRequest(
            promptRequestFor(11, "session-1"),
            sessionHeaders(connectionId, "session-1"),
          ),
        )
        .then((response) => {
          isNextPromptAccepted = true;
          return response;
        });
      await delay(50);
      expect(isNextPromptAccepted).toBe(false);

      // Reading lets both carry on.
      const messages = parseSseStream(stream.body)[Symbol.asyncIterator]();
      for (;;) {
        const next = await withTimeout(messages.next());
        if (next.done) {
          throw new Error("Expected the prompt response");
        }
        if ((next.value as { id?: unknown }).id === 10) {
          break;
        }
      }
      expect(sent.length).toBeGreaterThanOrEqual(50);
      expect((await withTimeout(nextPrompt)).status).toBe(202);

      await messages.return?.();
    } finally {
      await server.close();
    }
  });

  it("answers a held-back request with 404 once its agent exits", async () => {
    const agentClosed = createDeferred<void>();
    let agentWriter: WritableStreamDefaultWriter<AnyMessage> | undefined;
    const server = new AcpServer({
      agent: {
        connect(stream) {
          void (async () => {
            const reader = stream.readable.getReader();
            const { value } = await reader.read();
            agentWriter = stream.writable.getWriter();
            await agentWriter.write({
              jsonrpc: "2.0",
              id: (value as { id: number }).id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            });
          })();
          return { closed: agentClosed.promise };
        },
      },
      maxBufferedBytes: 64,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);
      const stream = await server.handleRequest(sseRequest(connectionId));
      if (!agentWriter) {
        throw new Error("Expected the agent to have answered initialize");
      }

      // The connection stream is open but unread, so this fills the limit.
      void agentWriter.write({
        jsonrpc: "2.0",
        method: "_vendor/acme/notification",
        params: { padding: "p".repeat(100) },
      });
      await until(() => connection.hasOutboundBacklog);
      const request = server.handleRequest(
        jsonRequest(
          { ...sessionNewRequest, id: 20 },
          { [HEADER_CONNECTION_ID]: connectionId },
        ),
      );
      await delay(20);

      agentClosed.resolve();
      expect((await withTimeout(request)).status).toBe(404);
      await stream.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("closes a connection whose invented session stalls its output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxBufferedBytes: 1024,
      maxOutputStallMs: 50,
    });

    try {
      const connectionId = await initializeDirect(server);
      const connection = connectionState(server, connectionId);

      // One session, never received, so its output fills the limit and stays.
      for (let index = 0; index < 50 && !connection.isClosed; index++) {
        await server.handleRequest(
          jsonRequest(
            promptRequestFor(100 + index, "unknown-session"),
            sessionHeaders(connectionId, "unknown-session"),
          ),
        );
      }

      await withTimeout(connection.closed);
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connectionId}:`,
        "Connection output stalled for maxOutputStallMs (50)",
      );
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("ends the stream of a client that stopped reading when its connection closes", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });

    try {
      const connectionId = await initializeDirect(server);
      const stream = await server.handleRequest(sseRequest(connectionId));
      if (!stream.body) {
        throw new Error("Expected SSE response body");
      }

      await server.handleRequest(
        jsonRequest(sessionNewRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
        }),
      );
      const deleted = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "DELETE",
          headers: { [HEADER_CONNECTION_ID]: connectionId },
        }),
      );
      expect(deleted.status).toBe(202);

      // A body left waiting for its reader would keep the response open.
      await expect(withTimeout(stream.body.getReader().read())).rejects.toThrow(
        "ACP connection is closed",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects connection limits that are not positive safe integers", () => {
    const createAgent = () => createTestAgentApp();

    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new AcpServer({ createAgent, maxBufferedBytes: value }),
      ).toThrow(RangeError);
      expect(
        () => new AcpServer({ createAgent, maxOutputStallMs: value }),
      ).toThrow(RangeError);
      expect(
        () => new AcpServer({ createAgent, maxBufferedSessionStreams: value }),
      ).toThrow(RangeError);
      expect(() => new AcpServer({ createAgent, maxIdLength: value })).toThrow(
        RangeError,
      );
    }

    // Timers cannot wait longer than this.
    expect(
      () => new AcpServer({ createAgent, maxOutputStallMs: 2 ** 31 }),
    ).toThrow("maxOutputStallMs must be at most 2147483647");
  });

  it("does not count delivered output against maxBufferedBytes", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
      maxBufferedBytes: 1024,
    });

    try {
      const connectionId = await initializeDirect(server);
      const stream = await server.handleRequest(sseRequest(connectionId));
      if (!stream.body) {
        throw new Error("Expected SSE response body");
      }
      const messages = parseSseStream(stream.body)[Symbol.asyncIterator]();

      // Together these responses exceed the limit, but each is delivered first.
      for (let index = 0; index < 50; index++) {
        await server.handleRequest(
          jsonRequest(
            { ...sessionNewRequest, id: 100 + index },
            { [HEADER_CONNECTION_ID]: connectionId },
          ),
        );
        const next = await withTimeout(messages.next());
        expect(next.value).toMatchObject({ id: 100 + index });
      }

      await messages.return?.();
      expect(connectionState(server, connectionId).isClosed).toBe(false);
    } finally {
      await server.close();
    }
  });
});

function connectionState(
  server: AcpServer,
  connectionId: string,
): ConnectionState {
  const connection = (
    server as unknown as { registry: ConnectionRegistry }
  ).registry.get(connectionId);
  if (!connection) {
    throw new Error("Expected an open connection");
  }

  return connection;
}

function sseRequest(connectionId: string, sessionId?: string): Request {
  return new Request("http://127.0.0.1/acp", {
    method: "GET",
    headers: {
      Accept: EVENT_STREAM_MIME_TYPE,
      [HEADER_CONNECTION_ID]: connectionId,
      ...(sessionId === undefined ? {} : { [HEADER_SESSION_ID]: sessionId }),
    },
  });
}

function sessionHeaders(
  connectionId: string,
  sessionId: string,
): Record<string, string> {
  return {
    [HEADER_CONNECTION_ID]: connectionId,
    [HEADER_SESSION_ID]: sessionId,
  };
}

function promptRequestFor(id: number, sessionId: string) {
  return {
    ...promptRequest,
    id,
    params: { ...promptRequest.params, sessionId },
  };
}

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

function createBackpressureAgent(onPromptDone: () => void) {
  return createAgentApp({ name: "backpressure-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
      },
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.prompt, async (c) => {
      for (let index = 0; index < 1_100; index++) {
        await c.client.notify(methods.client.session.update, {
          sessionId: c.params.sessionId,
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
    })
    .onNotification(methods.agent.session.cancel, () => {});
}

/**
 * An agent that answers each prompt with `count` updates of about `size`
 * characters, calling `onSent` as each send resolves.
 */
function createBurstAgent(
  count: number,
  size: number,
  onSent: (index: number) => void = () => {},
) {
  return createAgentApp({ name: "burst-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
      },
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.prompt, async (c) => {
      for (let index = 0; index < count; index++) {
        await c.client.notify(methods.client.session.update, {
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(size) },
          },
        });
        onSent(index);
      }

      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConnectionNotFound(
  server: AcpServer,
  connectionId: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;

  for (;;) {
    const response = await server.handleRequest(
      new Request("http://127.0.0.1/acp", {
        method: "GET",
        headers: {
          Accept: EVENT_STREAM_MIME_TYPE,
          [HEADER_CONNECTION_ID]: connectionId,
        },
      }),
    );

    if (response.status === 404) {
      return;
    }

    await response.body?.cancel();
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for connection to be removed");
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
