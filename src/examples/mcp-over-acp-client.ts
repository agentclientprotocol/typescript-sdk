#!/usr/bin/env node
/**
 * MCP-over-ACP, client side: an editor-like client that provides MCP tools
 * over its ACP connection to an agent running in a separate process.
 *
 * Run with `npx tsx src/examples/mcp-over-acp-client.ts`; it spawns
 * `mcp-over-acp-agent.ts` and talks to it over stdio.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import * as acp from "../v1/unstable/acp.js";
import { fromMcpServer } from "../mcp/mcp-server.js";

// 1. Define tools with the official MCP SDK. The factory runs once per MCP
//    request, so keep shared state (caches, connections) outside it.
const projectTools = fromMcpServer(() => {
  const server = new McpServer({ name: "project-tools", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message back",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
  server.registerTool(
    "word_count",
    {
      description: "Count the words in some text",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 1 },
        });
      }
      const words = text.split(/\s+/).filter(Boolean).length;
      return { content: [{ type: "text", text: String(words) }] };
    },
  );
  return server;
});

// 2. One provider serves every MCP server this client declares. Register its
//    handler for `mcp/message` once, alongside the client's other handlers.
const mcpProvider = new acp.McpOverAcpProvider();

const clientApp = acp
  .client({ name: "mcp-over-acp-client" })
  .onRequest(acp.methods.client.mcp.message, mcpProvider.handleRequest)
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.update.sessionUpdate === "agent_message_chunk") {
      const { content } = params.update;
      console.log(
        `[client] agent: ${content.type === "text" ? content.text : content.type}`,
      );
    }
  });

async function main(): Promise<void> {
  // 3. Start the agent in its own process and connect over stdio.
  const agentPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "mcp-over-acp-agent.ts",
  );
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const agentProcess = spawn(npx, ["tsx", agentPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection = clientApp.connect(
    acp.ndJsonStream(
      Writable.toWeb(agentProcess.stdin!),
      Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>,
    ),
  );
  const { agent } = connection;

  try {
    const init = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    if (!init.agentCapabilities?.mcpCapabilities?.acp) {
      throw new Error("This agent cannot use MCP servers provided over ACP");
    }

    // 4. Register the server on this connection *before* declaring it: the
    //    agent may call tools before `session/new` returns.
    const tools = mcpProvider.registerServer(agent, {
      name: "project-tools",
      handler: projectTools.handler,
    });

    // 5. Declare it like any other MCP server; it travels as
    //    `{ type: "acp", name, serverId }`.
    const session = await agent
      .buildSession(process.cwd())
      .withMcpServer(tools.declaration)
      .start();

    await agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Use your project tools" }],
    });

    session.dispose();
    await tools.dispose();
  } finally {
    connection.close();
    await projectTools.close();
    agentProcess.kill();
  }
}

await main();
