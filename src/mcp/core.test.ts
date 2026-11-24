import { afterEach, describe, expect, it } from "vitest";
import * as v1Schema from "../v1/unstable/schema/index.js";
import * as v2Schema from "../v2/unstable/schema/index.js";
import * as v2 from "../v2/unstable/acp.js";
import {
  CLIENT_METHODS,
  MCP_MESSAGE_METHOD,
  McpBindingErrorCode,
  McpProtocolError,
  McpSessionError,
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
  McpAdmissionRequest,
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

  it("passes the session and tool call to the handler", async () => {
    connections = connectPair();
    const seen: McpOperationContext[] = [];
    const server = connections.register({
      name: "tools",
      handler: (cx) => {
        seen.push(cx);
        return { result: {} };
      },
    });
    const call = (options?: McpRequestOptions) =>
      connections.call(
        server.serverId,
        "tools/call",
        { name: "echo" },
        options,
      );

    await call();
    await call({ sessionId: "sess-child" });
    await call({ sessionId: "sess-child", toolCallId: "call-1" });

    expect(
      seen.map(({ sessionId, toolCallId }) => ({ sessionId, toolCallId })),
    ).toEqual([
      { sessionId: undefined, toolCallId: undefined },
      { sessionId: "sess-child", toolCallId: undefined },
      { sessionId: "sess-child", toolCallId: "call-1" },
    ]);
  });

  it("refuses a tool call without a session before sending", async () => {
    connections = connectPair();
    const seen: McpOperationContext[] = [];
    const server = connections.register({
      name: "tools",
      handler: (cx) => {
        seen.push(cx);
        return { result: {} };
      },
    });

    await expect(
      connections.call(server.serverId, "tools/call", null, {
        toolCallId: "call-1",
      }),
    ).rejects.toThrow(/call-1 has no sessionId\. Pass the sessionId/);
    expect(seen).toEqual([]);

    // A peer that sends one anyway gets Invalid params from the generated
    // validator, before the provider's handler runs.
    await expectOuterError(
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: server.serverId,
        requestId: "r",
        method: "tools/call",
        params: { _meta: validMeta },
        toolCallId: "call-1",
      }),
      McpBindingErrorCode.invalidParams,
    );
    expect(seen).toEqual([]);
  });

  it("runs the admission check before the handler", async () => {
    connections = connectPair();
    const events: string[] = [];
    const admitted: McpAdmissionRequest[] = [];
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        events.push("admit");
        admitted.push(request);
      },
      handler: (cx) => {
        events.push("handler");
        return { result: { session: cx.sessionId } };
      },
    });

    expect(
      await connections.call(
        server.serverId,
        "tools/call",
        { name: "echo", arguments: {} },
        { requestId: "r-1", sessionId: "sess-1", toolCallId: "call-1" },
      ),
    ).toEqual({ result: { session: "sess-1" } });
    expect(events).toEqual(["admit", "handler"]);
    expect(admitted[0]).toMatchObject({
      serverId: server.serverId,
      requestId: "r-1",
      method: "tools/call",
      params: { name: "echo", arguments: {} },
      toolName: "echo",
      sessionId: "sess-1",
      toolCallId: "call-1",
    });
    expect(admitted[0]!.requireSession()).toBe("sess-1");
    expect(admitted[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a request that needs a session before the handler runs", async () => {
    connections = connectPair();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      // A rejected request must not keep the only slot either.
      maxActiveRequests: 1,
      admit: (request) => {
        request.requireSession();
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });

    const error = await expectOuterError(
      connections.call(server.serverId, "tools/call", null, {
        requestId: "r-1",
      }),
      McpBindingErrorCode.invalidParams,
    );
    expect(error.message).toBe(
      "Invalid params: this MCP server needs a sessionId on the request. " +
        "Send the sessionId of the ACP session the request is for",
    );
    expect(error.data).toEqual({ serverId: server.serverId });
    expect(handled).toBe(0);

    // The rejected request no longer holds its request ID.
    expect(
      await connections.call(server.serverId, "tools/call", null, {
        requestId: "r-1",
        sessionId: "sess-1",
      }),
    ).toEqual({ result: {} });
    expect(handled).toBe(1);
  });

  it("rejects a session that the check refuses", async () => {
    connections = connectPair();
    const open = new Set(["sess-1"]);
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        if (request.sessionId !== undefined && open.has(request.sessionId)) {
          return;
        }
        if (request.toolName === "explain") {
          request.rejectSession("this session is not open in this window");
        }
        request.rejectSession();
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const call = (name: string, sessionId?: string) =>
      connections.call(
        server.serverId,
        "tools/call",
        { name },
        sessionId === undefined ? {} : { sessionId },
      );

    expect(await call("explain", "sess-1")).toEqual({ result: {} });

    const explained = await expectOuterError(
      call("explain", "sess-2"),
      McpBindingErrorCode.invalidParams,
    );
    expect(explained.message).toBe(
      "Invalid params: this session is not open in this window",
    );
    expect(explained.data).toEqual({
      serverId: server.serverId,
      sessionId: "sess-2",
    });

    const unexplained = await expectOuterError(
      call("other", "sess-2"),
      McpBindingErrorCode.invalidParams,
    );
    expect(unexplained.message).toBe(
      'Invalid params: this MCP server rejected sessionId "sess-2"',
    );

    // With no session to name, the default message asks for one.
    const missing = await expectOuterError(
      call("other"),
      McpBindingErrorCode.invalidParams,
    );
    expect(missing.message).toContain("needs a sessionId");
    expect(missing.data).toEqual({ serverId: server.serverId });
    expect(handled).toBe(1);
  });

  it("lets the check tell tools and methods apart", async () => {
    connections = connectPair();
    const toolNames: Array<string | undefined> = [];
    const handled: string[] = [];
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        toolNames.push(request.toolName);
        if (request.toolName === "word_count") request.requireSession();
      },
      handler: (cx) => {
        handled.push(`${cx.method} ${String(cx.params?.name)}`);
        return { result: {} };
      },
    });
    const call = (
      method: string,
      params?: Record<string, unknown>,
      options?: McpRequestOptions,
    ) => connections.call(server.serverId, method, params, options);

    // Only `word_count` needs a session.
    await call("server/discover");
    await call("tools/list");
    await call("tools/call", { name: "echo" });
    await expectOuterError(
      call("tools/call", { name: "word_count" }),
      McpBindingErrorCode.invalidParams,
    );
    await call("tools/call", { name: "word_count" }, { sessionId: "sess-1" });
    // `name` only names a tool on tools/call, and only as a string.
    await call("prompts/get", { name: "word_count" });
    await call("tools/call", { name: 7 });

    expect(toolNames).toEqual([
      undefined,
      undefined,
      "echo",
      "word_count",
      "word_count",
      undefined,
      undefined,
    ]);
    expect(handled).toEqual([
      "server/discover undefined",
      "tools/list undefined",
      "tools/call echo",
      "tools/call word_count",
      "prompts/get word_count",
      "tools/call 7",
    ]);
  });

  it("can reject discovery and listing too", async () => {
    connections = connectPair();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        request.requireSession();
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    for (const method of ["server/discover", "tools/list"]) {
      await expectOuterError(
        connections.call(server.serverId, method),
        McpBindingErrorCode.invalidParams,
      );
      expect(
        await connections.call(server.serverId, method, null, {
          sessionId: "sess-1",
        }),
      ).toEqual({ result: {} });
    }
    expect(handled).toBe(2);
  });

  it("waits for an asynchronous check", async () => {
    connections = connectPair();
    const checking = deferred();
    const release = deferred<boolean>();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async (request) => {
        checking.resolve();
        if (!(await release.promise)) request.rejectSession("closed meanwhile");
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const call = (requestId: string) =>
      connections.call(server.serverId, "tools/call", null, {
        requestId,
        sessionId: "sess-1",
      });

    const first = call("r-1");
    await checking.promise;
    expect(handled).toBe(0);
    // A request that is being checked still holds its request ID.
    await expectOuterError(
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: server.serverId,
        requestId: "r-1",
        method: "tools/call",
        params: { _meta: validMeta },
      }),
      McpBindingErrorCode.invalidParams,
    );
    release.resolve(true);
    expect(await first).toEqual({ result: {} });
    expect(handled).toBe(1);
  });

  it("rejects from an asynchronous check", async () => {
    connections = connectPair();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async (request) => {
        await Promise.resolve();
        request.rejectSession("closed meanwhile");
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const error = await expectOuterError(
      connections.call(server.serverId, "tools/call", null, {
        sessionId: "sess-1",
      }),
      McpBindingErrorCode.invalidParams,
    );
    expect(error.message).toBe("Invalid params: closed meanwhile");
    expect(handled).toBe(0);
  });

  it("does not run the handler when cancelled during the check", async () => {
    connections = connectPair();
    const checking = deferred();
    const release = deferred();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async () => {
        checking.resolve();
        await release.promise;
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const other = connections.register({
      name: "other",
      handler: () => ({ result: {} }),
    });
    const controller = new AbortController();
    const pending = connections.call(server.serverId, "tools/call", null, {
      signal: controller.signal,
    });
    let answered = false;
    void pending
      .catch(() => {})
      .finally(() => {
        answered = true;
      });
    await checking.promise;
    controller.abort();
    // Messages are handled in order, so once this later request is answered
    // the cancellation has arrived.
    await connections.call(other.serverId, "tools/list");
    // This check ignores its signal, so the answer waits for it.
    expect(answered).toBe(false);
    release.resolve();

    await expectOuterError(pending, McpBindingErrorCode.requestCancelled);
    expect(handled).toBe(0);
  });

  it("aborts the check's signal when the request is cancelled", async () => {
    connections = connectPair();
    const checking = deferred();
    let sawAbort = false;
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async (request) => {
        expect(request.signal.aborted).toBe(false);
        checking.resolve();
        // A lookup that stops when the request is cancelled.
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        sawAbort = true;
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const controller = new AbortController();
    const pending = connections.call(server.serverId, "tools/call", null, {
      signal: controller.signal,
    });
    await checking.promise;
    controller.abort();

    // The check returned normally, and the request is still cancelled.
    await expectOuterError(pending, McpBindingErrorCode.requestCancelled);
    expect(sawAbort).toBe(true);
    expect(handled).toBe(0);
  });

  it("aborts the check's signal when the registration is disposed", async () => {
    connections = connectPair();
    const checking = deferred();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async (request) => {
        checking.resolve();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        // A session rejection after the abort does not replace the outcome.
        request.rejectSession("too late");
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const pending = expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.requestCancelled,
    );
    await checking.promise;

    // dispose() resolves only once the check has settled.
    await server.dispose();
    await pending;
    expect(handled).toBe(0);
  });

  it("does not run the handler when disposed during the check", async () => {
    connections = connectPair();
    const checking = deferred();
    const release = deferred();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: async () => {
        checking.resolve();
        await release.promise;
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const pending = expectOuterError(
      connections.call(server.serverId, "tools/call"),
      McpBindingErrorCode.requestCancelled,
    );
    await checking.promise;
    let disposed = false;
    const disposing = server.dispose().then(() => {
      disposed = true;
    });
    // This check ignores its signal, so dispose() waits for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    release.resolve();

    await disposing;
    await pending;
    expect(handled).toBe(0);
  });

  it("reports a check that fails as a binding failure", async () => {
    connections = connectPair();
    let handled = 0;
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        if (request.toolName === "inner") {
          // Not an inner MCP error: the MCP request never ran.
          throw new McpProtocolError(-32601, "no such tool");
        }
        if (request.toolName === "params") {
          throw RequestError.invalidParams(undefined, "not a session error");
        }
        throw new Error("session lookup failed");
      },
      handler: () => {
        handled += 1;
        return { result: {} };
      },
    });
    const call = (name: string) =>
      expectOuterError(
        connections.call(server.serverId, "tools/call", { name }),
        McpBindingErrorCode.backendFailed,
      );

    const failed = await call("other");
    expect(failed.message).toBe("MCP server admission check failed");
    expect(failed.data).toEqual({ details: "session lookup failed" });
    expect((await call("inner")).data).toEqual({ details: "no such tool" });
    expect((await call("params")).data).toMatchObject({ code: -32602 });
    expect(handled).toBe(0);
  });

  it("answers a malformed inner request without running the check", async () => {
    connections = connectPair();
    let admitted = 0;
    const server = connections.register({
      name: "tools",
      admit: (request) => {
        admitted += 1;
        request.requireSession();
      },
      handler: () => ({ result: {} }),
    });
    // No MCP protocol version in `params._meta`: an inner MCP error, as for
    // a server without a check.
    await expect(
      connections.agent.client.request(CLIENT_METHODS.mcp_message, {
        serverId: server.serverId,
        requestId: "r-1",
        method: "tools/list",
        params: null,
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(admitted).toBe(0);
  });

  it("reports only a session error as Invalid params", async () => {
    connections = connectPair();
    const server = connections.register({
      name: "tools",
      handler: (cx) => {
        if (cx.params?.name === "session") {
          throw new McpSessionError("this server serves one session");
        }
        // A handler's own Invalid params is still a binding failure.
        throw RequestError.invalidParams(undefined, "not about the session");
      },
    });
    const call = (name: string) =>
      connections.call(server.serverId, "tools/call", { name });

    const rejected = await expectOuterError(
      call("session"),
      McpBindingErrorCode.invalidParams,
    );
    expect(rejected.message).toBe(
      "Invalid params: this server serves one session",
    );
    const failed = await expectOuterError(
      call("other"),
      McpBindingErrorCode.backendFailed,
    );
    expect(failed.data).toMatchObject({ code: -32602 });
  });

  it("passes the session and tool call to the handler over ACP v2", async () => {
    const provider = new v2.McpOverAcpProvider();
    const caller = new v2.McpOverAcpCaller();
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agent = v2
      .agent()
      .onRequest(v2.methods.agent.initialize, () => ({
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "test-agent", version: "1" },
      }))
      .onNotification(v2.methods.agent.mcp.message, caller.handleNotification)
      .connect(v2.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    const client = v2
      .client()
      .onRequest(v2.methods.client.mcp.message, provider.handleRequest)
      .connect(v2.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    try {
      await client.agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1" },
      });
      const seen: McpOperationContext[] = [];
      const server = provider.registerServer(client.agent, {
        name: "tools",
        handler: (cx) => {
          seen.push(cx);
          return { result: {} };
        },
      });

      await caller.request(agent.client, server.serverId, "tools/list");
      await caller.request(agent.client, server.serverId, "tools/call", null, {
        sessionId: "sess-child",
        toolCallId: "call-1",
      });

      expect(
        seen.map(({ sessionId, toolCallId }) => ({ sessionId, toolCallId })),
      ).toEqual([
        { sessionId: undefined, toolCallId: undefined },
        { sessionId: "sess-child", toolCallId: "call-1" },
      ]);

      let handled = 0;
      const strict = provider.registerServer(client.agent, {
        name: "strict",
        admit: (request) => {
          request.requireSession();
        },
        handler: () => {
          handled += 1;
          return { result: {} };
        },
      });
      const error = await expectOuterError(
        caller.request(agent.client, strict.serverId, "tools/list"),
        McpBindingErrorCode.invalidParams,
      );
      expect(error.message).toContain("needs a sessionId");
      expect(error.data).toEqual({ serverId: strict.serverId });
      expect(handled).toBe(0);
    } finally {
      agent.close();
      client.close();
    }
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
