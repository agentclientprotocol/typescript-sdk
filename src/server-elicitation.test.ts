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
    sessionId: "elicitation-session",
    prompt: [{ type: "text", text: "Start" }],
  },
};

describe("AcpServer elicitation requests over HTTP", () => {
  it("routes elicitation requests through the HTTP backend with injected request IDs", async () => {
    let nextRequestId = 0;
    const server = new AcpServer({
      createAgent: () => createElicitationAgent(),
      httpBackend: new InMemoryAcpHttpBackend(
        new ConnectionRegistry(),
        () => `elicitation-${nextRequestId++}`,
      ),
    });

    try {
      const connectionId = await initialize(server);
      const sessionId = await createSession(server, connectionId);
      const connectionSse = await openConnectionSse(server, connectionId);
      const connectionEvents = createSseMessageIterator(connectionSse);
      const sessionSse = await openSessionSse(server, connectionId, sessionId);
      const sessionEvents = createSseMessageIterator(sessionSse);

      expect(
        await postJson(server, promptRequest, {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        }),
      ).toMatchObject({ status: 202 });

      const elicitationRequest = await readNextSseMessage(sessionEvents);
      expect(elicitationRequest).toMatchObject({
        jsonrpc: "2.0",
        id: "elicitation-0",
        method: "elicitation/create",
        params: {
          sessionId,
          mode: "form",
          message: "Please enter your name",
        },
      });

      expect(
        await postJson(
          server,
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
      expect(await readNextSseMessage(sessionEvents)).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: { stopReason: "end_turn" },
      });

      await connectionEvents.return?.();
      await sessionEvents.return?.();
      await connectionSse.body?.cancel();
      await sessionSse.body?.cancel();
    } finally {
      await server.close();
    }
  });
});

function createElicitationAgent(): AgentApp {
  return createAgentApp({ name: "elicitation-http-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: "elicitation-session",
    }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.prompt, async (c) => {
      const elicitation = await c.client.request(
        methods.client.elicitation.create,
        {
          sessionId: c.params.sessionId,
          mode: "form",
          message: "Please enter your name",
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

      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {});
}

async function initialize(server: AcpServer): Promise<string> {
  const response = await postJson(server, initializeRequest);
  const connectionId = response.headers.get(HEADER_CONNECTION_ID);

  expect(response.status).toBe(200);
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

  return connectionId ?? "";
}

async function createSession(
  server: AcpServer,
  connectionId: string,
): Promise<string> {
  const response = await openConnectionSse(server, connectionId);
  const events = createSseMessageIterator(response);

  try {
    expect(
      await postJson(server, sessionNewRequest, {
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
  server: AcpServer,
  connectionId: string,
): Promise<Response> {
  return server.handleRequest(
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
  server: AcpServer,
  connectionId: string,
  sessionId: string,
): Promise<Response> {
  return server.handleRequest(
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
  server: AcpServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return server.handleRequest(
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
