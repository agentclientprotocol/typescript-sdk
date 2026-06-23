import { describe, expect, it } from "vitest";

import {
  ConnectionRegistry,
  InMemoryAcpHttpBackend,
  OutboundStream,
} from "./connection.js";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
  messageIdKey,
  sessionIdFromMessageParams,
  sessionIdFromResponseResult,
} from "./protocol.js";
import { AcpServer } from "./server.js";
import { parseSseStream } from "./sse.js";
import { PROTOCOL_VERSION, agent as createAgentApp, methods } from "./acp.js";
import { createTestAgentApp } from "./test-support/test-agent.js";

import type { AgentApp } from "./acp.js";
import type { AgentConnector, ResponseRoute } from "./connection.js";
import type { AcpHttpBackend } from "./http-backend.js";
import type {
  AnyMessage,
  AnyResponse,
  JsonRpcRequestIdGenerator,
} from "./jsonrpc.js";
import type { Stream } from "./stream.js";
import { isResponseMessage } from "./jsonrpc.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
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

type HarnessRole =
  | "initialize"
  | "post"
  | "connectionSse"
  | "sessionSse"
  | "delete";

interface HttpBackendHarness {
  readonly name: string;
  readonly serverRequestIdPrefix: string;
  handle(role: HarnessRole, request: Request): Promise<Response>;
  close(): Promise<void>;
}

type HarnessFactory = (createAgent: () => AgentApp) => HttpBackendHarness;

const harnesses: Array<{
  readonly name: string;
  readonly createHarness: HarnessFactory;
}> = [
  {
    name: "in-memory backend",
    createHarness: (createAgent) => {
      let nextRequestId = 0;
      const server = new AcpServer({
        createAgent,
        httpBackend: new InMemoryAcpHttpBackend(
          new ConnectionRegistry(),
          () => `memory-${nextRequestId++}`,
        ),
      });

      return {
        name: "in-memory backend",
        serverRequestIdPrefix: "memory-",
        handle: (_role, request) => server.handleRequest(request),
        close: () => server.close(),
      };
    },
  },
  {
    name: "fake distributed backend",
    createHarness: (createAgent) => {
      const store = new FakeDistributedTransportStore();
      const counters = new Map<string, number>();
      const createServer = (nodeId: string): AcpServer =>
        new AcpServer({
          createAgent,
          httpBackend: new FakeDistributedAcpHttpBackend(store, () => {
            const next = counters.get(nodeId) ?? 0;
            counters.set(nodeId, next + 1);
            return `${nodeId}-${next}`;
          }),
        });
      const servers = {
        initialize: createServer("node-a"),
        post: createServer("node-b"),
        connectionSse: createServer("node-c"),
        sessionSse: createServer("node-d"),
        delete: createServer("node-e"),
      } satisfies Record<HarnessRole, AcpServer>;

      return {
        name: "fake distributed backend",
        serverRequestIdPrefix: "node-a-",
        handle: (role, request) => servers[role].handleRequest(request),
        close: async () => {
          await Promise.all(
            Array.from(new Set(Object.values(servers)), (server) =>
              server.close(),
            ),
          );
        },
      };
    },
  },
];

