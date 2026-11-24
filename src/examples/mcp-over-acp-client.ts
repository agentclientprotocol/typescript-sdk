#!/usr/bin/env node
/**
 * MCP-over-ACP, client side: an editor-like client that provides MCP tools
 * over its ACP connection to an agent running in a separate process.
 *
 * Run with `npx tsx src/examples/mcp-over-acp-client.ts`; it spawns
 * `mcp-over-acp-agent.ts` and talks to it over stdio.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import * as acp from "../v1/unstable/acp.js";
import { fromMcpServer } from "../mcp/mcp-server.js";

// 1. Define tools with the official MCP SDK. The factory runs once per MCP
//    request, so keep shared state (caches, connections) outside it. Its
//    second argument names the ACP session and tool call the request is for,
//    when the agent sent them.
const projectTools = fromMcpServer((_ctx, attribution) => {
  const server = new McpServer({ name: "project-tools", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message back",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }) => {
      // This tool runs without a session, so it only reads what was sent.
      console.log(
        `[client] echo for session ${attribution.sessionId ?? "(none)"}, ` +
          `tool call ${attribution.toolCallId ?? "(none)"}`,
      );
      return { content: [{ type: "text", text: message }] };
    },
  );
  server.registerTool(
    "word_count",
    {
      description: "Count the words in some text",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }, ctx) => {
      // This tool needs the session. A request that names none is rejected
      // with ACP `-32602` before the tool does any work.
      const sessionId = attribution.requireSession();
      console.log(
        `[client] word_count for session ${sessionId}, ` +
          `tool call ${attribution.toolCallId ?? "(none)"}`,
      );
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
    } else if (params.update.sessionUpdate === "tool_call") {
      const { toolCallId, title } = params.update;
      console.log(`[client] tool call ${toolCallId}: ${title}`);
    }
  });

async function main(): Promise<void> {
  // 3. Start the agent in its own process and connect over stdio.
  const agentPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "mcp-over-acp-agent.ts",
  );
  // Use the current Node through the tsx CLI, resolved from this file so it
  // works from any directory. Node does not spawn npx.cmd on Windows without a
  // shell (spawn EINVAL).
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const agentProcess = spawn(process.execPath, [tsxCli, agentPath], {
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
