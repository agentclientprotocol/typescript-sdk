import {
  PROTOCOL_VERSION,
  agent as createAgentApp,
  methods,
} from "../stable/acp.js";

import type {
  AgentApp,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
} from "../stable/acp.js";

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
