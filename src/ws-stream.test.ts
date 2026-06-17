import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { ClientSideConnection, PROTOCOL_VERSION } from "./acp.js";
import { HEADER_CONNECTION_ID } from "./protocol.js";
import { MemoryAcpCookieStore, createWebSocketStream } from "./ws-stream.js";
import { TestAgent } from "./test-support/test-agent.js";
import { startTestServer } from "./test-support/test-http-server.js";

import type { IncomingMessage } from "node:http";
import type {
  Agent,
  AgentSideConnection,
  Client,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "./acp.js";
import type { AnyMessage } from "./jsonrpc.js";
import type { Stream } from "./stream.js";
import type { WebSocketConstructor } from "./ws-stream.js";

const nodeWebSocket = WebSocket as unknown as WebSocketConstructor;

const initializeRequest = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  },
} satisfies AnyMessage;

const initializeResponse = {
  jsonrpc: "2.0",
  id: 0,
  result: {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
    },
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

describe("createWebSocketStream", () => {
  it("exposes the ACP connection ID during the WebSocket handshake", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(server.wsUrl);
    const upgrade = new Promise<IncomingMessage>((resolve, reject) => {
      socket.once("upgrade", resolve);
      socket.once("error", reject);
    });

    try {
      const request = await upgrade;
      expect(request.headers[HEADER_CONNECTION_ID.toLowerCase()]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("closes pre-created WebSocket connections when the first frame is not initialize", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(server.wsUrl);
    const upgrade = new Promise<IncomingMessage>((resolve, reject) => {
      socket.once("upgrade", resolve);
      socket.once("error", reject);
    });
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });

    try {
      const request = await upgrade;
      const connectionId = request.headers[HEADER_CONNECTION_ID.toLowerCase()];
      expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

      socket.send(JSON.stringify(sessionNewRequest));

      await expect(close).resolves.toEqual({
        code: 1002,
        reason: "First message must be initialize",
      });

      const response = await fetch(server.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          [HEADER_CONNECTION_ID]: String(connectionId),
        },
      });

      expect(response.status).toBe(404);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("ignores binary WebSocket initialize frames", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(server.wsUrl);
    const upgrade = new Promise<IncomingMessage>((resolve, reject) => {
      socket.once("upgrade", resolve);
      socket.once("error", reject);
    });
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });

    try {
      const request = await upgrade;
      const connectionId = request.headers[HEADER_CONNECTION_ID.toLowerCase()];
      expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

      socket.send(Buffer.from(JSON.stringify(initializeRequest)), {
        binary: true,
      });
      socket.send(JSON.stringify(sessionNewRequest));

      await expect(close).resolves.toEqual({
        code: 1002,
        reason: "First message must be initialize",
      });

      const response = await fetch(server.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          [HEADER_CONNECTION_ID]: String(connectionId),
        },
      });

      expect(response.status).toBe(404);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("uses the custom WebSocket constructor and queues writes until the socket opens", async () => {
    const instances: FakeWebSocket[] = [];
    const stream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket: createFakeWebSocketConstructor(instances),
      protocols: ["acp"],
      headers: { Authorization: "Bearer token" },
    });
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    try {
      const socket = fakeSocketAt(instances, 0);
      expect(socket.url).toBe("ws://agent.example/acp");
      expect(socket.protocols).toEqual(["acp"]);
      expect(socket.options).toEqual({
        headers: { Authorization: "Bearer token" },
      });

      const write = writer.write(initializeRequest);
      await Promise.resolve();
      expect(socket.sent).toEqual([]);

      socket.open();
      await write;
      expect(socket.sent).toEqual([JSON.stringify(initializeRequest)]);

      socket.receive(JSON.stringify(initializeResponse));
      expect(await readMessage(reader)).toEqual(initializeResponse);
    } finally {
      reader.releaseLock();
      await writer.close().catch(() => undefined);
      writer.releaseLock();
    }
  });

  it("does not emit unhandled rejections when the socket closes before the first write", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const instances: FakeWebSocket[] = [];
    const stream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket: createFakeWebSocketConstructor(instances),
    });
    const reader = stream.readable.getReader();

    try {
      fakeSocketAt(instances, 0).close();

      expect(await reader.read()).toEqual({ done: true, value: undefined });
      await waitForUnhandledRejections();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      reader.releaseLock();
      await closeStream(stream);
    }
  });

  it("passes managed cookies and custom headers to custom WebSocket constructors", async () => {
    const cookieStore = new MemoryAcpCookieStore();
    cookieStore.store(headersWithSetCookie(["transport=alpha", "route=bravo"]));
    const instances: FakeWebSocket[] = [];
    const stream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket: createFakeWebSocketConstructor(instances),
      cookieStore,
      headers: {
        Authorization: "Bearer token",
        Cookie: "route=caller; caller=custom",
      },
    });

    try {
      const socket = fakeSocketAt(instances, 0);
      expect(socket.options).toEqual({
        headers: {
          Authorization: "Bearer token",
          Cookie: "transport=alpha; route=caller; caller=custom",
        },
      });
      socket.open();
    } finally {
      await closeStream(stream);
    }
  });

  it("stores upgrade cookies for reuse by later WebSocket streams", async () => {
    const cookieStore = new MemoryAcpCookieStore();
    const instances: FakeWebSocket[] = [];
    const WebSocket = createFakeWebSocketConstructor(instances);
    const firstStream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket,
      cookieStore,
    });

    const firstSocket = fakeSocketAt(instances, 0);
    firstSocket.upgrade({
      headers: {
        "set-cookie": ["transport=alpha; Path=/"],
      },
    });
    firstSocket.open();
    await closeStream(firstStream);

    const secondStream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket,
      cookieStore,
    });

    try {
      const secondSocket = fakeSocketAt(instances, 1);
      expect(secondSocket.options).toEqual({
        headers: {
          Cookie: "transport=alpha",
        },
      });
      secondSocket.open();
    } finally {
      await closeStream(secondStream);
    }
  });

  it("omits managed cookies and upgrade cookie storage when cookies are disabled", async () => {
    const cookieStore = new MemoryAcpCookieStore();
    const instances: FakeWebSocket[] = [];
    const WebSocket = createFakeWebSocketConstructor(instances);
    const firstStream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket,
      cookieStore,
      cookies: "omit",
    });

    const firstSocket = fakeSocketAt(instances, 0);
    expect(firstSocket.options).toEqual({
      headers: undefined,
    });
    firstSocket.upgrade({
      headers: {
        "set-cookie": ["transport=alpha; Path=/"],
      },
    });
    firstSocket.open();
    await closeStream(firstStream);

    const secondStream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket,
      cookieStore,
    });

    try {
      const secondSocket = fakeSocketAt(instances, 1);
      expect(secondSocket.options).toEqual({
        headers: undefined,
      });
      secondSocket.open();
    } finally {
      await closeStream(secondStream);
    }
  });

  it("ignores binary, malformed JSON, and non-JSON-RPC messages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instances: FakeWebSocket[] = [];
    const stream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket: createFakeWebSocketConstructor(instances),
    });
    const reader = stream.readable.getReader();

    try {
      const socket = fakeSocketAt(instances, 0);
      socket.open();
      socket.receive(new Uint8Array([1, 2, 3]), true);
      socket.receive(
        new TextEncoder().encode(JSON.stringify(initializeResponse)),
      );
      socket.receive(
        new TextEncoder().encode(JSON.stringify(initializeResponse)).buffer,
      );
      socket.receive("not json");
      socket.receive(JSON.stringify({ hello: "world" }));
      socket.receive(JSON.stringify(initializeResponse));

      expect(await readMessage(reader)).toEqual(initializeResponse);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      reader.releaseLock();
      warn.mockRestore();
      await closeStream(stream);
    }
  });

  it("closes the readable stream when the socket closes", async () => {
    const instances: FakeWebSocket[] = [];
    const stream = createWebSocketStream("ws://agent.example/acp", {
      WebSocket: createFakeWebSocketConstructor(instances),
    });
    const reader = stream.readable.getReader();

    try {
      const socket = fakeSocketAt(instances, 0);
      socket.open();
      socket.close();

      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
      reader.releaseLock();
    }
  });

  it("runs initialize, newSession, and prompt through ClientSideConnection", async () => {
    const updates: SessionNotification[] = [];
    const server = await startTestServer(
      (conn: AgentSideConnection) => new TestAgent(conn, { chunkCount: 2 }),
    );
    const stream = createWebSocketStream(server.wsUrl, {
      WebSocket: nodeWebSocket,
    });
    const conn = new ClientSideConnection(
      () => createTestClient({ updates }),
      stream,
    );

    try {
      expect(
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      ).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      });

      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      await expect(
        conn.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Hello" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(updates).toHaveLength(2);
      expect(updates).toMatchObject([
        {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "chunk-1" },
          },
        },
        {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "chunk-2" },
          },
        },
      ]);
    } finally {
      await closeStream(stream);
      await server.close();
    }
  });

  it("round-trips permission requests through ClientSideConnection", async () => {
    const updates: SessionNotification[] = [];
    const permissionRequests: RequestPermissionRequest[] = [];
    const server = await startTestServer(
      (conn: AgentSideConnection) =>
        new TestAgent(conn, { enablePermission: true }),
    );
    const stream = createWebSocketStream(server.wsUrl, {
      WebSocket: nodeWebSocket,
    });
    const conn = new ClientSideConnection(
      () => createTestClient({ updates, permissionRequests }),
      stream,
    );

    try {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

      await expect(
        conn.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Hello" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });

      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "permission-tool",
          title: "Permission tool",
        },
      });
      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: session.sessionId,
            update: expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: expect.objectContaining({
                text: "permission-selected-allow",
              }),
            }),
          }),
        ]),
      );
    } finally {
      await closeStream(stream);
      await server.close();
    }
  });

  it("loads durable sessions after a WebSocket reconnect", async () => {
    const durableSessions = new Map<string, DurableSessionState>();
    const connectionIds: string[] = [];
    const WebSocket = createRecordingWebSocketConstructor(connectionIds);
    const cookieStore = new MemoryAcpCookieStore();
    const server = await startTestServer(
      (conn: AgentSideConnection) =>
        new DurableSessionAgent(conn, durableSessions),
    );

    try {
      const firstUpdates: SessionNotification[] = [];
      const firstStream = createWebSocketStream(server.wsUrl, {
        WebSocket,
        cookieStore,
      });
      const firstConn = new ClientSideConnection(
        () => createTestClient({ updates: firstUpdates }),
        firstStream,
      );
      const initialized = await firstConn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
      const session = await firstConn.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });
      await expect(
        firstConn.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Remember this" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      await waitForUpdates(firstUpdates, 1);
      await closeStream(firstStream);

      expect(durableSessions.has(session.sessionId)).toBe(true);

      const secondUpdates: SessionNotification[] = [];
      const secondStream = createWebSocketStream(server.wsUrl, {
        WebSocket,
        cookieStore,
      });
      const secondConn = new ClientSideConnection(
        () => createTestClient({ updates: secondUpdates }),
        secondStream,
      );
      const reinitialized = await secondConn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(reinitialized.agentCapabilities?.loadSession).toBe(true);

      // Production agents must authorize session/load against the authenticated
      // principal. This SDK transport test omits auth because there is no
      // generic auth layer in the SDK.
      await expect(
        secondConn.loadSession({
          sessionId: session.sessionId,
          cwd: "/tmp",
          mcpServers: [],
        }),
      ).resolves.toEqual({});
      await waitForUpdates(secondUpdates, firstUpdates.length);
      await closeStream(secondStream);

      expect(connectionIds).toHaveLength(2);
      expect(connectionIds[0]).not.toBe(connectionIds[1]);
      expect(secondUpdates).toEqual(firstUpdates);
    } finally {
      await server.close();
    }
  });

  it("keeps multiple sessions isolated through the SDK client abstraction", async () => {
    const updates: SessionNotification[] = [];
    const server = await startTestServer();
    const stream = createWebSocketStream(server.wsUrl, {
      WebSocket: nodeWebSocket,
    });
    const conn = new ClientSideConnection(
      () => createTestClient({ updates }),
      stream,
    );

    try {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const firstSession = await conn.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });
      const secondSession = await conn.newSession({
        cwd: "/tmp/other",
        mcpServers: [],
      });

      await Promise.all([
        conn.prompt({
          sessionId: firstSession.sessionId,
          prompt: [{ type: "text", text: "First" }],
        }),
        conn.prompt({
          sessionId: secondSession.sessionId,
          prompt: [{ type: "text", text: "Second" }],
        }),
      ]);

      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: firstSession.sessionId }),
          expect.objectContaining({ sessionId: secondSession.sessionId }),
        ]),
      );
      expect(
        updates.filter((update) => update.sessionId === firstSession.sessionId),
      ).toHaveLength(1);
      expect(
        updates.filter(
          (update) => update.sessionId === secondSession.sessionId,
        ),
      ).toHaveLength(1);
    } finally {
      await closeStream(stream);
      await server.close();
    }
  });
});

