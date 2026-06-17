#!/usr/bin/env node

import * as acp from "../acp.js";
import { MemoryAcpCookieStore, createHttpStream } from "../http-stream.js";

class HttpExampleClient implements acp.Client {
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: "selected",
        optionId: params.options[0]?.optionId ?? "allow",
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      process.stdout.write(
        update.content.type === "text" ? update.content.text : "",
      );
      return;
    }

    console.log(`[${update.sessionUpdate}]`);
  }
}

const serverUrl = process.env.ACP_HTTP_URL ?? "http://127.0.0.1:7331/acp";
const authHeaders = {
  Authorization: "Bearer example-token",
};

// Keep reconnect state outside individual stream instances. Reuse this store
// across fresh streams so an external affinity layer can route reconnects.
const cookieStore = new MemoryAcpCookieStore();
let savedSessionId: string | undefined;

function connect(): {
  readonly stream: acp.Stream;
  readonly connection: acp.ClientSideConnection;
} {
  const stream = createHttpStream(serverUrl, {
    headers: authHeaders,
    cookieStore,
    // Cookies are included by default. Use `cookies: "omit"` for stateless requests.
  });
  const connection = new acp.ClientSideConnection(
    (_agent) => new HttpExampleClient(),
    stream,
  );

  return { stream, connection };
}

const { stream, connection } = connect();

try {
  const initialized = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  savedSessionId = session.sessionId;

  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text: "Hello over Streamable HTTP",
      },
    ],
  });

  console.log(`\nDone: ${result.stopReason}`);

  console.log(
    `Saved session ${savedSessionId}; loadSession=${initialized.agentCapabilities?.loadSession === true}`,
  );

  // Reconnect flow sketch:
  // 1. Save `sessionId`, auth headers, cwd, MCP servers, and `cookieStore`.
  // 2. Create a fresh stream with the same auth headers and cookie store.
  // 3. Call initialize and require `agentCapabilities.loadSession`.
  // 4. Call session/load for the saved session ID.
  // Production agents must authorize session/load for the authenticated user.
  // ACP v1 does not replay in-flight transport messages emitted while disconnected.
  // Example:
  // const next = connect();
  // await next.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  // await next.connection.loadSession({ sessionId: savedSessionId, cwd: process.cwd(), mcpServers: [] });
} finally {
  await stream.writable.close();
}
