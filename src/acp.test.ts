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
} from "./acp.js";
import type {
  AnyMessage,
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

  it("supports role builders with context-aware handlers", async () => {
    const events: string[] = [];

    Agent.builder()
      .name("test-agent")
      .onInitialize(async (request, responder) => {
        events.push(`initialize:${request.protocolVersion}`);
        await responder.respond({
          protocolVersion: request.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        });
      })
      .onNewSession(async (request, responder) => {
        events.push(`new:${request.cwd}`);
        await responder.respond({ sessionId: "builder-session" });
      })
      .onPrompt(async (request, responder, cx) => {
        events.push(`prompt:${request.sessionId}`);
        await cx.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "builder update",
            },
          },
        });
        await responder.respond({ stopReason: "end_turn" });
      })
      .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await Client.builder()
      .name("test-client")
      .onSessionUpdate(async (notification) => {
        events.push(`update:${notification.sessionId}`);
      })
      .connectWith(
        ndJsonStream(clientToAgent.writable, agentToClient.readable),
        async (cx) => {
          const initializeResponse = await cx.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionResponse = await cx.newSession({
            cwd: "/builder",
            mcpServers: [],
          });
          const promptResponse = await cx.prompt({
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
    expect(result.sessionResponse.sessionId).toBe("builder-session");
    expect(result.promptResponse.stopReason).toBe("end_turn");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/builder",
      "prompt:builder-session",
      "update:builder-session",
    ]);
  });

  it("connects role builders directly without transport setup", async () => {
    const events: string[] = [];

    const agent = Agent.builder()
      .name("direct-agent")
      .onInitialize(async (request, responder) => {
        events.push(`initialize:${request.protocolVersion}`);
        await responder.respond({
          protocolVersion: request.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        });
      })
      .onNewSession(async (request, responder) => {
        events.push(`new:${request.cwd}`);
        await responder.respond({ sessionId: "direct-session" });
      });

    const result = await Client.builder()
      .name("direct-client")
      .connectWith(agent, async (cx) => {
        const initializeResponse = await cx.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionResponse = await cx.newSession({
          cwd: "/direct-builder",
          mcpServers: [],
        });

        return { initializeResponse, sessionResponse };
      });

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("direct-session");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/direct-builder",
    ]);
  });

  it("returns promises from typed request methods", async () => {
    const events: string[] = [];

    const agent = Agent.builder()
      .name("promise-agent")
      .onInitialize((request, responder) => {
        events.push(`initialize:${request.protocolVersion}`);
        return responder.respond({
          protocolVersion: request.protocolVersion,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        });
      })
      .onNewSession((request, responder) => {
        events.push(`new:${request.cwd}`);
        return responder.respond({ sessionId: "promise-session" });
      });

    const result = await Client.builder()
      .name("promise-client")
      .connectWith(agent, async (cx) => {
        const initializeResponse = await cx.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const sessionResponse = await cx.newSession({
          cwd: "/promise-builder",
          mcpServers: [],
        });

        return { initializeResponse, sessionResponse };
      });

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.sessionResponse.sessionId).toBe("promise-session");
    expect(events).toEqual([
      `initialize:${PROTOCOL_VERSION}`,
      "new:/promise-builder",
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

    const agent = Agent.builder()
      .name("handler-await-agent")
      .onNewSession(async (_request, responder) => {
        await responder.respond({ sessionId: "handler-await-session" });
      })
      .onPrompt(async (request, responder, cx) => {
        events.push(`prompt:${request.sessionId}`);
        const permission = await cx.requestPermission({
          sessionId: request.sessionId,
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
        await responder.respond({ stopReason: "end_turn" });
      });

    const promptResponse = await Client.builder()
      .name("handler-await-client")
      .onRequestPermission(async (request, responder) => {
        events.push(`request:${request.toolCall.toolCallId}`);
        await responder.respond({
          outcome: { outcome: "selected", optionId: "allow" },
        });
      })
      .connectWith(agent, async (cx) => {
        const session = await cx.newSession({
          cwd: "/handler-await",
          mcpServers: [],
        });
        return cx.prompt({
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

    const agent = Agent.builder()
      .name("handler-await-error-agent")
      .onNewSession((_request, responder) =>
        responder.respond({ sessionId: "handler-await-error-session" }),
      )
      .onPrompt(async (request, responder, cx) => {
        await cx.requestPermission({
          sessionId: request.sessionId,
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
        await responder.respond({ stopReason: "end_turn" });
      });

    await expect(
      Client.builder()
        .name("handler-await-error-client")
        .onRequestPermission((_request, responder) =>
          responder.respondWithError({
            code: -32000,
            message: "permission failed",
          }),
        )
        .connectWith(agent, async (cx) => {
          const session = await cx.newSession({
            cwd: "/handler-await-error",
            mcpServers: [],
          });
          return cx.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          });
        }),
    ).rejects.toThrow("permission failed");
    expect(successCalled).toBe(false);
  });

  it("supports session builders with active session reads", async () => {
    const events: string[] = [];

    Agent.builder()
      .name("session-agent")
      .onNewSession(async (request, responder) => {
        events.push(
          `new:${request.cwd}:${request.additionalDirectories?.join(",")}`,
        );
        await responder.respond({ sessionId: "active-session" });
      })
      .onPrompt(async (request, responder, cx) => {
        events.push(`prompt:${request.sessionId}:${request.prompt.length}`);
        await cx.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello ",
            },
          },
        });
        await cx.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "world",
            },
          },
        });
        await responder.respond({ stopReason: "end_turn" });
      })
      .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await Client.builder()
      .name("session-client")
      .connectWith(
        ndJsonStream(clientToAgent.writable, agentToClient.readable),
        async (cx) =>
          cx
            .buildSession("/session-builder")
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
      "new:/session-builder:/extra",
      "prompt:active-session:1",
    ]);
  });

  it("collects active session updates before the prompt response", async () => {
    const agent = Agent.builder()
      .name("active-session-order-agent")
      .onNewSession(async (_request, responder) => {
        await responder.respond({ sessionId: "active-session-order" });
      })
      .onPrompt(async (request, responder, cx) => {
        await cx.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "ordered ",
            },
          },
        });
        await cx.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "updates",
            },
          },
        });
        await responder.respond({ stopReason: "end_turn" });
      });

    const result = await Client.builder()
      .name("active-session-order-client")
      .connectWith(agent, async (cx) =>
        cx.buildSession("/active-session-order").runUntil(async (session) => {
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
    const update = await Client.builder()
      .name("early-update-client")
      .connectWith(
        ndJsonStream(clientToAgent.writable, agentToClient.readable),
        async (cx) => {
          const sessionResponse = cx.newSession({
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

          const session = cx.attachSession(response);
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

  it("rejects pending active session reads when disposed", async () => {
    const agent = Agent.builder()
      .name("dispose-session-agent")
      .onNewSession(async (_request, responder) => {
        await responder.respond({ sessionId: "dispose-session" });
      });

    await Client.builder()
      .name("dispose-session-client")
      .connectWith(agent, async (cx) => {
        const session = await cx
          .buildSession("/dispose-session")
          .startSession();
        const pendingUpdate = session.readUpdate();
        session.dispose();
        await expect(pendingUpdate).rejects.toThrow("Active session disposed");
      });
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
