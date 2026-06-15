import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as z from "zod/v4";
import {
  zAnnotations,
  zClientCapabilities,
  zCreateElicitationRequest,
  zCreateElicitationResponse,
  zInitializeResponse,
  zPlan,
  zToolCall,
} from "./schema/zod.gen.js";
import type {
  zNewSessionResponse,
  zSessionModeState,
  zSessionNotification,
  zSessionUpdate,
} from "./schema/zod.gen.js";
import {
  Agent,
  ClientSideConnection,
  Client,
  Connection,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  PromptRequest,
  PromptResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CancelNotification,
  SessionNotification,
  PROTOCOL_VERSION,
  ndJsonStream,
  StartNesRequest,
  StartNesResponse,
  SuggestNesRequest,
  SuggestNesResponse,
  CloseNesRequest,
  CloseNesResponse,
  AcceptNesNotification,
  RejectNesNotification,
  DidOpenDocumentNotification,
  DidChangeDocumentNotification,
  DidCloseDocumentNotification,
  DidSaveDocumentNotification,
  DidFocusDocumentNotification,
  ForkSessionRequest,
  ForkSessionResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetProviderRequest,
  DisableProviderRequest,
  DisableProviderResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CompleteElicitationNotification,
  AGENT_METHODS,
  CLIENT_METHODS,
  RequestError,
  agent as createAgent,
  client as createClient,
} from "./acp.js";
import type {
  AgentContext,
  AnyMessage,
  ClientContext,
  Plan,
  SessionModeState,
  SessionUpdate,
} from "./acp.js";

type AssertSchemaAssignable<Schema extends z.ZodType, Expected> = [
  z.input<Schema>,
  z.output<Schema>,
] extends [Expected, Expected]
  ? true
  : never;

