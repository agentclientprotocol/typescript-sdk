import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  client,
  methods,
} from "./unstable/acp.js";
import * as sdk from "./unstable/acp.js";
import * as stableSdk from "./stable/acp.js";
import * as stableZod from "./schema/zod.gen.js";
import * as guards from "./unstable/schema/guards.gen.js";
import * as unstableZod from "./unstable/schema/zod.gen.js";
import {
  zAnnotations,
  zDiffPatch,
  zSessionInfo,
  zSessionInfoUpdate,
} from "./unstable/schema/zod.gen.js";
import type {
  AgentContext,
  Annotations,
  ClientContext,
  DiffPatch,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  PromptResponse,
  SessionInfo,
  SessionInfoUpdate,
  SessionUpdate,
} from "./unstable/acp.js";

const clientInfo = { name: "test-client", version: "1.0.0" };
const agentInfo = { name: "test-agent", version: "1.0.0" };

function testAgent(): sdk.AgentApp {
  return agent().onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    info: agentInfo,
  }));
}

function assertV2MethodTypes(
  agentContext: ClientContext,
  clientContext: AgentContext,
): void {
  // @ts-expect-error Built-in methods must not fall through the extension overload.
  agentContext.request(methods.agent.session.new, { sessionId: "wrong" });
  // @ts-expect-error Built-in notifications must not fall through the extension overload.
  agentContext.notify(methods.agent.session.cancel, {});
  agent().onRequest(
    // @ts-expect-error Built-in handlers cannot replace their generated params parser.
    methods.agent.session.new,
    (params: unknown) => params,
    () => ({ sessionId: "wrong-parser" }),
  );
  // @ts-expect-error Request methods cannot be sent as notifications.
  agentContext.notify(methods.agent.session.new, {});
  // @ts-expect-error Notification methods cannot be sent as requests.
  agentContext.request(methods.agent.session.cancel, {});
  // @ts-expect-error Client-directed methods cannot be sent to an agent.
  agentContext.request(methods.client.mcp.message, {
    serverId: "server-1",
    requestId: "request-1",
    method: "tools/list",
  });

  const parseValue = (params: unknown): { value: string } =>
    params as { value: string };
  void agentContext.request("session/load", { sessionId: "session-1" });
  void agentContext.request<
    { value: string },
    { sessionId: string },
    "session/load"
  >("session/load", { sessionId: "session-1" });
  void agentContext.request<{ value: string }, { value: string }>(
    "_vendor/acme/echo",
    { value: "request" },
  );
  void agentContext.notify("session/set_model", { modelId: "model-1" });
  agent().onRequest("session/load", parseValue, ({ params }) => params);
  agent().onNotification("session/set_model", parseValue, () => {});

  const dynamicMethod: string = "method/from-another-draft";
  void agentContext.request(dynamicMethod, {});
  void agentContext.notify(dynamicMethod, {});
  agent().onRequest(dynamicMethod, parseValue, ({ params }) => params);
  agent().onNotification(dynamicMethod, parseValue, () => {});

  void agentContext.notify(methods.protocol.cancelRequest, { requestId: 1 });

  // @ts-expect-error ACP v2 has no JSON-RPC batch API.
  void agentContext.batch;
  // @ts-expect-error ACP v2 has no JSON-RPC batch API.
  void clientContext.batch;
}

void assertV2MethodTypes;

function memoryWireStreamPair(): [sdk.Stream, sdk.Stream] {
  const leftToRight = new TransformStream<sdk.AnyMessage>();
  const rightToLeft = new TransformStream<sdk.AnyMessage>();
  return [
    {
      readable: rightToLeft.readable,
      writable: leftToRight.writable,
    },
    {
      readable: leftToRight.readable,
      writable: rightToLeft.writable,
    },
  ];
}

async function respondToNextRequest(
  stream: sdk.Stream,
  result: unknown,
): Promise<void> {
  const reader = stream.readable.getReader();
  const request = await reader.read();
  reader.releaseLock();
  if (
    request.done ||
    Array.isArray(request.value) ||
    !("id" in request.value)
  ) {
    throw new Error("Expected one JSON-RPC request");
  }

  const writer = stream.writable.getWriter();
  try {
    await writer.write({
      jsonrpc: "2.0",
      id: request.value.id,
      result,
    });
  } finally {
    writer.releaseLock();
  }
}

describe("experimental v2 date-time schemas", () => {
  it("preserves RFC 3339 timestamps with timezone offsets as strings", () => {
    const timestamp = "2026-07-20T01:00:00+01:00";
    const annotations: Annotations = zAnnotations.parse({
      lastModified: timestamp,
    });
    const sessionInfo: SessionInfo = zSessionInfo.parse({
      sessionId: "session-1",
      cwd: "/workspace",
      updatedAt: timestamp,
    });
    const sessionInfoUpdate: SessionInfoUpdate = zSessionInfoUpdate.parse({
      updatedAt: timestamp,
    });

    expect(annotations.lastModified).toBe(timestamp);
    expect(sessionInfo.updatedAt).toBe(timestamp);
    expect(sessionInfoUpdate.updatedAt).toBe(timestamp);
  });
});