describe.each(harnesses)(
  "AcpServer HTTP backend conformance: $name",
  ({ createHarness }) => {
    it("preserves initialize, connected POST, connection-stream replay, and session-stream late attach", async () => {
      const harness = createHarness(() =>
        createTestAgentApp({
          newSession: () => ({ sessionId: "session-1" }),
        }),
      );

      try {
        const connectionId = await initialize(harness);

        expect(
          await postJson(harness, "post", sessionNewRequest, {
            [HEADER_CONNECTION_ID]: connectionId,
          }),
        ).toMatchObject({ status: 202 });

        const connectionSse = await openConnectionSse(harness, connectionId);
        expect(connectionSse.status).toBe(200);
        expect(await readSseMessages(connectionSse, 1)).toMatchObject([
          {
            jsonrpc: "2.0",
            id: 2,
            result: { sessionId: "session-1" },
          },
        ]);

        expect(
          await postJson(harness, "post", promptRequest, {
            [HEADER_CONNECTION_ID]: connectionId,
            [HEADER_SESSION_ID]: "session-1",
          }),
        ).toMatchObject({ status: 202 });

        const sessionSse = await openSessionSse(
          harness,
          connectionId,
          "session-1",
        );
        expect(sessionSse.status).toBe(200);
        expect(await readSseMessages(sessionSse, 2)).toMatchObject([
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "chunk-1" },
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 3,
            result: { stopReason: "end_turn" },
          },
        ]);
      } finally {
        await harness.close();
      }
    });

    it("closes HTTP backend connections through DELETE", async () => {
      const harness = createHarness(() => createTestAgentApp());

      try {
        const connectionId = await initialize(harness);
        const deleted = await harness.handle(
          "delete",
          new Request("http://example.test/acp", {
            method: "DELETE",
            headers: {
              [HEADER_CONNECTION_ID]: connectionId,
            },
          }),
        );

        expect(deleted.status).toBe(202);
        expect(
          await postJson(harness, "post", sessionNewRequest, {
            [HEADER_CONNECTION_ID]: connectionId,
          }),
        ).toMatchObject({ status: 404 });
        expect(await openConnectionSse(harness, connectionId)).toMatchObject({
          status: 404,
        });
      } finally {
        await harness.close();
      }
    });

    it("routes permission and elicitation request/response flows without method allowlists", async () => {
      const harness = createHarness(() => createInteractiveAgent());

      try {
        const connectionId = await initialize(harness);
        const sessionId = await createSession(harness, connectionId);
        const connectionSse = await openConnectionSse(harness, connectionId);
        const connectionEvents = createSseMessageIterator(connectionSse);
        const sessionSse = await openSessionSse(
          harness,
          connectionId,
          sessionId,
        );
        const sessionEvents = createSseMessageIterator(sessionSse);

        expect(
          await postJson(harness, "post", promptRequest, {
            [HEADER_CONNECTION_ID]: connectionId,
            [HEADER_SESSION_ID]: sessionId,
          }),
        ).toMatchObject({ status: 202 });

        expect(await readNextSseMessage(sessionEvents)).toMatchObject({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "before-permission" },
            },
          },
        });

        const permissionRequest = await readNextSseMessage(sessionEvents);
        expect(permissionRequest).toMatchObject({
          jsonrpc: "2.0",
          id: expect.stringMatching(
            new RegExp(`^${escapeRegExp(harness.serverRequestIdPrefix)}`),
          ),
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: "permission-tool",
              title: "Permission tool",
            },
          },
        });

        expect(
          await postJson(
            harness,
            "post",
            {
              jsonrpc: "2.0",
              id: readMessageId(permissionRequest),
              result: {
                outcome: {
                  outcome: "selected",
                  optionId: "allow",
                },
              },
            },
            {
              [HEADER_CONNECTION_ID]: connectionId,
              [HEADER_SESSION_ID]: sessionId,
            },
          ),
        ).toMatchObject({ status: 202 });

        expect(await readNextSseMessage(sessionEvents)).toMatchObject({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "permission-selected-allow" },
            },
          },
        });

        const elicitationRequest = await readNextSseMessage(sessionEvents);
        expect(elicitationRequest).toMatchObject({
          jsonrpc: "2.0",
          id: expect.stringMatching(
            new RegExp(`^${escapeRegExp(harness.serverRequestIdPrefix)}`),
          ),
          method: "elicitation/create",
          params: {
            sessionId,
            mode: "form",
            message: "Name",
          },
        });
        expect(readMessageId(elicitationRequest)).not.toBe(
          readMessageId(permissionRequest),
        );

        expect(
          await postJson(
            harness,
            "post",
            {
              jsonrpc: "2.0",
              id: readMessageId(elicitationRequest),
              result: {
                action: "accept",
                content: { name: "Alice" },
              },
            },
            {
              [HEADER_CONNECTION_ID]: connectionId,
              [HEADER_SESSION_ID]: sessionId,
            },
          ),
        ).toMatchObject({ status: 202 });

        expect(await readNextSseMessage(connectionEvents)).toMatchObject({
          jsonrpc: "2.0",
          method: "elicitation/complete",
          params: { elicitationId: "elicitation-1" },
        });
        expect(await readSseIteratorMessages(sessionEvents, 2)).toMatchObject([
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "elicitation-accept-Alice" },
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 3,
            result: { stopReason: "end_turn" },
          },
        ]);

        await sessionEvents.return?.();
        await connectionEvents.return?.();
        await sessionSse.body?.cancel();
        await connectionSse.body?.cancel();
      } finally {
        await harness.close();
      }
    }, 10_000);
  },
);

