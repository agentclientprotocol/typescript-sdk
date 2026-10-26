#!/usr/bin/env node
/**
 * MCP-over-ACP: a client provides MCP tools over its ACP connection, and an
 * agent calls them. Both sides run in this process for illustration; run with
 * `npx tsx src/examples/mcp-over-acp.ts`.
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import * as acp from "../v1/unstable/acp.js";
import { fromMcpServer } from "../mcp/mcp-server.js";

// ---------------------------------------------------------------------------
// Agent: consumes MCP servers declared with `"type": "acp"`.
// ---------------------------------------------------------------------------

const mcpCaller = new acp.McpOverAcpCaller({
  clientInfo: { name: "example-agent", version: "1.0.0" },
});
const sessionServers = new Map<string, acp.McpServerAcpDeclaration[]>();

const agentApp = acp
  .agent({ name: "example-agent" })
  // Delivers progress and other request-scoped MCP notifications.
  .onNotification(acp.methods.agent.mcp.message, mcpCaller.handleNotification)
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { acp: true } },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = globalThis.crypto.randomUUID();
    sessionServers.set(sessionId, params.mcpServers.filter(acp.isMcpServerAcp));
    return { sessionId };
  })
  .onRequest(
    acp.methods.agent.session.prompt,
    async ({ params, client, signal }) => {
      for (const server of sessionServers.get(params.sessionId) ?? []) {
        // A real agent would hand these tools to its model.
        const tools = await mcpCaller.request(
          client,
          server.serverId,
          "tools/list",
          {},
          { signal },
        );
        if ("error" in tools) throw new Error(tools.error.message);

        const call = await mcpCaller.request(
          client,
          server.serverId,
          "tools/call",
          {
            name: "echo",
            arguments: { message: "hello from the agent" },
            _meta: { progressToken: "echo-1" },
          },
          {
            signal,
            onNotification: (notification) =>
              console.log("[agent] notification:", notification),
          },
        );
        const text =
          "error" in call
            ? `MCP error ${call.error.code}: ${call.error.message}`
            : JSON.stringify(call.result);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${server.name}: ${text}` },
          },
        });
      }
      return { stopReason: "end_turn" };
    },
  );

// ---------------------------------------------------------------------------
// Client: provides an MCP server over the same ACP connection.
// ---------------------------------------------------------------------------

const mcpProvider = new acp.McpOverAcpProvider();

const clientApp = acp
  .client({ name: "example-client" })
  // Serves `mcp/message` requests for every server registered below.
  .onRequest(acp.methods.client.mcp.message, mcpProvider.handleRequest)
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.update.sessionUpdate === "agent_message_chunk") {
      console.log("[client] agent says:", params.update.content);
    }
  });

// Tools are defined with the official MCP SDK. `fromMcpServer` serves a fresh
// server instance per request, as MCP 2026-07-28 requires. (Handlers can
// also be written by hand as an `acp.McpRequestHandler`.)
const projectTools = fromMcpServer(() => {
  const server = new McpServer({ name: "project-tools", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message back",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 1 },
        });
      }
      return { content: [{ type: "text", text: message }] };
    },
  );
  return server;
});

async function main(): Promise<void> {
  const connection = clientApp.connect(agentApp);
  const { agent } = connection;

  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  if (!init.agentCapabilities?.mcpCapabilities?.acp) {
    throw new Error("Agent does not support MCP-over-ACP");
  }

  // Register before declaring: the agent may call tools before session/new
  // returns. Register several servers the same way; requests route by ID.
  const server = mcpProvider.registerServer(agent, {
    name: "project-tools",
    handler: projectTools.handler,
  });

  const session = await agent
    .buildSession(process.cwd())
    .withMcpServer(server.declaration)
    .start();
  await agent.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Use your tools" }],
  });

  session.dispose();
  await server.dispose();
  await projectTools.close();
  connection.close();
}

await main();
