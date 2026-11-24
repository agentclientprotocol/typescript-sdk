import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  McpOverAcpCaller,
  McpOverAcpProvider,
  McpProtocolError,
  PROTOCOL_VERSION,
  RequestError,
  agent as createAgent,
  client as createClient,
  methods,
  ndJsonStream,
} from "../v1/unstable/acp.js";
import type {
  AgentConnection,
  ClientConnection,
  HasConnectionContext,
  McpServerOptions,
} from "../v1/unstable/acp.js";
import { stripHeaderAnnotations } from "./header-annotations.js";
import { McpOverAcpHttpBridge } from "./http.js";
import type {
  McpHttpRequestInfo,
  McpOverAcpHttpBridgeOptions,
  McpServerHttpDeclaration,
} from "./http.js";

function setup(options?: McpOverAcpHttpBridgeOptions) {
  const provider = new McpOverAcpProvider();
  const caller = new McpOverAcpCaller();
  const bridge = new McpOverAcpHttpBridge(caller, options);
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agent: AgentConnection = createAgent()
    .onNotification(methods.agent.mcp.message, caller.handleNotification)
    .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
  let forwarded = 0;
  const client: ClientConnection = createClient()
    .onRequest(methods.client.mcp.message, (context) => {
      forwarded += 1;
      return provider.handleRequest(context);
    })
    .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));
  return {
    agent,
    client,
    bridge,
    /** How many `mcp/message` requests have reached the client. */
    forwarded: () => forwarded,
    /** Registers a server on the client and re-exports it over HTTP. */
    async serve(options: McpServerOptions) {
      const registration = provider.registerServer(client.agent, options);
      const http = await bridge.toHttp(agent.client, registration.declaration);
      return { registration, http };
    },
  };
}

