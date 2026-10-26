import { afterEach, describe, expect, it } from "vitest";
import * as v1Schema from "../v1/unstable/schema/index.js";
import * as v2Schema from "../v2/unstable/schema/index.js";
import {
  CLIENT_METHODS,
  MCP_MESSAGE_METHOD,
  McpBindingErrorCode,
  McpProtocolError,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  RequestError,
  agent as createAgent,
  client as createClient,
  McpOverAcpCaller,
  McpOverAcpProvider,
  methods,
  ndJsonStream,
} from "../v1/unstable/acp.js";
import type {
  AgentConnection,
  ClientConnection,
  McpOutcome,
  McpOperationContext,
  McpRequestOptions,
  McpServerOptions,
} from "../v1/unstable/acp.js";

function connectPair() {
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
  return {
    agent,
    client,
    register: (options: McpServerOptions) =>
      provider.registerServer(client.agent, options),
    call: (
      serverId: string,
      method: string,
      params?: Record<string, unknown> | null,
      options?: McpRequestOptions,
    ) => caller.request(agent.client, serverId, method, params, options),
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function expectOuterError(
  promise: Promise<unknown>,
  code: number,
): Promise<RequestError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).code).toBe(code);
  return error as RequestError;
}

const validMeta = {
  [MCP_META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
  [MCP_META_CLIENT_CAPABILITIES]: {},
};

describe("MCP-over-ACP", () => {
  let connections: ReturnType<typeof connectPair>;

  afterEach(() => {
    connections?.agent.close();
    connections?.client.close();
  });

  it("round-trips a request with per-request metadata", async () => {
    connections = connectPair();
    const seen: McpOperationContext[] = [];
    const server = connections.register({
      name: "project-tools",
      handler: (cx) => {
        seen.push(cx);
        return {
          result: {
            resultType: "complete",
            content: [{ type: "text", text: String(cx.params?.name) }],
          },
        };
      },
    });
    expect(server.declaration).toEqual({
      type: "acp",
      name: "project-tools",
      serverId: server.serverId,
    });

    const outcome = await connections.call(
      server.serverId,
      "tools/call",
      { name: "echo", arguments: {} },
      { requestId: "logical-1" },
    );

    expect(outcome).toEqual({
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "echo" }],
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      serverId: server.serverId,
      requestId: "logical-1",
      method: "tools/call",
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test-agent", version: "1" },
    });
    expect(seen[0]!.params?._meta).toMatchObject({
      [MCP_META_CLIENT_INFO]: { name: "test-agent", version: "1" },
    });
  });

  it("dispatches to several servers on one connection", async () => {
    connections = connectPair();
    const tools = connections.register({
      name: "tools",
      handler: () => ({ result: "tools" }),
    });
    const docs = connections.register({
      name: "docs",
      handler: () => ({ result: "docs" }),
    });

    await expect(
      connections.call(tools.serverId, "tools/list"),
    ).resolves.toEqual({ result: "tools" });
    await expect(
      connections.call(docs.serverId, "tools/list"),
    ).resolves.toEqual({ result: "docs" });
    await tools.dispose();
    await expect(
      connections.call(docs.serverId, "tools/list"),
    ).resolves.toEqual({ result: "docs" });
  });

  it("returns inner MCP errors without treating them as ACP errors", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "errors",
      handler: () => {
        // -32000 collides with ACP's auth-required code on purpose.
        throw new McpProtocolError(-32000, "server error", null);
      },
    });

    const outcome = await connections.call(server.serverId, "tools/call", {
      name: "x",
    });

    expect(outcome).toEqual({
      error: { code: -32000, message: "server error", data: null },
    });
  });

  it("routes request-scoped notifications and drops late ones", async () => {
    connections = connectPair();
    const finish = deferred();
    let lateNotify: McpOperationContext["notify"] | undefined;
    const server = connections.register({
      name: "progress",
      handler: async (cx) => {
        lateNotify = cx.notify;
        await cx.notify("notifications/progress", { progress: 1 });
        await finish.promise;
        return { result: {} };
      },
    });

    const received: unknown[] = [];
    const pending = connections.call(
      server.serverId,
      "tools/call",
      { name: "slow" },
      {
        onNotification: (notification) => {
          received.push(notification);
          finish.resolve();
        },
      },
    );

    await expect(pending).resolves.toEqual({ result: {} });
    expect(received).toEqual([
      { method: "notifications/progress", params: { progress: 1 } },
    ]);

    await lateNotify!("notifications/progress", { progress: 2 });
    expect(received).toHaveLength(1);
  });

  it("reports unknown and disposed servers as unavailable", async () => {
    connections = connectPair();
    connections.register({ name: "other", handler: () => ({ result: {} }) });

    await expectOuterError(
      connections.call("missing", "tools/list"),
      McpBindingErrorCode.serverUnavailable,
    );

    const server = connections.register({
      name: "gone",
      handler: () => ({ result: {} }),
    });
    await server.dispose();
    await expectOuterError(
      connections.call(server.serverId, "tools/list"),
      McpBindingErrorCode.serverUnavailable,
    );
    expect(() =>
      connections.register({
        name: "gone",
        serverId: server.serverId,
        handler: () => ({ result: {} }),
      }),
    ).toThrow(/already registered/);
  });

  it("rejects duplicate active request IDs", async () => {
    connections = connectPair();
    const finish = deferred();
    const started = deferred();
    const server = connections.register({
      name: "dupes",
      handler: async () => {
        started.resolve();
        await finish.promise;
        return { result: {} };
      },
    });
    const first = connections.call(server.serverId, "tools/call", null, {
      requestId: "same",
    });
    await started.promise;

    await expect(
      connections.call(server.serverId, "tools/call", null, {
        requestId: "same",
      }),
    ).rejects.toThrow(/already active/);
    await expectOuterError(
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: server.serverId,
        requestId: "same",
        method: "tools/call",
        params: { _meta: validMeta },
      }),
      McpBindingErrorCode.invalidParams,
    );

    finish.resolve();
    await expect(first).resolves.toEqual({ result: {} });
  });

  it("validates the inner MCP protocol version and metadata", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "versions",
      handler: () => ({ result: "unreachable" }),
    });
    const send = (params: Record<string, unknown> | null) =>
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: server.serverId,
        requestId: globalThis.crypto.randomUUID(),
        method: "tools/list",
        params,
      });

    await expect(
      send({
        _meta: { ...validMeta, [MCP_META_PROTOCOL_VERSION]: "2025-11-25" },
      }),
    ).resolves.toEqual({
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [MCP_PROTOCOL_VERSION], requested: "2025-11-25" },
      },
    });
    await expect(send(null)).resolves.toMatchObject({
      error: { code: -32602 },
    });
    await expect(
      send({ _meta: { [MCP_META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION } }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("rejects malformed envelopes", async () => {
    connections = connectPair();
    connections.register({
      name: "s",
      serverId: "s",
      handler: () => ({ result: {} }),
    });
    await expectOuterError(
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: "s",
        requestId: "r",
        method: "tools/list",
        params: [] as unknown as Record<string, unknown>,
      }),
      McpBindingErrorCode.invalidParams,
    );
  });

  it("cancels a running request and waits for the handler", async () => {
    connections = connectPair();
    const started = deferred();
    let cleanedUp = false;
    const server = connections.register({
      name: "cancel",
      handler: async (cx) => {
        started.resolve();
        await new Promise((resolve) =>
          cx.signal.addEventListener("abort", resolve, { once: true }),
        );
        cleanedUp = true;
        throw cx.signal.reason;
      },
    });
    const controller = new AbortController();
    const pending = connections.call(
      server.serverId,
      "subscriptions/listen",
      {},
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();

    await expectOuterError(pending, McpBindingErrorCode.requestCancelled);
    expect(cleanedUp).toBe(true);
  });

  it("cancels active requests when a registration is disposed", async () => {
    connections = connectPair();
    const started = deferred();
    let settled = false;
    const server = connections.register({
      name: "dispose",
      handler: async (cx) => {
        started.resolve();
        await new Promise((resolve) =>
          cx.signal.addEventListener("abort", resolve, { once: true }),
        );
        settled = true;
        throw cx.signal.reason;
      },
    });
    const pending = connections.call(server.serverId, "tools/call");
    await started.promise;

    const rejected = expectOuterError(
      pending,
      McpBindingErrorCode.requestCancelled,
    );
    await server.dispose();
    expect(settled).toBe(true);
    await rejected;
  });

  it("enforces the active request limit", async () => {
    connections = connectPair();
    const finish = deferred();
    const started = deferred();
    const server = connections.register({
      name: "limited",
      maxActiveRequests: 1,
      handler: async () => {
        started.resolve();
        await finish.promise;
        return { result: {} };
      },
    });
    const first = connections.call(server.serverId, "tools/call");
    await started.promise;

    await expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.resourceLimitExceeded,
    );
    finish.resolve();
    await expect(first).resolves.toEqual({ result: {} });
  });

  it("matches the generated method names", () => {
    for (const methods of [
      v1Schema.AGENT_METHODS,
      v1Schema.CLIENT_METHODS,
      v2Schema.AGENT_METHODS,
      v2Schema.CLIENT_METHODS,
    ]) {
      expect(methods.mcp_message).toBe(MCP_MESSAGE_METHOD);
    }
  });

  it("does not let handler ACP errors pose as binding errors", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "nested",
      handler: () => {
        throw new RequestError(
          McpBindingErrorCode.serverUnavailable,
          "nested failure",
        );
      },
    });
    const error = await expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.backendFailed,
    );
    expect(error.data).toMatchObject({
      code: McpBindingErrorCode.serverUnavailable,
    });
  });

  it("allows an explicit null result", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "null",
      handler: () => ({ result: null }),
    });
    await expect(
      connections.call(server.serverId, "tools/call"),
    ).resolves.toEqual({ result: null });
  });

  it.each([
    ["an undefined result", { result: undefined }],
    ["both result and error", { result: 1, error: { code: 1, message: "x" } }],
    ["a non-integer error code", { error: { code: 1.5, message: "x" } }],
  ])("rejects handler outcomes with %s", async (_, outcome) => {
    connections = connectPair();
    const server = connections.register({
      name: "invalid",
      handler: () => outcome as McpOutcome,
    });
    await expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.backendFailed,
    );
  });

  it("validates thrown MCP protocol errors", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "nan",
      handler: () => {
        throw new McpProtocolError(Number.NaN, "bad code");
      },
    });
    await expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.backendFailed,
    );
  });

  it("reports handler failures as binding failures", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "broken",
      handler: () => {
        throw new Error("boom");
      },
    });
    await expectOuterError(
      connections.call(server.serverId, "tools/list"),
      McpBindingErrorCode.backendFailed,
    );
  });
});