interface DurableSessionState {
  readonly cwd: string;
  readonly history: SessionNotification[];
}

class DurableSessionAgent implements Agent {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessions: Map<string, DurableSessionState>,
  ) {}

  initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    });
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = globalThis.crypto.randomUUID();
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      history: [],
    });
    return Promise.resolve({ sessionId });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown durable session: ${params.sessionId}`);
    }

    for (const update of session.history) {
      await this.connection.sessionUpdate(update);
    }

    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown durable session: ${params.sessionId}`);
    }

    const update: SessionNotification = {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `durable-history:${session.cwd}`,
        },
      },
    };
    session.history.push(update);
    await this.connection.sessionUpdate(update);

    return { stopReason: "end_turn" };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  authenticate(): Promise<void> {
    return Promise.resolve();
  }
}

interface TestClientState {
  readonly updates: SessionNotification[];
  readonly permissionRequests?: RequestPermissionRequest[];
}

function createTestClient(state: TestClientState): Client {
  return {
    requestPermission: (params): Promise<RequestPermissionResponse> => {
      state.permissionRequests?.push(params);
      return Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      });
    },
    sessionUpdate: (params): Promise<void> => {
      state.updates.push(params);
      return Promise.resolve();
    },
  };
}

async function closeStream(stream: Stream): Promise<void> {
  await stream.writable.close().catch(() => undefined);
}

