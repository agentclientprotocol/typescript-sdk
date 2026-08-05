import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROTOCOL_VERSION,
  agent,
  batchNotification,
  batchRequest,
  client,
  methods,
} from "./acp.js";
import * as sdk from "./acp.js";
import * as guards from "./schema/guards.gen.js";
import {
  zAnnotations,
  zDiffPatch,
  zSessionInfo,
  zSessionInfoUpdate,
} from "./schema/zod.gen.js";
import type {
  AgentContext,
  Annotations,
  ClientContext,
  DiffPatch,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  SessionInfo,
  SessionInfoUpdate,
  SessionUpdate,
} from "./acp.js";

const clientInfo = { name: "test-client", version: "1.0.0" };
const agentInfo = { name: "test-agent", version: "1.0.0" };

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
  agentContext.request(methods.client.mcp.disconnect, {
    connectionId: "connection-1",
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

  const outputs = agentContext.batch([
    batchRequest(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    }),
    batchNotification(methods.agent.session.cancel, {
      sessionId: "session-1",
    }),
  ] as const);
  expectTypeOf(outputs).toEqualTypeOf<Promise<[NewSessionResponse, void]>>();
  void agentContext.notify(methods.protocol.cancelRequest, { requestId: 1 });

  const clientRequest = batchRequest(methods.client.mcp.disconnect, {
    connectionId: "connection-1",
  });
  // @ts-expect-error Notification methods cannot be used as batch requests.
  batchRequest(methods.agent.session.cancel, { sessionId: "session-1" });
  // @ts-expect-error Request methods cannot be used as batch notifications.
  batchNotification(methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
  // @ts-expect-error Client-directed methods cannot be sent in an agent-directed batch.
  agentContext.batch([clientRequest] as const);
  agentContext.batch([
    // @ts-expect-error Raw built-in batch entries must use method-specific params.
    {
      kind: "request",
      method: methods.agent.session.new,
      params: { sessionId: "wrong" },
    },
  ] as const);
  agentContext.batch([
    batchRequest("session/load", { sessionId: "session-1" }),
    batchNotification("session/set_model", { modelId: "model-1" }),
  ] as const);
  const legacyAgentEntry: sdk.AgentBatchEntry = batchRequest("session/load", {
    sessionId: "session-1",
  });
  const legacyClientEntry: sdk.ClientBatchEntry = batchNotification(
    "authentication/status",
    {},
  );
  void legacyAgentEntry;
  void legacyClientEntry;
  agentContext.batch([
    { kind: "request", method: dynamicMethod, params: {} },
    { kind: "notification", method: dynamicMethod, params: {} },
  ] as const);

  clientContext.batch([clientRequest] as const);
}

void assertV2MethodTypes;

function memoryWireStreamPair(): [sdk.Stream, sdk.Stream] {
  const leftToRight = new TransformStream<sdk.AnyWireMessage>();
  const rightToLeft = new TransformStream<sdk.AnyWireMessage>();
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
  it("defaults NDJSON streams to batch-capable wire messages", async () => {
    const chunks: Uint8Array[] = [];
    const stream = sdk.ndJsonStream(
      new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      }),
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    );
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "example/request" },
      { jsonrpc: "2.0", method: "example/notification" },
    ] as const satisfies sdk.AnyWireMessage;
    const typedStream: sdk.Stream = stream;
    const writer = typedStream.writable.getWriter();

    await writer.write(batch);
    writer.releaseLock();

    expect(new TextDecoder().decode(chunks[0])).toBe(
      `${JSON.stringify(batch)}\n`,
    );
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

    await client().connectWith(agent(), (agentClient) => {
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

    await client().connectWith(agent(), (agentClient) => {
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

  it("does not complete a prompt from an idle update received before it", async () => {
    let updateClient: AgentContext | undefined;

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
        await expect(session.prompt("Hello")).resolves.toEqual({});
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
          update: { sessionUpdate: "state_update", state: "idle" },
        });
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
      } finally {
        session.dispose();
      }
    });
  });

  it("keeps overlapping prompt activity isolated when one request fails", async () => {
    let updateClient: AgentContext | undefined;
    const firstPrompt = Promise.withResolvers<void>();
    const secondPrompt = Promise.withResolvers<void>();
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
        const firstText = session.readText();
        const second = session.prompt("Second");
        await bothPromptsReceived.promise;
        await expect(firstText).rejects.toThrow(
          "cannot attribute updates across overlapping prompts",
        );
        await expect(session.readText()).rejects.toThrow(
          "cannot attribute updates across overlapping prompts",
        );

        firstPrompt.reject(new Error("first prompt rejected"));
        await expect(first).rejects.toThrow("Internal error");
        secondPrompt.resolve();
        await expect(second).resolves.toEqual({});

        await updateClient!.notify(methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });

        await expect(session.nextUpdate()).rejects.toThrow("Internal error");
        await expect(session.nextUpdate()).resolves.toMatchObject({
          kind: "stop",
          stopReason: "end_turn",
        });
      } finally {
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
      .onRequest(methods.agent.session.prompt, () => {});

    await client().connectWith(agentApp, async (agentClient) => {
      await agentClient.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      const session = await agentClient.buildSession("/workspace").start();
      try {
        await session.prompt("Hello");
        const text = session.readText();
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

  it("starts text reads at the latest prompt boundary", async () => {
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
      .onRequest(methods.agent.session.prompt, () => {});

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
        const text = session.readText();
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

        await expect(text).resolves.toBe("second");
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
        const [response] = await agentClient.batch([
          batchRequest(
            methods.agent.initialize,
            { protocolVersion: 1, info: clientInfo },
            (value: InitializeResponse) => value,
          ),
        ] as const);
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
    const response = client().connectWith(clientStream, (agentContext) =>
      agentContext.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    );

    await respondToNextRequest(peerStream, { sessionId: 42 });
    await expect(response).rejects.toThrow();
  });

  it("validates built-in batch responses before applying caller mappings", async () => {
    const [clientStream, peerStream] = memoryWireStreamPair();
    let mapped = false;
    const response = client().connectWith(clientStream, (agentContext) =>
      agentContext.batch([
        batchRequest(
          methods.agent.session.new,
          { cwd: "/workspace", mcpServers: [] },
          (session) => {
            mapped = true;
            return session.sessionId;
          },
        ),
      ] as const),
    );

    const reader = peerStream.readable.getReader();
    const request = await reader.read();
    reader.releaseLock();
    if (
      request.done ||
      !Array.isArray(request.value) ||
      request.value.length !== 1 ||
      !("id" in request.value[0])
    ) {
      throw new Error("Expected one JSON-RPC batch request");
    }
    const writer = peerStream.writable.getWriter();
    try {
      await writer.write([
        {
          jsonrpc: "2.0",
          id: request.value[0].id,
          result: { sessionId: 42 },
        },
      ]);
    } finally {
      writer.releaseLock();
    }

    await expect(response).rejects.toThrow();
    expect(mapped).toBe(false);
  });

  it("rejects peer null for empty responses but preserves local void handlers", async () => {
    const [clientStream, peerStream] = memoryWireStreamPair();
    const invalidResponse = client().connectWith(clientStream, (agentContext) =>
      agentContext.request(methods.agent.session.delete, {
        sessionId: "session-1",
      }),
    );

    await respondToNextRequest(peerStream, null);
    await expect(invalidResponse).rejects.toThrow();

    await expect(
      client().connectWith(
        agent().onRequest(methods.agent.session.delete, () => {}),
        (agentContext) =>
          agentContext.request(methods.agent.session.delete, {
            sessionId: "session-1",
          }),
      ),
    ).resolves.toEqual({});
  });

  it("supports unrecognized protocol methods and underscore extensions", async () => {
    const parseValue = (params: unknown): { value: string } =>
      params as { value: string };
    const returnValue = ({ params }: { params: { value: string } }) => params;

    let agentNotificationValue: string | undefined;
    let clientNotificationValue: string | undefined;
    const clientApp = client()
      .onRequest("authentication/logout", parseValue, returnValue)
      .onNotification("authentication/status", parseValue, ({ params }) => {
        clientNotificationValue = params.value;
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
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        info: agentInfo,
      }));

    await clientApp.connectWith(agentApp, async (agentContext) => {
      const wrongDirection: string = methods.client.mcp.disconnect;
      expect(() =>
        agentContext.request(wrongDirection, { connectionId: "connection-1" }),
      ).toThrow("not valid in this direction");
      expect(() =>
        agentContext.batch([
          {
            kind: "request",
            method: wrongDirection,
            params: { connectionId: "connection-1" },
          },
        ] as const),
      ).toThrow("not valid in this direction");

      await agentContext.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
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

      const [batchResponse] = await agentContext.batch([
        batchRequest<{ value: string }, { value: string }, "session/load">(
          "session/load",
          { value: "batch response" },
        ),
        batchNotification("session/set_model", {
          value: "batch notification",
        }),
      ] as const);
      expect(batchResponse).toEqual({ value: "batch response" });
      expect(agentNotificationValue).toBe("batch notification");

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
