import { describe, expect, it, vi } from "vitest";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  agent as createAgentApp,
  methods,
} from "./acp.js";
import { ConnectionRegistry } from "./connection.js";
import {
  Connection as JsonRpcConnection,
  batchNotification,
  batchRequest,
} from "./jsonrpc.js";
import { HEADER_CONNECTION_ID, JSON_MIME_TYPE } from "./protocol.js";
import { AcpServer } from "./server.js";
import { createTestAgentApp, TestAgent } from "./test-support/test-agent.js";
import { until } from "./test-support/until.js";
import { handleWebSocketConnection } from "./ws-server.js";

import type { InitializeResponse } from "./acp.js";
import type { AgentConnector, ResponseRoute } from "./connection.js";
import type { AnyMessage, AnyWireMessage } from "./jsonrpc.js";
import type { WebSocketServerSocket } from "./ws-server.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  },
} satisfies AnyMessage;

const sessionNewRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "session/new",
  params: {
    cwd: "/tmp",
    mcpServers: [],
  },
} satisfies AnyMessage;

const v2InitializeRequest = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: 2,
    info: { name: "test-client", version: "1.0.0" },
  },
} satisfies AnyMessage;

function createProtocolAgent(
  protocolVersion: number,
  onRequest?: (method: string) => void,
): AgentConnector {
  return {
    connect(stream) {
      return new JsonRpcConnection(
        async (method) => {
          onRequest?.(method);

          if (method === "initialize") {
            return {
              protocolVersion,
              info: { name: "test-agent", version: "1.0.0" },
            };
          }

          if (method === "session/new") {
            return { sessionId: globalThis.crypto.randomUUID() };
          }

          return {};
        },
        async () => {},
        stream,
      );
    },
  };
}

