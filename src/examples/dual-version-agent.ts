#!/usr/bin/env node

import { Readable, Writable } from "node:stream";

import * as v1 from "../acp.js";
import * as v2 from "../v2/acp.js";

const v1Sessions = new Set<string>();
const v1Agent = v1
  .agent({ name: "dual-version-example-v1" })
  .onRequest(v1.methods.agent.initialize, () => ({
    protocolVersion: v1.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(v1.methods.agent.session.new, () => {
    const sessionId = crypto.randomUUID();
    v1Sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(v1.methods.agent.session.prompt, async ({ params, client }) => {
    requireSession(v1Sessions, params.sessionId);
    await client.notify(v1.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from the v1 implementation." },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(v1.methods.agent.session.cancel, () => {});

const v2Sessions = new Set<string>();
const v2Agent = v2
  .agent({ name: "dual-version-example-v2" })
  .onRequest(v2.methods.agent.initialize, () => ({
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: "dual-version-example", version: "1.0.0" },
    capabilities: { session: {} },
  }))
  .onRequest(v2.methods.agent.session.new, () => {
    const sessionId = crypto.randomUUID();
    v2Sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(v2.methods.agent.session.prompt, ({ params, client }) => {
    requireSession(v2Sessions, params.sessionId);
    void runV2Turn(params, client).catch((error) => {
      console.error("v2 example turn failed", error);
    });
  })
  .onNotification(v2.methods.agent.session.cancel, () => {});

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = v1.ndJsonStream(output, input);

v2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream);

function requireSession(sessions: Set<string>, sessionId: string): void {
  if (!sessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} not found`);
  }
}

async function runV2Turn(
  params: v2.PromptRequest,
  client: v2.AgentContext,
): Promise<void> {
  const userMessageId = crypto.randomUUID();
  const agentMessageId = crypto.randomUUID();

  await client.notify(v2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "user_message",
      messageId: userMessageId,
      content: params.prompt,
    },
  });
  await client.notify(v2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: "state_update", state: "running" },
  });
  await client.notify(v2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "agent_message",
      messageId: agentMessageId,
      content: [{ type: "text", text: "Hello from the v2 implementation." }],
    },
  });
  await client.notify(v2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    },
  });
}
