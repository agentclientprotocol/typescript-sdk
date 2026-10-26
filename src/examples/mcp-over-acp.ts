#!/usr/bin/env node
/**
 * MCP-over-ACP: a client provides MCP tools over its ACP connection, and an
 * agent calls them. Both sides run in this process for illustration; run with
 * `npx tsx src/examples/mcp-over-acp.ts`.
 */
import * as acp from "../v1/unstable/acp.js";

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

const projectTools: acp.McpRequestHandler = async (cx) => {
  switch (cx.method) {
    case "tools/list":
      return {
        result: {
          // MCP 2026-07-28 list results carry completion and cache metadata.
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          tools: [
            {
              name: "echo",
              description: "Echo a message back",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          ],
        },
      };
    case "tools/call": {
      const args = (cx.params?.arguments ?? {}) as { message?: string };
      const progressToken = (cx.params?._meta as { progressToken?: unknown })
        ?.progressToken;
      if (progressToken !== undefined) {
        await cx.notify("notifications/progress", {
          progressToken,
          progress: 1,
          total: 1,
        });
      }
      return {
        result: {
          resultType: "complete",
          content: [{ type: "text", text: args.message ?? "" }],
          isError: false,
        },
      };
    }
    default:
      // Inner MCP errors go back to the agent as `{ error }`, not ACP errors.
      throw new acp.McpProtocolError(-32601, `Method not found: ${cx.method}`);
  }
};

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
    handler: projectTools,
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
  connection.close();
}

await main();
