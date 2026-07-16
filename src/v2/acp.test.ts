import { describe, expect, it } from "vitest";

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
import type { AgentContext, InitializeResponse, SessionUpdate } from "./acp.js";

const clientInfo = { name: "test-client", version: "1.0.0" };
const agentInfo = { name: "test-agent", version: "1.0.0" };

describe("experimental v2 app API", () => {
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
        const second = session.prompt("Second");
        await bothPromptsReceived.promise;

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

  it("requires and preserves underscore-prefixed extension methods", async () => {
    const parseValue = (params: unknown): { value: string } =>
      params as { value: string };
    const returnValue = ({ params }: { params: { value: string } }) => params;

    expect(() =>
      agent().onRequest("vendor/echo", parseValue, returnValue),
    ).toThrow("must start with '_'");
    expect(() =>
      agent().onNotification("vendor/event", parseValue, () => {}),
    ).toThrow("must start with '_'");
    expect(() =>
      client().onRequest("vendor/echo", parseValue, returnValue),
    ).toThrow("must start with '_'");
    expect(() =>
      client().onNotification("vendor/event", parseValue, () => {}),
    ).toThrow("must start with '_'");

    let notificationValue: string | undefined;
    const clientApp = client().onNotification(
      "_vendor/acme/event",
      parseValue,
      ({ params }) => {
        notificationValue = params.value;
      },
    );
    const agentApp = agent()
      .onRequest("_vendor/acme/echo", parseValue, returnValue)
      .onRequest(
        methods.agent.initialize,
        async ({ client: clientContext }) => {
          expect(() =>
            clientContext.request("vendor/client-request", {}),
          ).toThrow("must start with '_'");
          expect(() =>
            clientContext.notify("vendor/client-notification", {}),
          ).toThrow("must start with '_'");
          await clientContext.notify("_vendor/acme/event", {
            value: "notification",
          });
          return { protocolVersion: PROTOCOL_VERSION, info: agentInfo };
        },
      );

    await clientApp.connectWith(agentApp, async (agentContext) => {
      expect(() => agentContext.request("vendor/request", {})).toThrow(
        "must start with '_'",
      );
      expect(() => agentContext.notify("vendor/notification", {})).toThrow(
        "must start with '_'",
      );
      expect(() =>
        agentContext.batch([
          batchNotification("vendor/batch-notification", {}),
        ] as const),
      ).toThrow("must start with '_'");

      await agentContext.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: clientInfo,
      });
      await expect(
        agentContext.request<{ value: string }, { value: string }>(
          "_vendor/acme/echo",
          { value: "response" },
        ),
      ).resolves.toEqual({ value: "response" });
    });
    expect(notificationValue).toBe("notification");
  });
});