describe("v2 schema parsing matches the Rust schema crate", () => {
  describe.each([
    ["stable", stableZod],
    ["unstable", unstableZod],
  ] as const)("%s lane", (_lane, zod) => {
    it("parses null DefaultOnNull lists as empty and keeps omitted keys omitted", () => {
      const request = zod.zNewSessionRequest.parse({
        cwd: "/workspace",
        mcpServers: null,
        additionalDirectories: null,
      });
      expect(request.mcpServers).toEqual([]);
      expect(request.additionalDirectories).toEqual([]);

      const omitted = zod.zNewSessionRequest.parse({ cwd: "/workspace" });
      expect(omitted.mcpServers).toBeUndefined();
      expect(omitted.additionalDirectories).toBeUndefined();

      expect(
        zod.zMcpServerHttp.parse({
          name: "http",
          url: "https://example.com/mcp",
          headers: null,
        }).headers,
      ).toEqual([]);
      const terminal = zod.zAuthMethodTerminal.parse({
        methodId: "terminal",
        name: "Terminal",
        args: null,
        env: null,
      });
      expect(terminal.args).toEqual([]);
      expect(terminal.env).toEqual([]);
      // Only `null` is defaulted; a malformed list is still rejected.
      expect(
        zod.zNewSessionRequest.safeParse({ cwd: "/workspace", mcpServers: 1 })
          .success,
      ).toBe(false);
    });

    it("requires exactly one of sessionId / requestId in an elicitation scope", () => {
      const urlMode = {
        elicitationId: "elicitation-1",
        url: "https://example.com/consent",
      };
      expect(
        zod.zElicitationUrlMode.parse({ ...urlMode, sessionId: "session-1" }),
      ).toEqual({ ...urlMode, sessionId: "session-1" });
      expect(
        zod.zElicitationUrlMode.parse({ ...urlMode, requestId: 7 }),
      ).toEqual({ ...urlMode, requestId: 7 });

      for (const scope of [
        { sessionId: "session-1", requestId: "request-1" },
        { sessionId: 42, requestId: "request-1" },
        { sessionId: null, requestId: "request-1" },
        {},
      ]) {
        expect(
          zod.zElicitationUrlMode.safeParse({ ...urlMode, ...scope }).success,
        ).toBe(false);
        for (const mode of ["url", "form", "_vendor"]) {
          expect(
            zod.zCreateElicitationRequest.safeParse({
              ...urlMode,
              ...scope,
              mode,
              message: "Approve?",
              requestedSchema: {},
            }).success,
          ).toBe(false);
        }
      }

      expect(
        zod.zCreateElicitationRequest.parse({
          mode: "_vendor",
          message: "Approve?",
          requestId: "request-1",
          payload: { x: 1 },
        }),
      ).toEqual({
        mode: "_vendor",
        message: "Approve?",
        requestId: "request-1",
        payload: { x: 1 },
      });
    });

    it("checks 64-bit integers like i64 / u64", () => {
      // TerminalExitStatus.exitCode: Option<i64> with DefaultOnError.
      expect(zod.zTerminalExitStatus.parse({ exitCode: -1 }).exitCode).toBe(-1);
      expect(
        zod.zTerminalExitStatus.parse({ exitCode: 1.5 }).exitCode,
      ).toBeUndefined();

      // ResourceLink.size: Option<u64> with DefaultOnError.
      const link = { name: "file", uri: "file:///workspace/file.txt" };
      expect(zod.zResourceLink.parse({ ...link, size: 12 }).size).toBe(12);
      expect(zod.zResourceLink.parse({ ...link, size: -1 }).size).toBe(
        undefined,
      );
      expect(zod.zResourceLink.parse({ ...link, size: 1.5 }).size).toBe(
        undefined,
      );

      // RequestId: i64 or string, without a safe-integer bound.
      expect(zod.zRequestId.parse(-3)).toBe(-3);
      expect(zod.zRequestId.parse(2 ** 60)).toBe(2 ** 60);
      expect(zod.zRequestId.safeParse(1.5).success).toBe(false);
    });

    it("keeps custom available commands and skips malformed known ones", () => {
      const custom = {
        type: "_acme/macro",
        name: "deploy",
        description: "Deploy",
        steps: ["build", "ship"],
      };
      const command = { type: "command", name: "test", description: "Test" };
      expect(
        zod.zAvailableCommandsUpdate.parse({
          availableCommands: [
            command,
            custom,
            { type: "command", name: 5, description: "Bad" },
          ],
        }).availableCommands,
      ).toEqual([command, custom]);
      expect(
        zod.zAvailableCommand.safeParse({ type: "command", name: "missing" })
          .success,
      ).toBe(false);
    });
  });

  it("validates unstable u64 usage counters", () => {
    const usage = { totalTokens: 3, inputTokens: 1, outputTokens: 2 };
    expect(unstableZod.zUsage.safeParse(usage).success).toBe(true);
    expect(
      unstableZod.zUsage.safeParse({ ...usage, totalTokens: -1 }).success,
    ).toBe(false);
    expect(
      unstableZod.zUsage.safeParse({ ...usage, totalTokens: 1.5 }).success,
    ).toBe(false);
  });

  it("classifies only exclusive scopes as custom elicitation requests", () => {
    const request = {
      mode: "_vendor",
      message: "Approve?",
    } as sdk.CreateElicitationRequest;
    expect(
      guards.CreateElicitationRequest.isCustom({
        ...request,
        sessionId: "session-1",
      } as sdk.CreateElicitationRequest),
    ).toBe(true);
    expect(
      guards.CreateElicitationRequest.isCustom({
        ...request,
        sessionId: "session-1",
        requestId: "request-1",
      } as sdk.CreateElicitationRequest),
    ).toBe(false);
  });
});

describe("experimental v2 diff schemas", () => {
  it("uses text for git patch payloads", () => {
    const patch: DiffPatch = zDiffPatch.parse({
      format: "git_patch",
      text: "diff --git /workspace/a /workspace/a\n",
    });

    expect(patch.text).toBe("diff --git /workspace/a /workspace/a\n");
    expect(
      zDiffPatch.safeParse({
        format: "git_patch",
        diff: "diff --git /workspace/a /workspace/a\n",
      }).success,
    ).toBe(false);
  });
});

describe("experimental v2 streams", () => {
  it.each(["agent", "client"] as const)(
    "rejects JSON arrays on a v2 %s connection with a single -32600",
    async (side) => {
      let handled = 0;
      const app =
        side === "agent"
          ? agent()
              .onRequest(methods.agent.initialize, () => ({
                protocolVersion: PROTOCOL_VERSION,
                info: agentInfo,
              }))
              .onRequest(methods.agent.session.new, () => {
                handled += 1;
                return { sessionId: "session-1" };
              })
          : client();
      const [localStream, peerStream] = memoryWireStreamPair();
      const connection = app.connect(localStream);
      const writer = peerStream.writable.getWriter();
      const reader = peerStream.readable.getReader();
      const invalidBatch = {
        done: false,
        value: {
          jsonrpc: "2.0",
          id: null,
          error: expect.objectContaining({ code: -32600 }),
        },
      };

      try {
        for (const batch of [
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: methods.agent.initialize,
              params: { protocolVersion: PROTOCOL_VERSION, info: clientInfo },
            },
          ],
          [],
          [{ jsonrpc: "2.0", id: 1, result: {} }],
          [
            {
              jsonrpc: "2.0",
              id: 2,
              method: methods.agent.session.new,
              params: { cwd: "/workspace", mcpServers: [] },
            },
            { jsonrpc: "2.0", method: "_vendor/note" },
          ],
        ]) {
          await writer.write(batch as unknown as sdk.AnyMessage);
          await expect(reader.read()).resolves.toEqual(invalidBatch);
        }
        expect(handled).toBe(0);
        expect(connection.signal.aborted).toBe(false);
      } finally {
        writer.releaseLock();
        reader.releaseLock();
        connection.close();
        await connection.closed;
      }
    },
  );
});