class FakeDistributedAcpHttpBackend implements AcpHttpBackend {
  constructor(
    private readonly store: FakeDistributedTransportStore,
    readonly generateServerRequestId?: JsonRpcRequestIdGenerator,
  ) {}

  initialize: AcpHttpBackend["initialize"] = (input) =>
    this.store.initialize(input, this.generateServerRequestId);

  loadConnection: AcpHttpBackend["loadConnection"] = (input) =>
    this.store.loadConnection(input);

  touchConnection: AcpHttpBackend["touchConnection"] = (input) =>
    this.store.touchConnection(input);

  acceptClientMethodMessage: AcpHttpBackend["acceptClientMethodMessage"] = (
    input,
  ) => this.store.acceptClientMethodMessage(input);

  acceptClientResponse: AcpHttpBackend["acceptClientResponse"] = (input) =>
    this.store.acceptClientResponse(input);

  openConnectionStream: AcpHttpBackend["openConnectionStream"] = (input) =>
    this.store.openConnectionStream(input);

  openSessionStream: AcpHttpBackend["openSessionStream"] = (input) =>
    this.store.openSessionStream(input);

  closeConnection: AcpHttpBackend["closeConnection"] = (input) =>
    this.store.closeConnection(input);

  close: AcpHttpBackend["close"] = () => this.store.close();
}

class FakeDistributedTransportStore {
  private readonly connections = new Map<string, FakeDistributedConnection>();

  async initialize(
    { agent, message, signal }: Parameters<AcpHttpBackend["initialize"]>[0],
    requestIdGenerator?: JsonRpcRequestIdGenerator,
  ): ReturnType<AcpHttpBackend["initialize"]> {
    if (!("id" in message) || message.id === null) {
      throw new Error("Initialize request must include an ID");
    }

    const connection = new FakeDistributedConnection(agent, requestIdGenerator);

    try {
      await connection.writeInbound(message);
      const response = await connection.recvInitial(message.id);

      if (signal.aborted) {
        throw new Error("Request aborted");
      }

      connection.startRouter();
      this.connections.set(connection.connectionId, connection);

      return {
        connectionId: connection.connectionId,
        response,
      };
    } catch (error) {
      this.connections.delete(connection.connectionId);
      void connection.shutdown();
      throw error;
    }
  }

  async loadConnection({
    connectionId,
  }: Parameters<AcpHttpBackend["loadConnection"]>[0]): ReturnType<
    AcpHttpBackend["loadConnection"]
  > {
    if (!this.connections.has(connectionId)) {
      return undefined;
    }

    return { connectionId };
  }

  async touchConnection(
    _input: Parameters<AcpHttpBackend["touchConnection"]>[0],
  ): ReturnType<AcpHttpBackend["touchConnection"]> {}

  async acceptClientMethodMessage({
    connectionId,
    message,
    route,
    responseRoute,
  }: Parameters<AcpHttpBackend["acceptClientMethodMessage"]>[0]): ReturnType<
    AcpHttpBackend["acceptClientMethodMessage"]
  > {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      return unknownConnectionResult();
    }

    if (route !== "connection") {
      connection.ensureSession(route.session);
    }

    const key = "id" in message ? messageIdKey(message.id) : undefined;
    if (key) {
      connection.trackPendingResponseRoute(key, responseRoute);
    }

