import { describe, expect, it } from "vitest";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  agent as createAgentApp,
  methods,
} from "./acp.js";
import { ConnectionRegistry } from "./connection.js";
import { HEADER_CONNECTION_ID, JSON_MIME_TYPE } from "./protocol.js";
import { AcpServer } from "./server.js";
import { createTestAgentApp, TestAgent } from "./test-support/test-agent.js";
import { handleWebSocketConnection } from "./ws-server.js";

import type { InitializeResponse } from "./acp.js";
import type { AcpHttpBackend } from "./http-backend.js";
import type { AnyMessage } from "./jsonrpc.js";
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

describe("AcpServer prepared WebSocket upgrades", () => {
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

  it("keeps prepared WebSocket upgrades on the in-memory path when an HTTP backend is configured", async () => {
    const server = new AcpServer({
      createAgent: () =>
        createTestAgentApp({
          newSession: () => ({ sessionId: "ws-session" }),
        }),
      httpBackend: createThrowingHttpBackend(),
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

      socket.receive(JSON.stringify(sessionNewRequest));

      await expect(readSentMessage(socket)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: sessionNewRequest.id,
        result: {
          sessionId: "ws-session",
        },
      });
    } finally {
      socket.close();
      await server.close();
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

function createThrowingHttpBackend(): AcpHttpBackend {
  const error = () => new Error("HTTP backend must not be used by WebSocket");

  return {
    generateServerRequestId: () => {
      throw error();
    },
    initialize: () => Promise.reject(error()),
    loadConnection: () => Promise.reject(error()),
    touchConnection: () => Promise.reject(error()),
    acceptClientMethodMessage: () => Promise.reject(error()),
    acceptClientResponse: () => Promise.reject(error()),
    openConnectionStream: () => Promise.reject(error()),
    openSessionStream: () => Promise.reject(error()),
    closeConnection: () => Promise.reject(error()),
    close: () => Promise.resolve(),
  };
}

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

function readSentMessage(socket: FakeServerSocket): Promise<AnyMessage> {
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
  closeCount = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string): void {
    this.sent.push(data);
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