async function readMessage(
  reader: ReadableStreamDefaultReader<AnyMessage>,
): Promise<AnyMessage> {
  const result = await reader.read();
  if (result.done) {
    throw new Error("Expected a message");
  }

  return result.value;
}

async function waitForUpdates(
  updates: readonly SessionNotification[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (updates.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} session updates`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForUnhandledRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createRecordingWebSocketConstructor(
  connectionIds: string[],
): WebSocketConstructor {
  return class RecordingWebSocket extends WebSocket {
    constructor(
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> },
    ) {
      super(url, protocols, options);
      this.once("upgrade", (message: IncomingMessage) => {
        const connectionId =
          message.headers[HEADER_CONNECTION_ID.toLowerCase()];
        if (typeof connectionId === "string") {
          connectionIds.push(connectionId);
        }
      });
    }
  } as unknown as WebSocketConstructor;
}

function createFakeWebSocketConstructor(
  instances: FakeWebSocket[],
): WebSocketConstructor {
  return class extends FakeWebSocket {
    constructor(
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> },
    ) {
      super(url, protocols, options);
      instances.push(this);
    }
  };
}

function fakeSocketAt(
  instances: readonly FakeWebSocket[],
  index: number,
): FakeWebSocket {
  const socket = instances[index];

  if (!socket) {
    throw new Error(`Expected fake WebSocket at index ${index}`);
  }

  return socket;
}

function headersWithSetCookie(values: readonly string[]): Headers {
  const headers = new Headers();

  Object.defineProperty(headers, "getSetCookie", {
    value: () => values,
  });

  return headers;
}

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readyState = 0;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {}

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("Fake WebSocket is not open");
    }

    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }

    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let listeners = this.listeners.get(type);

    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }

    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(data: unknown, isBinary = false): void {
    this.emit("message", { data, isBinary });
  }

  upgrade(message: unknown): void {
    this.emit("upgrade", message);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
