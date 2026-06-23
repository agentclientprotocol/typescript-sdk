import { describe, expect, it } from "vitest";

import { ConnectionRegistry, InMemoryAcpHttpBackend } from "./connection.js";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
} from "./protocol.js";
import { AcpServer } from "./server.js";
import { parseSseStream } from "./sse.js";
import { PROTOCOL_VERSION, agent as createAgentApp, methods } from "./acp.js";
import { createTestAgentApp } from "./test-support/test-agent.js";

import type { AgentApp } from "./acp.js";
import type { AnyMessage } from "./jsonrpc.js";

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
      const registry = new ConnectionRegistry();
      const counters = new Map<string, number>();
      const createServer = (nodeId: string): AcpServer =>
        new AcpServer({
          createAgent,
          httpBackend: new InMemoryAcpHttpBackend(registry, () => {
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
