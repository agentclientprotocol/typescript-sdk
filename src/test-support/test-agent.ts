import { PROTOCOL_VERSION, agent as createAgentApp, methods } from "../acp.js";

import type {
  Agent,
  AgentApp,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "../acp.js";

export interface TestAgentOptions {
  readonly chunkCount?: number;
  readonly chunkDelayMs?: number;
  readonly enablePermission?: boolean;
}

export interface TestAgentAppOptions extends TestAgentOptions {
  readonly initialize?: (
    params: InitializeRequest,
  ) => Promise<InitializeResponse> | InitializeResponse;
  readonly onInitialize?: () => void;
  readonly newSession?: (
    params: NewSessionRequest,
  ) => Promise<NewSessionResponse> | NewSessionResponse;
}

export class TestAgent implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly chunkCount: number;
  private readonly chunkDelayMs: number;
  private readonly enablePermission: boolean;

  constructor(connection: AgentSideConnection, options: TestAgentOptions = {}) {
    this.connection = connection;
    this.chunkCount = options.chunkCount ?? 1;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.enablePermission = options.enablePermission ?? false;
  }

  initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    });
  }

  newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return Promise.resolve({ sessionId: globalThis.crypto.randomUUID() });
  }

  authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    return Promise.resolve();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    for (const index of Array.from(
      { length: this.chunkCount },
      (_, item) => item,
    )) {
      if (this.chunkDelayMs > 0) {
        await delay(this.chunkDelayMs);
      }

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `chunk-${index + 1}`,
          },
        },
      });
    }

    if (this.enablePermission) {
      const permission = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "permission-tool",
          title: "Permission tool",
        },
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow",
          },
          {
            kind: "reject_once",
            name: "Reject once",
            optionId: "reject",
          },
        ],
      });

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              permission.outcome.outcome === "selected"
                ? `permission-selected-${permission.outcome.optionId}`
                : "permission-cancelled",
          },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  cancel(_params: CancelNotification): Promise<void> {
    return Promise.resolve();
  }
}

export function createTestAgentApp(
  options: TestAgentAppOptions = {},
): AgentApp {
  return createAgentApp({ name: "test-agent" })
    .onRequest(methods.agent.initialize, async (c) => {
      options.onInitialize?.();

      if (options.initialize) {
        return await options.initialize(c.params);
      }

      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
        },
      };
    })
    .onRequest(methods.agent.session.new, async (c) => {
      if (options.newSession) {
        return await options.newSession(c.params);
      }

      return { sessionId: globalThis.crypto.randomUUID() };
    })
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.prompt, async (c) => {
      const chunkCount = options.chunkCount ?? 1;
      const chunkDelayMs = options.chunkDelayMs ?? 0;

      for (const index of Array.from(
        { length: chunkCount },
        (_, item) => item,
      )) {
        if (chunkDelayMs > 0) {
          await delay(chunkDelayMs);
        }

        await c.client.notify(methods.client.session.update, {
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `chunk-${index + 1}`,
            },
          },
        });
      }

      if (options.enablePermission) {
        const permission = await c.client.request(
          methods.client.session.requestPermission,
          {
            sessionId: c.params.sessionId,
            toolCall: {
              toolCallId: "permission-tool",
              title: "Permission tool",
            },
            options: [
              {
                kind: "allow_once",
                name: "Allow once",
                optionId: "allow",
              },
              {
                kind: "reject_once",
                name: "Reject once",
                optionId: "reject",
              },
            ],
          },
        );

        await c.client.notify(methods.client.session.update, {
          sessionId: c.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                permission.outcome.outcome === "selected"
                  ? `permission-selected-${permission.outcome.optionId}`
                  : "permission-cancelled",
            },
          },
        });
      }

      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