    await connection.writeInbound(message);
    return { ok: true };
  }

  async acceptClientResponse({
    connectionId,
    message,
    headerSessionId,
  }: Parameters<AcpHttpBackend["acceptClientResponse"]>[0]): ReturnType<
    AcpHttpBackend["acceptClientResponse"]
  > {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      return unknownConnectionResult();
    }

    const key = messageIdKey(message.id);
    const route = key ? connection.clientResponseRoute(key) : undefined;

    if (route && route !== "connection" && !headerSessionId) {
      return {
        ok: false,
        status: 400,
        message: "Missing Acp-Session-Id",
      };
    }

    if (route && route !== "connection" && headerSessionId !== route.session) {
      return {
        ok: false,
        status: 400,
        message: "Mismatched Acp-Session-Id",
      };
    }

    if (key) {
      connection.clearClientResponseRoute(key);
    }

    await connection.writeInbound(message);
    return { ok: true };
  }

  async openConnectionStream({
    connectionId,
  }: Parameters<AcpHttpBackend["openConnectionStream"]>[0]): ReturnType<
    AcpHttpBackend["openConnectionStream"]
  > {
    return this.connections.get(connectionId)?.connectionStream.subscribe();
  }

  async openSessionStream({
    connectionId,
    sessionId,
  }: Parameters<AcpHttpBackend["openSessionStream"]>[0]): ReturnType<
    AcpHttpBackend["openSessionStream"]
  > {
    return this.connections
      .get(connectionId)
      ?.ensureSession(sessionId)
      .subscribe();
  }

  async closeConnection({
    connectionId,
  }: Parameters<AcpHttpBackend["closeConnection"]>[0]): ReturnType<
    AcpHttpBackend["closeConnection"]
  > {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      return false;
    }

    this.connections.delete(connectionId);
    void connection.shutdown();
    return true;
  }

  async close(): Promise<void> {
    const connections = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.shutdown()));
  }
}

class FakeDistributedConnection {
  readonly connectionId = globalThis.crypto.randomUUID();
  readonly connectionStream = new OutboundStream();

  private readonly inboundTx: WritableStream<AnyMessage>;
  private readonly outboundRx: ReadableStream<AnyMessage>;
  private readonly sessionStreams = new Map<string, OutboundStream>();
  private readonly pendingRoutes = new Map<string, ResponseRoute>();
  private readonly clientResponseRoutes = new Map<string, ResponseRoute>();
  private inboundWriteChain: Promise<void> = Promise.resolve();
  private initialReader: ReadableStreamDefaultReader<AnyMessage> | undefined;
  private outboundReader: ReadableStreamDefaultReader<AnyMessage> | undefined;
  private hasStartedRouter = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    agent: AgentConnector,
    requestIdGenerator?: JsonRpcRequestIdGenerator,
  ) {
    const inbound = new TransformStream<AnyMessage, AnyMessage>();
    const outbound = new TransformStream<AnyMessage, AnyMessage>();
    this.inboundTx = inbound.writable;
    this.outboundRx = outbound.readable;

    const stream: Stream = {
      readable: inbound.readable,
      writable: outbound.writable,
    };

    agent.connect(stream, { requestIdGenerator });
  }

  async recvInitial(initializeId: string | number): Promise<AnyResponse> {
    const reader = this.outboundRx.getReader();
    this.initialReader = reader;

    try {
      const result = await reader.read();

      if (
        result.done ||
        !result.value ||
        !isMatchingResponse(result.value, initializeId)
      ) {
        if (!this.shutdownPromise) {
          await this.shutdown();
        }

        throw new Error("Expected initialize response from agent");
      }

      return result.value;
    } finally {
      if (this.initialReader === reader) {
        this.initialReader = undefined;
      }

      reader.releaseLock();
    }
  }

  async writeInbound(message: AnyMessage): Promise<void> {
    const write = this.inboundWriteChain.then(() =>
      this.writeInboundMessage(message),
    );
    this.inboundWriteChain = write.catch(() => undefined);
    await write;
  }

  startRouter(): void {
    if (this.hasStartedRouter) {
      return;
    }

    this.hasStartedRouter = true;
    void this.runRouter();
  }

  ensureSession(sessionId: string): OutboundStream {
    const existing = this.sessionStreams.get(sessionId);
    if (existing) {
      return existing;
    }

    const stream = new OutboundStream();
    this.sessionStreams.set(sessionId, stream);

    return stream;
  }

  trackPendingResponseRoute(key: string, route: ResponseRoute): void {
    this.pendingRoutes.set(key, route);
  }

  clientResponseRoute(key: string): ResponseRoute | undefined {
    return this.clientResponseRoutes.get(key);
  }

  clearClientResponseRoute(key: string): void {
    this.clientResponseRoutes.delete(key);
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown();
    }

    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.connectionStream.close();

    for (const stream of this.sessionStreams.values()) {
      stream.close();
    }

    this.sessionStreams.clear();
    this.pendingRoutes.clear();
    this.clientResponseRoutes.clear();

    await Promise.allSettled([
      this.inboundTx.close(),
      this.cancelOutboundReader(),
    ]);
  }

  private cancelOutboundReader(): Promise<void> {
    const reader = this.initialReader ?? this.outboundReader;
    if (reader) {
      return reader.cancel();
    }

    return this.outboundRx.cancel();
  }

  private async writeInboundMessage(message: AnyMessage): Promise<void> {
    const writer = this.inboundTx.getWriter();

    try {
      await writer.write(message);
    } finally {
      writer.releaseLock();
    }
  }

  private async runRouter(): Promise<void> {
    const reader = this.outboundRx.getReader();
    this.outboundReader = reader;

    try {
      while (true) {
        const result = await reader.read();

        if (result.done) {
          return;
        }

        this.routeOutbound(result.value);
      }
    } catch (error) {
      console.error("Fake distributed ACP router stopped unexpectedly:", error);
    } finally {
      if (this.outboundReader === reader) {
        this.outboundReader = undefined;
      }

      reader.releaseLock();
      this.connectionStream.close();

      for (const stream of this.sessionStreams.values()) {
        stream.close();
      }
    }
  }

  private routeOutbound(message: AnyMessage): void {
    if (isResponseMessage(message)) {
      this.routeOutboundResponse(message);
      return;
    }

    this.routeOutboundRequestOrNotification(message);
  }

  private routeOutboundResponse(message: AnyResponse): void {
    const key = messageIdKey(message.id);
    const route = key ? this.pendingRoutes.get(key) : undefined;
    const sessionId = sessionIdFromResponseResult(message);

    if (sessionId) {
      this.ensureSession(sessionId);
    }

    if (key) {
      this.pendingRoutes.delete(key);
    }

    this.pushToRoute(route ?? "connection", message);
  }

  private routeOutboundRequestOrNotification(message: AnyMessage): void {
    const sessionId = sessionIdFromMessageParams(message);
    if (sessionId) {
      this.trackClientResponseRoute(message, { session: sessionId });
      this.ensureSession(sessionId).push(message);
      return;
    }

    this.trackClientResponseRoute(message, "connection");
    this.connectionStream.push(message);
  }

  private trackClientResponseRoute(
    message: AnyMessage,
    route: ResponseRoute,
  ): void {
    if (!("id" in message) || !("method" in message)) {
      return;
    }

    const key = messageIdKey(message.id);
    if (key) {
      this.clientResponseRoutes.set(key, route);
    }
  }

  private pushToRoute(route: ResponseRoute, message: AnyMessage): void {
    if (route === "connection") {
      this.connectionStream.push(message);
      return;
    }

    this.ensureSession(route.session).push(message);
  }
}