describe("assertSupportedMcpServers", () => {
  const stdio: McpServer = {
    type: "stdio",
    name: "files",
    command: "/usr/bin/mcp-files",
    args: [],
    env: [],
  };
  const http: McpServer = {
    type: "http",
    name: "remote",
    url: "https://example.com/mcp",
    headers: [],
  };
  const acp: McpServer = {
    type: "acp",
    name: "client-tools",
    serverId: "tools-1",
  };

  function rejection(run: () => void): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected assertSupportedMcpServers to throw");
  }

  it("accepts no servers and advertised transports", () => {
    expect(() =>
      sdk.assertSupportedMcpServers(undefined, undefined),
    ).not.toThrow();
    expect(() => sdk.assertSupportedMcpServers([], null)).not.toThrow();
    expect(() =>
      sdk.assertSupportedMcpServers([stdio, http, acp], {
        stdio: {},
        http: {},
        acp: {},
      }),
    ).not.toThrow();
  });

  it("rejects duplicate server names", () => {
    const capabilities = { stdio: {}, http: {}, acp: {} };
    expect(
      rejection(() =>
        sdk.assertSupportedMcpServers(
          [stdio, http, { ...acp, name: stdio.name }],
          capabilities,
        ),
      ),
    ).toMatchObject({ code: -32602, data: { name: stdio.name } });
    expect(() =>
      sdk.assertSupportedMcpServers(
        [stdio, { ...stdio, name: "other-files" }],
        capabilities,
      ),
    ).not.toThrow();
  });

  it("rejects transports the agent did not advertise, including stdio", () => {
    for (const [server, capabilities] of [
      [stdio, undefined],
      [stdio, { http: {} }],
      [http, { stdio: {}, http: null }],
      [acp, { stdio: {}, http: {} }],
    ] as const) {
      expect(
        rejection(() => sdk.assertSupportedMcpServers([server], capabilities)),
      ).toMatchObject({
        code: -32602,
        data: { type: server.type },
      });
    }
  });

  it("rejects v1 sse, custom, and unknown transports", () => {
    const capabilities = { stdio: {}, http: {}, acp: {} };
    for (const type of ["sse", "_custom", "future"]) {
      const server = { type, name: "other", url: "https://example.com" };
      expect(
        rejection(() =>
          sdk.assertSupportedMcpServers(
            [stdio, server as unknown as McpServer],
            capabilities,
          ),
        ),
      ).toMatchObject({ code: -32602, data: { type } });
    }
  });

  it("rejects acp from the stable entrypoint, which cannot advertise it", () => {
    expect(
      rejection(() =>
        stableSdk.assertSupportedMcpServers(
          [acp as unknown as stableSdk.McpServer],
          { stdio: {}, http: {}, acp: {} } as stableSdk.McpCapabilities,
        ),
      ),
    ).toMatchObject({ code: -32602, data: { type: "acp" } });
  });
});

