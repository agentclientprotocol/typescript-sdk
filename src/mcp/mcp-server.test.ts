import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import {
  McpOverAcpCaller,
  McpOverAcpProvider,
  RequestError,
  agent as createAgent,
  client as createClient,
  methods,
  ndJsonStream,
} from "../v1/unstable/acp.js";
import type {
  AgentConnection,
  ClientConnection,
  McpNotification,
  McpRequestOptions,
} from "../v1/unstable/acp.js";
import { fromMcpServer } from "./mcp-server.js";
import type { McpServerAdapter } from "./mcp-server.js";

function buildServer(
  hooks: {
    started?: () => void;
    cancelled?: () => void;
  } = {},
): McpServer {
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
    "progress",
    { inputSchema: z.object({}) },
    async (_args, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2 },
        });
      }
      return { content: [{ type: "text", text: "done" }] };
    },
  );
  server.registerTool(
    "wait",
    { inputSchema: z.object({}) },
    async (_args, ctx) => {
      hooks.started?.();
      await new Promise((resolve) =>
        ctx.mcpReq.signal.addEventListener("abort", resolve, { once: true }),
      );
      hooks.cancelled?.();
      return { content: [] };
    },
  );
  server.registerTool(
    "regional",
    {
      inputSchema: z.object({
        region: z.string().meta({ "x-mcp-header": "Region" }),
      }),
    },
    async ({ region }) => ({ content: [{ type: "text", text: region }] }),
  );
  server.registerTool(
    "size",
    { inputSchema: z.object({ data: z.string() }) },
    async ({ data }) => ({
      content: [{ type: "text", text: String(data.length) }],
    }),
  );
  server.registerTool("fail", { inputSchema: z.object({}) }, async () => {
    throw new Error("tool exploded");
  });
  return server;
}

function setup(adapter: McpServerAdapter) {
  const provider = new McpOverAcpProvider();
  const caller = new McpOverAcpCaller({
    clientInfo: { name: "test-agent", version: "1" },
  });
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agent: AgentConnection = createAgent()
    .onNotification(methods.agent.mcp.message, caller.handleNotification)
    .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
  const client: ClientConnection = createClient()
    .onRequest(methods.client.mcp.message, provider.handleRequest)
    .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));
  const registration = provider.registerServer(client.agent, {
    name: "project-tools",
    handler: adapter.handler,
  });
  return {
    agent,
    client,
    call: (
      method: string,
      params?: Record<string, unknown>,
      options?: McpRequestOptions,
    ) =>
      caller.request(
        agent.client,
        registration.serverId,
        method,
        params,
        options,
      ),
  };
}

describe("fromMcpServer", () => {
  let env: ReturnType<typeof setup> | undefined;
  let adapter: McpServerAdapter | undefined;

  afterEach(async () => {
    env?.agent.close();
    env?.client.close();
    await adapter?.close();
    env = undefined;
    adapter = undefined;
  });

  it("answers discovery without an initialize handshake", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const outcome = await env.call("server/discover");
    expect(outcome).toMatchObject({
      result: {
        supportedVersions: expect.arrayContaining(["2026-07-28"]),
        capabilities: { tools: expect.any(Object) },
      },
    });
  });

  it("lists and calls registered tools", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);

    const list = await env.call("tools/list");
    expect("result" in list && list.result).toMatchObject({
      resultType: "complete",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "echo" }),
      ]),
    });

    const call = await env.call("tools/call", {
      name: "echo",
      arguments: { message: "héllo over ACP" },
    });
    expect(call).toMatchObject({
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "héllo over ACP" }],
      },
    });
  });

  it("reports tool failures as tool results, not protocol errors", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const call = await env.call("tools/call", { name: "fail", arguments: {} });
    expect(call).toMatchObject({
      result: {
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("tool exploded") },
        ],
      },
    });
  });

  it("returns inner MCP errors for invalid requests", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const outcome = await env.call("resources/list");
    expect("error" in outcome && outcome.error.code).toBe(-32601);
  });

  it("calls tools whose schemas declare x-mcp-header annotations", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const list = await env.call("tools/list");
    const regional = (
      "result" in list
        ? (
            list.result as {
              tools: Array<{ name: string; inputSchema: unknown }>;
            }
          ).tools
        : []
    ).find((tool) => tool.name === "regional");
    // Native ACP passes descriptors through unchanged.
    expect(JSON.stringify(regional?.inputSchema)).toContain("x-mcp-header");

    const call = await env.call("tools/call", {
      name: "regional",
      arguments: { region: "eu-wést" },
    });
    expect(call).toMatchObject({
      result: { content: [{ type: "text", text: "eu-wést" }] },
    });
  });

  it("accepts arguments beyond the SDK's HTTP body limit", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const data = "x".repeat(5 * 1024 * 1024);
    const call = await env.call("tools/call", {
      name: "size",
      arguments: { data },
    });
    expect(call).toMatchObject({
      result: { content: [{ type: "text", text: String(data.length) }] },
    });
  });

  it("answers methods that cannot be mirrored as headers", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const outcome = await env.call("tools/列表");
    expect("error" in outcome && outcome.error.code).toBe(-32601);
  });

  it("forwards progress notifications to the caller", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const notifications: McpNotification[] = [];
    const call = await env.call(
      "tools/call",
      { name: "progress", arguments: {}, _meta: { progressToken: "p-1" } },
      { onNotification: (n) => notifications.push(n) },
    );
    expect(call).toMatchObject({ result: { resultType: "complete" } });
    expect(notifications).toEqual([
      {
        method: "notifications/progress",
        params: { progressToken: "p-1", progress: 1, total: 2 },
      },
    ]);
  });

  it("cancels the tool when the caller cancels", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    adapter = fromMcpServer(() =>
      buildServer({
        started: () => started.resolve(),
        cancelled: () => cancelled.resolve(),
      }),
    );
    env = setup(adapter);
    const controller = new AbortController();
    const pending = env.call(
      "tools/call",
      { name: "wait", arguments: {} },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await cancelled.promise;
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).code).toBe(-32800);
  });

  it("serves subscriptions and publishes change events", async () => {
    adapter = fromMcpServer(() => buildServer());
    env = setup(adapter);
    const notifications: McpNotification[] = [];
    const controller = new AbortController();
    const acknowledged = Promise.withResolvers<void>();
    const changed = Promise.withResolvers<void>();
    const listen = env
      .call(
        "subscriptions/listen",
        { notifications: { toolsListChanged: true } },
        {
          signal: controller.signal,
          onNotification: (n) => {
            notifications.push(n);
            if (n.method === "notifications/subscriptions/acknowledged") {
              acknowledged.resolve();
            }
            if (n.method === "notifications/tools/list_changed") {
              changed.resolve();
            }
          },
        },
      )
      .catch((e: unknown) => e);

    await acknowledged.promise;
    adapter.notify.toolsChanged();
    await changed.promise;
    controller.abort();
    await listen;

    expect(notifications.map((n) => n.method)).toEqual([
      "notifications/subscriptions/acknowledged",
      "notifications/tools/list_changed",
    ]);
  });
});
