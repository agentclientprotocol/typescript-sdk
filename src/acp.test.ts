import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Agent,
  ClientSideConnection,
  Client,
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
  ListSessionsRequest,
  ListSessionsResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
} from "./acp.js";

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

  it("preserves unknown properties on known incoming params", async () => {
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
      expect(receivedInitializeParams).toMatchObject({
        extraTopLevel: "keep me",
        clientCapabilities: {
          customCapability: {
            enabled: true,
          },
          fs: {
            experimentalFs: true,
          },
        },
      });

      expect(receivedSessionUpdate).toMatchObject({
        extraNotificationField: "keep this too",
        update: {
          extraUpdateField: {
            keep: true,
          },
        },
      });
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
      async unstable_resumeSession(
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

    const resumeResponse = await agentConnection.unstable_resumeSession({
      sessionId: "s1",
      cwd: "/test",
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(resumeResponse).toEqual({});
    expect(receivedResumeSession?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);

    const listResponse = await agentConnection.listSessions({
      additionalDirectories: ["/extra/root1", "/extra/root2"],
    });
    expect(listResponse).toEqual({ sessions: [] });
    expect(receivedListSessions?.additionalDirectories).toEqual([
      "/extra/root1",
      "/extra/root2",
    ]);
  });
});