const meta = {
  [MCP_META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
  [MCP_META_CLIENT_CAPABILITIES]: {},
};

type PostOptions = {
  id?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  body?: string;
  method?: string;
  signal?: AbortSignal;
};

function post(
  server: McpServerHttpDeclaration,
  method: string,
  options: PostOptions = {},
): Promise<Response> {
  const params = options.params ?? {};
  const name =
    method === "resources/read" ? params.uri : (params.name as unknown);
  const headers: Record<string, string> = {
    authorization: server.headers[0]!.value,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(typeof name === "string" ? { "mcp-name": name } : {}),
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return fetch(server.url, {
    method: options.method ?? "POST",
    headers,
    signal: options.signal,
    body:
      options.method && options.method !== "POST"
        ? undefined
        : (options.body ??
          JSON.stringify({
            jsonrpc: "2.0",
            id: options.id ?? 1,
            method,
            params: { ...params, _meta: { ...meta, ...(params._meta ?? {}) } },
          })),
  });
}

function sseEvents(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((event) =>
      event
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

describe("McpOverAcpHttpBridge", () => {
  let env: ReturnType<typeof setup> | undefined;

  afterEach(() => {
    env?.agent.close();
    env?.client.close();
    env = undefined;
  });

  it("declares a loopback endpoint with a bearer header", async () => {
    env = setup();
    const { registration, http } = await env.serve({
      name: "tools",
      handler: () => ({ result: {} }),
    });
    expect(http).toMatchObject({ type: "http", name: "tools" });
    expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-/);
    expect(http.url).not.toContain(registration.serverId);
    expect(http.headers).toEqual([
      { name: "Authorization", value: expect.stringMatching(/^Bearer \S+$/) },
    ]);
  });

  it("adapts only acp entries of a server list", async () => {
    env = setup();
    const stdio = { name: "stdio", command: "x", args: [], env: [] };
    const adapted = await env.bridge.adaptServers(env.agent.client, [
      stdio,
      { type: "acp", name: "native", serverId: "native-1" },
    ]);
    expect(adapted[0]).toBe(stdio);
    expect(adapted[1]).toMatchObject({ type: "http", name: "native" });
  });

  it("forwards a tool call as a JSON response", async () => {
    env = setup();
    let logicalId: string | undefined;
    const { http } = await env.serve({
      name: "tools",
      handler: (cx) => {
        logicalId = cx.requestId;
        return { result: { content: [{ type: "text", text: "hi" }] } };
      },
    });

    const response = await post(http, "tools/call", {
      id: "http-1",
      params: { name: "echo", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "http-1",
      result: { content: [{ type: "text", text: "hi" }] },
    });
    expect(logicalId).toMatch(/^mcp-http:/);
  });

  it("sends the session and tool call that the host supplies", async () => {
    // What a host records before each tool runs, keyed by the tool-use ID
    // that its MCP client puts in `params._meta`.
    const toolUses = new Map([
      ["toolu_1", { sessionId: "sess-child", toolCallId: "call-1" }],
      ["toolu_2", { sessionId: "sess-root" }],
    ]);
    const asked: unknown[] = [];
    env = setup({
      attribution: (request) => {
        asked.push(request);
        const meta = request.params?._meta as Record<string, unknown>;
        return toolUses.get(String(meta["host/toolUseId"]));
      },
    });
    const seen: Array<{ sessionId?: string; toolCallId?: string }> = [];
    const { registration, http } = await env.serve({
      name: "tools",
      handler: ({ sessionId, toolCallId }) => {
        seen.push({ sessionId, toolCallId });
        return { result: { content: [] } };
      },
    });

    for (const toolUseId of ["toolu_1", "toolu_2", "toolu_unknown"]) {
      const response = await post(http, "tools/call", {
        params: { name: "echo", _meta: { "host/toolUseId": toolUseId } },
      });
      expect(response.status).toBe(200);
    }

    expect(seen).toEqual([
      { sessionId: "sess-child", toolCallId: "call-1" },
      { sessionId: "sess-root", toolCallId: undefined },
      // A request the host cannot match is sent without attribution.
      { sessionId: undefined, toolCallId: undefined },
    ]);
    expect(asked[0]).toMatchObject({
      serverId: registration.serverId,
      method: "tools/call",
      params: { name: "echo" },
    });
    // An answered request was never abandoned.
    for (const request of asked as McpHttpRequestInfo[]) {
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal.aborted).toBe(false);
    }
    expect(env.forwarded()).toBe(3);
  });

  it("shows the HTTP client a provider's session rejection", async () => {
    const sessions = new Map([["toolu_1", { sessionId: "sess-1" }]]);
    env = setup({
      attribution: (request) => {
        const meta = request.params?._meta as Record<string, unknown>;
        return sessions.get(String(meta["host/toolUseId"]));
      },
    });
    let handled = 0;
    const { http } = await env.serve({
      name: "tools",
      admit: (request) => {
        request.requireSession();
      },
      handler: (cx) => {
        handled += 1;
        return { result: { session: cx.sessionId } };
      },
    });
    const call = (toolUseId: string) =>
      post(http, "tools/call", {
        id: "http-1",
        params: { name: "echo", _meta: { "host/toolUseId": toolUseId } },
      });

    const attributed = await call("toolu_1");
    expect(await attributed.json()).toMatchObject({
      result: { session: "sess-1" },
    });

    // The provider answers the bridge with ACP -32602. The HTTP client's own
    // params are fine, so it sees a binding failure whose message gives the
    // provider's reason without the words "Invalid params".
    const rejected = await call("toolu_unknown");
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({
      jsonrpc: "2.0",
      id: "http-1",
      error: {
        code: -33002,
        message:
          "The MCP server refused this request before running it. " +
          "Reason: this MCP server needs to know which ACP session the " +
          "request is for, and the agent did not say. " +
          "Changing the tool arguments will not help.",
      },
    });
    expect(handled).toBe(1);
  });

  it.each([
    {
      // The Rust SDK's provider answers with the fixed message "Invalid
      // params" and puts the reason in a `data` string.
      provider: "sends the reason as a data string",
      message: "Invalid params",
      data: "this MCP server requires sessionId on mcp/message",
      reason: "Reason: this MCP server requires sessionId on mcp/message. ",
    },
    {
      provider: "ends the reason with a period",
      message: "Invalid params",
      data: " The session is closed. ",
      reason: "Reason: The session is closed. ",
    },
    {
      provider: "sends the reason in the message",
      message: "Invalid params: duplicate active MCP request ID",
      data: { serverId: "srv-1", requestId: "r-1" },
      reason: "Reason: duplicate active MCP request ID. ",
    },
    {
      provider: "sends a message of its own",
      message: "sessionId is required",
      data: "",
      reason: "Reason: sessionId is required. ",
    },
    {
      provider: "gives no reason",
      message: "Invalid params",
      data: undefined,
      reason: "",
    },
  ])(
    "rewords a -32602 from a provider that $provider",
    async ({ message, data, reason }) => {
      const caller = new McpOverAcpCaller();
      const bridge = new McpOverAcpHttpBridge(caller);
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
      const agent: AgentConnection = createAgent()
        .onNotification(methods.agent.mcp.message, caller.handleNotification)
        .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
      const client: ClientConnection = createClient()
        .onRequest(methods.client.mcp.message, () => {
          throw new RequestError(-32602, message, data);
        })
        .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));
      try {
        const http = await bridge.toHttp(agent.client, {
          type: "acp",
          name: "tools",
          serverId: "srv-1",
        });
        const rejected = await post(http, "tools/call", {
          id: "http-1",
          params: { name: "echo" },
        });
        expect(rejected.status).toBe(200);
        // No `data`: the reason is in the message.
        expect(await rejected.json()).toEqual({
          jsonrpc: "2.0",
          id: "http-1",
          error: {
            code: -33002,
            message:
              "The MCP server refused this request before running it. " +
              reason +
              "Changing the tool arguments will not help.",
          },
        });
      } finally {
        agent.close();
        client.close();
      }
    },
  );

  it("tells the resolver which connection a request is forwarded on", async () => {
    // One bridge and caller serve two ACP connections. Both clients declare
    // a server with the same ID, so `serverId` does not tell them apart.
    const requests: McpHttpRequestInfo[] = [];
    const sessionOf = new Map<unknown, string>();
    const caller = new McpOverAcpCaller();
    const bridge = new McpOverAcpHttpBridge(caller, {
      attribution: (request) => {
        requests.push(request);
        const sessionId = sessionOf.get(request.connection);
        return sessionId === undefined ? undefined : { sessionId };
      },
    });
    const connect = (name: string) => {
      const provider = new McpOverAcpProvider();
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
      let handlerClient: HasConnectionContext | undefined;
      const agent: AgentConnection = createAgent()
        .onNotification(methods.agent.mcp.message, caller.handleNotification)
        .onRequest(methods.agent.initialize, ({ client }) => {
          // The context of a request handler is a new object per request.
          handlerClient = client;
          return { protocolVersion: PROTOCOL_VERSION };
        })
        .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
      const client: ClientConnection = createClient()
        .onRequest(methods.client.mcp.message, provider.handleRequest)
        .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));
      provider.registerServer(client.agent, {
        name: "tools",
        serverId: "tools",
        handler: (cx) => ({ result: { served: name, session: cx.sessionId } }),
      });
      return { agent, client, handlerClient: () => handlerClient! };
    };
    const a = connect("a");
    const b = connect("b");
    try {
      for (const { client } of [a, b]) {
        await client.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
      }
      // What a host records per connection, from a handler's own context.
      sessionOf.set(bridge.connection(a.handlerClient()), "sess-a");
      sessionOf.set(bridge.connection(b.handlerClient()), "sess-b");
      const declaration = {
        type: "acp",
        name: "tools",
        serverId: "tools",
      } as const;
      const httpA = await bridge.toHttp(a.handlerClient(), declaration);
      const httpB = await bridge.toHttp(b.agent.client, declaration);

      const call = async (http: McpServerHttpDeclaration) =>
        (await (await post(http, "tools/list")).json()) as { result: unknown };
      expect((await call(httpA)).result).toEqual({
        served: "a",
        session: "sess-a",
      });
      expect((await call(httpB)).result).toEqual({
        served: "b",
        session: "sess-b",
      });
      expect((await call(httpA)).result).toEqual({
        served: "a",
        session: "sess-a",
      });

      // One object per connection, whichever context the host started from.
      const [first, second, third] = requests.map(
        ({ connection }) => connection,
      );
      expect(first).toBe(third);
      expect(first).not.toBe(second);
      expect(first).toBe(bridge.connection(a.agent.client));
      expect(first).not.toBe(a.handlerClient());
      expect(requests[0]).toMatchObject({
        serverId: "tools",
        method: "tools/list",
      });

      // It can be handed back to the SDK as a context of that connection.
      expect(await caller.request(second!, "tools", "tools/list")).toEqual({
        result: { served: "b", session: undefined },
      });
    } finally {
      for (const { agent, client } of [a, b]) {
        agent.close();
        client.close();
      }
    }
  });

  it("aborts the resolver's signal when the HTTP client drops the request", async () => {
    const waiting = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    let asked = 0;
    env = setup({
      attribution: async (request) => {
        asked += 1;
        if (asked > 1) return { sessionId: "sess-1" };
        waiting.resolve();
        // Waits for an announcement that never comes, until the request is
        // abandoned. Rejecting is how such a wait usually ends.
        await new Promise<never>((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(new Error("stopped waiting"));
            },
            { once: true },
          ),
        );
        return undefined;
      },
    });
    const seen: Array<string | undefined> = [];
    const { http } = await env.serve({
      name: "tools",
      handler: (cx) => {
        seen.push(cx.sessionId);
        return { result: {} };
      },
    });
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const controller = new AbortController();
      const dropped = post(http, "tools/call", {
        params: { name: "echo" },
        signal: controller.signal,
      }).then(
        () => "answered",
        () => "dropped",
      );
      await waiting.promise;
      controller.abort();
      expect(await dropped).toBe("dropped");
      await stopped.promise;

      // The abandoned request was not forwarded, and the resolver's error
      // was not reported as a bridge failure. The bridge still serves.
      expect(
        (await post(http, "tools/call", { params: { name: "echo" } })).status,
      ).toBe(200);
      expect(env.forwarded()).toBe(1);
      expect(seen).toEqual(["sess-1"]);
      expect(errors).toEqual([]);
    } finally {
      console.error = consoleError;
    }
  });

  it.each(["returns", "throws"])(
    "ignores a resolver that %s after its request was abandoned",
    async (ending) => {
      const waiting = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      let asked = 0;
      env = setup({
        // This resolver does not look at the signal.
        attribution: async (request) => {
          asked += 1;
          if (asked > 1) return { sessionId: "sess-2" };
          waiting.resolve(request.signal);
          await release.promise;
          queueMicrotask(settled.resolve);
          if (ending === "throws") throw new Error("lookup failed late");
          return { sessionId: "sess-1" };
        },
      });
      const seen: Array<string | undefined> = [];
      const { http } = await env.serve({
        name: "tools",
        handler: (cx) => {
          seen.push(cx.sessionId);
          return { result: {} };
        },
      });
      const errors: unknown[][] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        const controller = new AbortController();
        const dropped = post(http, "tools/call", {
          params: { name: "echo" },
          signal: controller.signal,
        }).catch(() => "dropped");
        const signal = await waiting.promise;
        const aborted = new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        controller.abort();
        expect(await dropped).toBe("dropped");
        await aborted;
        // The resolver settles only now, after the bridge stopped waiting.
        release.resolve();
        await settled.promise;

        expect(
          (await post(http, "tools/call", { params: { name: "echo" } })).status,
        ).toBe(200);
        expect(env.forwarded()).toBe(1);
        expect(seen).toEqual(["sess-2"]);
        expect(errors).toEqual([]);
      } finally {
        console.error = consoleError;
      }
    },
  );

  it("aborts the resolver's signal when the ACP connection closes", async () => {
    const waiting = Promise.withResolvers<AbortSignal>();
    env = setup({
      attribution: (request) => {
        waiting.resolve(request.signal);
        return new Promise(() => {});
      },
    });
    const { http } = await env.serve({
      name: "tools",
      handler: () => ({ result: {} }),
    });
    const dropped = post(http, "tools/call", {
      params: { name: "echo" },
    }).then(
      () => "answered",
      () => "dropped",
    );
    const signal = await waiting.promise;
    expect(signal.aborted).toBe(false);
    const aborted = new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );

    // Closing the ACP connection closes the listener and its connections.
    env.agent.close();
    await aborted;
    expect(await dropped).toBe("dropped");
    expect(env.forwarded()).toBe(0);
  });

  it("sends no attribution without a resolver", async () => {
    env = setup();
    const seen: unknown[] = [];
    const { http } = await env.serve({
      name: "tools",
      handler: ({ sessionId, toolCallId }) => {
        seen.push({ sessionId, toolCallId });
        return { result: {} };
      },
    });
    expect((await post(http, "tools/list")).status).toBe(200);
    expect(seen).toEqual([{ sessionId: undefined, toolCallId: undefined }]);
  });

  it.each<[string, () => unknown]>([
    [
      "throws",
      () => {
        throw new Error("lookup failed");
      },
    ],
    ["returns a tool call without a session", () => ({ toolCallId: "call-1" })],
  ])("fails the request when the resolver %s", async (_name, resolver) => {
    env = setup({
      // What a JavaScript host could pass despite the declared type.
      attribution: resolver as McpOverAcpHttpBridgeOptions["attribution"],
    });
    let handled = 0;
    const { http } = await env.serve({
      name: "tools",
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const response = await post(http, "tools/list");
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: -33002 },
      });
    } finally {
      console.error = consoleError;
    }
    expect(handled).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("returns inner MCP errors unchanged", async () => {
    env = setup();
    const { http } = await env.serve({
      name: "tools",
      handler: () => {
        throw new McpProtocolError(-32000, "tool failed", null);
      },
    });
    const response = await post(http, "tools/call", {
      params: { name: "x" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "tool failed", data: null },
    });
  });

  it("streams notifications before the result as SSE", async () => {
    env = setup();
    const { http } = await env.serve({
      name: "tools",
      handler: async (cx) => {
        await cx.notify("notifications/progress", {
          progressToken: "p",
          progress: 1,
        });
        await cx.notify("notifications/message", {
          _meta: { "io.modelcontextprotocol/subscriptionId": cx.requestId },
        });
        return {
          result: {
            _meta: { "io.modelcontextprotocol/subscriptionId": cx.requestId },
          },
        };
      },
    });

    const response = await post(http, "subscriptions/listen", { id: 7 });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const subscription = {
      _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
    };
    expect(sseEvents(await response.text())).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "p", progress: 1 },
      },
      { jsonrpc: "2.0", method: "notifications/message", params: subscription },
      { jsonrpc: "2.0", id: 7, result: subscription },
    ]);
  });

  it("cancels the ACP request when the HTTP client disconnects", async () => {
    env = setup();
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const { http } = await env.serve({
      name: "tools",
      handler: async (cx) => {
        await cx.notify("notifications/progress", { progress: 0 });
        started.resolve();
        await new Promise((resolve) =>
          cx.signal.addEventListener("abort", resolve, { once: true }),
        );
        cancelled.resolve();
        throw cx.signal.reason;
      },
    });
    const controller = new AbortController();
    const response = await post(http, "subscriptions/listen", {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await cancelled.promise;
  });

  it("strips x-mcp-header annotations from tool schemas only", async () => {
    env = setup();
    const { http } = await env.serve({
      name: "tools",
      handler: () => ({
        result: {
          tools: [
            {
              name: "t",
              inputSchema: {
                type: "object",
                properties: {
                  region: { type: "string", "x-mcp-header": "Region" },
                  "x-mcp-header": { type: "string", default: "kept" },
                },
                default: { "x-mcp-header": "instance data" },
              },
            },
          ],
        },
      }),
    });
    const body = (await (await post(http, "tools/list")).json()) as {
      result: { tools: Array<{ inputSchema: Record<string, unknown> }> };
    };
    expect(body.result.tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: {
        region: { type: "string" },
        "x-mcp-header": { type: "string", default: "kept" },
      },
      default: { "x-mcp-header": "instance data" },
    });
  });

  it("authenticates each server with its own token", async () => {
    env = setup();
    const one = await env.serve({
      name: "one",
      handler: () => ({ result: 1 }),
    });
    const two = await env.serve({
      name: "two",
      handler: () => ({ result: 2 }),
    });

    const missing = await post(one.http, "tools/list", {
      headers: { authorization: undefined },
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const crossed = await post(one.http, "tools/list", {
      headers: { authorization: two.http.headers[0]!.value },
    });
    expect(crossed.status).toBe(401);
  });

  it.each<[string, string, PostOptions, number, number]>([
    [
      "a foreign Origin",
      "tools/list",
      { headers: { origin: "http://evil.example" } },
      403,
      -32600,
    ],
    ["GET", "tools/list", { method: "GET" }, 405, -32600],
    ["DELETE", "tools/list", { method: "DELETE" }, 405, -32600],
    [
      "an Accept without SSE",
      "tools/list",
      { headers: { accept: "application/json" } },
      406,
      -32600,
    ],
    [
      "a non-JSON body type",
      "tools/list",
      { headers: { "content-type": "text/plain" } },
      415,
      -32600,
    ],
    ["invalid JSON", "tools/list", { body: "{" }, 400, -32700],
    ["a batch", "tools/list", { body: "[]" }, 400, -32600],
    [
      "a notification",
      "tools/list",
      { body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) },
      400,
      -32600,
    ],
    [
      "a mismatched Mcp-Method",
      "tools/list",
      { headers: { "mcp-method": "tools/call" } },
      400,
      -32020,
    ],
    [
      "a mismatched Mcp-Name",
      "tools/call",
      { params: { name: "a" }, headers: { "mcp-name": "b" } },
      400,
      -32020,
    ],
    [
      "an Mcp-Param header",
      "tools/list",
      { headers: { "mcp-param-region": "x" } },
      400,
      -32020,
    ],
    [
      "an old protocol version",
      "tools/list",
      {
        headers: { "mcp-protocol-version": "2025-11-25" },
        params: { _meta: { [MCP_META_PROTOCOL_VERSION]: "2025-11-25" } },
      },
      400,
      -32022,
    ],
    ["initialize", "initialize", {}, 404, -32601],
  ])("rejects %s", async (_, method, options, status, code) => {
    env = setup();
    let called = false;
    const { http } = await env.serve({
      name: "tools",
      handler: () => {
        called = true;
        return { result: {} };
      },
    });
    const response = await post(http, method, options);
    expect(response.status).toBe(status);
    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(code);
    expect(called).toBe(false);
  });

  it("accepts a base64-encoded Mcp-Name", async () => {
    env = setup();
    const { http } = await env.serve({
      name: "tools",
      handler: () => ({ result: "ok" }),
    });
    const name = "héllo";
    const response = await post(http, "tools/call", {
      params: { name },
      headers: {
        "mcp-name": `=?base64?${Buffer.from(name).toString("base64")}?=`,
      },
    });
    expect(response.status).toBe(200);
  });

  it("reports a removed registration as a binding failure", async () => {
    env = setup();
    const { registration, http } = await env.serve({
      name: "tools",
      handler: () => ({ result: {} }),
    });
    await registration.dispose();
    const response = await post(http, "tools/list");
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { error: { code: number } }).error.code,
    ).toBe(-33001);
  });

  it("limits the request body size", async () => {
    env = setup({ maxRequestBodyBytes: 64 });
    const { http } = await env.serve({
      name: "tools",
      handler: () => ({ result: {} }),
    });
    const response = await post(http, "tools/list", {
      params: { padding: "x".repeat(128) },
    });
    expect(response.status).toBe(413);
  });

  it("limits outstanding responses and recovers", async () => {
    env = setup({ maxActiveRequests: 1 });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { http } = await env.serve({
      name: "tools",
      handler: async () => {
        started.resolve();
        await release.promise;
        return { result: "done" };
      },
    });
    const first = post(http, "tools/list");
    await started.promise;

    const rejected = await post(http, "tools/list");
    expect(rejected.status).toBe(429);
    expect(
      ((await rejected.json()) as { error: { code: number } }).error.code,
    ).toBe(-33000);

    release.resolve();
    expect((await first).status).toBe(200);
    await (await first).text();
    await expect
      .poll(async () => (await post(http, "tools/list")).status)
      .toBe(200);
  });

  it("refuses to declare servers after the connection closes", async () => {
    env = setup();
    env.agent.close();
    await expect(
      env.bridge.toHttp(env.agent.client, {
        type: "acp",
        name: "late",
        serverId: "late-1",
      }),
    ).rejects.toThrow(/closed/);
  });

  it.each([
    "maxActiveRequests",
    "maxRequestBodyBytes",
    "maxBufferedResponseBytes",
  ])("validates %s", (option) => {
    for (const value of [0, -1, Number.NaN, 1.5]) {
      expect(
        () =>
          new McpOverAcpHttpBridge(new McpOverAcpCaller(), { [option]: value }),
      ).toThrow(RangeError);
    }
  });

  it("closes the listener with the ACP connection", async () => {
    env = setup();
    const { http } = await env.serve({
      name: "tools",
      handler: () => ({ result: {} }),
    });
    env.agent.close();
    await expect(post(http, "tools/list")).rejects.toThrow();
  });
});

describe("stripHeaderAnnotations", () => {
  it("only traverses schema locations", () => {
    const listing = {
      tools: [
        {
          name: "t",
          inputSchema: {
            $defs: { inner: { type: "string", "x-mcp-header": "Inner" } },
            items: [{ type: "string", "x-mcp-header": "Tuple" }],
            dependencies: {
              trigger: { "x-mcp-header": "Dependency" },
              property: ["x-mcp-header"],
            },
            enum: [{ "x-mcp-header": "enum data" }],
            anyOf: [{ "x-mcp-header": "Any" }],
          },
        },
      ],
    };
    expect(stripHeaderAnnotations(listing)).toEqual({
      tools: [
        {
          name: "t",
          inputSchema: {
            $defs: { inner: { type: "string" } },
            items: [{ type: "string" }],
            dependencies: { trigger: {}, property: ["x-mcp-header"] },
            enum: [{ "x-mcp-header": "enum data" }],
            anyOf: [{}],
          },
        },
      ],
    });
  });
});