function unknownConnectionResult() {
  return {
    ok: false as const,
    status: 404,
    message: "Unknown Acp-Connection-Id",
  };
}

function isMatchingResponse(
  msg: AnyMessage,
  id: string | number,
): msg is AnyResponse {
  return "id" in msg && !("method" in msg) && msg.id === id;
}

function createInteractiveAgent(): AgentApp {
  return createAgentApp({ name: "http-backend-conformance-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.prompt, async (c) => {
      await c.client.notify(methods.client.session.update, {
        sessionId: c.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "before-permission",
          },
        },
      });

      const permission = await c.client.request(
        methods.client.session.requestPermission,
        {
          sessionId: c.params.sessionId,
          toolCall: {
            toolCallId: "permission-tool",
            title: "Permission tool",
          },
          options: [
            {
              kind: "allow_once",
              name: "Allow once",
              optionId: "allow",
            },
            {
              kind: "reject_once",
              name: "Reject once",
              optionId: "reject",
            },
          ],
        },
      );

      if (!isPermissionResponse(permission)) {
        throw new Error("Expected permission response");
      }

      await c.client.notify(methods.client.session.update, {
        sessionId: c.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              permission.outcome.outcome === "selected"
                ? `permission-selected-${permission.outcome.optionId}`
                : "permission-cancelled",
          },
        },
      });

      const elicitation = await c.client.request(
        methods.client.elicitation.create,
        {
          sessionId: c.params.sessionId,
          mode: "form",
          message: "Name",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      );

      if (!isAcceptedElicitation(elicitation)) {
        throw new Error("Expected accepted elicitation response");
      }

      await c.client.notify(methods.client.elicitation.complete, {
        elicitationId: "elicitation-1",
      });
      await c.client.notify(methods.client.session.update, {
        sessionId: c.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `elicitation-accept-${String(elicitation.content["name"])}`,
          },
        },
      });

      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {});
}

