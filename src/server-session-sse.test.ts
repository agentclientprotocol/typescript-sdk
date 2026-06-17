import { describe, expect, it } from "vitest";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
} from "./protocol.js";
import { PROTOCOL_VERSION } from "./schema/index.js";
import { parseSseStream } from "./sse.js";
import { TestAgent } from "./test-support/test-agent.js";
import { startTestServer } from "./test-support/test-http-server.js";

import type {
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
} from "./acp.js";
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

function createPromptRequest(id: string | number | null, sessionId?: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      ...(sessionId === undefined ? {} : { sessionId }),
      prompt: [{ type: "text", text: "Hello" }],
    },
  };
}

function createForkRequest(id: number, sessionId: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/fork",
    params: {
      cwd: "/tmp",
      mcpServers: [],
      sessionId,
    },
  };
}

function createLoadSessionRequest(id: number, sessionId: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/load",
    params: {
      cwd: "/tmp",
      mcpServers: [],
      sessionId,
    },
  };
}

function createCancelNotification(sessionId: string) {
  return {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: {
      sessionId,
    },
  };
}

class LoadSessionAgent extends TestAgent {
  constructor(private readonly agentConnection: AgentSideConnection) {
    super(agentConnection);
  }

  initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    await this.agentConnection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "replayed-session-history",
        },
      },
    });

    return {};
  }
}