describe("experimental v2 app API", () => {
  it("defensively copies nested session request values", async () => {
    type NestedMeta = { nested: { value: string } };

    const requestMeta: NestedMeta = { nested: { value: "request" } };
    const httpMeta: NestedMeta = { nested: { value: "http" } };
    const headerMeta: NestedMeta = { nested: { value: "header" } };
    const headers = [
      {
        name: "Authorization",
        value: "original-header",
        _meta: headerMeta,
      },
    ];
    const httpServer = {
      type: "http",
      name: "http-server",
      url: "https://example.com/mcp",
      headers,
      _meta: httpMeta,
    } satisfies McpServer;

    const stdioMeta: NestedMeta = { nested: { value: "stdio" } };
    const envMeta: NestedMeta = { nested: { value: "env" } };
    const args = ["--mode", "test"];
    const env = [{ name: "TOKEN", value: "original-env", _meta: envMeta }];
    const stdioServer = {
      type: "stdio",
      name: "stdio-server",
      command: "/usr/bin/example-mcp",
      args,
      env,
      _meta: stdioMeta,
    } satisfies McpServer;

    const acpMeta: NestedMeta = { nested: { value: "acp" } };
    const acpServer = {
      type: "acp",
      name: "acp-server",
      serverId: "server-1",
      _meta: acpMeta,
    } satisfies McpServer;

    const customSettings = { nested: { value: "custom" } };
    const customServer = {
      type: "_vendor/custom",
      name: "custom-server",
      settings: customSettings,
    } satisfies McpServer;

    const additionalDirectories = ["/workspace/other"];
    const request = {
      cwd: "/workspace",
      additionalDirectories,
      mcpServers: [httpServer, stdioServer, acpServer, customServer],
      _meta: requestMeta,
    } satisfies NewSessionRequest;
    const expected = structuredClone(request);

    await client().connectWith(testAgent(), (agentClient) => {
      const builder = agentClient.buildSession(request);

      additionalDirectories[0] = "/mutated-input";
      requestMeta.nested.value = "mutated-input";
      httpServer.name = "mutated-input";
      headers[0].value = "mutated-input";
      headerMeta.nested.value = "mutated-input";
      httpMeta.nested.value = "mutated-input";
      args[0] = "mutated-input";
      env[0].value = "mutated-input";
      envMeta.nested.value = "mutated-input";
      stdioMeta.nested.value = "mutated-input";
      acpMeta.nested.value = "mutated-input";
      customSettings.nested.value = "mutated-input";
      request.mcpServers.pop();

      expect(builder.toRequest()).toEqual(expected);

      const returned = builder.toRequest();
      returned.additionalDirectories![0] = "/mutated-output";
      (returned._meta as NestedMeta).nested.value = "mutated-output";

      const returnedHttp = returned.mcpServers![0] as typeof httpServer;
      returnedHttp.name = "mutated-output";
      returnedHttp.headers![0].value = "mutated-output";
      (returnedHttp.headers![0]._meta as NestedMeta).nested.value =
        "mutated-output";
      (returnedHttp._meta as NestedMeta).nested.value = "mutated-output";

      const returnedStdio = returned.mcpServers![1] as typeof stdioServer;
      returnedStdio.args![0] = "mutated-output";
      returnedStdio.env![0].value = "mutated-output";
      (returnedStdio.env![0]._meta as NestedMeta).nested.value =
        "mutated-output";
      (returnedStdio._meta as NestedMeta).nested.value = "mutated-output";

      const returnedAcp = returned.mcpServers![2] as typeof acpServer;
      (returnedAcp._meta as NestedMeta).nested.value = "mutated-output";

      const returnedCustom = returned.mcpServers![3] as typeof customServer;
      returnedCustom.settings.nested.value = "mutated-output";
      returned.mcpServers!.pop();

      expect(builder.toRequest()).toEqual(expected);
    });
  });

  it("copies MCP servers when adding them to a session builder", async () => {
    type NestedMeta = { nested: { value: string } };

    const serverMeta: NestedMeta = { nested: { value: "server" } };
    const envMeta: NestedMeta = { nested: { value: "env" } };
    const args = ["--original"];
    const env = [{ name: "TOKEN", value: "original", _meta: envMeta }];
    const mcpServer = {
      type: "stdio",
      name: "stdio-server",
      command: "/usr/bin/example-mcp",
      args,
      env,
      _meta: serverMeta,
    } satisfies McpServer;
    const expected = structuredClone(mcpServer);

    await client().connectWith(testAgent(), (agentClient) => {
      const builder = agentClient
        .buildSession("/workspace")
        .withMcpServer(mcpServer);

      args[0] = "mutated-input";
      env[0].value = "mutated-input";
      envMeta.nested.value = "mutated-input";
      serverMeta.nested.value = "mutated-input";

      expect(builder.toRequest().mcpServers).toEqual([expected]);

      const returned = builder.toRequest().mcpServers![0] as typeof mcpServer;
      returned.args![0] = "mutated-output";
      returned.env![0].value = "mutated-output";
      (returned.env![0]._meta as NestedMeta).nested.value = "mutated-output";
      (returned._meta as NestedMeta).nested.value = "mutated-output";

      expect(builder.toRequest().mcpServers).toEqual([expected]);
    });
  });

  it("re-exports every generated extensible-union guard", () => {
    const guardNames = Object.keys(guards);
    expect(guardNames.length).toBeGreaterThan(0);
    for (const name of guardNames) {
      expect((sdk as Record<string, unknown>)[name]).toBe(
        (guards as Record<string, unknown>)[name],
      );
    }
  });

  describe("extensible unions", () => {
    it("check a known variant you build, at any depth", () => {
      // @ts-expect-error a select option with a field it does not have
      const option: sdk.SessionConfigOption = {
        type: "select",
        configId: "model",
        name: "Model",
        currentValue: "fast",
        options: [{ value: "fast", name: "Fast", title: "Fast model" }],
      };
      // @ts-expect-error a known variant missing a required field
      const usage: SessionUpdate = { sessionUpdate: "usage_update", used: 1 };
      // @ts-expect-error a misnamed field in a nested known block
      const chunk: SessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "m",
        content: { type: "text", txt: "hello" },
      };
      expect([option, usage, chunk]).toHaveLength(3);
    });

    it("accept custom variants only under a `_`-prefixed tag", () => {
      const custom: SessionUpdate = {
        sessionUpdate: "_acme/progress",
        percent: 40,
      };
      const customOption: sdk.SessionConfigOption = {
        type: "_slider",
        configId: "temperature",
        name: "Temperature",
        min: 0,
        max: 1,
      };
      const customBlock: SessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "m",
        content: { type: "_acme/widget", spec: 1 },
      };
      // @ts-expect-error unknown tags without `_` are reserved for future ACP versions
      const reserved: SessionUpdate = { sessionUpdate: "progress" };
      // @ts-expect-error a custom variant still carries the union's shared fields
      const missingShared: sdk.SessionConfigOption = {
        type: "_slider",
        name: "Temperature",
      };
      expect([
        custom,
        customOption,
        customBlock,
        reserved,
        missingShared,
      ]).toHaveLength(5);
    });

    it("pass on received values, unknown variants included", async () => {
      // A newer client sends a content block this SDK does not know. The agent
      // echoes the prompt into its user message without converting it.
      const futureBlock = { type: "future_block", payload: 1 };
      const echoed = Promise.withResolvers<SessionUpdate>();
      const agentApp = testAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: "s" }))
        .onRequest(
          methods.agent.session.prompt,
          async ({ params, client: agentClient }) => {
            await agentClient.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "user_message",
                messageId: "u",
                content: params.prompt,
              },
            });
            return { messageId: "u" };
          },
        );
      const clientApp = client().onNotification(
        methods.client.session.update,
        ({ params }) => echoed.resolve(params.update),
      );
      await clientApp.connectWith(agentApp, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        });
        await agent.request(methods.agent.session.prompt, {
          sessionId: "s",
          // Simulates a newer peer: a value you build cannot be unknown.
          prompt: [futureBlock as sdk.UnknownVariant<typeof futureBlock>],
        });
      });
      expect(await echoed.promise).toEqual({
        sessionUpdate: "user_message",
        messageId: "u",
        content: [futureBlock],
      });
    });

    it("keep known variants that have no tag", () => {
      const titled: sdk.MultiSelectItems = {
        anyOf: [{ const: "a", title: "A" }],
      };
      expect(titled).toBeDefined();
    });
  });

  it("initializes exactly once, queues later calls, and exposes the exchange", async () => {
    const initializeGate = Promise.withResolvers<void>();
    const agentReady = Promise.withResolvers<void>();
    const clientReady = Promise.withResolvers<void>();
    const events: string[] = [];
    let newSessionCalls = 0;
    let receivedInitialize: InitializeRequest | undefined;
    const requestMeta = { nested: { source: "client" } };

    const initializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      info: clientInfo,
      capabilities: {
        _meta: requestMeta,
      },
    } satisfies InitializeRequest;
    const initializeResponse = {
      protocolVersion: PROTOCOL_VERSION,
      info: agentInfo,
      capabilities: {
        session: {},
        _meta: { source: "agent" },
      },
    } satisfies InitializeResponse;
    const expectedInitializeRequest = structuredClone(initializeRequest);

    const agentApp = agent()
      .onConnect(async (connection) => {
        events.push("agent-connect");
        const initialization = await connection.initialized;
        events.push("agent-initialized");
        expect(initialization).toMatchObject({
          request: expectedInitializeRequest,
          response: initializeResponse,
        });
        agentReady.resolve();
      })
      .onRequest(methods.agent.initialize, async ({ params }) => {
        receivedInitialize = params;
        await initializeGate.promise;
        return initializeResponse;
      })
      .onRequest(methods.agent.session.new, () => {
        newSessionCalls += 1;
        return { sessionId: "session-1" };
      });
    const clientApp = client().onConnect(async (connection) => {
      events.push("client-connect");
      const initialization = await connection.initialized;
      events.push("client-initialized");
      expect(initialization).toMatchObject({
        request: expectedInitializeRequest,
        response: initializeResponse,
      });
      clientReady.resolve();
    });

    await clientApp.connectWith(agentApp, async (agentContext) => {
      await expect(
        agentContext.request(methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(
        agentContext.notify(methods.agent.session.cancel, {
          sessionId: "session-1",
        }),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(
        agentContext.request("_vendor/pre-initialize", {}),
      ).rejects.toMatchObject({ code: -32600 });
      expect(() =>
        agentContext.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
          _meta: { notCloneable: () => undefined },
        }),
      ).toThrow();

      const initialized = agentContext.request(
        methods.agent.initialize,
        initializeRequest,
      );
      requestMeta.nested.source = "mutated";
      const queuedSession = agentContext.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await Promise.resolve();
      expect(newSessionCalls).toBe(0);
      expect(() =>
        agentContext.request(methods.agent.initialize, initializeRequest),
      ).toThrow("Invalid request");

      initializeGate.resolve();
      await expect(initialized).resolves.toMatchObject(initializeResponse);
      await expect(queuedSession).resolves.toEqual({ sessionId: "session-1" });

      await expect(agentContext.initialized).resolves.toMatchObject({
        request: expectedInitializeRequest,
        response: initializeResponse,
      });
      expect(receivedInitialize).toMatchObject(expectedInitializeRequest);
      expect(events.slice(0, 2)).toEqual(["agent-connect", "client-connect"]);
      expect(events).toContain("client-initialized");
      expect(() =>
        agentContext.request(methods.agent.initialize, initializeRequest),
      ).toThrow("Invalid request");
    });
    await Promise.all([agentReady.promise, clientReady.promise]);
    expect(events).toContain("agent-initialized");
  });

  it("lets clients retry initialize after an error response but not after an unusable one", async () => {
    let initializeCalls = 0;
    const retryAgent = agent().onRequest(methods.agent.initialize, () => {
      initializeCalls += 1;
      if (initializeCalls === 1) {
        throw RequestError.invalidParams(undefined, "fix the params");
      }
      return { protocolVersion: PROTOCOL_VERSION, info: agentInfo };
    });
    const retryConnection = client().connect(retryAgent);
    try {
      const failed = retryConnection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const queued = retryConnection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await expect(failed).rejects.toMatchObject({ code: -32602 });
      await expect(queued).rejects.toMatchObject({ code: -32600 });
      expect(retryConnection.signal.aborted).toBe(false);

      await expect(
        retryConnection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        }),
      ).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
      await expect(retryConnection.initialized).resolves.toMatchObject({
        response: { info: agentInfo },
      });
      expect(initializeCalls).toBe(2);
    } finally {
      retryConnection.close();
      await retryConnection.closed;
    }

    // An agent that answers with a protocol version this client cannot use
    // fails initialization for good and closes the connection.
    const [clientStream, peerStream] = memoryWireStreamPair();
    const invalidConnection = client().connect(clientStream);
    const peerWriter = peerStream.writable.getWriter();
    const peerReader = peerStream.readable.getReader();
    try {
      const initialized = invalidConnection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        },
      );
      const queued = invalidConnection.agent.request(
        methods.agent.session.new,
        {
          cwd: "/workspace",
          mcpServers: [],
        },
      );
      const { value: request } = await peerReader.read();
      await peerWriter.write({
        jsonrpc: "2.0",
        id: (request as { id: number }).id,
        result: { protocolVersion: 1, info: agentInfo },
      });
      const initializeError = await initialized.catch((error) => error);
      expect(initializeError).toMatchObject({ code: -32600 });
      await expect(invalidConnection.initialized).rejects.toBe(initializeError);
      await expect(queued).rejects.toBe(initializeError);
      await expect(invalidConnection.agent.initialized).rejects.toBe(
        initializeError,
      );
      await invalidConnection.closed;
      expect(invalidConnection.signal.reason).toBe(initializeError);
      expect(() =>
        invalidConnection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        }),
      ).toThrow("Invalid request");
    } finally {
      peerWriter.releaseLock();
      peerReader.releaseLock();
      invalidConnection.close();
      await invalidConnection.closed;
    }
  });

  it("rejects pre-initialize requests and ignores notifications without failing the connection", async () => {
    let initializeCalls = 0;
    let newSessionCalls = 0;
    let notifications = 0;
    const agentApp = agent()
      .onRequest(methods.agent.initialize, () => {
        initializeCalls += 1;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
        };
      })
      .onRequest(methods.agent.session.new, () => {
        newSessionCalls += 1;
        return { sessionId: "session-1" };
      })
      .onNotification(methods.agent.session.cancel, () => {
        notifications += 1;
      });
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();
    const reader = peerStream.readable.getReader();

    try {
      await writer.write({
        jsonrpc: "2.0",
        method: methods.agent.session.cancel,
        params: { sessionId: "session-1" },
      });
      await writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: methods.agent.session.new,
        params: { cwd: "/workspace", mcpServers: [] },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: {
          id: 1,
          error: { code: -32600 },
        },
      });

      // A failed initialize also leaves the connection uninitialized.
      await writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: methods.agent.initialize,
        params: { protocolVersion: PROTOCOL_VERSION },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: 2, error: { code: -32602 } },
      });

      await writer.write({
        jsonrpc: "2.0",
        id: 3,
        method: methods.agent.initialize,
        params: {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: {
          id: 3,
          result: { protocolVersion: PROTOCOL_VERSION },
        },
      });
      await expect(connection.initialized).resolves.toMatchObject({
        request: { info: clientInfo },
      });

      await writer.write({
        jsonrpc: "2.0",
        id: 4,
        method: methods.agent.session.new,
        params: { cwd: "/workspace", mcpServers: [] },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: 4, result: { sessionId: "session-1" } },
      });
      expect(initializeCalls).toBe(1);
      expect(newSessionCalls).toBe(1);
      expect(notifications).toBe(0);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      connection.close();
      await connection.closed;
    }
  });

  it("requires an initialize handler before opening a connection", async () => {
    const agentApp = agent();
    const [firstStream] = memoryWireStreamPair();
    expect(() => agentApp.connect(firstStream)).toThrow(
      "requires an initialize request handler",
    );

    agentApp.onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      info: agentInfo,
    }));
    const [secondStream] = memoryWireStreamPair();
    const connection = agentApp.connect(secondStream);
    connection.close();
    await connection.closed;
    await expect(connection.initialized).rejects.toThrow(
      "ACP connection closed",
    );
  });

  it("ignores a cancellation notification before initialize", async () => {
    let initializeCalls = 0;
    const agentApp = agent().onRequest(methods.agent.initialize, () => {
      initializeCalls += 1;
      return {
        protocolVersion: PROTOCOL_VERSION,
        info: agentInfo,
      };
    });
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();
    const reader = peerStream.readable.getReader();

    try {
      await writer.write({
        jsonrpc: "2.0",
        method: methods.protocol.cancelRequest,
        params: { requestId: 999 },
      });
      const initializeWrite = writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: methods.agent.initialize,
        params: {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: 1, result: { protocolVersion: PROTOCOL_VERSION } },
      });
      await initializeWrite;
      expect(initializeCalls).toBe(1);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      connection.close();
      await connection.closed;
    }
  });

  it("rejects raw peer requests during an in-flight initialize", async () => {
    const initializeGate = Promise.withResolvers<void>();
    const initializeStarted = Promise.withResolvers<void>();
    let initializeCalls = 0;
    let newSessionCalls = 0;
    const agentApp = agent()
      .onRequest(methods.agent.initialize, async () => {
        initializeCalls += 1;
        initializeStarted.resolve();
        await initializeGate.promise;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
        };
      })
      .onRequest(methods.agent.session.new, () => {
        newSessionCalls += 1;
        return { sessionId: "session-1" };
      });
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();
    const reader = peerStream.readable.getReader();

    try {
      const initializeWrite = writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: methods.agent.initialize,
        params: {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        },
      });
      await initializeStarted.promise;

      for (const params of [
        { protocolVersion: "invalid" },
        { protocolVersion: PROTOCOL_VERSION, info: clientInfo },
      ]) {
        const duplicateWrite = writer.write({
          jsonrpc: "2.0",
          id: 3,
          method: methods.agent.initialize,
          params,
        });
        await expect(reader.read()).resolves.toMatchObject({
          done: false,
          value: {
            id: 3,
            error: { code: -32600 },
          },
        });
        await duplicateWrite;
      }

      await writer.write({
        jsonrpc: "2.0",
        method: methods.protocol.cancelRequest,
        params: { requestId: 999 },
      });
      const rejectedWrite = writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: methods.agent.session.new,
        params: { cwd: "/workspace", mcpServers: [] },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: {
          id: 2,
          error: { code: -32600 },
        },
      });
      await rejectedWrite;
      expect(newSessionCalls).toBe(0);

      const initializeResponse = reader.read();
      initializeGate.resolve();
      await expect(initializeResponse).resolves.toMatchObject({
        done: false,
        value: {
          id: 1,
          result: { protocolVersion: PROTOCOL_VERSION },
        },
      });
      await initializeWrite;
      expect(initializeCalls).toBe(1);

      const sessionWrite = writer.write({
        jsonrpc: "2.0",
        id: 5,
        method: methods.agent.session.new,
        params: { cwd: "/workspace", mcpServers: [] },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: {
          id: 5,
          result: { sessionId: "session-1" },
        },
      });
      await sessionWrite;
      expect(newSessionCalls).toBe(1);

      const malformedCancelWrite = writer.write({
        jsonrpc: "2.0",
        id: 4,
        method: methods.protocol.cancelRequest,
        params: { requestId: 999 },
      });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: 4, error: { code: -32601 } },
      });
      await malformedCancelWrite;
    } finally {
      initializeGate.resolve();
      writer.releaseLock();
      reader.releaseLock();
      connection.close();
      await connection.closed;
    }
  });

  it("accepts repeated raw initialize requests until another request arrives", async () => {
    const received: InitializeRequest[] = [];
    let failNextInitialize = false;
    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ params }) => {
        received.push(params);
        if (failNextInitialize) {
          failNextInitialize = false;
          throw new Error("initialize failed");
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: { ...agentInfo, title: `call ${received.length}` },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }));
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();
    const reader = peerStream.readable.getReader();
    const call = async (id: number, method: string, params: unknown) => {
      await writer.write({ jsonrpc: "2.0", id, method, params });
      const response = await reader.read();
      return response.value;
    };

    try {
      await expect(
        call(1, methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION + 1,
          info: clientInfo,
          capabilities: { auth: { terminal: {} } },
        }),
      ).resolves.toMatchObject({
        id: 1,
        result: { protocolVersion: PROTOCOL_VERSION },
      });
      await expect(connection.initialized).resolves.toMatchObject({
        request: { capabilities: { auth: { terminal: {} } } },
      });

      const repeated = {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "repeat-client", version: "2.0.0" },
        capabilities: { elicitation: { form: {} } },
      };
      await expect(
        call(2, methods.agent.initialize, repeated),
      ).resolves.toMatchObject({
        id: 2,
        result: { info: { title: "call 2" } },
      });
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(repeated);
      await expect(connection.initialized).resolves.toMatchObject({
        request: repeated,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          info: { ...agentInfo, title: "call 2" },
        },
      });

      // A repeat must not request a version below the selected one.
      await expect(
        call(3, methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        }),
      ).resolves.toMatchObject({ id: 3, error: { code: -32600 } });
      // Failed repeats keep the previous initialization in effect.
      await expect(
        call(4, methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
        }),
      ).resolves.toMatchObject({ id: 4, error: { code: -32602 } });
      failNextInitialize = true;
      await expect(
        call(5, methods.agent.initialize, repeated),
      ).resolves.toMatchObject({ id: 5, error: { code: -32603 } });
      expect(received).toHaveLength(3);
      await expect(connection.initialized).resolves.toMatchObject({
        request: repeated,
        response: { info: { title: "call 2" } },
      });

      await expect(
        call(6, methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).resolves.toMatchObject({ id: 6, result: { sessionId: "session-1" } });
      await expect(
        call(7, methods.agent.initialize, repeated),
      ).resolves.toMatchObject({ id: 7, error: { code: -32600 } });
      expect(received).toHaveLength(3);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      connection.close();
      await connection.closed;
    }
  });

  it("lets clients repeat initialize before sending other requests", async () => {
    const received: InitializeRequest[] = [];
    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ params }) => {
        received.push(params);
        return { protocolVersion: PROTOCOL_VERSION, info: agentInfo };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }));
    const agentConnection = Promise.withResolvers<sdk.AgentConnection>();
    agentApp.onConnect((connection) => agentConnection.resolve(connection));

    await client().connectWith(agentApp, async (agentContext) => {
      await agentContext.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const repeated = {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
        capabilities: { auth: { terminal: {} } },
      } satisfies InitializeRequest;
      const repeat = agentContext.request(methods.agent.initialize, repeated);
      expect(() =>
        agentContext.request(methods.agent.initialize, repeated),
      ).toThrow("Invalid request");
      // Requests issued during the repeat wait for it to complete.
      const session = agentContext.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await expect(repeat).resolves.toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
      });
      await expect(session).resolves.toEqual({ sessionId: "session-1" });
      expect(received).toHaveLength(2);
      await expect(agentContext.initialized).resolves.toMatchObject({
        request: repeated,
      });
      await expect(
        (await agentConnection.promise).initialized,
      ).resolves.toMatchObject({ request: repeated });
      expect(() =>
        agentContext.request(methods.agent.initialize, repeated),
      ).toThrow("Invalid request");
    });
  });

  it("ignores unparsable initialize params only for newer protocol versions", async () => {
    const received: InitializeRequest[] = [];
    const agentApp = agent().onRequest(
      methods.agent.initialize,
      ({ params }) => {
        received.push(params);
        return { protocolVersion: PROTOCOL_VERSION, info: agentInfo };
      },
    );
    const malformed = {
      info: { name: 42 },
      capabilities: {
        auth: { terminal: "yes" },
        elicitation: { form: {}, url: 7 },
        futureCapability: { enabled: true },
      },
      _meta: "not an object",
    };

    for (const id of [1, 2]) {
      const [agentStream, peerStream] = memoryWireStreamPair();
      const connection = agentApp.connect(agentStream);
      const writer = peerStream.writable.getWriter();
      const reader = peerStream.readable.getReader();
      try {
        await writer.write({
          jsonrpc: "2.0",
          id,
          method: methods.agent.initialize,
          params: {
            protocolVersion: id === 1 ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
            ...malformed,
          },
        });
        const response = await reader.read();
        if (id === 1) {
          expect(response.value).toMatchObject({
            id,
            result: { protocolVersion: PROTOCOL_VERSION },
          });
        } else {
          expect(response.value).toMatchObject({
            id,
            error: { code: -32602 },
          });
        }
      } finally {
        writer.releaseLock();
        reader.releaseLock();
        connection.close();
        await connection.closed;
      }
    }

    expect(received).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "unknown", version: "unknown" },
        capabilities: { auth: {}, elicitation: { form: {} } },
      },
    ]);
  });

  it("rejects null and non-integer request IDs", async () => {
    let initializeCalls = 0;
    const agentApp = agent().onRequest(methods.agent.initialize, () => {
      initializeCalls += 1;
      return { protocolVersion: PROTOCOL_VERSION, info: agentInfo };
    });
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();
    const reader = peerStream.readable.getReader();
    const initialize = {
      jsonrpc: "2.0",
      method: methods.agent.initialize,
      params: { protocolVersion: PROTOCOL_VERSION, info: clientInfo },
    } as const;

    try {
      for (const id of [null, 1.5]) {
        await writer.write({ ...initialize, id });
        await expect(reader.read()).resolves.toMatchObject({
          done: false,
          value: { id: null, error: { code: -32600 } },
        });
      }
      expect(initializeCalls).toBe(0);

      await writer.write({ ...initialize, id: 1 });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: 1, result: { protocolVersion: PROTOCOL_VERSION } },
      });
      await writer.write({ ...initialize, id: null, method: "_vendor/x" });
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: { id: null, error: { code: -32600 } },
      });
      expect(initializeCalls).toBe(1);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      connection.close();
      await connection.closed;
    }

    const [clientStream, agentPeerStream] = memoryWireStreamPair();
    const clientConnection = client().connect(clientStream);
    const agentWriter = agentPeerStream.writable.getWriter();
    const agentReader = agentPeerStream.readable.getReader();
    try {
      await agentWriter.write({
        jsonrpc: "2.0",
        id: null,
        method: "_vendor/x",
        params: {},
      });
      await expect(agentReader.read()).resolves.toMatchObject({
        done: false,
        value: { id: null, error: { code: -32600 } },
      });
    } finally {
      agentWriter.releaseLock();
      agentReader.releaseLock();
      clientConnection.close();
      await clientConnection.closed;
    }
  });

  it("rejects queued peer calls when an in-flight initialize connection closes", async () => {
    const initializeGate = Promise.withResolvers<void>();
    const initializeStarted = Promise.withResolvers<void>();
    const agentApp = agent().onRequest(methods.agent.initialize, async () => {
      initializeStarted.resolve();
      await initializeGate.promise;
      return {
        protocolVersion: PROTOCOL_VERSION,
        info: agentInfo,
      };
    });
    const [agentStream, peerStream] = memoryWireStreamPair();
    const connection = agentApp.connect(agentStream);
    const writer = peerStream.writable.getWriter();

    try {
      const initializeWrite = writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: methods.agent.initialize,
        params: {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        },
      });
      await initializeStarted.promise;
      await initializeWrite;

      const queuedCall = connection.client.request("_vendor/queued", {});
      connection.close();
      await expect(queuedCall).rejects.toThrow("ACP connection closed");
    } finally {
      initializeGate.resolve();
      writer.releaseLock();
      connection.close();
      await connection.closed;
    }
  });

  it("reports idle independently of pending prompt insertion", async () => {
    let updateClient: AgentContext | undefined;
    const promptReceived = Promise.withResolvers<void>();
    const promptResponse = Promise.withResolvers<PromptResponse>();

    const agentApp = agent()
      .onRequest(
        methods.agent.initialize,
        ({ params, client: agentClient }) => {
          updateClient = agentClient;
          return {
            protocolVersion: params.protocolVersion,
            info: agentInfo,
            capabilities: { session: {} },
          };
        },
      )
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
      .onRequest(methods.agent.session.prompt, ({ client: agentClient }) => {
        updateClient = agentClient;
        promptReceived.resolve();
        return promptResponse.promise;
      });

    await client().connectWith(agentApp, async (agentClient) => {
      await expect(
        agentClient.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
          capabilities: {},
        }),
      ).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });

      const session = await agentClient.buildSession("/workspace").start();
      try {
        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "state_update", state: "idle" },
        });
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "stop",
          update: { sessionUpdate: "state_update", state: "idle" },
        });
        let inserted = false;
        const prompt = session.prompt("Hello").then((response) => {
          inserted = true;
          return response;
        });
        await promptReceived.promise;
        expect(updateClient).toBeDefined();

        const updates: SessionUpdate[] = [
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "Hello" },
          },
          { sessionUpdate: "state_update", state: "running" },
          { sessionUpdate: "state_update", state: "idle" },
        ];
        for (const update of updates) {
          await updateClient!.notify(methods.client.session.update, {
            sessionId: session.sessionId,
            update,
          });
        }

        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "session_update",
          update: { sessionUpdate: "agent_message_chunk" },
        });
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "session_update",
          update: { sessionUpdate: "state_update", state: "running" },
        });
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "stop",
          update: { sessionUpdate: "state_update", state: "idle" },
          stopReason: undefined,
        });
        expect(inserted).toBe(false);
        promptResponse.resolve({ messageId: "user-message-1" });
        await expect(prompt).resolves.toEqual({
          messageId: "user-message-1",
        });
      } finally {
        promptResponse.resolve({ messageId: "user-message-1" });
        session.dispose();
      }
    });
  });

  it("keeps ActiveSession.configOptions in sync with config updates", async () => {
    let updateClient: AgentContext | undefined;
    const modelOption = (currentValue: string) => ({
      configId: "model",
      name: "Model",
      type: "select" as const,
      currentValue,
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    });
    const setRequests: unknown[] = [];

    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ client: agentClient }) => {
        updateClient = agentClient;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
          capabilities: { session: {} },
        };
      })
      .onRequest(methods.agent.session.new, () => ({
        sessionId: "session-1",
        configOptions: [modelOption("fast")],
      }))
      .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        setRequests.push(params);
        return { configOptions: [modelOption(String(params.value))] };
      });

    await client().connectWith(agentApp, async (agentClient) => {
      await agentClient.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const session = await agentClient.buildSession("/workspace").start();
      try {
        expect(session.configOptions).toEqual([modelOption("fast")]);

        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [modelOption("smart")],
          },
        });
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "session_update",
          update: { sessionUpdate: "config_option_update" },
        });
        expect(session.configOptions).toEqual([modelOption("smart")]);
        expect(session.newSessionResponse.configOptions).toEqual([
          modelOption("fast"),
        ]);

        await expect(
          session.setConfigOption({
            configId: "model",
            type: "id",
            value: "fast",
          }),
        ).resolves.toEqual({ configOptions: [modelOption("fast")] });
        expect(setRequests).toEqual([
          {
            sessionId: "session-1",
            configId: "model",
            type: "id",
            value: "fast",
          },
        ]);
        expect(session.configOptions).toEqual([modelOption("fast")]);
      } finally {
        session.dispose();
      }
    });
  });

  it("keeps session reads independent of overlapping prompt responses", async () => {
    let updateClient: AgentContext | undefined;
    const firstPrompt = Promise.withResolvers<PromptResponse>();
    const secondPrompt = Promise.withResolvers<PromptResponse>();
    const bothPromptsReceived = Promise.withResolvers<void>();
    let promptCount = 0;

    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ client: agentClient }) => {
        updateClient = agentClient;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
          capabilities: { session: {} },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
      .onRequest(methods.agent.session.prompt, () => {
        promptCount += 1;
        if (promptCount === 2) {
          bothPromptsReceived.resolve();
        }
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      });

    await client().connectWith(agentApp, async (agentClient) => {
      await agentClient.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const session = await agentClient.buildSession("/workspace").start();
      try {
        const first = session.prompt("First");
        const text = session.readTextUntilIdle();
        const second = session.prompt("Second");
        await bothPromptsReceived.promise;

        firstPrompt.reject(new Error("first prompt rejected"));
        await expect(first).rejects.toThrow("Internal error");

        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "session output" },
          },
        });
        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });
        await expect(text).resolves.toBe("session output");
        secondPrompt.resolve({ messageId: "user-message-2" });
        await expect(second).resolves.toEqual({
          messageId: "user-message-2",
        });

        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "stop",
          stopReason: "end_turn",
        });
      } finally {
        firstPrompt.resolve({ messageId: "user-message-1" });
        secondPrompt.resolve({ messageId: "user-message-2" });
        session.dispose();
      }
    });
  });

  it("reads full agent messages and applies replacement semantics", async () => {
    let updateClient: AgentContext | undefined;
    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ client: agentClient }) => {
        updateClient = agentClient;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
          capabilities: { session: {} },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
      .onRequest(methods.agent.session.prompt, () => ({
        messageId: "user-message-1",
      }));

    await client().connectWith(agentApp, async (agentClient) => {
      await agentClient.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const session = await agentClient.buildSession("/workspace").start();
      try {
        await session.prompt("Hello");
        const text = session.readTextUntilIdle();
        const updates: SessionUpdate[] = [
          {
            sessionUpdate: "agent_message",
            messageId: "message-1",
            content: [{ type: "text", text: "old" }],
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: " chunk" },
          },
          {
            sessionUpdate: "agent_message",
            messageId: "message-1",
            content: [{ type: "text", text: "replacement" }],
          },
          {
            sessionUpdate: "agent_message",
            messageId: "message-2",
            content: [{ type: "text", text: " second" }],
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-2",
            content: { type: "text", text: "!" },
          },
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        ];
        for (const update of updates) {
          await updateClient!.notify(methods.client.session.update, {
            sessionId: session.sessionId,
            update,
          });
        }

        await expect(text).resolves.toBe("replacement second!");
      } finally {
        session.dispose();
      }
    });
  });

  it("preserves queued session output across prompt submissions", async () => {
    let updateClient: AgentContext | undefined;
    let promptCount = 0;
    const agentApp = agent()
      .onRequest(methods.agent.initialize, ({ client: agentClient }) => {
        updateClient = agentClient;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
          capabilities: { session: {} },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
      .onRequest(methods.agent.session.prompt, () => ({
        messageId: `user-message-${++promptCount}`,
      }));

    await client().connectWith(agentApp, async (agentClient) => {
      await agentClient.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const session = await agentClient.buildSession("/workspace").start();
      try {
        await session.prompt("First");
        for (const update of [
          {
            sessionUpdate: "agent_message",
            messageId: "message-1",
            content: [{ type: "text", text: "first" }],
          },
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
          {
            sessionUpdate: "agent_message",
            messageId: "background-message",
            content: [{ type: "text", text: "background" }],
          },
        ] satisfies SessionUpdate[]) {
          await updateClient!.notify(methods.client.session.update, {
            sessionId: session.sessionId,
            update,
          });
        }

        await session.prompt("Second");
        await expect(session.readTextUntilIdle()).resolves.toBe("first");
        const text = session.readTextUntilIdle();
        for (const update of [
          {
            sessionUpdate: "agent_message",
            messageId: "message-2",
            content: [{ type: "text", text: "second" }],
          },
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        ] satisfies SessionUpdate[]) {
          await updateClient!.notify(methods.client.session.update, {
            sessionId: session.sessionId,
            update,
          });
        }

        await expect(text).resolves.toBe("backgroundsecond");
      } finally {
        session.dispose();
      }
    });
  });

  it("fixes initialization to the v2 protocol boundary", async () => {
    let receivedVersion: number | undefined;
    const agentApp = agent().onRequest(
      methods.agent.initialize,
      ({ params }) => {
        receivedVersion = params.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSION,
          info: agentInfo,
        };
      },
    );

    await expect(
      client().connectWith(agentApp, async (agentClient) => {
        const response: InitializeResponse = await agentClient.request(
          methods.agent.initialize,
          { protocolVersion: 1, info: clientInfo },
        );
        return response;
      }),
    ).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    expect(receivedVersion).toBe(PROTOCOL_VERSION);

    const wrongVersionAgent = agent().onRequest(
      methods.agent.initialize,
      () => ({ protocolVersion: 1, info: agentInfo }),
    );
    await expect(
      client().connectWith(wrongVersionAgent, (agentClient) =>
        agentClient.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        }),
      ),
    ).rejects.toMatchObject({ code: -32600 });
  });

  it("validates every built-in direct response before returning it", async () => {
    const [clientStream, peerStream] = memoryWireStreamPair();
    const response = client().connectWith(
      clientStream,
      async (agentContext) => {
        await agentContext.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        });
        return agentContext.request(methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
      },
    );

    await respondToNextRequest(peerStream, {
      protocolVersion: PROTOCOL_VERSION,
      info: agentInfo,
    });
    await respondToNextRequest(peerStream, { sessionId: 42 });
    await expect(response).rejects.toThrow();
  });

  it("rejects peer null for empty responses but preserves local void handlers", async () => {
    const [clientStream, peerStream] = memoryWireStreamPair();
    const invalidResponse = client().connectWith(
      clientStream,
      async (agentContext) => {
        await agentContext.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: clientInfo,
        });
        return agentContext.request(methods.agent.session.delete, {
          sessionId: "session-1",
        });
      },
    );

    await respondToNextRequest(peerStream, {
      protocolVersion: PROTOCOL_VERSION,
      info: agentInfo,
    });
    await respondToNextRequest(peerStream, null);
    await expect(invalidResponse).rejects.toThrow();

    await expect(
      client().connectWith(
        agent()
          .onRequest(methods.agent.initialize, () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: agentInfo,
          }))
          .onRequest(methods.agent.session.delete, () => {}),
        async (agentContext) => {
          await agentContext.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: clientInfo,
          });
          return agentContext.request(methods.agent.session.delete, {
            sessionId: "session-1",
          });
        },
      ),
    ).resolves.toEqual({});
  });

  it("supports unrecognized protocol methods and underscore extensions", async () => {
    const parseValue = (params: unknown): { value: string } =>
      params as { value: string };
    const returnValue = ({ params }: { params: { value: string } }) => params;

    let agentNotificationValue: string | undefined;
    let clientNotificationValue: string | undefined;
    let initializedNotificationValue: string | undefined;
    const notificationSent = Promise.withResolvers<void>();
    const clientApp = client()
      .onRequest("authentication/logout", parseValue, returnValue)
      .onNotification("authentication/status", parseValue, ({ params }) => {
        clientNotificationValue = params.value;
      })
      .onNotification("_vendor/acme/event", parseValue, ({ params }) => {
        initializedNotificationValue = params.value;
      });
    const agentApp = agent()
      .onRequest("session/load", parseValue, async ({ params, client }) => {
        const response = await client.request<
          { value: string },
          { value: string },
          "authentication/logout"
        >("authentication/logout", params);
        await client.notify("authentication/status", params);
        return response;
      })
      .onRequest("_vendor/acme/echo", parseValue, returnValue)
      .onNotification("session/set_model", parseValue, ({ params }) => {
        agentNotificationValue = params.value;
      })
      .onConnect(async (connection) => {
        await connection.initialized;
        try {
          await connection.client.notify("_vendor/acme/event", {
            value: "initialized notification",
          });
          notificationSent.resolve();
        } catch (error) {
          notificationSent.reject(error);
          throw error;
        }
      })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        info: agentInfo,
      }));

    await clientApp.connectWith(agentApp, async (agentContext) => {
      const wrongDirection: string = methods.client.mcp.message;
      expect(() =>
        agentContext.request(wrongDirection, {
          serverId: "server-1",
          requestId: "request-1",
          method: "tools/list",
        }),
      ).toThrow("not valid in this direction");

      await agentContext.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      await notificationSent.promise;
      expect(initializedNotificationValue).toBe("initialized notification");
      await expect(
        agentContext.request<
          { value: string },
          { value: string },
          "session/load"
        >("session/load", { value: "legacy response" }),
      ).resolves.toEqual({ value: "legacy response" });
      expect(clientNotificationValue).toBe("legacy response");

      await agentContext.notify("session/set_model", {
        value: "direct notification",
      });
      expect(agentNotificationValue).toBe("direct notification");

      await expect(
        agentContext.request<{ value: string }, { value: string }>(
          "_vendor/acme/echo",
          { value: "response" },
        ),
      ).resolves.toEqual({ value: "response" });
    });

    const dynamicBuiltIn: string = methods.agent.session.new;
    expect(() =>
      agent().onRequest(dynamicBuiltIn, parseValue, returnValue),
    ).toThrow("Cannot replace the built-in");
  });
});
