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
 *
 * Both paths name the ACP session and tool call each MCP request is for. The
 * direct call passes them as options. The bridge asks its `attribution`
 * resolver, because an MCP HTTP request does not carry them.
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

// The backend names each tool use with an ID of its own, and its MCP client
// sends that ID in the `_meta` of `tools/call`. An adapter learns the same ID
// before the tool runs (Claude Code reports it in a pre-tool-use hook) and
// records which ACP session and tool call it belongs to.
const TOOL_USE_ID = "example.com/toolUseId";
const backendToolUses = new Map<
  string,
  { sessionId: string; toolCallId: string }
>();

const httpBridge = new McpOverAcpHttpBridge(mcpCaller, {
  // Return undefined for a request that cannot be matched, such as the
  // backend's `tools/list`. Never guess from the order of requests.
  attribution: ({ params }) => {
    const meta = params?._meta as Record<string, unknown> | undefined;
    const toolUseId = meta?.[TOOL_USE_ID];
    return typeof toolUseId === "string"
      ? backendToolUses.get(toolUseId)
      : undefined;
  },
});

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

      // Reports a tool call to the client, and returns the function that
      // marks it completed.
      const reportToolCall = async (title: string) => {
        const toolCallId = `call-${globalThis.crypto.randomUUID()}`;
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            status: "in_progress",
          },
        });
        const complete = () =>
          client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "completed",
            },
          });
        return { toolCallId, complete };
      };

      // Path 1: call a tool directly over ACP.
      for (const server of session.acpServers) {
        // Report the tool call before sending the request that names it.
        const toolCall = await reportToolCall(`${server.name}/word_count`);
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
            // Name the session and tool call this request is for. A client
            // can need the session to run the tool, and can reject a request
            // without it. With the tool call it can show the tool's own
            // output where the user sees that call.
            sessionId: params.sessionId,
            toolCallId: toolCall.toolCallId,
            onNotification: (notification) =>
              log("progress:", notification.params),
          },
        );
        await toolCall.complete();
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
        // Record the tool use before the backend runs the tool, so the
        // bridge's resolver can match the request it causes.
        const toolUseId = `toolu-${globalThis.crypto.randomUUID()}`;
        const toolCall = await reportToolCall(`${server.name}/echo`);
        backendToolUses.set(toolUseId, {
          sessionId: params.sessionId,
          toolCallId: toolCall.toolCallId,
        });
        const result = await backend.callTool({
          name: "echo",
          arguments: { message: "hello from the backend" },
          _meta: { [TOOL_USE_ID]: toolUseId },
        });
        backendToolUses.delete(toolUseId);
        await toolCall.complete();
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