describe("AcpServer prepared WebSocket upgrades", () => {
  it("returns JSON-RPC errors for malformed frames and remains usable", async () => {
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(1);
    const socket = new FakeServerSocket();

    try {
      handleWebSocketConnection(socket, { registry, agent });

      socket.receive("not json");
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700 },
      });

      socket.receive("42");
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600 },
      });
      expect(socket.closeCount).toBe(0);

      socket.receive(JSON.stringify(initializeRequest));
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: { protocolVersion: 1 },
      });

      socket.receive("{ malformed");
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700 },
      });

      socket.receive(JSON.stringify(sessionNewRequest));
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
      expect(socket.closeCount).toBe(0);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("uses the default factory when no per-upgrade override is provided", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: recordingFactory(createdBy, "default"),
    });
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(createdBy).toEqual(["default"]);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("sends initialize before agent app connect hook messages", async () => {
    const server = new AcpServer({
      agent: createAgentApp({ name: "ws-connect-hook-agent" })
        .onConnect((connection) =>
          connection.client.notify("vendor/connect-ready", { ready: true }),
        )
        .onRequest(methods.agent.initialize, (c) => ({
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: {
            loadSession: false,
          },
          authMethods: [],
        })),
    });
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "vendor/connect-ready",
        params: { ready: true },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("forwards deferred connect hooks through WebSocket agent factories", async () => {
    let connectHookRuns = 0;
    const server = new AcpServer({
      createAgent: () =>
        createAgentApp({ name: "ws-factory-connect-hook-agent" })
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
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(connectHookRuns).toBe(1);
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "vendor/connect-ready",
        params: { source: "factory" },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("accepts a deprecated legacy agent factory for prepared WebSocket upgrades", async () => {
    const connections: AgentSideConnection[] = [];
    const server = new AcpServer({
      createLegacyAgent: (conn) => {
        connections.push(conn);
        return new TestAgent(conn);
      },
    });
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(connections).toHaveLength(1);
      expect(connections[0]).toBeInstanceOf(AgentSideConnection);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("uses a per-upgrade factory override for that WebSocket connection", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: recordingFactory(createdBy, "default"),
    });
    const socket = new FakeServerSocket();

    try {
      server
        .prepareWebSocketUpgrade({
          createAgent: recordingFactory(createdBy, "override"),
        })
        .accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await readSentMessage(socket);
      expect(createdBy).toEqual(["override"]);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("does not leak WebSocket factory overrides to later prepared upgrades", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: recordingFactory(createdBy, "default"),
    });
    const overrideSocket = new FakeServerSocket();
    const defaultSocket = new FakeServerSocket();

    try {
      server
        .prepareWebSocketUpgrade({
          createAgent: recordingFactory(createdBy, "override"),
        })
        .accept(overrideSocket);
      server.prepareWebSocketUpgrade().accept(defaultSocket);

      overrideSocket.receive(JSON.stringify(initializeRequest));
      defaultSocket.receive(JSON.stringify({ ...initializeRequest, id: 1 }));

      await Promise.all([
        readSentMessage(overrideSocket),
        readSentMessage(defaultSocket),
      ]);
      expect(createdBy).toEqual(["override", "default"]);
    } finally {
      overrideSocket.close();
      defaultSocket.close();
      await server.close();
    }
  });

  it("keeps concurrent WebSocket factory overrides isolated", async () => {
    const createdBy: string[] = [];
    const server = new AcpServer({
      createAgent: recordingFactory(createdBy, "default"),
    });
    const firstSocket = new FakeServerSocket();
    const secondSocket = new FakeServerSocket();

    try {
      const first = server.prepareWebSocketUpgrade({
        createAgent: recordingFactory(createdBy, "first"),
      });
      const second = server.prepareWebSocketUpgrade({
        createAgent: recordingFactory(createdBy, "second"),
      });

      second.accept(secondSocket);
      first.accept(firstSocket);
      secondSocket.receive(JSON.stringify({ ...initializeRequest, id: 2 }));
      firstSocket.receive(JSON.stringify({ ...initializeRequest, id: 1 }));

      await Promise.all([
        readSentMessage(firstSocket),
        readSentMessage(secondSocket),
      ]);
      expect(createdBy).toEqual(expect.arrayContaining(["first", "second"]));
      expect(createdBy).toHaveLength(2);
    } finally {
      firstSocket.close();
      secondSocket.close();
      await server.close();
    }
  });

  it("removes rejected prepared WebSocket connections", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const prepared = server.prepareWebSocketUpgrade();

    try {
      prepared.reject();
      const response = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            [HEADER_CONNECTION_ID]: prepared.connectionId,
          },
        }),
      );

      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("does not expose accepted WebSocket upgrades to HTTP before initialize succeeds", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const prepared = server.prepareWebSocketUpgrade();
    const socket = new FakeServerSocket();

    try {
      prepared.accept(socket);

      const getResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            [HEADER_CONNECTION_ID]: prepared.connectionId,
          },
        }),
      );
      const postResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "POST",
          headers: {
            "Content-Type": JSON_MIME_TYPE,
            [HEADER_CONNECTION_ID]: prepared.connectionId,
          },
          body: JSON.stringify(sessionNewRequest),
        }),
      );
      const deleteResponse = await server.handleRequest(
        new Request("http://127.0.0.1/acp", {
          method: "DELETE",
          headers: {
            [HEADER_CONNECTION_ID]: prepared.connectionId,
          },
        }),
      );

      expect(getResponse.status).toBe(404);
      expect(postResponse.status).toBe(404);
      expect(deleteResponse.status).toBe(404);

      socket.receive(JSON.stringify(initializeRequest));
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("closes accepted WebSocket upgrades before initialize on server close", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const socket = new FakeServerSocket();

    server.prepareWebSocketUpgrade().accept(socket);

    expect(socket.closeCount).toBe(0);

    await server.close();

    expect(socket.closeCount).toBe(1);
    expect(socket.closeCode).toBe(1001);
    expect(socket.closeReason).toBe("Server shutting down");
  });

  it("queues WebSocket frames while initialize is pending", async () => {
    const initialize = createDeferred<InitializeResponse>();
    const server = new AcpServer({
      createAgent: () =>
        createTestAgentApp({
          initialize: () => initialize.promise,
          newSession: () => ({ sessionId: "queued-session" }),
        }),
    });
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));
      socket.receive(JSON.stringify(sessionNewRequest));

      expect(socket.sent).toEqual([]);

      initialize.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
        },
      });

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: "queued-session",
        },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("rejects duplicate WebSocket initialize requests after connection setup", async () => {
    let initializeCalls = 0;
    const server = new AcpServer({
      createAgent: () =>
        createTestAgentApp({
          onInitialize: () => {
            initializeCalls += 1;
          },
        }),
    });
    const socket = new FakeServerSocket();

    try {
      server.prepareWebSocketUpgrade().accept(socket);
      socket.receive(JSON.stringify(initializeRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
        },
      });

      socket.receive(JSON.stringify({ ...initializeRequest, id: 99 }));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: 99,
        error: {
          code: -32600,
          message: "Initialize not allowed on existing connection",
        },
      });
      expect(initializeCalls).toBe(1);

      socket.receive(JSON.stringify(sessionNewRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("accepts a single-entry v2 initialize batch with array response framing", async () => {
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(2);
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify([v2InitializeRequest]));
      const response = await readSentWireMessage(socket);

      expect(response).toEqual([
        expect.objectContaining({
          jsonrpc: "2.0",
          id: v2InitializeRequest.id,
          result: expect.objectContaining({ protocolVersion: 2 }),
        }),
      ]);

      socket.receive(JSON.stringify([sessionNewRequest]));
      await expect(readSentWireMessage(socket)).resolves.toEqual([
        expect.objectContaining({
          jsonrpc: "2.0",
          id: sessionNewRequest.id,
          result: expect.objectContaining({
            sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          }),
        }),
      ]);
      expect(socket.closeCount).toBe(0);
    } finally {
      socket.close();
      await session.closed;
      await registry.closeAll();
    }
  });

  it("retains array framing when a batched initialize fails", async () => {
    let agentTask: Promise<void> = Promise.resolve();
    const agent: AgentConnector = {
      connect(stream) {
        agentTask = (async () => {
          const reader = stream.readable.getReader();
          try {
            await reader.read();
          } finally {
            reader.releaseLock();
          }

          const writer = stream.writable.getWriter();
          try {
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        })();
        void agentTask.catch(() => undefined);
        return {};
      },
    };
    const registry = new ConnectionRegistry();
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify([v2InitializeRequest]));

      await expect(readSentWireMessage(socket)).resolves.toEqual([
        expect.objectContaining({
          jsonrpc: "2.0",
          id: v2InitializeRequest.id,
          error: expect.objectContaining({
            code: -32603,
            message: "Initialize failed",
          }),
        }),
      ]);
      await session.closed;
      expect(socket.closeCode).toBe(1011);
      expect(socket.closeReason).toBe("Initialize failed");
    } finally {
      socket.close();
      await agentTask;
      await registry.closeAll();
    }
  });

  it("rejects a multi-entry initial WebSocket batch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(2);
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify([v2InitializeRequest, sessionNewRequest]));
      await session.closed;

      expect(socket.closeCount).toBe(1);
      expect(socket.closeCode).toBe(1002);
      expect(socket.closeReason).toBe("First message must be initialize");
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("rejects post-initialize batches when ACP v1 was negotiated", async () => {
    let newSessionCalls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry();
    const agent = createTestAgentApp({
      newSession: () => {
        newSessionCalls += 1;
        return { sessionId: "must-not-be-created" };
      },
    });
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);

      socket.receive(JSON.stringify([sessionNewRequest]));
      await session.closed;

      expect(newSessionCalls).toBe(0);
      expect(socket.closeCode).toBe(1002);
      expect(socket.closeReason).toBe("JSON-RPC batches require ACP v2");
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("closes the socket for session IDs and request IDs longer than maxIdLength", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry({ maxIdLength: 8 });
    const agent = createTestAgentApp();
    const tooLong = "s".repeat(9);
    const frames = [
      {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: tooLong },
      },
      { ...sessionNewRequest, id: tooLong },
    ];

    try {
      for (const [index, frame] of frames.entries()) {
        const socket = new FakeServerSocket();
        const session = handleWebSocketConnection(socket, { registry, agent });
        socket.receive(JSON.stringify(initializeRequest));
        await readSentMessage(socket);

        socket.receive(JSON.stringify(frame));
        await session.closed;

        expect(socket.closeCode).toBe(1008);
        expect(socket.closeReason).toBe(
          `${index === 0 ? "Session" : "Request"} ID exceeds maxIdLength (8)`,
        );
      }
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("holds back client requests while the socket holds maxBufferedBytes", async () => {
    const registry = new ConnectionRegistry({ maxBufferedBytes: 1024 });
    const agent = createTestAgentApp();
    const socket = new FakeServerSocket();
    handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);

      // The client has not read what the socket holds, so the request waits.
      socket.bufferedAmount = 1024;
      const reads = socket.bufferedAmountReads;
      socket.receive(JSON.stringify(sessionNewRequest));
      await until(() => socket.bufferedAmountReads > reads);
      await delay(20);
      expect(socket.sent).toEqual([]);

      socket.bufferedAmount = 0;
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        id: sessionNewRequest.id,
        result: { sessionId: expect.any(String) },
      });
      expect(socket.closeCount).toBe(0);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("holds back batches the agent answers while the socket holds maxBufferedBytes", async () => {
    const registry = new ConnectionRegistry({ maxBufferedBytes: 4096 });
    const agent = createProtocolAgent(2);
    const socket = new FakeServerSocket();
    handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      // Each of these gets an error reply, and none is a request.
      socket.bufferedAmount = 4096;
      const reads = socket.bufferedAmountReads;
      socket.receive(JSON.stringify([]));
      socket.receive(
        JSON.stringify([
          { id: 1, padding: "p" },
          { jsonrpc: "2.0", method: "_vendor/acme/notification" },
        ]),
      );
      await until(() => socket.bufferedAmountReads > reads);
      await delay(20);
      expect(socket.sent).toEqual([]);

      socket.bufferedAmount = 0;
      await expect(readSentWireMessage(socket)).resolves.toMatchObject({
        error: { code: -32600 },
      });
      await expect(readSentWireMessage(socket)).resolves.toMatchObject([
        { error: { code: -32600 } },
      ]);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("paces agent output to what the socket has sent", async () => {
    const registry = new ConnectionRegistry({ maxBufferedBytes: 4096 });
    const sent: number[] = [];
    const agent = createAgentApp({ name: "burst-agent" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.prompt, async (c) => {
        for (let index = 0; index < 50; index++) {
          await c.client.notify(methods.client.session.update, {
            sessionId: c.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "x".repeat(1000) },
            },
          });
          sent.push(index);
        }

        return { stopReason: "end_turn" };
      });
    const socket = new FakeServerSocket();
    handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);

      // The client stops reading, so everything sent stays in the socket.
      socket.holdsSentData = true;
      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "session/prompt",
          params: {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "go" }],
          },
        }),
      );
      await until(() => socket.bufferedAmount >= 4096);
      await delay(20);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.length).toBeLessThan(10);
      expect(socket.sent.length).toBeLessThan(10);

      // Once the client reads, the agent finishes.
      socket.holdsSentData = false;
      socket.bufferedAmount = 0;
      await until(
        () => socket.sent.some((data) => JSON.parse(data).id === 5),
        2_000,
      );
      expect(sent).toHaveLength(50);
      expect(socket.closeCount).toBe(0);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("closes the socket when its client reads none of its output for maxOutputStallMs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry({
      maxBufferedBytes: 1024,
      maxOutputStallMs: 50,
    });
    // A reply larger than the socket may hold, after which the agent has
    // nothing more to send.
    const agent = createTestAgentApp({
      newSession: () => ({
        sessionId: "session-1",
        _meta: { padding: "p".repeat(2000) },
      }),
    });
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);

      socket.holdsSentData = true;
      socket.receive(JSON.stringify(sessionNewRequest));
      await session.closed;

      expect(socket.sent).toHaveLength(1);
      expect(socket.closeCode).toBe(1008);
      expect(socket.closeReason).toBe(
        "Connection output stalled for maxOutputStallMs (50)",
      );
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("closes a full socket once its connection shuts down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry({
      maxBufferedBytes: 1024,
      maxIdLength: 8,
    });
    let agentWriter: WritableStreamDefaultWriter<AnyWireMessage> | undefined;
    const agent: AgentConnector = {
      connect(stream) {
        void (async () => {
          const reader = stream.readable.getReader();
          const { value } = await reader.read();
          agentWriter = stream.writable.getWriter();
          await agentWriter.write({
            jsonrpc: "2.0",
            id: (value as { id: number }).id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {},
            },
          });
        })();
      },
    };
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);
      if (!agentWriter) {
        throw new Error("Expected the agent to have answered initialize");
      }

      // The client stops reading, so this fills the socket.
      socket.holdsSentData = true;
      void agentWriter.write({
        jsonrpc: "2.0",
        method: "_vendor/acme/notification",
        params: { padding: "p".repeat(2000) },
      });
      await readSentMessage(socket);

      // A session ID the connection refuses shuts it down, which closes the
      // socket without waiting for the client to read.
      void agentWriter.write({
        jsonrpc: "2.0",
        method: "_vendor/acme/notification",
        params: { sessionId: "s".repeat(9) },
      });
      await session.closed;

      expect(socket.closeCode).toBe(1008);
      expect(socket.closeReason).toBe("Session ID exceeds maxIdLength (8)");
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("closes the socket when the client sends more than maxBufferedBytes while earlier messages wait", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const initialize = createDeferred<InitializeResponse>();
    const registry = new ConnectionRegistry({ maxBufferedBytes: 4096 });
    const agent = createTestAgentApp({ initialize: () => initialize.promise });
    const connection = registry.createPendingConnection(agent);
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, {
      registry,
      agent,
      connection,
    });
    const padding = JSON.stringify({
      jsonrpc: "2.0",
      method: "_vendor/acme/padding",
      params: { padding: "p".repeat(1500) },
    });

    try {
      // Frames wait behind the initialize request until the agent answers.
      socket.receive(JSON.stringify(initializeRequest));
      await delay(0);
      socket.receive(padding);
      expect(socket.closeCount).toBe(0);
      socket.receive(padding);
      await session.closed;

      expect(socket.closeCode).toBe(1008);
      expect(socket.closeReason).toBe(
        "Connection exceeds maxBufferedBytes (4096)",
      );
      expect(warn).toHaveBeenCalledWith(
        `Closing ACP connection ${connection.connectionId}:`,
        "Connection exceeds maxBufferedBytes (4096)",
      );
    } finally {
      initialize.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      });
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("counts empty frames waiting to be handled toward maxBufferedBytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const initialize = createDeferred<InitializeResponse>();
    const registry = new ConnectionRegistry({ maxBufferedBytes: 4096 });
    const agent = createTestAgentApp({ initialize: () => initialize.promise });
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      // Frames wait behind the initialize request until the agent answers.
      // Each also holds more than its text, which counts 1 KiB, so four fit.
      socket.receive(JSON.stringify(initializeRequest));
      await delay(0);
      let frames = 0;
      while (socket.closeCount === 0 && frames < 100) {
        socket.receive("");
        frames += 1;
      }

      expect(frames).toBe(5);
      await session.closed;
      expect(socket.closeCode).toBe(1008);
      expect(socket.closeReason).toBe(
        "Connection exceeds maxBufferedBytes (4096)",
      );
    } finally {
      initialize.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      });
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("forwards post-initialize batches and sends one response-array frame", async () => {
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(2);
    const connection = registry.createPendingConnection(agent);
    const socket = new FakeServerSocket();

    try {
      handleWebSocketConnection(socket, { registry, agent, connection });
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      const secondRequest = { ...sessionNewRequest, id: 2 };
      socket.receive(JSON.stringify([sessionNewRequest, secondRequest]));

      const response = await readSentWireMessage(socket);
      expect(Array.isArray(response)).toBe(true);
      expect(response).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jsonrpc: "2.0",
            id: sessionNewRequest.id,
            result: expect.objectContaining({
              sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            }),
          }),
          expect.objectContaining({
            jsonrpc: "2.0",
            id: secondRequest.id,
            result: expect.objectContaining({
              sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            }),
          }),
        ]),
      );
      expect(socket.sent).toEqual([]);
      expect(connection.pendingRoutes.size).toBe(0);
      expect(socket.closeCount).toBe(0);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("tracks each inbound batch route before forwarding the batch", async () => {
    const loadStarted = createDeferred<void>();
    const finishLoad = createDeferred<void>();
    const agent: AgentConnector = {
      connect(stream) {
        return new JsonRpcConnection(
          async (method) => {
            if (method === "initialize") {
              return {
                protocolVersion: 2,
                info: { name: "test-agent", version: "1.0.0" },
              };
            }

            if (method === "session/load") {
              loadStarted.resolve();
              await finishLoad.promise;
              return {};
            }

            return {};
          },
          async () => {},
          stream,
        );
      },
    };
    const registry = new ConnectionRegistry();
    const connection = registry.createPendingConnection(agent);
    const socket = new FakeServerSocket();
    const sessionId = "session-1";

    try {
      handleWebSocketConnection(socket, { registry, agent, connection });
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      socket.receive(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 30,
            method: "session/load",
            params: { sessionId, cwd: "/tmp", mcpServers: [] },
          },
          {
            jsonrpc: "2.0",
            method: "_vendor/acme/session-notification",
            params: { sessionId },
          },
        ]),
      );
      await loadStarted.promise;

      expect(connection.pendingRoutes.get("number:30")).toBe("connection");
      expect(connection.sessionStreams.has(sessionId)).toBe(false);

      finishLoad.resolve();
      const response = await readSentWireMessage(socket);
      expect(response).toMatchObject([{ jsonrpc: "2.0", id: 30 }]);
      expect(connection.pendingRoutes.size).toBe(0);
    } finally {
      finishLoad.resolve();
      socket.close();
      await registry.closeAll();
    }
  });

  it("returns an invalid-request error for an empty post-initialize batch", async () => {
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(2);
    const socket = new FakeServerSocket();

    try {
      handleWebSocketConnection(socket, { registry, agent });
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      socket.receive(JSON.stringify([]));
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600 },
      });
      expect(socket.closeCount).toBe(0);

      socket.receive(JSON.stringify(sessionNewRequest));
      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("sends agent-originated batches atomically and tracks each request route", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let rpcConnection: JsonRpcConnection | undefined;
    const agent: AgentConnector = {
      connect(stream) {
        rpcConnection = new JsonRpcConnection(
          async () => ({
            protocolVersion: 2,
            info: { name: "test-agent", version: "1.0.0" },
          }),
          async () => {},
          stream,
        );
        return rpcConnection;
      },
    };
    const registry = new ConnectionRegistry();
    const connection = registry.createPendingConnection(agent);
    const socket = new FakeServerSocket();
    const sessionId = "session-1";

    try {
      handleWebSocketConnection(socket, { registry, agent, connection });
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      if (!rpcConnection) {
        throw new Error("Expected JSON-RPC connection");
      }

      const batchResult = rpcConnection.sendBatch([
        batchRequest("_vendor/acme/session-request", { sessionId }),
        batchRequest("_vendor/acme/connection-request", {}),
        batchNotification("_vendor/acme/session-notification", { sessionId }),
      ] as const);
      batchResult.catch(() => undefined);

      const outbound = await readSentWireMessage(socket);
      if (!Array.isArray(outbound)) {
        throw new Error("Expected outbound batch frame");
      }

      expect(outbound).toMatchObject([
        {
          jsonrpc: "2.0",
          method: "_vendor/acme/session-request",
          params: { sessionId },
        },
        {
          jsonrpc: "2.0",
          method: "_vendor/acme/connection-request",
          params: {},
        },
        {
          jsonrpc: "2.0",
          method: "_vendor/acme/session-notification",
          params: { sessionId },
        },
      ]);
      expect(socket.sent).toEqual([]);
      const firstRequest = outbound[0];
      const secondRequest = outbound[1];
      if (!("id" in firstRequest) || !("id" in secondRequest)) {
        throw new Error("Expected outbound batch request IDs");
      }
      expect(connection.clientResponseRoutes).toEqual(
        new Map<string, ResponseRoute>([
          [`number:${firstRequest.id}`, { session: sessionId }],
          [`number:${secondRequest.id}`, "connection"],
        ]),
      );
      expect(connection.sessionStreams.has(sessionId)).toBe(false);

      socket.receive(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: firstRequest.id,
            result: { value: "session" },
          },
          {
            jsonrpc: "2.0",
            id: secondRequest.id,
            result: { value: "connection" },
          },
        ]),
      );

      await expect(batchResult).resolves.toEqual([
        { value: "session" },
        { value: "connection" },
        undefined,
      ]);
      expect(connection.clientResponseRoutes.size).toBe(0);

      connection.clientResponseRoutes.set("number:77", "connection");
      connection.clientResponseRoutes.set("null", { session: sessionId });
      socket.receive(
        JSON.stringify([
          { jsonrpc: "2.0", id: 77, error: null },
          { jsonrpc: "2.0", id: null, error: null },
        ]),
      );
      socket.receive(JSON.stringify({ ...sessionNewRequest, id: 88 }));
      await readSentMessage(socket);
      expect(connection.clientResponseRoutes.size).toBe(0);
    } finally {
      error.mockRestore();
      socket.close();
      await registry.closeAll();
    }
  });

  it("rejects duplicate initialize requests inside post-initialize batches", async () => {
    let initializeCalls = 0;
    let newSessionCalls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new ConnectionRegistry();
    const agent = createProtocolAgent(2, (method) => {
      if (method === "initialize") {
        initializeCalls += 1;
      }
      if (method === "session/new") {
        newSessionCalls += 1;
      }
    });
    const socket = new FakeServerSocket();
    const session = handleWebSocketConnection(socket, { registry, agent });

    try {
      socket.receive(JSON.stringify(v2InitializeRequest));
      await readSentMessage(socket);

      socket.receive(
        JSON.stringify([{ ...v2InitializeRequest, id: 99 }, sessionNewRequest]),
      );
      await session.closed;

      expect(initializeCalls).toBe(1);
      expect(newSessionCalls).toBe(0);
      expect(socket.closeCode).toBe(1002);
      expect(socket.closeReason).toBe(
        "Initialize not allowed on existing connection",
      );
    } finally {
      warn.mockRestore();
      await registry.closeAll();
    }
  });

  it("clears WebSocket client-response routes after forwarding responses", async () => {
    const registry = new ConnectionRegistry();
    const agent = createTestAgentApp({ enablePermission: true });
    const connection = registry.createPendingConnection(agent);
    const socket = new FakeServerSocket();

    try {
      handleWebSocketConnection(socket, {
        registry,
        agent,
        connection,
      });
      socket.receive(JSON.stringify(initializeRequest));
      await readSentMessage(socket);

      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/prompt",
          params: {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "Hello" }],
          },
        }),
      );
      await readSentMessage(socket);
      const permissionRequest = await readSentMessage(socket);
      if (!("id" in permissionRequest)) {
        throw new Error("Expected permission request ID");
      }

      expect(connection.clientResponseRoutes.size).toBe(1);

      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        }),
      );

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              text: "permission-selected-allow",
            },
          },
        },
      });
      expect(connection.clientResponseRoutes.size).toBe(0);
    } finally {
      socket.close();
      await registry.closeAll();
    }
  });

  it("keeps existing double-settle behavior for prepared WebSocket upgrades", async () => {
    const server = new AcpServer({
      createAgent: () => createTestAgentApp(),
    });
    const rejected = server.prepareWebSocketUpgrade();
    const accepted = server.prepareWebSocketUpgrade();
    const socket = new FakeServerSocket();

    try {
      rejected.reject();
      expect(() => rejected.accept(new FakeServerSocket())).toThrow(
        "ACP WebSocket upgrade has already been settled",
      );

      accepted.accept(socket);
      expect(() => accepted.accept(new FakeServerSocket())).toThrow(
        "ACP WebSocket upgrade has already been settled",
      );
      expect(() => accepted.reject()).not.toThrow();
    } finally {
      socket.close();
      await server.close();
    }
  });
});