async function initialize(harness: HttpBackendHarness): Promise<string> {
  const response = await postJson(harness, "initialize", initializeRequest);
  const connectionId = response.headers.get(HEADER_CONNECTION_ID);

  expect(response.status).toBe(200);
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

  return connectionId ?? "";
}

async function createSession(
  harness: HttpBackendHarness,
  connectionId: string,
): Promise<string> {
  const response = await openConnectionSse(harness, connectionId);
  const events = createSseMessageIterator(response);

  try {
    expect(
      await postJson(harness, "post", sessionNewRequest, {
        [HEADER_CONNECTION_ID]: connectionId,
      }),
    ).toMatchObject({ status: 202 });

    return readSessionId(await readNextSseMessage(events));
  } finally {
    await events.return?.();
    await response.body?.cancel();
  }
}

function openConnectionSse(
  harness: HttpBackendHarness,
  connectionId: string,
): Promise<Response> {
  return harness.handle(
    "connectionSse",
    new Request("http://example.test/acp", {
      method: "GET",
      headers: {
        Accept: EVENT_STREAM_MIME_TYPE,
        [HEADER_CONNECTION_ID]: connectionId,
      },
    }),
  );
}

function openSessionSse(
  harness: HttpBackendHarness,
  connectionId: string,
  sessionId: string,
): Promise<Response> {
  return harness.handle(
    "sessionSse",
    new Request("http://example.test/acp", {
      method: "GET",
      headers: {
        Accept: EVENT_STREAM_MIME_TYPE,
        [HEADER_CONNECTION_ID]: connectionId,
        [HEADER_SESSION_ID]: sessionId,
      },
    }),
  );
}

function postJson(
  harness: HttpBackendHarness,
  role: HarnessRole,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return harness.handle(
    role,
    new Request("http://example.test/acp", {
      method: "POST",
      headers: {
        "Content-Type": JSON_MIME_TYPE,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function createSseMessageIterator(
  response: Response,
): AsyncIterator<AnyMessage> {
  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  return parseSseStream(response.body)[Symbol.asyncIterator]();
}

async function readNextSseMessage(
  iterator: AsyncIterator<AnyMessage>,
): Promise<AnyMessage> {
  const result = await iterator.next();

  if (result.done) {
    throw new Error("Expected SSE message");
  }

  return result.value;
}

async function readSseIteratorMessages(
  iterator: AsyncIterator<AnyMessage>,
  count: number,
): Promise<AnyMessage[]> {
  const messages: AnyMessage[] = [];

  for (const __unused of Array.from({ length: count })) {
    void __unused;
    messages.push(await readNextSseMessage(iterator));
  }

  return messages;
}

async function readSseMessages(
  response: Response,
  count: number,
): Promise<AnyMessage[]> {
  const iterator = createSseMessageIterator(response);

  try {
    return await readSseIteratorMessages(iterator, count);
  } finally {
    await iterator.return?.();
    await response.body?.cancel();
  }
}

function readSessionId(message: AnyMessage): string {
  if (!("result" in message) || !isRecord(message.result)) {
    throw new Error("Expected session/new response result");
  }

  const sessionId = message.result["sessionId"];

  if (typeof sessionId !== "string") {
    throw new Error("Expected session ID");
  }

  return sessionId;
}

function readMessageId(message: AnyMessage): string | number | null {
  if (!("id" in message)) {
    throw new Error("Expected message ID");
  }

  return message.id;
}

function isPermissionResponse(value: unknown): value is {
  readonly outcome:
    | { readonly outcome: "cancelled" }
    | { readonly outcome: "selected"; readonly optionId: string };
} {
  if (!isRecord(value) || !isRecord(value["outcome"])) {
    return false;
  }

  const outcome = value["outcome"];
  return (
    outcome["outcome"] === "cancelled" || outcome["outcome"] === "selected"
  );
}

function isAcceptedElicitation(value: unknown): value is {
  readonly action: "accept";
  readonly content: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    value["action"] === "accept" &&
    isRecord(value["content"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