describe("Connection", () => {
  let clientToAgent: TransformStream<Uint8Array, Uint8Array>;
  let agentToClient: TransformStream<Uint8Array, Uint8Array>;

  beforeEach(() => {
    clientToAgent = new TransformStream();
    agentToClient = new TransformStream();
  });

  it("handles errors in bidirectional communication", async () => {
    // Create client that throws errors
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        throw new Error("Write failed");
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        throw new Error("Read failed");
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        throw new Error("Permission denied");
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
    }

    // Create agent that throws errors
    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        throw new Error("Failed to initialize");
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        throw new Error("Failed to create session");
      }
      async loadSession(_: LoadSessionRequest): Promise<LoadSessionResponse> {
        throw new Error("Failed to load session");
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        throw new Error("Authentication failed");
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        throw new Error("Prompt failed");
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test error handling in client->agent direction
    await expect(
      clientConnection.writeTextFile({
        path: "/test.txt",
        content: "test",
        sessionId: "test-session",
      }),
    ).rejects.toThrow();

    // Test error handling in agent->client direction
    await expect(
      agentConnection.newSession({
        cwd: "/test",
        mcpServers: [],
      }),
    ).rejects.toThrow();
  });

  it("handles concurrent requests", async () => {
    let requestCount = 0;

    // Create client
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        requestCount++;
        const currentCount = requestCount;
        await new Promise((resolve) => setTimeout(resolve, 40));
        console.log(`Write request ${currentCount} completed`);
        return {};
      }
      async readTextFile(
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: `Content of ${params.path}` };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
    }

    // Create agent
    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }

      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return {
          sessionId: "test-session",
        };
      }
      async loadSession(_: LoadSessionRequest): Promise<LoadSessionResponse> {
        return {};
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    // Set up connections
    new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Send multiple concurrent requests
    const promises = [
      clientConnection.writeTextFile({
        path: "/file1.txt",
        content: "content1",
        sessionId: "session1",
      }),
      clientConnection.writeTextFile({
        path: "/file2.txt",
        content: "content2",
        sessionId: "session1",
      }),
      clientConnection.writeTextFile({
        path: "/file3.txt",
        content: "content3",
        sessionId: "session1",
      }),
    ];

    const results = await Promise.all(promises);

    // Verify all requests completed successfully
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({});
    expect(results[1]).toEqual({});
    expect(results[2]).toEqual({});
    expect(requestCount).toBe(3);
  });

  it("handles message ordering correctly", async () => {
    const messageLog: string[] = [];

    // Create client
    class TestClient implements Client {
      async writeTextFile(
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        messageLog.push(`writeTextFile called: ${params.path}`);
        return {};
      }
      async readTextFile(
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        messageLog.push(`readTextFile called: ${params.path}`);
        return { content: "test content" };
      }
      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        messageLog.push(`requestPermission called: ${params.toolCall.title}`);
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_params: SessionNotification): Promise<void> {
        messageLog.push("sessionUpdate called");
      }
    }

    // Create agent
    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(
        request: NewSessionRequest,
      ): Promise<NewSessionResponse> {
        messageLog.push(`newSession called: ${request.cwd}`);
        return {
          sessionId: "test-session",
        };
      }
      async loadSession(
        params: LoadSessionRequest,
      ): Promise<LoadSessionResponse> {
        messageLog.push(`loadSession called: ${params.sessionId}`);
        return {};
      }
      async authenticate(params: AuthenticateRequest): Promise<void> {
        messageLog.push(`authenticate called: ${params.methodId}`);
      }
      async prompt(params: PromptRequest): Promise<PromptResponse> {
        messageLog.push(`prompt called: ${params.sessionId}`);
        return { stopReason: "end_turn" };
      }
      async cancel(params: CancelNotification): Promise<void> {
        messageLog.push(`cancelled called: ${params.sessionId}`);
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Send requests in specific order
    await agentConnection.newSession({
      cwd: "/test",
      mcpServers: [],
    });
    await clientConnection.writeTextFile({
      path: "/test.txt",
      content: "test",
      sessionId: "test-session",
    });
    await clientConnection.readTextFile({
      path: "/test.txt",
      sessionId: "test-session",
    });
    await clientConnection.requestPermission({
      sessionId: "test-session",
      toolCall: {
        title: "Execute command",
        kind: "execute",
        status: "pending",
        toolCallId: "tool-123",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "ls -la",
            },
          },
        ],
      },
      options: [
        {
          kind: "allow_once",
          name: "Allow",
          optionId: "allow",
        },
        {
          kind: "reject_once",
          name: "Reject",
          optionId: "reject",
        },
      ],
    });

    // Verify order
    expect(messageLog).toEqual([
      "newSession called: /test",
      "writeTextFile called: /test.txt",
      "readTextFile called: /test.txt",
      "requestPermission called: Execute command",
    ]);
  });

  it("handles notifications correctly", async () => {
    const notificationLog: string[] = [];

    // Create client
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(notification: SessionNotification): Promise<void> {
        if (
          notification.update &&
          "sessionUpdate" in notification.update &&
          notification.update.sessionUpdate === "agent_message_chunk"
        ) {
          notificationLog.push(
            `agent message: ${(notification.update.content as any).text}`,
          );
        }
      }
    }

    // Create agent
    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return {
          sessionId: "test-session",
        };
      }
      async loadSession(_: LoadSessionRequest): Promise<LoadSessionResponse> {
        return {};
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(params: CancelNotification): Promise<void> {
        notificationLog.push(`cancelled: ${params.sessionId}`);
      }
    }

    // Create shared instances
    const testClient = () => new TestClient();
    const testAgent = () => new TestAgent();

    // Set up connections
    const agentConnection = new ClientSideConnection(
      testClient,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      testAgent,
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Send notifications
    await clientConnection.sessionUpdate({
      sessionId: "test-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Hello from agent",
        },
      },
    });

    await agentConnection.cancel({
      sessionId: "test-session",
    });

    // Verify notifications were received
    await vi.waitFor(() => {
      expect(notificationLog).toContain("agent message: Hello from agent");
      expect(notificationLog).toContain("cancelled: test-session");
    });
  });

  it("handles requests from inside a request handler without deadlocking", async () => {
    let agentConnection: ClientSideConnection | null = null;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const listResponse = await agentConnection!.listSessions({});
        expect(listResponse.sessions).toEqual([]);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}
      async listSessions(
        _: ListSessionsRequest,
      ): Promise<ListSessionsResponse> {
        return { sessions: [] };
      }
    }

    agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    const permissionResponse = await clientConnection.requestPermission({
      sessionId: "test-session",
      toolCall: {
        title: "Execute command",
        kind: "execute",
        status: "pending",
        toolCallId: "tool-123",
        content: [
          { type: "content", content: { type: "text", text: "ls -la" } },
        ],
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    expect(permissionResponse.outcome.outcome).toBe("selected");
  });

  it("supports app handlers over streams", async () => {
    const events: string[] = [];

    createAgent({ name: "test-agent" })
      .initialize((c) => {
        events.push(`initialize:${c.params.protocolVersion}`);
        return {
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      })
      .newSession((c) => {
        events.push(`new:${c.params.cwd}`);
        return { sessionId: "app-session" };
      })
      .prompt(async (c) => {
        events.push(`prompt:${c.params.sessionId}`);
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "app update",
            },
          },
        });
        return { stopReason: "end_turn" };
      })
      .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await createClient({ name: "test-client" })
      .sessionUpdate((c) => {
        events.push(`update:${c.params.sessionId}`);
      })
      .connectWith(
        ndJsonStream(clientToAgent.writable, agentToClient.readable),
        async (agent) => {
          const initializeResponse = await agent.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionResponse = await agent.newSession({
            cwd: "/app",
            mcpServers: [],
          });
          const promptResponse = await agent.prompt({
            sessionId: sessionResponse.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          });

          return {
            initializeResponse,
            sessionResponse,
            promptResponse,
          };
        },
      );

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("app-session");
    expect(result.promptResponse.stopReason).toBe("end_turn");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/app",
      "prompt:app-session",
      "update:app-session",
    ]);
  });

  it("connects apps directly without transport setup", async () => {
    const events: string[] = [];

    const appAgent = createAgent({ name: "direct-agent" })
      .initialize((c) => {
        events.push(`initialize:${c.params.protocolVersion}`);
        return {
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      })
      .newSession((c) => {
        events.push(`new:${c.params.cwd}`);
        return { sessionId: "direct-session" };
      });

    const result = await createClient({ name: "direct-client" }).connectWith(
      appAgent,
      async (agent) => {
        const initializeResponse = await agent.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionResponse = await agent.newSession({
          cwd: "/direct-app",
          mcpServers: [],
        });

        return { initializeResponse, sessionResponse };
      },
    );

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("direct-session");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/direct-app",
    ]);
  });

  it("connects app-style agents and clients directly", async () => {
    const events: string[] = [];

    const appAgent = createAgent({ name: "app-agent" })
      .initialize((c) => {
        events.push(`initialize:${c.params.protocolVersion}`);
        expect(Object.keys(c).sort()).toEqual(["client", "params"]);

        return {
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      })
      .newSession((c) => {
        events.push(`new:${c.params.cwd}`);
        return { sessionId: "app-session" };
      })
      .route<Record<string, unknown>>({
        kind: "notification",
        method: "vendor/agent-notify",
        params: {
          parse(params) {
            const message = (params as Record<string, unknown>).message;
            return { message: `${String(message)}:parsed` };
          },
        },
        handler: (c) => {
          expect(Object.keys(c).sort()).toEqual(["client", "params"]);
          events.push(`agent-route:${String(c.params.message)}`);
        },
      })
      .prompt(async (c) => {
        events.push(`prompt:${c.params.sessionId}`);
        const pong = await c.client.extMethod("vendor/ping", {
          message: "hello",
        });
        events.push(`pong:${String(pong.message)}`);
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "app update" },
          },
        });

        return { stopReason: "end_turn" };
      });

    const appClient = createClient({ name: "app-client" })
      .sessionUpdate((c) => {
        events.push(`update:${c.params.sessionId}`);
      })
      .route<Record<string, unknown>, Record<string, unknown>>({
        kind: "request",
        method: "vendor/ping",
        params(params) {
          const message = (params as Record<string, unknown>).message;
          return { message: String(message).toUpperCase() };
        },
        handler: (c) => {
          expect(Object.keys(c).sort()).toEqual(["agent", "params"]);
          events.push(`client-route:${String(c.params.message)}`);

          return { message: c.params.message };
        },
      });

    const result = await appClient.connectWith(appAgent, async (agentCx) => {
      const initializeResponse = await agentCx.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const sessionResponse = await agentCx.newSession({
        cwd: "/app",
        mcpServers: [],
      });
      await agentCx.extNotification("vendor/agent-notify", {
        message: "from-client",
      });
      const promptResponse = await agentCx.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      return { initializeResponse, sessionResponse, promptResponse };
    });

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("app-session");
    expect(result.promptResponse.stopReason).toBe("end_turn");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/app",
      "agent-route:from-client:parsed",
      "prompt:app-session",
      "client-route:HELLO",
      "pong:HELLO",
      "update:app-session",
    ]);
  });

  it("normalizes app built-in empty-object handler responses before sending", async () => {
    const appAgent = createAgent({ name: "empty-agent-responses" })
      .loadSession(() => undefined as unknown as LoadSessionResponse)
      .deleteSession(() => {})
      .closeSession(() => {})
      .setSessionMode(() => {})
      .authenticate(() => {})
      .unstable_setProvider(() => {})
      .unstable_disableProvider(() => {})
      .logout(() => {})
      .unstable_closeNes(() => {});

    const agentResponses = await createClient({
      name: "empty-agent-response-client",
    }).connectWith(appAgent, async (agent) => ({
      loadSession: await agent.extMethod(AGENT_METHODS.session_load, {
        sessionId: "empty-session",
        cwd: "/empty",
        mcpServers: [],
      }),
      deleteSession: await agent.extMethod(AGENT_METHODS.session_delete, {
        sessionId: "empty-session",
      }),
      closeSession: await agent.extMethod(AGENT_METHODS.session_close, {
        sessionId: "empty-session",
      }),
      setSessionMode: await agent.extMethod(AGENT_METHODS.session_set_mode, {
        sessionId: "empty-session",
        modeId: "ask",
      }),
      authenticate: await agent.extMethod(AGENT_METHODS.authenticate, {
        methodId: "none",
      }),
      setProvider: await agent.extMethod(AGENT_METHODS.providers_set, {
        id: "main",
        apiType: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      disableProvider: await agent.extMethod(AGENT_METHODS.providers_disable, {
        id: "main",
      }),
      logout: await agent.extMethod(AGENT_METHODS.logout, {}),
      closeNes: await agent.extMethod(AGENT_METHODS.nes_close, {
        sessionId: "nes-session",
      }),
    }));

    expect(agentResponses).toEqual({
      loadSession: {},
      deleteSession: {},
      closeSession: {},
      setSessionMode: {},
      authenticate: {},
      setProvider: {},
      disableProvider: {},
      logout: {},
      closeNes: {},
    });

    let clientResponses: Record<string, unknown> | undefined;
    const appClient = createClient({ name: "empty-client-responses" })
      .writeTextFile(() => undefined as unknown as WriteTextFileResponse)
      .releaseTerminal(() => {})
      .killTerminal(() => {});

    await appClient.connectWith(
      createAgent({ name: "empty-client-response-agent" })
        .newSession(() => ({ sessionId: "empty-client-session" }))
        .prompt(async (c) => {
          clientResponses = {
            writeTextFile: await c.client.extMethod(
              CLIENT_METHODS.fs_write_text_file,
              {
                sessionId: c.params.sessionId,
                path: "/empty-client.txt",
                content: "hello",
              },
            ),
            releaseTerminal: await c.client.extMethod(
              CLIENT_METHODS.terminal_release,
              {
                sessionId: c.params.sessionId,
                terminalId: "terminal-1",
              },
            ),
            killTerminal: await c.client.extMethod(
              CLIENT_METHODS.terminal_kill,
              {
                sessionId: c.params.sessionId,
                terminalId: "terminal-1",
              },
            ),
          };
          return { stopReason: "end_turn" };
        }),
      async (agent) => {
        const session = await agent.newSession({
          cwd: "/empty-client",
          mcpServers: [],
        });
        await agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "check empty responses" }],
        });
      },
    );

    expect(clientResponses).toEqual({
      writeTextFile: {},
      releaseTerminal: {},
      killTerminal: {},
    });
  });

  it("normalizes raw null terminal handle empty responses in app contexts", async () => {
    let terminalResponses:
      | {
          kill: unknown;
          release: unknown;
        }
      | undefined;

    const appAgent = createAgent({ name: "terminal-null-agent" })
      .newSession(() => ({ sessionId: "terminal-null-session" }))
      .prompt(async (c) => {
        const terminal = await c.client.createTerminal({
          sessionId: c.params.sessionId,
          command: "echo hello",
        });
        terminalResponses = {
          kill: await terminal.kill(),
          release: await terminal.release(),
        };
        return { stopReason: "end_turn" };
      });

    await createClient({ name: "terminal-null-client" })
      .createTerminal(() => ({ terminalId: "terminal-1" }))
      .route<Record<string, unknown>, null>({
        kind: "request",
        method: CLIENT_METHODS.terminal_kill,
        handler: () => null,
      })
      .route<Record<string, unknown>, null>({
        kind: "request",
        method: CLIENT_METHODS.terminal_release,
        handler: () => null,
      })
      .connectWith(appAgent, async (agent) => {
        const session = await agent.newSession({
          cwd: "/terminal-null",
          mcpServers: [],
        });
        await agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "terminal" }],
        });
      });

    expect(terminalResponses).toEqual({
      kill: {},
      release: {},
    });
  });

  describe.each(["legacy", "app"] as const)(
    "%s connection API parity",
    (api) => {
      it("runs a prompt flow with outbound agent requests and notifications", async () => {
        const events: string[] = [];

        async function runPrompt(agent: {
          initialize(params: InitializeRequest): Promise<InitializeResponse>;
          newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
          prompt(params: PromptRequest): Promise<PromptResponse>;
        }) {
          const initializeResponse = await agent.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionResponse = await agent.newSession({
            cwd: "/parity",
            mcpServers: [],
          });
          const promptResponse = await agent.prompt({
            sessionId: sessionResponse.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          });

          return { initializeResponse, sessionResponse, promptResponse };
        }

        let result: {
          initializeResponse: InitializeResponse;
          sessionResponse: NewSessionResponse;
          promptResponse: PromptResponse;
        };

        if (api === "legacy") {
          class TestClient implements Client {
            requestPermission(): RequestPermissionResponse {
              events.push("request-permission");
              return { outcome: { outcome: "selected", optionId: "allow" } };
            }

            sessionUpdate(params: SessionNotification): void {
              events.push(`update:${params.sessionId}`);
            }
          }

          class TestAgent implements Agent {
            constructor(private readonly client: AgentSideConnection) {}

            initialize(params: InitializeRequest): InitializeResponse {
              events.push(`initialize:${params.protocolVersion}`);
              return {
                protocolVersion: params.protocolVersion,
                agentCapabilities: { loadSession: false },
                authMethods: [],
              };
            }

            newSession(params: NewSessionRequest): NewSessionResponse {
              events.push(`new:${params.cwd}`);
              return { sessionId: "parity-session" };
            }

            async authenticate(): Promise<void> {}

            async prompt(params: PromptRequest): Promise<PromptResponse> {
              events.push(`prompt:${params.sessionId}`);
              const permission = await this.client.requestPermission({
                sessionId: params.sessionId,
                toolCall: {
                  title: "Execute command",
                  kind: "execute",
                  status: "pending",
                  toolCallId: "parity-tool",
                  content: [],
                },
                options: [
                  { kind: "allow_once", name: "Allow", optionId: "allow" },
                ],
              });
              events.push(`permission:${permission.outcome.outcome}`);
              await this.client.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "done" },
                },
              });
              return { stopReason: "end_turn" };
            }

            cancel(): void {}
          }

          const agentConnection = new ClientSideConnection(
            () => new TestClient(),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            (client) => new TestAgent(client),
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          result = await runPrompt(agentConnection);
        } else {
          const appAgent = createAgent({ name: "parity-agent" })
            .initialize((c) => {
              events.push(`initialize:${c.params.protocolVersion}`);
              return {
                protocolVersion: c.params.protocolVersion,
                agentCapabilities: { loadSession: false },
                authMethods: [],
              };
            })
            .newSession((c) => {
              events.push(`new:${c.params.cwd}`);
              return { sessionId: "parity-session" };
            })
            .prompt(async (c) => {
              events.push(`prompt:${c.params.sessionId}`);
              const permission = await c.client.requestPermission({
                sessionId: c.params.sessionId,
                toolCall: {
                  title: "Execute command",
                  kind: "execute",
                  status: "pending",
                  toolCallId: "parity-tool",
                  content: [],
                },
                options: [
                  { kind: "allow_once", name: "Allow", optionId: "allow" },
                ],
              });
              events.push(`permission:${permission.outcome.outcome}`);
              await c.client.sessionUpdate({
                sessionId: c.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "done" },
                },
              });
              return { stopReason: "end_turn" };
            });

          result = await createClient({ name: "parity-client" })
            .requestPermission(() => {
              events.push("request-permission");
              return { outcome: { outcome: "selected", optionId: "allow" } };
            })
            .sessionUpdate((c) => {
              events.push(`update:${c.params.sessionId}`);
            })
            .connectWith(appAgent, runPrompt);
        }

        expect(result.initializeResponse.protocolVersion).toBe(
          PROTOCOL_VERSION,
        );
        expect(result.sessionResponse.sessionId).toBe("parity-session");
        expect(result.promptResponse.stopReason).toBe("end_turn");
        expect(events).toEqual([
          `initialize:${PROTOCOL_VERSION}`,
          "new:/parity",
          "prompt:parity-session",
          "request-permission",
          "permission:selected",
          "update:parity-session",
        ]);
      });

      it("supports custom request and notification extensions", async () => {
        const events: string[] = [];

        if (api === "legacy") {
          class TestClient implements Client {
            requestPermission(): RequestPermissionResponse {
              return { outcome: { outcome: "cancelled" } };
            }

            sessionUpdate(): void {}

            extMethod(
              method: string,
              params: Record<string, unknown>,
            ): Record<string, unknown> {
              events.push(`client-request:${method}`);
              return { echoed: params.message };
            }

            extNotification(
              method: string,
              params: Record<string, unknown>,
            ): void {
              events.push(`client-notification:${method}:${params.message}`);
            }
          }

          class TestAgent implements Agent {
            initialize(params: InitializeRequest): InitializeResponse {
              return {
                protocolVersion: params.protocolVersion,
                agentCapabilities: { loadSession: false },
                authMethods: [],
              };
            }

            newSession(): NewSessionResponse {
              return { sessionId: "extension-session" };
            }

            authenticate(): void {}

            prompt(): PromptResponse {
              return { stopReason: "end_turn" };
            }

            cancel(): void {}

            extMethod(
              method: string,
              params: Record<string, unknown>,
            ): Record<string, unknown> {
              events.push(`agent-request:${method}`);
              return { echoed: params.message };
            }

            extNotification(
              method: string,
              params: Record<string, unknown>,
            ): void {
              events.push(`agent-notification:${method}:${params.message}`);
            }
          }

          const agentConnection = new ClientSideConnection(
            () => new TestClient(),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          const clientConnection = new AgentSideConnection(
            () => new TestAgent(),
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          await expect(
            agentConnection.extMethod("vendor/agent-echo", {
              message: "to-agent",
            }),
          ).resolves.toEqual({ echoed: "to-agent" });
          await agentConnection.extNotification("vendor/agent-note", {
            message: "notify-agent",
          });
          await expect(
            clientConnection.extMethod("vendor/client-echo", {
              message: "to-client",
            }),
          ).resolves.toEqual({ echoed: "to-client" });
          await clientConnection.extNotification("vendor/client-note", {
            message: "notify-client",
          });
        } else {
          const appAgent = createAgent({ name: "extension-agent" })
            .initialize((c) => ({
              protocolVersion: c.params.protocolVersion,
              agentCapabilities: { loadSession: false },
              authMethods: [],
            }))
            .newSession(() => ({ sessionId: "extension-session" }))
            .prompt(async (c) => {
              await expect(
                c.client.extMethod("vendor/client-echo", {
                  message: "to-client",
                }),
              ).resolves.toEqual({ echoed: "to-client" });
              await c.client.extNotification("vendor/client-note", {
                message: "notify-client",
              });
              return { stopReason: "end_turn" };
            })
            .route<Record<string, unknown>, Record<string, unknown>>({
              kind: "request",
              method: "vendor/agent-echo",
              handler: (c) => {
                events.push("agent-request:vendor/agent-echo");
                return { echoed: c.params.message };
              },
            })
            .route<Record<string, unknown>>({
              kind: "notification",
              method: "vendor/agent-note",
              handler: (c) => {
                events.push(
                  `agent-notification:vendor/agent-note:${c.params.message}`,
                );
              },
            });

          await createClient({ name: "extension-client" })
            .route<Record<string, unknown>, Record<string, unknown>>({
              kind: "request",
              method: "vendor/client-echo",
              handler: (c) => {
                events.push("client-request:vendor/client-echo");
                return { echoed: c.params.message };
              },
            })
            .route<Record<string, unknown>>({
              kind: "notification",
              method: "vendor/client-note",
              handler: (c) => {
                events.push(
                  `client-notification:vendor/client-note:${c.params.message}`,
                );
              },
            })
            .connectWith(appAgent, async (agent) => {
              await expect(
                agent.extMethod("vendor/agent-echo", {
                  message: "to-agent",
                }),
              ).resolves.toEqual({ echoed: "to-agent" });
              await agent.extNotification("vendor/agent-note", {
                message: "notify-agent",
              });
              const session = await agent.newSession({
                cwd: "/extension",
                mcpServers: [],
              });
              await agent.prompt({
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "run extension checks" }],
              });
            });
        }

        await vi.waitFor(() => {
          expect(events).toEqual([
            "agent-request:vendor/agent-echo",
            "agent-notification:vendor/agent-note:notify-agent",
            "client-request:vendor/client-echo",
            "client-notification:vendor/client-note:notify-client",
          ]);
        });
      });

      it("propagates agent-to-client request errors through prompt handlers", async () => {
        let successCalled = false;

        if (api === "legacy") {
          class TestClient implements Client {
            requestPermission(): RequestPermissionResponse {
              throw new RequestError(-32000, "permission failed");
            }

            sessionUpdate(): void {}
          }

          class TestAgent implements Agent {
            constructor(private readonly client: AgentSideConnection) {}

            initialize(params: InitializeRequest): InitializeResponse {
              return {
                protocolVersion: params.protocolVersion,
                agentCapabilities: { loadSession: false },
                authMethods: [],
              };
            }

            newSession(): NewSessionResponse {
              return { sessionId: "error-parity-session" };
            }

            authenticate(): void {}

            async prompt(params: PromptRequest): Promise<PromptResponse> {
              await this.client.requestPermission({
                sessionId: params.sessionId,
                toolCall: {
                  title: "Execute command",
                  kind: "execute",
                  status: "pending",
                  toolCallId: "error-parity-tool",
                  content: [],
                },
                options: [
                  { kind: "allow_once", name: "Allow", optionId: "allow" },
                ],
              });
              successCalled = true;
              return { stopReason: "end_turn" };
            }

            cancel(): void {}
          }

          const agentConnection = new ClientSideConnection(
            () => new TestClient(),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            (client) => new TestAgent(client),
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          const session = await agentConnection.newSession({
            cwd: "/error-parity",
            mcpServers: [],
          });
          await expect(
            agentConnection.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            }),
          ).rejects.toThrow("permission failed");
        } else {
          const appAgent = createAgent({ name: "error-parity-agent" })
            .newSession(() => ({ sessionId: "error-parity-session" }))
            .prompt(async (c) => {
              await c.client.requestPermission({
                sessionId: c.params.sessionId,
                toolCall: {
                  title: "Execute command",
                  kind: "execute",
                  status: "pending",
                  toolCallId: "error-parity-tool",
                  content: [],
                },
                options: [
                  { kind: "allow_once", name: "Allow", optionId: "allow" },
                ],
              });
              successCalled = true;
              return { stopReason: "end_turn" };
            });

          await expect(
            createClient({ name: "error-parity-client" })
              .requestPermission(() => {
                throw new RequestError(-32000, "permission failed");
              })
              .connectWith(appAgent, async (agent) => {
                const session = await agent.newSession({
                  cwd: "/error-parity",
                  mcpServers: [],
                });
                return agent.prompt({
                  sessionId: session.sessionId,
                  prompt: [{ type: "text", text: "hello" }],
                });
              }),
          ).rejects.toThrow("permission failed");
        }

        expect(successCalled).toBe(false);
      });

      it("keeps agent lifecycle responses equivalent", async () => {
        async function exerciseAgent(
          agent: ClientSideConnection | ClientContext,
        ) {
          const initializeResponse = await agent.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionResponse = await agent.newSession({
            cwd: "/lifecycle",
            mcpServers: [],
            additionalDirectories: ["/lifecycle/extra"],
          });
          const loadResponse = await agent.loadSession({
            sessionId: sessionResponse.sessionId,
            cwd: "/lifecycle",
            mcpServers: [],
            additionalDirectories: ["/lifecycle/extra"],
          });
          const forkResponse = await agent.unstable_forkSession({
            sessionId: sessionResponse.sessionId,
            cwd: "/lifecycle",
            additionalDirectories: ["/lifecycle/extra"],
          });
          const listResponse = await agent.listSessions({});
          const resumeResponse = await agent.resumeSession({
            sessionId: sessionResponse.sessionId,
            cwd: "/lifecycle",
            additionalDirectories: ["/lifecycle/extra"],
          });
          const deleteResponse = await agent.deleteSession({
            sessionId: sessionResponse.sessionId,
          });
          const closeResponse = await agent.closeSession({
            sessionId: sessionResponse.sessionId,
          });
          const setModeResponse = await agent.setSessionMode({
            sessionId: sessionResponse.sessionId,
            modeId: "ask",
          });
          const configResponse = await agent.setSessionConfigOption({
            sessionId: sessionResponse.sessionId,
            configId: "model",
            value: "fast",
          });
          const authNoneResponse = await agent.authenticate({
            methodId: "none",
          });
          const authOauthResponse = await agent.authenticate({
            methodId: "oauth",
          });

          return {
            initializeResponse,
            sessionResponse,
            loadResponse,
            forkResponse,
            listResponse,
            resumeResponse,
            deleteResponse,
            closeResponse,
            setModeResponse,
            configResponse,
            authNoneResponse,
            authOauthResponse,
          };
        }

        const received: Record<string, unknown> = {};
        const handlers = {
          initialize(params: InitializeRequest): InitializeResponse {
            received.initialize = params;
            return {
              protocolVersion: params.protocolVersion,
              agentCapabilities: { loadSession: true },
              authMethods: [],
              _meta: { api },
            };
          },
          newSession(params: NewSessionRequest): NewSessionResponse {
            received.newSession = params;
            return {
              sessionId: "lifecycle-session",
              _meta: { createdBy: api },
            };
          },
          loadSession(params: LoadSessionRequest): LoadSessionResponse {
            received.loadSession = params;
            return {};
          },
          unstable_forkSession(
            params: ForkSessionRequest,
          ): ForkSessionResponse {
            received.forkSession = params;
            return { sessionId: "forked-lifecycle-session" };
          },
          listSessions(params: ListSessionsRequest): ListSessionsResponse {
            received.listSessions = params;
            return { sessions: [] };
          },
          resumeSession(params: ResumeSessionRequest): ResumeSessionResponse {
            received.resumeSession = params;
            return {};
          },
          deleteSession(_params): void {},
          closeSession(_params): void {},
          setSessionMode(_params): void {},
          setSessionConfigOption(_params) {
            return {
              configOptions: [
                {
                  type: "select",
                  id: "model",
                  name: "Model",
                  currentValue: "fast",
                  options: [
                    {
                      value: "fast",
                      name: "Fast",
                    },
                  ],
                },
              ],
              currentValues: {
                model: "fast",
              },
            };
          },
          authenticate(
            params: AuthenticateRequest,
          ): AuthenticateResponse | void {
            if (params.methodId === "none") {
              return;
            }

            return { _meta: { methodId: params.methodId } };
          },
          prompt(_params): PromptResponse {
            return { stopReason: "end_turn" };
          },
          cancel(_params): void {},
        } satisfies Agent;

        let result: Awaited<ReturnType<typeof exerciseAgent>>;
        if (api === "legacy") {
          const agentConnection = new ClientSideConnection(
            () => ({
              requestPermission(): RequestPermissionResponse {
                return { outcome: { outcome: "cancelled" } };
              },
              sessionUpdate(): void {},
            }),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            () => handlers,
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          result = await exerciseAgent(agentConnection);
        } else {
          const appAgent = createAgent({ name: "lifecycle-parity-agent" })
            .initialize((c) => handlers.initialize(c.params))
            .newSession((c) => handlers.newSession(c.params))
            .loadSession((c) => handlers.loadSession(c.params))
            .unstable_forkSession((c) =>
              handlers.unstable_forkSession(c.params),
            )
            .listSessions((c) => handlers.listSessions(c.params))
            .resumeSession((c) => handlers.resumeSession(c.params))
            .deleteSession((c) => handlers.deleteSession(c.params))
            .closeSession((c) => handlers.closeSession(c.params))
            .setSessionMode((c) => handlers.setSessionMode(c.params))
            .setSessionConfigOption((c) =>
              handlers.setSessionConfigOption(c.params),
            )
            .authenticate((c) => handlers.authenticate(c.params))
            .prompt((c) => handlers.prompt(c.params))
            .cancel((c) => handlers.cancel(c.params));

          result = await createClient({
            name: "lifecycle-parity-client",
          }).connectWith(appAgent, exerciseAgent);
        }

        expect(result.initializeResponse).toEqual({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          _meta: { api },
        });
        expect(result.sessionResponse).toEqual({
          sessionId: "lifecycle-session",
          _meta: { createdBy: api },
        });
        expect(result.loadResponse).toEqual({});
        expect(result.forkResponse).toEqual({
          sessionId: "forked-lifecycle-session",
        });
        expect(result.listResponse).toEqual({ sessions: [] });
        expect(result.resumeResponse).toEqual({});
        expect(result.deleteResponse).toEqual({});
        expect(result.closeResponse).toEqual({});
        expect(result.setModeResponse).toEqual({});
        expect(result.configResponse.configOptions).toEqual([
          {
            type: "select",
            id: "model",
            name: "Model",
            currentValue: "fast",
            options: [
              {
                value: "fast",
                name: "Fast",
              },
            ],
          },
        ]);
        expect(result.authNoneResponse).toEqual({});
        expect(result.authOauthResponse).toEqual({
          _meta: { methodId: "oauth" },
        });
        expect(received.newSession).toMatchObject({
          cwd: "/lifecycle",
          additionalDirectories: ["/lifecycle/extra"],
        });
        expect(received.loadSession).toMatchObject({
          sessionId: "lifecycle-session",
          additionalDirectories: ["/lifecycle/extra"],
        });
        expect(received.forkSession).toMatchObject({
          sessionId: "lifecycle-session",
          additionalDirectories: ["/lifecycle/extra"],
        });
        expect(received.resumeSession).toMatchObject({
          sessionId: "lifecycle-session",
          additionalDirectories: ["/lifecycle/extra"],
        });
      });

      it("keeps agent-to-client helper calls equivalent", async () => {
        const events: string[] = [];
        async function runPrompt(agent: Agent) {
          const session = await agent.newSession({
            cwd: "/client-helpers",
            mcpServers: [],
          });
          return agent.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "use client helpers" }],
          });
        }

        const clientHandlers = {
          requestPermission(params: RequestPermissionRequest) {
            events.push(`permission:${params.toolCall.toolCallId}`);
            return { outcome: { outcome: "selected", optionId: "allow" } };
          },
          sessionUpdate(params: SessionNotification): void {
            events.push(`update:${params.sessionId}`);
          },
          writeTextFile(params: WriteTextFileRequest): WriteTextFileResponse {
            events.push(`write:${params.path}:${params.content}`);
            return {};
          },
          readTextFile(params: ReadTextFileRequest): ReadTextFileResponse {
            events.push(`read:${params.path}`);
            return { content: "file contents" };
          },
          createTerminal(_params) {
            events.push("terminal:create");
            return { terminalId: "terminal-1" };
          },
          terminalOutput(_params) {
            events.push("terminal:output");
            return { output: "hello", truncated: false };
          },
          waitForTerminalExit(_params) {
            events.push("terminal:wait");
            return { exitCode: 0 };
          },
          killTerminal(_params): void {
            events.push("terminal:kill");
          },
          releaseTerminal(_params): void {
            events.push("terminal:release");
          },
        } satisfies Client;

        async function handlePrompt(
          client: AgentSideConnection | AgentContext,
          params: PromptRequest,
        ): Promise<PromptResponse> {
          await client.writeTextFile({
            sessionId: params.sessionId,
            path: "/client-helpers.txt",
            content: "hello",
          });
          const read = await client.readTextFile({
            sessionId: params.sessionId,
            path: "/client-helpers.txt",
          });
          events.push(`content:${read.content}`);
          const permission = await client.requestPermission({
            sessionId: params.sessionId,
            toolCall: {
              title: "Execute command",
              kind: "execute",
              status: "pending",
              toolCallId: "client-helper-tool",
              content: [],
            },
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
          });
          events.push(`outcome:${permission.outcome.outcome}`);
          const terminal = await client.createTerminal({
            sessionId: params.sessionId,
            command: "echo hello",
          });
          const output = await terminal.currentOutput();
          events.push(`terminal-content:${output.output}`);
          const exit = await terminal.waitForExit();
          events.push(`exit:${exit.exitCode}`);
          await terminal.kill();
          await terminal.release();
          await client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "done" },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (api === "legacy") {
          const agentConnection = new ClientSideConnection(
            () => clientHandlers,
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            (client) => ({
              initialize(params) {
                return {
                  protocolVersion: params.protocolVersion,
                  agentCapabilities: {},
                  authMethods: [],
                };
              },
              newSession() {
                return { sessionId: "client-helper-session" };
              },
              authenticate(): void {},
              prompt(params) {
                return handlePrompt(client, params);
              },
              cancel(): void {},
            }),
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          await expect(runPrompt(agentConnection)).resolves.toEqual({
            stopReason: "end_turn",
          });
        } else {
          const appAgent = createAgent({ name: "client-helper-parity-agent" })
            .newSession(() => ({ sessionId: "client-helper-session" }))
            .prompt((c) => handlePrompt(c.client, c.params));

          await expect(
            createClient({ name: "client-helper-parity-client" })
              .requestPermission((c) =>
                clientHandlers.requestPermission(c.params),
              )
              .sessionUpdate((c) => clientHandlers.sessionUpdate(c.params))
              .writeTextFile((c) => clientHandlers.writeTextFile(c.params))
              .readTextFile((c) => clientHandlers.readTextFile(c.params))
              .createTerminal((c) => clientHandlers.createTerminal(c.params))
              .terminalOutput((c) => clientHandlers.terminalOutput(c.params))
              .waitForTerminalExit((c) =>
                clientHandlers.waitForTerminalExit(c.params),
              )
              .killTerminal((c) => clientHandlers.killTerminal(c.params))
              .releaseTerminal((c) => clientHandlers.releaseTerminal(c.params))
              .connectWith(appAgent, runPrompt),
          ).resolves.toEqual({ stopReason: "end_turn" });
        }

        expect(events).toEqual([
          "write:/client-helpers.txt:hello",
          "read:/client-helpers.txt",
          "content:file contents",
          "permission:client-helper-tool",
          "outcome:selected",
          "terminal:create",
          "terminal:output",
          "terminal-content:hello",
          "terminal:wait",
          "exit:0",
          "terminal:kill",
          "terminal:release",
          "update:client-helper-session",
        ]);
      });

      it("keeps provider and NES request lifecycles equivalent", async () => {
        async function exerciseAgent(
          agent: ClientSideConnection | ClientContext,
        ) {
          const providers = await agent.unstable_listProviders({});
          const set = await agent.unstable_setProvider({
            id: "main",
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
          });
          const disable = await agent.unstable_disableProvider({ id: "main" });
          const start = await agent.unstable_startNes({
            workspaceUri: "file:///workspace",
            workspaceFolders: [{ uri: "file:///workspace/app", name: "app" }],
          });
          const suggest = await agent.unstable_suggestNes({
            sessionId: start.sessionId,
            position: { line: 0, character: 5 },
            triggerKind: "manual",
            uri: "file:///workspace/app/main.ts",
            version: 1,
          });
          const close = await agent.unstable_closeNes({
            sessionId: start.sessionId,
          });

          return { providers, set, disable, start, suggest, close };
        }

        const events: string[] = [];
        const handlers = {
          ...({
            initialize(params: InitializeRequest): InitializeResponse {
              return {
                protocolVersion: params.protocolVersion,
                agentCapabilities: { providers: {} },
                authMethods: [],
              };
            },
            newSession(): NewSessionResponse {
              return { sessionId: "provider-nes-session" };
            },
            authenticate(): void {},
            prompt(): PromptResponse {
              return { stopReason: "end_turn" };
            },
            cancel(): void {},
          } satisfies Agent),
          unstable_listProviders(_params): ListProvidersResponse {
            events.push("providers:list");
            return {
              providers: [
                {
                  id: "main",
                  supported: ["openai"],
                  required: true,
                  current: {
                    apiType: "openai",
                    baseUrl: "https://api.openai.com/v1",
                  },
                },
              ],
            };
          },
          unstable_setProvider(params: SetProviderRequest): void {
            events.push(`providers:set:${params.id}:${params.apiType}`);
          },
          unstable_disableProvider(
            params: DisableProviderRequest,
          ): DisableProviderResponse {
            events.push(`providers:disable:${params.id}`);
            return {};
          },
          unstable_startNes(params: StartNesRequest): StartNesResponse {
            events.push(`nes:start:${params.workspaceUri}`);
            return { sessionId: "nes-parity-session" };
          },
          unstable_suggestNes(params: SuggestNesRequest): SuggestNesResponse {
            events.push(`nes:suggest:${params.uri}:${params.triggerKind}`);
            return {
              suggestions: [
                {
                  kind: "edit",
                  id: "suggestion-1",
                  uri: params.uri,
                  edits: [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 5 },
                      },
                      newText: "hello",
                    },
                  ],
                },
              ],
            };
          },
          unstable_closeNes(params: CloseNesRequest): CloseNesResponse {
            events.push(`nes:close:${params.sessionId}`);
            return {};
          },
        } satisfies Agent;

        let result: Awaited<ReturnType<typeof exerciseAgent>>;
        if (api === "legacy") {
          const agentConnection = new ClientSideConnection(
            () => ({
              requestPermission(): RequestPermissionResponse {
                return { outcome: { outcome: "cancelled" } };
              },
              sessionUpdate(): void {},
            }),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            () => handlers,
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          result = await exerciseAgent(agentConnection);
        } else {
          const appAgent = createAgent({ name: "provider-nes-parity-agent" })
            .unstable_listProviders((c) =>
              handlers.unstable_listProviders(c.params),
            )
            .unstable_setProvider((c) =>
              handlers.unstable_setProvider(c.params),
            )
            .unstable_disableProvider((c) =>
              handlers.unstable_disableProvider(c.params),
            )
            .unstable_startNes((c) => handlers.unstable_startNes(c.params))
            .unstable_suggestNes((c) => handlers.unstable_suggestNes(c.params))
            .unstable_closeNes((c) => handlers.unstable_closeNes(c.params));

          result = await createClient({
            name: "provider-nes-parity-client",
          }).connectWith(appAgent, exerciseAgent);
        }

        expect(result.providers.providers).toHaveLength(1);
        expect(result.set).toEqual({});
        expect(result.disable).toEqual({});
        expect(result.start).toEqual({ sessionId: "nes-parity-session" });
        expect(result.suggest.suggestions).toEqual([
          {
            kind: "edit",
            id: "suggestion-1",
            uri: "file:///workspace/app/main.ts",
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                newText: "hello",
              },
            ],
          },
        ]);
        expect(result.close).toEqual({});
        expect(events).toEqual([
          "providers:list",
          "providers:set:main:openai",
          "providers:disable:main",
          "nes:start:file:///workspace",
          "nes:suggest:file:///workspace/app/main.ts:manual",
          "nes:close:nes-parity-session",
        ]);
      });

      it("keeps agent notification handlers equivalent", async () => {
        const notifications: unknown[] = [];
        async function sendNotifications(
          agent: ClientSideConnection | ClientContext,
        ) {
          await agent.unstable_didOpenDocument({
            sessionId: "notification-session",
            uri: "file:///workspace/file.ts",
            languageId: "typescript",
            version: 1,
            text: "const value = 1;",
          });
          await agent.unstable_didChangeDocument({
            sessionId: "notification-session",
            uri: "file:///workspace/file.ts",
            version: 2,
            contentChanges: [{ text: "const value = 2;" }],
          });
          await agent.unstable_didSaveDocument({
            sessionId: "notification-session",
            uri: "file:///workspace/file.ts",
          });
          await agent.unstable_didFocusDocument({
            sessionId: "notification-session",
            uri: "file:///workspace/file.ts",
            version: 2,
            position: { line: 0, character: 12 },
            visibleRange: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
          });
          await agent.unstable_didCloseDocument({
            sessionId: "notification-session",
            uri: "file:///workspace/file.ts",
          });
          await agent.unstable_acceptNes({
            sessionId: "notification-session",
            id: "suggestion-1",
          });
          await agent.unstable_rejectNes({
            sessionId: "notification-session",
            id: "suggestion-2",
            reason: "rejected",
          });
        }

        const handlers = {
          ...({
            initialize(params: InitializeRequest): InitializeResponse {
              return {
                protocolVersion: params.protocolVersion,
                agentCapabilities: {},
                authMethods: [],
              };
            },
            newSession(): NewSessionResponse {
              return { sessionId: "notification-session" };
            },
            authenticate(): void {},
            prompt(): PromptResponse {
              return { stopReason: "end_turn" };
            },
            cancel(): void {},
          } satisfies Agent),
          unstable_didOpenDocument(params: DidOpenDocumentNotification): void {
            notifications.push(["open", params.uri, params.version]);
          },
          unstable_didChangeDocument(
            params: DidChangeDocumentNotification,
          ): void {
            notifications.push(["change", params.uri, params.version]);
          },
          unstable_didSaveDocument(params: DidSaveDocumentNotification): void {
            notifications.push(["save", params.uri]);
          },
          unstable_didFocusDocument(
            params: DidFocusDocumentNotification,
          ): void {
            notifications.push(["focus", params.uri, params.version]);
          },
          unstable_didCloseDocument(
            params: DidCloseDocumentNotification,
          ): void {
            notifications.push(["close", params.uri]);
          },
          unstable_acceptNes(params: AcceptNesNotification): void {
            notifications.push(["accept", params.id]);
          },
          unstable_rejectNes(params: RejectNesNotification): void {
            notifications.push(["reject", params.id, params.reason]);
          },
        } satisfies Agent;

        if (api === "legacy") {
          const agentConnection = new ClientSideConnection(
            () => ({
              requestPermission(): RequestPermissionResponse {
                return { outcome: { outcome: "cancelled" } };
              },
              sessionUpdate(): void {},
            }),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          new AgentSideConnection(
            () => handlers,
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          await sendNotifications(agentConnection);
        } else {
          const appAgent = createAgent({ name: "notification-parity-agent" })
            .unstable_didOpenDocument((c) =>
              handlers.unstable_didOpenDocument(c.params),
            )
            .unstable_didChangeDocument((c) =>
              handlers.unstable_didChangeDocument(c.params),
            )
            .unstable_didSaveDocument((c) =>
              handlers.unstable_didSaveDocument(c.params),
            )
            .unstable_didFocusDocument((c) =>
              handlers.unstable_didFocusDocument(c.params),
            )
            .unstable_didCloseDocument((c) =>
              handlers.unstable_didCloseDocument(c.params),
            )
            .unstable_acceptNes((c) => handlers.unstable_acceptNes(c.params))
            .unstable_rejectNes((c) => handlers.unstable_rejectNes(c.params));

          await createClient({
            name: "notification-parity-client",
          }).connectWith(appAgent, sendNotifications);
        }

        await vi.waitFor(() => {
          expect(notifications).toEqual([
            ["open", "file:///workspace/file.ts", 1],
            ["change", "file:///workspace/file.ts", 2],
            ["save", "file:///workspace/file.ts"],
            ["focus", "file:///workspace/file.ts", 2],
            ["close", "file:///workspace/file.ts"],
            ["accept", "suggestion-1"],
            ["reject", "suggestion-2", "rejected"],
          ]);
        });
      });

      it("keeps elicitation handlers equivalent", async () => {
        const received: unknown[] = [];
        const elicitationRequest: CreateElicitationRequest = {
          sessionId: "elicitation-session",
          mode: "form",
          message: "Name",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        };

        async function exerciseElicitation(agentClient: AgentSideConnection) {
          const response =
            await agentClient.unstable_createElicitation(elicitationRequest);
          await agentClient.unstable_completeElicitation({
            elicitationId: "elicitation-1",
          });
          return response;
        }

        if (api === "legacy") {
          new ClientSideConnection(
            () => ({
              requestPermission(): RequestPermissionResponse {
                return { outcome: { outcome: "cancelled" } };
              },
              sessionUpdate(): void {},
              unstable_createElicitation(params) {
                received.push(["create", params.message]);
                return {
                  action: "accept",
                  content: { name: "Alice" },
                };
              },
              unstable_completeElicitation(params) {
                received.push(["complete", params.elicitationId]);
              },
            }),
            ndJsonStream(clientToAgent.writable, agentToClient.readable),
          );
          const clientConnection = new AgentSideConnection(
            () => ({
              initialize(params) {
                return {
                  protocolVersion: params.protocolVersion,
                  agentCapabilities: {},
                  authMethods: [],
                };
              },
              newSession() {
                return { sessionId: "elicitation-session" };
              },
              authenticate(): void {},
              prompt(): PromptResponse {
                return { stopReason: "end_turn" };
              },
              cancel(): void {},
            }),
            ndJsonStream(agentToClient.writable, clientToAgent.readable),
          );

          await expect(exerciseElicitation(clientConnection)).resolves.toEqual({
            action: "accept",
            content: { name: "Alice" },
          });
        } else {
          const appClient = createClient({ name: "elicitation-parity-client" })
            .unstable_createElicitation((c) => {
              received.push(["create", c.params.message]);
              return {
                action: "accept",
                content: { name: "Alice" },
              };
            })
            .unstable_completeElicitation((c) => {
              received.push(["complete", c.params.elicitationId]);
            });

          await expect(
            createAgent({ name: "elicitation-parity-agent" }).connectWith(
              appClient,
              async (client) => {
                const response =
                  await client.unstable_createElicitation(elicitationRequest);
                await client.unstable_completeElicitation({
                  elicitationId: "elicitation-1",
                });
                return response;
              },
            ),
          ).resolves.toEqual({
            action: "accept",
            content: { name: "Alice" },
          });
        }

        await vi.waitFor(() => {
          expect(received).toEqual([
            ["create", "Name"],
            ["complete", "elicitation-1"],
          ]);
        });
      });
    },
  );

  it("returns promises from typed request methods", async () => {
    const events: string[] = [];

    const appAgent = createAgent({ name: "promise-agent" })
      .initialize((c) => {
        events.push(`initialize:${c.params.protocolVersion}`);
        return {
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      })
      .newSession((c) => {
        events.push(`new:${c.params.cwd}`);
        return { sessionId: "promise-session" };
      });

    const result = await createClient({ name: "promise-client" }).connectWith(
      appAgent,
      async (agent) => {
        const initializeResponse = await agent.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const sessionResponse = await agent.newSession({
          cwd: "/promise-app",
          mcpServers: [],
        });

        return { initializeResponse, sessionResponse };
      },
    );

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("promise-session");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/promise-app",
    ]);
  });

  it("accepts synchronous client and agent implementations", () => {
    const client: Client = {
      requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      sessionUpdate() {},
    };
    const agent: Agent = {
      initialize(request) {
        return {
          protocolVersion: request.protocolVersion,
          agentCapabilities: {},
          authMethods: [],
        };
      },
      newSession() {
        return { sessionId: "sync-session" };
      },
      authenticate() {
        return {};
      },
      prompt() {
        return { stopReason: "end_turn" };
      },
      cancel() {},
    };

    expect(
      client.requestPermission({
        sessionId: "sync-session",
        toolCall: {
          title: "Read",
          kind: "read",
          status: "pending",
          toolCallId: "sync-tool",
          content: [],
        },
        options: [{ kind: "reject_once", name: "Reject", optionId: "reject" }],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      agent.newSession({
        cwd: "/sync",
        mcpServers: [],
      }),
    ).toEqual({ sessionId: "sync-session" });
  });

  it("supports awaiting outbound requests from handlers", async () => {
    const events: string[] = [];

    const appAgent = createAgent({ name: "handler-await-agent" })
      .newSession(() => ({ sessionId: "handler-await-session" }))
      .prompt(async (c) => {
        events.push(`prompt:${c.params.sessionId}`);
        const permission = await c.client.requestPermission({
          sessionId: c.params.sessionId,
          toolCall: {
            title: "Execute command",
            kind: "execute",
            status: "pending",
            toolCallId: "handler-await-tool",
            content: [
              { type: "content", content: { type: "text", text: "ls" } },
            ],
          },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        events.push(`permission:${permission.outcome.outcome}`);
        return { stopReason: "end_turn" };
      });

    const promptResponse = await createClient({ name: "handler-await-client" })
      .requestPermission((c) => {
        events.push(`request:${c.params.toolCall.toolCallId}`);
        return {
          outcome: { outcome: "selected", optionId: "allow" },
        };
      })
      .connectWith(appAgent, async (agent) => {
        const session = await agent.newSession({
          cwd: "/handler-await",
          mcpServers: [],
        });
        return agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });
      });

    expect(promptResponse.stopReason).toBe("end_turn");
    expect(events).toEqual([
      "prompt:handler-await-session",
      "request:handler-await-tool",
      "permission:selected",
    ]);
  });

  it("forwards awaited outbound request errors from handlers", async () => {
    let successCalled = false;

    const appAgent = createAgent({ name: "handler-await-error-agent" })
      .newSession(() => ({ sessionId: "handler-await-error-session" }))
      .prompt(async (c) => {
        await c.client.requestPermission({
          sessionId: c.params.sessionId,
          toolCall: {
            title: "Execute command",
            kind: "execute",
            status: "pending",
            toolCallId: "handler-await-error-tool",
            content: [
              {
                type: "content",
                content: { type: "text", text: "delete files" },
              },
            ],
          },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        successCalled = true;
        return { stopReason: "end_turn" };
      });

    await expect(
      createClient({ name: "handler-await-error-client" })
        .requestPermission(() => {
          throw new RequestError(-32000, "permission failed");
        })
        .connectWith(appAgent, async (agent) => {
          const session = await agent.newSession({
            cwd: "/handler-await-error",
            mcpServers: [],
          });
          return agent.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          });
        }),
    ).rejects.toThrow("permission failed");
    expect(successCalled).toBe(false);
  });

  it("supports session builders with active session reads", async () => {
    const events: string[] = [];

    createAgent({ name: "session-agent" })
      .newSession((c) => {
        events.push(
          `new:${c.params.cwd}:${c.params.additionalDirectories?.join(",")}`,
        );
        return { sessionId: "active-session" };
      })
      .prompt(async (c) => {
        events.push(`prompt:${c.params.sessionId}:${c.params.prompt.length}`);
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello ",
            },
          },
        });
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "world",
            },
          },
        });
        return { stopReason: "end_turn" };
      })
      .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await createClient({ name: "session-client" }).connectWith(
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
      async (agent) =>
        agent
          .buildSession("/session-app")
          .withAdditionalDirectories(["/extra"])
          .runUntil(async (session) => {
            const promptResponse = session.sendPrompt("hello");
            const output = await session.readToString();
            return {
              output,
              response: await promptResponse,
              sessionId: session.sessionId,
            };
          }),
    );

    expect(result.sessionId).toBe("active-session");
    expect(result.output).toBe("hello world");
    expect(result.response.stopReason).toBe("end_turn");
    expect(events).toEqual([
      "new:/session-app:/extra",
      "prompt:active-session:1",
    ]);
  });

  it("delivers session updates to active sessions when a sessionUpdate handler is registered", async () => {
    const observedUpdates: string[] = [];

    const appAgent = createAgent({ name: "session-observer-agent" })
      .newSession(() => ({ sessionId: "observed-session" }))
      .prompt(async (c) => {
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "observed ",
            },
          },
        });
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "stream",
            },
          },
        });
        return { stopReason: "end_turn" };
      });

    const result = await createClient({ name: "session-observer-client" })
      .sessionUpdate((c) => {
        if (
          c.params.update.sessionUpdate === "agent_message_chunk" &&
          c.params.update.content.type === "text"
        ) {
          observedUpdates.push(c.params.update.content.text);
        }
      })
      .connectWith(appAgent, async (agent) =>
        agent.buildSession("/session-observer").runUntil(async (session) => {
          const response = session.sendPrompt("hello");
          return {
            output: await session.readToString(),
            response: await response,
          };
        }),
      );

    expect(result.output).toBe("observed stream");
    expect(result.response.stopReason).toBe("end_turn");
    expect(observedUpdates).toEqual(["observed ", "stream"]);
  });

  it("collects active session updates before the prompt response", async () => {
    const appAgent = createAgent({ name: "active-session-order-agent" })
      .newSession(() => ({ sessionId: "active-session-order" }))
      .prompt(async (c) => {
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "ordered ",
            },
          },
        });
        await c.client.sessionUpdate({
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "updates",
            },
          },
        });
        return { stopReason: "end_turn" };
      });

    const result = await createClient({
      name: "active-session-order-client",
    }).connectWith(appAgent, async (agent) =>
      agent.buildSession("/active-session-order").runUntil(async (session) => {
        const response = session.sendPrompt("hello");
        return {
          output: await session.readToString(),
          response: await response,
        };
      }),
    );

    expect(result.output).toBe("ordered updates");
    expect(result.response.stopReason).toBe("end_turn");
  });

  it("retries early session updates until an active session is attached", async () => {
    const update = await createClient({
      name: "early-update-client",
    }).connectWith(
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
      async (agent) => {
        const sessionResponse = agent.newSession({
          cwd: "/early-update",
          mcpServers: [],
        });

        const requestReader = clientToAgent.readable.getReader();
        const { value: requestChunk } = await requestReader.read();
        requestReader.releaseLock();
        const { id: requestId } = JSON.parse(
          new TextDecoder().decode(requestChunk),
        );

        const writer = agentToClient.writable.getWriter();
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              result: { sessionId: "early-update-session" },
            }) +
              "\n" +
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "early-update-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: "early",
                    },
                  },
                },
              }) +
              "\n",
          ),
        );
        writer.releaseLock();

        const response = await sessionResponse;
        await new Promise((resolve) => setTimeout(resolve, 0));

        const session = agent.attachSession(response);
        try {
          return await Promise.race([
            session.readUpdate(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error("Timed out waiting for retried session update"),
                  ),
                100,
              ),
            ),
          ]);
        } finally {
          session.dispose();
        }
      },
    );

    if (update.kind !== "session_update") {
      throw new Error(`Expected session update, got ${update.kind}`);
    }
    expect(update.notification.sessionId).toBe("early-update-session");
    expect(update.update).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "early",
      },
    });
  });

  it("retries early session updates when a sessionUpdate handler is registered", async () => {
    const observedUpdates: string[] = [];
    const update = await createClient({
      name: "early-update-observer-client",
    })
      .sessionUpdate((c) => {
        if (
          c.params.update.sessionUpdate === "agent_message_chunk" &&
          c.params.update.content.type === "text"
        ) {
          observedUpdates.push(c.params.update.content.text);
        }
      })
      .connectWith(
        ndJsonStream(clientToAgent.writable, agentToClient.readable),
        async (agent) => {
          const sessionResponse = agent.newSession({
            cwd: "/early-update-observer",
            mcpServers: [],
          });

          const requestReader = clientToAgent.readable.getReader();
          const { value: requestChunk } = await requestReader.read();
          requestReader.releaseLock();
          const { id: requestId } = JSON.parse(
            new TextDecoder().decode(requestChunk),
          );

          const writer = agentToClient.writable.getWriter();
          await writer.write(
            new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                result: { sessionId: "early-update-observer-session" },
              }) +
                "\n" +
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "early-update-observer-session",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: {
                        type: "text",
                        text: "early-observed",
                      },
                    },
                  },
                }) +
                "\n",
            ),
          );
          writer.releaseLock();

          const response = await sessionResponse;
          await new Promise((resolve) => setTimeout(resolve, 0));

          const session = agent.attachSession(response);
          try {
            return await Promise.race([
              session.readUpdate(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Timed out waiting for retried observed session update",
                      ),
                    ),
                  100,
                ),
              ),
            ]);
          } finally {
            session.dispose();
          }
        },
      );

    if (update.kind !== "session_update") {
      throw new Error(`Expected session update, got ${update.kind}`);
    }
    expect(update.notification.sessionId).toBe("early-update-observer-session");
    expect(update.update).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "early-observed",
      },
    });
    expect(observedUpdates).toContain("early-observed");
  });

  it("rejects pending active session reads when disposed", async () => {
    const appAgent = createAgent({ name: "dispose-session-agent" }).newSession(
      () => ({ sessionId: "dispose-session" }),
    );

    await createClient({ name: "dispose-session-client" }).connectWith(
      appAgent,
      async (agent) => {
        const session = await agent
          .buildSession("/dispose-session")
          .startSession();
        const pendingUpdate = session.readUpdate();
        session.dispose();
        await expect(pendingUpdate).rejects.toThrow("Active session disposed");
      },
    );
  });

  it("processes notification after response when both arrive in quick succession", async () => {
    const events: string[] = [];
    const {
      promise: sessionNotification,
      resolve: resolveSessionNotification,
    } = Promise.withResolvers<void>();

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_params: SessionNotification): Promise<void> {
        // Record the session notification
        events.push("SessionNotification");
        resolveSessionNotification();
      }
    }

    const connection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const newSessionResponse = connection
      .newSession({ cwd: "/test", mcpServers: [] })
      .then((result) => {
        // Record the new session response event
        events.push("NewSessionResponse");
        return result;
      });

    // Get the NewSessionRequest ID
    const requestReader = clientToAgent.readable.getReader();
    const { value: requestChunk } = await requestReader.read();
    requestReader.releaseLock();
    const { id: requestId } = JSON.parse(
      new TextDecoder().decode(requestChunk),
    );

    // Write response and notification in quick succession
    const sessionId = "test-session";
    const writer = agentToClient.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: { sessionId },
        }) + "\n",
      ),
    );
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            },
          },
        }) + "\n",
      ),
    );
    writer.releaseLock();

    await newSessionResponse;
    await sessionNotification;

    expect(events).toEqual(["NewSessionResponse", "SessionNotification"]);
  });

  it("processes notification after response when both arrive in the same chunk", async () => {
    const events: string[] = [];
    const {
      promise: sessionNotification,
      resolve: resolveSessionNotification,
    } = Promise.withResolvers<void>();

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        events.push("SessionNotification");
        resolveSessionNotification();
      }
    }

    const connection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const newSessionResponse = connection
      .newSession({ cwd: "/test", mcpServers: [] })
      .then((result) => {
        events.push("NewSessionResponse");
        return result;
      });

    const requestReader = clientToAgent.readable.getReader();
    const { value: requestChunk } = await requestReader.read();
    requestReader.releaseLock();
    const { id: requestId } = JSON.parse(
      new TextDecoder().decode(requestChunk),
    );

    const sessionId = "test-session";
    const writer = agentToClient.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: { sessionId },
        }) +
          "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [],
              },
            },
          }) +
          "\n",
      ),
    );
    writer.releaseLock();

    await newSessionResponse;
    await sessionNotification;

    expect(events).toEqual(["NewSessionResponse", "SessionNotification"]);
  });

  it("normalizes null results for known empty object responses", async () => {
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    const connection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const authenticateResponse = connection.authenticate({
      methodId: "test",
    });

    const requestReader = clientToAgent.readable.getReader();
    const { value: requestChunk } = await requestReader.read();
    requestReader.releaseLock();
    const { id: requestId } = JSON.parse(
      new TextDecoder().decode(requestChunk),
    );

    const writer = agentToClient.writable.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: null,
        }) + "\n",
      ),
    );
    writer.releaseLock();

    await expect(authenticateResponse).resolves.toEqual({});
  });

  it("handles initialize method", async () => {
    // Create client
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
    }

    // Create agent
    class TestAgent implements Agent {
      async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: true },
          authMethods: [
            {
              id: "oauth",
              name: "OAuth",
              description: "Authenticate with OAuth",
            },
          ],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async loadSession(_: LoadSessionRequest): Promise<LoadSessionResponse> {
        return {};
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test initialize request
    const response = await agentConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      },
    });

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.authMethods).toHaveLength(1);
    expect(response.authMethods?.[0].id).toBe("oauth");
  });

  it("strips unknown properties on known incoming params", async () => {
    let receivedInitializeParams: Record<string, unknown> | undefined;
    let receivedSessionUpdate: Record<string, unknown> | undefined;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(params: SessionNotification): Promise<void> {
        receivedSessionUpdate = params as unknown as Record<string, unknown>;
      }
    }

    class TestAgent implements Agent {
      async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        receivedInitializeParams = params as unknown as Record<string, unknown>;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async loadSession(_: LoadSessionRequest): Promise<LoadSessionResponse> {
        return {};
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await agentConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
          experimentalFs: true,
        },
        customCapability: {
          enabled: true,
        },
      },
      extraTopLevel: "keep me",
    } as any);

    await clientConnection.sessionUpdate({
      sessionId: "test-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Hello from agent",
        },
        extraUpdateField: {
          keep: true,
        },
      },
      extraNotificationField: "keep this too",
    } as any);

    await vi.waitFor(() => {
      expect(receivedInitializeParams).not.toHaveProperty("extraTopLevel");
      expect(receivedInitializeParams).not.toHaveProperty(
        "clientCapabilities.customCapability",
      );
      expect(receivedInitializeParams).not.toHaveProperty(
        "clientCapabilities.fs.experimentalFs",
      );

      expect(receivedSessionUpdate).not.toHaveProperty(
        "extraNotificationField",
      );
      expect(receivedSessionUpdate).not.toHaveProperty(
        "update.extraUpdateField",
      );
    });
  });

  it("handles extension methods and notifications", async () => {
    const extensionLog: string[] = [];

    // Create client with extension method support
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
      async extMethod(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        if (method === "example.com/ping") {
          return { response: "pong", params };
        }
        throw new Error(`Unknown method: ${method}`);
      }
      async extNotification(
        method: string,
        _params: Record<string, unknown>,
      ): Promise<void> {
        extensionLog.push(`client extNotification: ${method}`);
      }
    }

    // Create agent with extension method support
    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
      async extMethod(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        if (method === "example.com/echo") {
          return { echo: params };
        }
        throw new Error(`Unknown method: ${method}`);
      }
      async extNotification(
        method: string,
        _params: Record<string, unknown>,
      ): Promise<void> {
        extensionLog.push(`agent extNotification: ${method}`);
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test agent calling client extension method
    const clientResponse = await clientConnection.extMethod(
      "example.com/ping",
      {
        data: "test",
      },
    );
    expect(clientResponse).toEqual({
      response: "pong",
      params: { data: "test" },
    });

    // Test client calling agent extension method
    const agentResponse = await agentConnection.extMethod("example.com/echo", {
      message: "hello",
    });
    expect(agentResponse).toEqual({ echo: { message: "hello" } });

    // Test extension notifications
    await clientConnection.extNotification("example.com/client/notify", {
      info: "client notification",
    });
    await agentConnection.extNotification("example.com/agent/notify", {
      info: "agent notification",
    });

    // Verify notifications were logged
    await vi.waitFor(() => {
      expect(extensionLog).toContain(
        "client extNotification: example.com/client/notify",
      );
      expect(extensionLog).toContain(
        "agent extNotification: example.com/agent/notify",
      );
    });
  });

  it("handles optional extension methods correctly", async () => {
    // Create client WITHOUT extension methods
    class TestClientWithoutExtensions implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
      // Note: No extMethod or extNotification implemented
    }

    // Create agent WITHOUT extension methods
    class TestAgentWithoutExtensions implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
      // Note: No extMethod or extNotification implemented
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClientWithoutExtensions(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgentWithoutExtensions(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test that calling extension methods on connections without them throws method not found
    try {
      await clientConnection.extMethod("_example.com/ping", { data: "test" });
      expect.fail("Should have thrown method not found error");
    } catch (error: any) {
      expect(error.code).toBe(-32601); // Method not found
      expect(error.data.method).toBe("_example.com/ping");
    }

    try {
      await agentConnection.extMethod("_example.com/echo", {
        message: "hello",
      });
      expect.fail("Should have thrown method not found error");
    } catch (error: any) {
      expect(error.code).toBe(-32601); // Method not found
      expect(error.data.method).toBe("_example.com/echo");
    }

    // Notifications should be ignored when not implemented (no error thrown)
    await clientConnection.extNotification("example.com/notify", {
      info: "test",
    });
    await agentConnection.extNotification("example.com/notify", {
      info: "test",
    });
  });

  it("resolves closed promise when stream ends", async () => {
    const closeLog: string[] = [];

    // Create simple client and agent
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Listen for close via signal
    agentConnection.signal.addEventListener("abort", () => {
      closeLog.push("agent connection closed (signal)");
    });

    clientConnection.signal.addEventListener("abort", () => {
      closeLog.push("client connection closed (signal)");
    });

    // Verify connections are not closed yet
    expect(agentConnection.signal.aborted).toBe(false);
    expect(clientConnection.signal.aborted).toBe(false);
    expect(closeLog).toHaveLength(0);

    // Close the streams by closing the writable ends
    await clientToAgent.writable.close();
    await agentToClient.writable.close();

    // Wait for closed promises to resolve
    await agentConnection.closed;
    await clientConnection.closed;

    // Verify connections are now closed
    expect(agentConnection.signal.aborted).toBe(true);
    expect(clientConnection.signal.aborted).toBe(true);
    expect(closeLog).toContain("agent connection closed (signal)");
    expect(closeLog).toContain("client connection closed (signal)");
  });

  it("rejects connectWith when the stream closes before the operation finishes", async () => {
    let readableController!: ReadableStreamDefaultController<AnyMessage>;
    const run = Connection.builder().connectWith(
      {
        readable: new ReadableStream<AnyMessage>({
          start(controller) {
            readableController = controller;
          },
        }),
        writable: new WritableStream<AnyMessage>(),
      },
      async () => new Promise<never>(() => {}),
    );

    readableController.close();

    await expect(run).rejects.toThrow("ACP connection closed");
  });

  it("cancels the receive reader when connectWith closes", async () => {
    const { promise: canceled, resolve: resolveCanceled } =
      Promise.withResolvers<void>();

    await expect(
      Connection.builder().connectWith(
        {
          readable: new ReadableStream<AnyMessage>({
            cancel() {
              resolveCanceled();
            },
          }),
          writable: new WritableStream<AnyMessage>(),
        },
        () => "done",
      ),
    ).resolves.toBe("done");

    await expect(canceled).resolves.toBeUndefined();
  });

  it("does not dispatch incoming messages after connectWith closes", async () => {
    const input = new TransformStream<AnyMessage>();
    const output = new TransformStream<AnyMessage>();
    const handled: unknown[] = [];

    await expect(
      Connection.builder()
        .onReceiveNotification(
          "late/notification",
          (params) => params,
          (params) => {
            handled.push(params);
          },
        )
        .connectWith(
          {
            readable: input.readable,
            writable: output.writable,
          },
          () => "done",
        ),
    ).resolves.toBe("done");

    const writer = input.writable.getWriter();
    try {
      await writer.write({
        jsonrpc: "2.0",
        method: "late/notification",
        params: { afterClose: true },
      });
    } catch {
      // Closing the connection may cancel the readable side before the peer writes.
    } finally {
      writer.releaseLock();
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual([]);
  });

  it("allows connectWith operations to return synchronously", async () => {
    const result = await Connection.builder().connectWith(
      {
        readable: new ReadableStream<AnyMessage>(),
        writable: new WritableStream<AnyMessage>(),
      },
      () => "done",
    );

    expect(result).toBe("done");
  });

  it("rejects connectWith with the stream error while the operation is pending", async () => {
    let readableController!: ReadableStreamDefaultController<AnyMessage>;
    const run = Connection.builder().connectWith(
      {
        readable: new ReadableStream<AnyMessage>({
          start(controller) {
            readableController = controller;
          },
        }),
        writable: new WritableStream<AnyMessage>(),
      },
      async () => new Promise<never>(() => {}),
    );

    readableController.error(new Error("stream exploded"));

    await expect(run).rejects.toThrow("stream exploded");
  });

  class MinimalTestClient implements Client {
    async writeTextFile(
      _: WriteTextFileRequest,
    ): Promise<WriteTextFileResponse> {
      return {};
    }
    async readTextFile(_: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      return { content: "test" };
    }
    async requestPermission(
      _: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      return {
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      };
    }
    async sessionUpdate(_: SessionNotification): Promise<void> {
      // no-op
    }
  }

  it("propagates input stream errors through ndJsonStream", async () => {
    const inputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Simulate a process crash after partial data
        controller.error(new Error("process exited with code 1"));
      },
    });
    const outputStream = new WritableStream<Uint8Array>();

    const connection = new ClientSideConnection(
      () => new MinimalTestClient(),
      ndJsonStream(outputStream, inputStream),
    );

    await expect(connection.closed).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(true);
  });

  it("rejects pending requests when input stream errors via ndJsonStream", async () => {
    let errorController!: ReadableStreamDefaultController<Uint8Array>;

    const inputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        errorController = controller;
      },
    });
    const outputStream = new WritableStream<Uint8Array>();

    const connection = new ClientSideConnection(
      () => new MinimalTestClient(),
      ndJsonStream(outputStream, inputStream),
    );

    const requestPromise = connection.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    errorController.error(new Error("process exited with code 1"));

    await expect(requestPromise).rejects.toThrow("process exited with code 1");
  });

  it("rejects pending requests when the stream errors", async () => {
    let readableController!: ReadableStreamDefaultController<AnyMessage>;

    const connection = new ClientSideConnection(() => new MinimalTestClient(), {
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          readableController = controller;
        },
      }),
      writable: new WritableStream<AnyMessage>({
        async write() {
          // no-op
        },
      }),
    });

    const requestPromise = connection.newSession({
      cwd: "/test",
      mcpServers: [],
    });
    const error = new Error("stream exploded");

    readableController.error(error);

    await expect(requestPromise).rejects.toThrow("stream exploded");
    await expect(connection.closed).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(true);
  });

  it("rejects pending requests when the writable stream errors", async () => {
    const writeError = new Error("write failed");

    const connection = new ClientSideConnection(() => new MinimalTestClient(), {
      readable: new ReadableStream<AnyMessage>({
        // Never produces messages; stays open.
        start() {},
      }),
      writable: new WritableStream<AnyMessage>({
        async write() {
          throw writeError;
        },
      }),
    });

    const requestPromise = connection.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    await expect(requestPromise).rejects.toThrow("write failed");
    await expect(connection.closed).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(true);
  });

  it("rejects notifications when the writable stream errors", async () => {
    const writeError = new Error("write failed");

    const connection = new ClientSideConnection(() => new MinimalTestClient(), {
      readable: new ReadableStream<AnyMessage>({
        // Never produces messages; stays open.
        start() {},
      }),
      writable: new WritableStream<AnyMessage>({
        async write() {
          throw writeError;
        },
      }),
    });

    await expect(
      connection.cancel({ sessionId: "test-session" }),
    ).rejects.toThrow("write failed");
    await expect(connection.closed).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(true);
  });

  it("rejects requests issued after the connection is closed", async () => {
    const connection = new ClientSideConnection(() => new MinimalTestClient(), {
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          // Close the readable stream immediately so the connection closes.
          controller.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        async write() {
          // no-op
        },
      }),
    });

    await connection.closed;
    expect(connection.signal.aborted).toBe(true);

    await expect(
      connection.newSession({ cwd: "/test", mcpServers: [] }),
    ).rejects.toThrow("ACP connection closed");
  });

  it("rejects requests issued after the connection closes with a falsy reason", async () => {
    const connection = new ClientSideConnection(() => new MinimalTestClient(), {
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          controller.error(0);
        },
      }),
      writable: new WritableStream<AnyMessage>({
        async write() {
          // no-op
        },
      }),
    });

    await connection.closed;
    expect(connection.signal.aborted).toBe(true);

    await expect(
      connection.newSession({ cwd: "/test", mcpServers: [] }),
    ).rejects.toBe(0);
  });

  it("supports removing signal event listeners", async () => {
    const closeLog: string[] = [];

    // Create simple client and agent
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "test" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {
        // no-op
      }
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {
        // no-op
      }
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {
        // no-op
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Register and then remove a listener
    const listener = () => {
      closeLog.push("this should not be called");
    };

    agentConnection.signal.addEventListener("abort", listener);
    agentConnection.signal.removeEventListener("abort", listener);

    // Register another listener that should be called
    agentConnection.signal.addEventListener("abort", () => {
      closeLog.push("agent connection closed");
    });

    // Close the streams
    await clientToAgent.writable.close();
    await agentToClient.writable.close();

    // Wait for closed promise
    await agentConnection.closed;

    // Verify only the non-removed listener was called
    expect(closeLog).toEqual(["agent connection closed"]);
    expect(closeLog).not.toContain("this should not be called");
  });

  it("handles methods returning response objects with _meta or void", async () => {
    // Create client that returns both response objects and void
    class TestClient implements Client {
      async writeTextFile(
        _params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        // Return response object with _meta
        return {
          _meta: {
            timestamp: new Date().toISOString(),
            version: "1.0.0",
          },
        };
      }
      async readTextFile(
        _params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return {
          content: "test content",
          _meta: {
            encoding: "utf-8",
          },
        };
      }
      async requestPermission(
        _params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
          _meta: {
            userId: "test-user",
          },
        };
      }
      async sessionUpdate(_params: SessionNotification): Promise<void> {
        // Returns void
      }
    }

    // Create agent that returns both response objects and void
    class TestAgent implements Agent {
      async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: true },
          _meta: {
            agentVersion: "2.0.0",
          },
        };
      }
      async newSession(
        _params: NewSessionRequest,
      ): Promise<NewSessionResponse> {
        return {
          sessionId: "test-session",
          _meta: {
            sessionType: "ephemeral",
          },
        };
      }
      async loadSession(
        _params: LoadSessionRequest,
      ): Promise<LoadSessionResponse> {
        // Test returning minimal response
        return {};
      }
      async authenticate(
        params: AuthenticateRequest,
      ): Promise<AuthenticateResponse | void> {
        if (params.methodId === "none") {
          // Test returning void
          return;
        }
        // Test returning response with _meta
        return {
          _meta: {
            authenticated: true,
            method: params.methodId,
          },
        };
      }
      async prompt(_params: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_params: CancelNotification): Promise<void> {
        // Returns void
      }
    }

    // Set up connections
    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test writeTextFile returns response with _meta
    const writeResponse = await clientConnection.writeTextFile({
      path: "/test.txt",
      content: "test",
      sessionId: "test-session",
    });
    expect(writeResponse).toEqual({
      _meta: {
        timestamp: expect.any(String),
        version: "1.0.0",
      },
    });

    // Test readTextFile returns response with content and _meta
    const readResponse = await clientConnection.readTextFile({
      path: "/test.txt",
      sessionId: "test-session",
    });
    expect(readResponse.content).toBe("test content");
    expect(readResponse._meta).toEqual({
      encoding: "utf-8",
    });

    // Test initialize with _meta
    const initResponse = await agentConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initResponse._meta).toEqual({
      agentVersion: "2.0.0",
    });

    // Test authenticate returning void
    const authResponseVoid = await agentConnection.authenticate({
      methodId: "none",
    });
    expect(authResponseVoid).toEqual({});

    // Test authenticate returning response with _meta
    const authResponse = await agentConnection.authenticate({
      methodId: "oauth",
    });
    expect(authResponse).toEqual({
      _meta: {
        authenticated: true,
        method: "oauth",
      },
    });

    // Test newSession with _meta
    const sessionResponse = await agentConnection.newSession({
      cwd: "/test",
      mcpServers: [],
    });
    expect(sessionResponse._meta).toEqual({
      sessionType: "ephemeral",
    });

    // Test loadSession returning minimal response
    const loadResponse = await agentConnection.loadSession({
      sessionId: "test-session",
      mcpServers: [],
      cwd: "/test",
    });
    expect(loadResponse).toEqual({});
  });

  it("handles NES request lifecycle", async () => {
    let receivedStartRequest: StartNesRequest | undefined;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}

      async unstable_startNes(
        params: StartNesRequest,
      ): Promise<StartNesResponse> {
        receivedStartRequest = params;
        return { sessionId: "nes-session-1" };
      }
      async unstable_suggestNes(
        _: SuggestNesRequest,
      ): Promise<SuggestNesResponse> {
        return {
          suggestions: [
            {
              kind: "edit",
              id: "sug-1",
              uri: "file:///test.ts",
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                  },
                  newText: "hello",
                },
              ],
            },
          ],
        };
      }
      async unstable_closeNes(_: CloseNesRequest): Promise<CloseNesResponse> {
        return {};
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    const startResponse = await agentConnection.unstable_startNes({
      workspaceUri: "file:///workspace",
      workspaceFolders: [
        { uri: "file:///workspace/frontend", name: "frontend" },
        { uri: "file:///workspace/backend", name: "backend" },
      ],
      repository: {
        name: "my-repo",
        owner: "my-org",
        remoteUrl: "https://github.com/my-org/my-repo.git",
      },
    });
    expect(startResponse).toEqual({ sessionId: "nes-session-1" });
    expect(receivedStartRequest?.workspaceUri).toEqual("file:///workspace");
    expect(receivedStartRequest?.workspaceFolders).toEqual([
      { uri: "file:///workspace/frontend", name: "frontend" },
      { uri: "file:///workspace/backend", name: "backend" },
    ]);
    expect(receivedStartRequest?.repository).toEqual({
      name: "my-repo",
      owner: "my-org",
      remoteUrl: "https://github.com/my-org/my-repo.git",
    });

    const suggestResponse = await agentConnection.unstable_suggestNes({
      sessionId: "nes-session-1",
      position: { line: 0, character: 5 },
      triggerKind: "manual",
      uri: "file:///test.ts",
      version: 1,
    });
    expect(suggestResponse).toEqual({
      suggestions: [
        {
          kind: "edit",
          id: "sug-1",
          uri: "file:///test.ts",
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              newText: "hello",
            },
          ],
        },
      ],
    });

    const closeResponse = await agentConnection.unstable_closeNes({
      sessionId: "nes-session-1",
    });
    expect(closeResponse).toEqual({});
  });

  it("handles providers request lifecycle", async () => {
    let receivedSetRequest: SetProviderRequest | undefined;
    let receivedDisableRequest: DisableProviderRequest | undefined;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, providers: {} },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}

      async unstable_listProviders(
        _: ListProvidersRequest,
      ): Promise<ListProvidersResponse> {
        return {
          providers: [
            {
              id: "main",
              supported: ["anthropic", "openai"],
              required: true,
              current: {
                apiType: "anthropic",
                baseUrl: "https://api.anthropic.com",
              },
            },
            {
              id: "openai",
              supported: ["openai"],
              required: false,
            },
            {
              id: "azure",
              supported: ["azure"],
              required: false,
              current: null,
            },
          ],
        };
      }

      async unstable_setProvider(params: SetProviderRequest): Promise<void> {
        receivedSetRequest = params;
      }

      async unstable_disableProvider(
        params: DisableProviderRequest,
      ): Promise<DisableProviderResponse> {
        receivedDisableRequest = params;
        return {};
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    const listResponse = await agentConnection.unstable_listProviders({});
    expect(listResponse.providers).toEqual([
      {
        id: "main",
        supported: ["anthropic", "openai"],
        required: true,
        current: {
          apiType: "anthropic",
          baseUrl: "https://api.anthropic.com",
        },
      },
      {
        id: "openai",
        supported: ["openai"],
        required: false,
      },
      {
        id: "azure",
        supported: ["azure"],
        required: false,
        current: null,
      },
    ]);
    expect("current" in listResponse.providers[1]).toBe(false);

    const setResponse = await agentConnection.unstable_setProvider({
      id: "main",
      apiType: "openai",
      baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
      headers: {
        Authorization: "Bearer token",
        "X-Request-Source": "test-client",
      },
    });
    expect(setResponse).toEqual({});
    expect(receivedSetRequest).toEqual({
      id: "main",
      apiType: "openai",
      baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
      headers: {
        Authorization: "Bearer token",
        "X-Request-Source": "test-client",
      },
    });

    const disableResponse = await agentConnection.unstable_disableProvider({
      id: "openai",
    });
    expect(disableResponse).toEqual({});
    expect(receivedDisableRequest).toEqual({ id: "openai" });
  });

  it("rejects providers requests when agent does not implement handlers", async () => {
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    await expect(
      agentConnection.unstable_listProviders({}),
    ).rejects.toMatchObject({
      code: -32601,
      data: { method: "providers/list" },
    });

    await expect(
      agentConnection.unstable_setProvider({
        id: "main",
        apiType: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).rejects.toMatchObject({
      code: -32601,
      data: { method: "providers/set" },
    });

    await expect(
      agentConnection.unstable_disableProvider({ id: "main" }),
    ).rejects.toMatchObject({
      code: -32601,
      data: { method: "providers/disable" },
    });
  });

  it("handles NES notifications", async () => {
    const notificationLog: unknown[] = [];

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}

      async unstable_acceptNes(params: AcceptNesNotification): Promise<void> {
        notificationLog.push({ type: "acceptNes", params });
      }
      async unstable_rejectNes(params: RejectNesNotification): Promise<void> {
        notificationLog.push({ type: "rejectNes", params });
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    await agentConnection.unstable_acceptNes({
      sessionId: "nes-session-1",
      id: "sug-1",
    });
    await agentConnection.unstable_rejectNes({
      sessionId: "nes-session-1",
      id: "sug-2",
      reason: "rejected",
    });

    await vi.waitFor(() => {
      expect(notificationLog).toEqual([
        {
          type: "acceptNes",
          params: { sessionId: "nes-session-1", id: "sug-1" },
        },
        {
          type: "rejectNes",
          params: {
            sessionId: "nes-session-1",
            id: "sug-2",
            reason: "rejected",
          },
        },
      ]);
    });
  });

  it("handles document notifications", async () => {
    const notificationLog: unknown[] = [];

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}

      async unstable_didOpenDocument(
        params: DidOpenDocumentNotification,
      ): Promise<void> {
        notificationLog.push({ type: "didOpen", params });
      }
      async unstable_didChangeDocument(
        params: DidChangeDocumentNotification,
      ): Promise<void> {
        notificationLog.push({ type: "didChange", params });
      }
      async unstable_didCloseDocument(
        params: DidCloseDocumentNotification,
      ): Promise<void> {
        notificationLog.push({ type: "didClose", params });
      }
      async unstable_didSaveDocument(
        params: DidSaveDocumentNotification,
      ): Promise<void> {
        notificationLog.push({ type: "didSave", params });
      }
      async unstable_didFocusDocument(
        params: DidFocusDocumentNotification,
      ): Promise<void> {
        notificationLog.push({ type: "didFocus", params });
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    await agentConnection.unstable_didOpenDocument({
      sessionId: "s1",
      uri: "file:///test.ts",
      languageId: "typescript",
      version: 1,
      text: "const x = 1;",
    });
    await agentConnection.unstable_didChangeDocument({
      sessionId: "s1",
      uri: "file:///test.ts",
      version: 2,
      contentChanges: [{ text: "const x = 2;" }],
    });
    await agentConnection.unstable_didSaveDocument({
      sessionId: "s1",
      uri: "file:///test.ts",
    });
    await agentConnection.unstable_didFocusDocument({
      sessionId: "s1",
      uri: "file:///test.ts",
      version: 2,
      position: { line: 0, character: 5 },
      visibleRange: {
        start: { line: 0, character: 0 },
        end: { line: 10, character: 0 },
      },
    });
    await agentConnection.unstable_didCloseDocument({
      sessionId: "s1",
      uri: "file:///test.ts",
    });

    await vi.waitFor(() => {
      expect(notificationLog).toEqual([
        {
          type: "didOpen",
          params: {
            sessionId: "s1",
            uri: "file:///test.ts",
            languageId: "typescript",
            version: 1,
            text: "const x = 1;",
          },
        },
        {
          type: "didChange",
          params: {
            sessionId: "s1",
            uri: "file:///test.ts",
            version: 2,
            contentChanges: [{ text: "const x = 2;" }],
          },
        },
        {
          type: "didSave",
          params: {
            sessionId: "s1",
            uri: "file:///test.ts",
          },
        },
        {
          type: "didFocus",
          params: {
            sessionId: "s1",
            uri: "file:///test.ts",
            version: 2,
            position: { line: 0, character: 5 },
            visibleRange: {
              start: { line: 0, character: 0 },
              end: { line: 10, character: 0 },
            },
          },
        },
        {
          type: "didClose",
          params: {
            sessionId: "s1",
            uri: "file:///test.ts",
          },
        },
      ]);
    });
  });

  it("propagates additionalDirectories on session lifecycle methods", async () => {
    let receivedNewSession: NewSessionRequest | undefined;
    let receivedLoadSession: LoadSessionRequest | undefined;
    let receivedForkSession: ForkSessionRequest | undefined;
    let receivedResumeSession: ResumeSessionRequest | undefined;
    let receivedListSessions: ListSessionsRequest | undefined;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        receivedNewSession = params;
        return { sessionId: "new-s1" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}

      async loadSession(
        params: LoadSessionRequest,
      ): Promise<LoadSessionResponse> {
        receivedLoadSession = params;
        return {};
      }
      async unstable_forkSession(
        params: ForkSessionRequest,
      ): Promise<ForkSessionResponse> {
        receivedForkSession = params;
        return { sessionId: "forked-s1" };
      }
      async resumeSession(
        params: ResumeSessionRequest,
      ): Promise<ResumeSessionResponse> {
        receivedResumeSession = params;
        return {};
      }
      async listSessions(
        params: ListSessionsRequest,
      ): Promise<ListSessionsResponse> {
        receivedListSessions = params;
        return { sessions: [] };
      }
    }

    const agentConnection = new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    void clientConnection;

    const newSessionResponse = await agentConnection.newSession({
      cwd: "/test",
      mcpServers: [],
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(newSessionResponse).toEqual({ sessionId: "new-s1" });
    expect(receivedNewSession?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);

    const loadResponse = await agentConnection.loadSession({
      sessionId: "s1",
      cwd: "/test",
      mcpServers: [],
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(loadResponse).toEqual({});
    expect(receivedLoadSession?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);

    const forkResponse = await agentConnection.unstable_forkSession({
      sessionId: "s1",
      cwd: "/test",
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(forkResponse).toEqual({ sessionId: "forked-s1" });
    expect(receivedForkSession?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);

    const resumeResponse = await agentConnection.resumeSession({
      sessionId: "s1",
      cwd: "/test",
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(resumeResponse).toEqual({});
    expect(receivedResumeSession?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);

    const listResponse = await agentConnection.listSessions({});
    expect(listResponse).toEqual({ sessions: [] });
    expect(receivedListSessions).toEqual({});
  });

  it("handles elicitation request lifecycle", async () => {
    let receivedRequest: CreateElicitationRequest | undefined;
    let receivedNotification: CompleteElicitationNotification | undefined;

    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}

      async unstable_createElicitation(
        params: CreateElicitationRequest,
      ): Promise<CreateElicitationResponse> {
        receivedRequest = params;
        return {
          action: "accept",
          content: { name: "Alice" },
        };
      }
      async unstable_completeElicitation(
        params: CompleteElicitationNotification,
      ): Promise<void> {
        receivedNotification = params;
      }
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}
    }

    new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    // Test form-mode elicitation request
    const response = await clientConnection.unstable_createElicitation({
      sessionId: "test-session",
      mode: "form",
      message: "Please enter your name",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Your name" },
        },
      },
    });

    expect(response.action).toBe("accept");
    expect(receivedRequest?.message).toBe("Please enter your name");
    expect((receivedRequest as any)?.sessionId).toBe("test-session");
    expect((receivedRequest as any)?.mode).toBe("form");

    // Test url-mode elicitation request
    receivedRequest = undefined;
    const urlResponse = await clientConnection.unstable_createElicitation({
      sessionId: "test-session",
      mode: "url",
      message: "Please authenticate",
      elicitationId: "elic-url-1",
      url: "https://example.com/auth",
    });

    expect(urlResponse.action).toBe("accept");
    expect((receivedRequest as any)?.message).toBe("Please authenticate");
    expect((receivedRequest as any)?.mode).toBe("url");
    expect((receivedRequest as any)?.url).toBe("https://example.com/auth");
    expect((receivedRequest as any)?.elicitationId).toBe("elic-url-1");

    // Test elicitation complete notification
    await clientConnection.unstable_completeElicitation({
      elicitationId: "elic-1",
    });

    await vi.waitFor(() => {
      expect(receivedNotification?.elicitationId).toBe("elic-1");
    });
  });

  it("silently ignores completeElicitation when client does not implement handler", async () => {
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}
    }

    new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await clientConnection.unstable_completeElicitation({
      elicitationId: "elic-1",
    });
  });

  it("rejects elicitation request when client does not implement handler", async () => {
    // Client WITHOUT unstable_createElicitation
    class TestClient implements Client {
      async writeTextFile(
        _: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> {
        return {};
      }
      async readTextFile(
        _: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> {
        return { content: "" };
      }
      async requestPermission(
        _: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow" } };
      }
      async sessionUpdate(_: SessionNotification): Promise<void> {}
    }

    class TestAgent implements Agent {
      async initialize(_: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        };
      }
      async newSession(_: NewSessionRequest): Promise<NewSessionResponse> {
        return { sessionId: "test-session" };
      }
      async authenticate(_: AuthenticateRequest): Promise<void> {}
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        return { stopReason: "end_turn" };
      }
      async cancel(_: CancelNotification): Promise<void> {}
    }

    new ClientSideConnection(
      () => new TestClient(),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const clientConnection = new AgentSideConnection(
      () => new TestAgent(),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await expect(
      clientConnection.unstable_createElicitation({
        sessionId: "test-session",
        mode: "form",
        message: "Enter your name",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      }),
    ).rejects.toMatchObject({ code: -32601 });
  });
});

describe("CreateElicitationRequest schema", () => {
  // These tests verify the post-processed zod schema correctly enforces
  // both the scope union (session vs request) and mode discriminator (form vs url).
  // If the generate.js patches stop applying, these will fail.

  const formSessionRequest = {
    sessionId: "sess-1",
    mode: "form" as const,
    message: "Enter your name",
    requestedSchema: { type: "object" as const, properties: {} },
  };

  it("accepts form-mode request scoped to a session", () => {
    const result = zCreateElicitationRequest.safeParse(formSessionRequest);
    expect(result.success).toBe(true);
  });

  it("accepts form-mode request with optional toolCallId", () => {
    const result = zCreateElicitationRequest.safeParse({
      ...formSessionRequest,
      toolCallId: "tc-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts form-mode request scoped to a request", () => {
    const result = zCreateElicitationRequest.safeParse({
      requestId: "req-1",
      mode: "form",
      message: "Enter your name",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result.success).toBe(true);
  });

  it("accepts url-mode request scoped to a session", () => {
    const result = zCreateElicitationRequest.safeParse({
      sessionId: "sess-1",
      mode: "url",
      message: "Please authenticate",
      elicitationId: "elic-1",
      url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
  });

  it("accepts url-mode request with optional toolCallId", () => {
    const result = zCreateElicitationRequest.safeParse({
      sessionId: "sess-1",
      toolCallId: "tc-1",
      mode: "url",
      message: "Please authenticate",
      elicitationId: "elic-1",
      url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
  });

  it("accepts url-mode request scoped to a request", () => {
    const result = zCreateElicitationRequest.safeParse({
      requestId: "req-1",
      mode: "url",
      message: "Please authenticate",
      elicitationId: "elic-1",
      url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
  });

  it("rejects request without mode", () => {
    const result = zCreateElicitationRequest.safeParse({
      sessionId: "sess-1",
      message: "Enter your name",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects request with invalid mode", () => {
    const result = zCreateElicitationRequest.safeParse({
      sessionId: "sess-1",
      mode: "invalid",
      message: "Enter your name",
    });
    expect(result.success).toBe(false);
  });

  it("rejects request without message", () => {
    const result = zCreateElicitationRequest.safeParse({
      sessionId: "sess-1",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects form-mode request without scope (no sessionId or requestId)", () => {
    const result = zCreateElicitationRequest.safeParse({
      mode: "form",
      message: "Enter your name",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects url-mode request without scope (no sessionId or requestId)", () => {
    const result = zCreateElicitationRequest.safeParse({
      mode: "url",
      message: "Please authenticate",
      elicitationId: "elic-1",
      url: "https://example.com/auth",
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown properties", () => {
    const result = zCreateElicitationRequest.safeParse({
      ...formSessionRequest,
      customField: "custom-value",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).customField).toBeUndefined();
    }
  });
});

describe("CreateElicitationResponse schema", () => {
  it("accepts accept action with content", () => {
    const result = zCreateElicitationResponse.safeParse({
      action: "accept",
      content: { name: "Alice" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts decline action", () => {
    const result = zCreateElicitationResponse.safeParse({
      action: "decline",
    });
    expect(result.success).toBe(true);
  });

  it("accepts cancel action", () => {
    const result = zCreateElicitationResponse.safeParse({
      action: "cancel",
    });
    expect(result.success).toBe(true);
  });

  it("rejects response without action", () => {
    const result = zCreateElicitationResponse.safeParse({
      content: { name: "Alice" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects response with invalid action", () => {
    const result = zCreateElicitationResponse.safeParse({
      action: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("Schema deserialization compatibility", () => {
  it("preserves inferred types for required default-on-error fields", () => {
    const checks: [
      AssertSchemaAssignable<typeof zPlan, Plan>,
      AssertSchemaAssignable<typeof zSessionModeState, SessionModeState>,
      AssertSchemaAssignable<typeof zNewSessionResponse, NewSessionResponse>,
      AssertSchemaAssignable<typeof zSessionUpdate, SessionUpdate>,
      AssertSchemaAssignable<typeof zSessionNotification, SessionNotification>,
    ] = [true, true, true, true, true];

    expect(checks).toEqual([true, true, true, true, true]);
  });

  it("defaults invalid optional values to undefined", () => {
    const response = zInitializeResponse.parse({
      protocolVersion: 1,
      agentInfo: "invalid",
    });

    expect(response.agentInfo).toBeUndefined();
  });

  it("keeps explicit schema defaults and skips invalid array items", () => {
    const response = zInitializeResponse.parse({
      protocolVersion: 1,
      authMethods: [
        { id: "agent-auth", name: "Agent auth" },
        { type: "terminal", id: "missing-name" },
      ],
    });

    expect(response.authMethods).toEqual([
      { id: "agent-auth", name: "Agent auth" },
    ]);
    expect(
      zInitializeResponse.parse({
        protocolVersion: 1,
        authMethods: "invalid",
      }).authMethods,
    ).toEqual([]);
  });

  it("keeps required default-on-error arrays required when missing", () => {
    expect(zPlan.safeParse({}).success).toBe(false);

    expect(zPlan.parse({ entries: "invalid" }).entries).toEqual([]);
    expect(
      zPlan.parse({
        entries: [
          { content: "done", priority: "high", status: "completed" },
          { content: "missing status", priority: "low" },
        ],
      }).entries,
    ).toEqual([{ content: "done", priority: "high", status: "completed" }]);
  });

  it("defaults optional non-null arrays to [] only for invalid present values", () => {
    expect(zClientCapabilities.parse({}).positionEncodings).toBeUndefined();
    expect(
      zClientCapabilities.parse({ positionEncodings: "invalid" })
        .positionEncodings,
    ).toEqual([]);
  });

  it("defaults optional nullable arrays to undefined for invalid present values", () => {
    expect(
      zAnnotations.parse({ audience: "invalid" }).audience,
    ).toBeUndefined();
    expect(
      zAnnotations.parse({ audience: ["user", "invalid", "assistant"] })
        .audience,
    ).toEqual(["user", "assistant"]);
  });

  it("skips invalid nested tool call content and locations", () => {
    const toolCall = zToolCall.parse({
      content: [
        { type: "content", content: { type: "text", text: "hello" } },
        { type: "terminal" },
      ],
      locations: [{ path: "/tmp/file.ts", line: 1 }, { path: 1 }],
      title: "Read file",
      toolCallId: "tool-call-1",
    });

    expect(toolCall.content).toEqual([
      { type: "content", content: { type: "text", text: "hello" } },
    ]);
    expect(toolCall.locations).toEqual([{ path: "/tmp/file.ts", line: 1 }]);
  });
});