function recordingFactory(
  createdBy: string[],
  label: string,
): () => ReturnType<typeof createTestAgentApp> {
  return () => {
    createdBy.push(label);
    return createTestAgentApp();
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSentMessage(socket: FakeServerSocket): Promise<AnyMessage> {
  return readSentWireMessage(socket).then((message) => {
    if (Array.isArray(message)) {
      throw new Error("Expected individual WebSocket message");
    }

    return message as AnyMessage;
  });
}

function readSentWireMessage(
  socket: FakeServerSocket,
): Promise<AnyWireMessage> {
  const message = socket.sent.shift();

  if (message) {
    return Promise.resolve(JSON.parse(message));
  }

  return new Promise((resolve) => {
    socket.onSend = (data) => {
      const message = socket.sent.shift();
      resolve(JSON.parse(message ?? data));
    };
  });
}

class FakeServerSocket implements WebSocketServerSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  onSend: ((data: string) => void) | undefined;
  /** Whether sent data stays in `bufferedAmount`, as if the peer stopped reading. */
  holdsSentData = false;
  /** How many times `bufferedAmount` was read, such as by a session waiting on it. */
  bufferedAmountReads = 0;
  closeCount = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private unsentBytes = 0;

  get bufferedAmount(): number {
    this.bufferedAmountReads += 1;
    return this.unsentBytes;
  }

  set bufferedAmount(value: number) {
    this.unsentBytes = value;
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.holdsSentData) {
      this.unsentBytes += data.length;
    }
    this.onSend?.(data);
    this.onSend = undefined;
  }

  close(code?: number, reason?: string): void {
    this.closeCount += 1;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, this.listeners.get(type) ?? new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(data: string): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
