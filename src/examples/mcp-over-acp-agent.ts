#!/usr/bin/env node
/**
 * MCP-over-ACP, agent side: uses MCP servers that the client provides over
 * the ACP connection. Spawned by `mcp-over-acp-client.ts`; stdout carries
 * ACP, so diagnostics go to stderr.
 *
 * It shows both ways an agent can consume those servers:
 *
 * - Directly: the agent's own code sends MCP requests with
 *   `McpOverAcpCaller`.
 * - Through a backend: adapters for Claude Code or Codex hand MCP servers to
 *   a separate MCP client that only accepts URLs. `McpOverAcpHttpBridge`
 *   turns each `acp` server into a loopback HTTP endpoint for it; here the
 *   official MCP client stands in for that backend.
 */
import { Readable, Writable } from "node:stream";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as acp from "../v1/unstable/acp.js";
import { McpOverAcpHttpBridge } from "../mcp/http.js";
import type { McpServerHttpDeclaration } from "../mcp/http.js";

const log = (...args: unknown[]) => console.error("[agent]", ...args);

const mcpCaller = new acp.McpOverAcpCaller({
  clientInfo: { name: "mcp-over-acp-agent", version: "1.0.0" },
});
const httpBridge = new McpOverAcpHttpBridge(mcpCaller);

type Session = {
  acpServers: acp.McpServerAcpDeclaration[];
  /** The same servers as the backend would see them. */
  backendServers: unknown[];
};
const sessions = new Map<string, Session>();

acp
  .agent({ name: "mcp-over-acp-agent" })
  // Required so progress and subscription events reach their requests.
  .onNotification(acp.methods.agent.mcp.message, mcpCaller.handleNotification)
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true, acp: true } },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    const sessionId = globalThis.crypto.randomUUID();
    sessions.set(sessionId, {
      acpServers: params.mcpServers.filter(acp.isMcpServerAcp),
      // `acp` entries become loopback `http` ones; others pass through.
      backendServers: await httpBridge.adaptServers(client, params.mcpServers),
    });
    return { sessionId };
  })
  .onRequest(
    acp.methods.agent.session.prompt,
    async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session)
        throw acp.RequestError.invalidParams({ sessionId: params.sessionId });
      const say = (text: string) =>
        client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

      // Path 1: call a tool directly over ACP.
      for (const server of session.acpServers) {
        const outcome = await mcpCaller.request(
          client,
          server.serverId,
          "tools/call",
          {
            name: "word_count",
            arguments: { text: "MCP over the ACP connection" },
            _meta: { progressToken: "count-1" },
          },
          {
            signal,
            onNotification: (notification) =>
              log("progress:", notification.params),
          },
        );
        await say(`direct ${server.name}/word_count -> ${textOf(outcome)}`);
      }

      // Path 2: let a URL-only MCP client (the "backend") use the servers.
      for (const server of session.backendServers) {
        if (!isHttp(server)) continue;
        log("backend connecting to", server.url);
        const backend = new Client(
          { name: "backend", version: "1.0.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await backend.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: {
              headers: Object.fromEntries(
                server.headers.map((h) => [h.name, h.value]),
              ),
            },
          }),
        );
        const { tools } = await backend.listTools();
        const result = await backend.callTool({
          name: "echo",
          arguments: { message: "hello from the backend" },
        });
        await say(
          `backend saw [${tools.map((t) => t.name).join(", ")}]; ` +
            `echo -> ${JSON.stringify(result.content)}`,
        );
        await backend.close();
      }

      return { stopReason: "end_turn" };
    },
  )
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );

function textOf(outcome: acp.McpOutcome): string {
  if ("error" in outcome) return `MCP error ${outcome.error.code}`;
  const { content } = outcome.result as { content: Array<{ text?: string }> };
  return content.map((c) => c.text).join("");
}

function isHttp(server: unknown): server is McpServerHttpDeclaration {
  return (server as { type?: unknown }).type === "http";
}