describe("AcpServer session SSE", () => {
  it("streams prompt updates and responses on the session SSE stream", async () => {
    const server = await startTestServer(
      (conn: AgentSideConnection) => new TestAgent(conn, { chunkCount: 2 }),
    );

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const sessionSse = await openSessionSse(
        server.url,
        connectionId,
        sessionId,
      );

      expect(sessionSse.status).toBe(200);

      const accepted = await postJson(
        server.url,
        createPromptRequest(3, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );

      expect(accepted.status).toBe(202);
      expect(await readSseMessages(sessionSse, 3)).toMatchObject([
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: "chunk-1",
              },
            },
          },
        },
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: "chunk-2",
              },
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          result: {
            stopReason: "end_turn",
          },
        },
      ]);
      expect(
        await readNextConnectionSseMessage(server.url, connectionId),
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("routes null-ID session request responses to the session SSE stream", async () => {
    const server = await startTestServer(
      (conn: AgentSideConnection) => new TestAgent(conn, { chunkCount: 1 }),
    );

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const sessionSse = await openSessionSse(
        server.url,
        connectionId,
        sessionId,
      );

      const accepted = await postJson(
        server.url,
        createPromptRequest(null, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );

      expect(accepted.status).toBe(202);
      expect(await readSseMessages(sessionSse, 2)).toMatchObject([
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId },
        },
        {
          jsonrpc: "2.0",
          id: null,
          result: {
            stopReason: "end_turn",
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("rejects session-scoped requests without a session header", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const response = await postJson(
        server.url,
        createPromptRequest(3, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
        },
      );

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects session-scoped requests with mismatched session header and params", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const response = await postJson(
        server.url,
        createPromptRequest(3, "other-session"),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects session-scoped notifications without a session header", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const response = await postJson(
        server.url,
        createCancelNotification(sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
        },
      );

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects session-scoped notifications with mismatched session header and params", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const response = await postJson(
        server.url,
        createCancelNotification("other-session"),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects session-scoped requests without any session identifier", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const response = await postJson(server.url, createPromptRequest(3), {
        [HEADER_CONNECTION_ID]: connectionId,
      });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("routes non-required session methods using params.sessionId when the session header is absent", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const response = await postJson(
        server.url,
        createForkRequest(3, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
        },
      );

      expect(response.status).toBe(202);
    } finally {
      await server.close();
    }
  });

  it("routes session/load replay updates to session SSE and final response to connection SSE", async () => {
    const server = await startTestServer(
      (conn: AgentSideConnection) => new LoadSessionAgent(conn),
    );

    try {
      const connectionId = await initialize(server.url);
      const sessionId = "existing-session";
      const connectionSse = await openConnectionSse(server.url, connectionId);
      const sessionSse = await openSessionSse(
        server.url,
        connectionId,
        sessionId,
      );
      const accepted = await postJson(
        server.url,
        createLoadSessionRequest(3, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );

      expect(sessionSse.status).toBe(200);
      expect(accepted.status).toBe(202);
      expect(await readSseMessages(sessionSse, 1)).toMatchObject([
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: "replayed-session-history",
              },
            },
          },
        },
      ]);
      expect(await readSseMessages(connectionSse, 1)).toMatchObject([
        {
          jsonrpc: "2.0",
          id: 3,
          result: {},
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("replays buffered session messages when session SSE attaches after prompt", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const sessionId = await createSession(server.url, connectionId);
      const accepted = await postJson(
        server.url,
        createPromptRequest(3, sessionId),
        {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: sessionId,
        },
      );
      const sessionSse = await openSessionSse(
        server.url,
        connectionId,
        sessionId,
      );

      expect(accepted.status).toBe(202);
      expect(await readSseMessages(sessionSse, 2)).toMatchObject([
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          result: { stopReason: "end_turn" },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("isolates prompt events for multiple sessions on the same connection", async () => {
    const server = await startTestServer();

    try {
      const connectionId = await initialize(server.url);
      const connectionSse = await openConnectionSse(server.url, connectionId);
      const connectionEvents = createSseMessageIterator(connectionSse);
      const firstSessionId = await createSessionFromConnectionEvents(
        server.url,
        connectionId,
        connectionEvents,
      );
      const secondSessionId = await createSessionFromConnectionEvents(
        server.url,
        connectionId,
        connectionEvents,
      );
      const firstSse = await openSessionSse(
        server.url,
        connectionId,
        firstSessionId,
      );
      const secondSse = await openSessionSse(
        server.url,
        connectionId,
        secondSessionId,
      );

      expect(
        await postJson(server.url, createPromptRequest(3, firstSessionId), {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: firstSessionId,
        }),
      ).toMatchObject({ status: 202 });
      expect(
        await postJson(server.url, createPromptRequest(4, secondSessionId), {
          [HEADER_CONNECTION_ID]: connectionId,
          [HEADER_SESSION_ID]: secondSessionId,
        }),
      ).toMatchObject({ status: 202 });

      expect(await readSseMessages(firstSse, 2)).toMatchObject([
        { method: "session/update", params: { sessionId: firstSessionId } },
        { id: 3, result: { stopReason: "end_turn" } },
      ]);
      expect(await readSseMessages(secondSse, 2)).toMatchObject([
        { method: "session/update", params: { sessionId: secondSessionId } },
        { id: 4, result: { stopReason: "end_turn" } },
      ]);
    } finally {
      await server.close();
    }
  });
});

async function initialize(url: string): Promise<string> {
  const response = await postJson(url, initializeRequest);
  const connectionId = response.headers.get(HEADER_CONNECTION_ID);

  expect(response.status).toBe(200);
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);

  return connectionId ?? "";
}

async function createSession(
  url: string,
  connectionId: string,
): Promise<string> {
  return createSessionFromConnectionSse(
    url,
    connectionId,
    await openConnectionSse(url, connectionId),
  );
}

async function createSessionFromConnectionSse(
  url: string,
  connectionId: string,
  response: Response,
): Promise<string> {
  return createSessionFromConnectionEvents(
    url,
    connectionId,
    createSseMessageIterator(response),
  );
}

async function createSessionFromConnectionEvents(
  url: string,
  connectionId: string,
  events: AsyncIterator<AnyMessage>,
): Promise<string> {
  const accepted = await postJson(url, sessionNewRequest, {
    [HEADER_CONNECTION_ID]: connectionId,
  });

  expect(accepted.status).toBe(202);

  return readSessionId(await readNextSseMessage(events));
}

function openConnectionSse(
  url: string,
  connectionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Accept: EVENT_STREAM_MIME_TYPE,
      [HEADER_CONNECTION_ID]: connectionId,
    },
    signal,
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

async function readNextConnectionSseMessage(
  url: string,
  connectionId: string,
): Promise<AnyMessage | undefined> {
  const abort = new AbortController();
  const response = await openConnectionSse(url, connectionId, abort.signal);

  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  const iterator = parseSseStream(response.body)[Symbol.asyncIterator]();

  try {
    const result = await Promise.race([
      iterator.next(),
      delay(50).then(() => ({ done: true, value: undefined })),
    ]);

    return result.done ? undefined : result.value;
  } finally {
    abort.abort();
    await iterator.return?.();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
