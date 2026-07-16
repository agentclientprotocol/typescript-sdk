#!/usr/bin/env node

/**
 * Experimental example for the draft ACP v2 API.
 *
 * Package consumers must opt in through
 * `@agentclientprotocol/sdk/experimental/v2`. The protocol and API may change
 * incompatibly while ACP v2 remains a draft.
 */

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

type V2Turn = {
  controller: AbortController;
  done: Promise<void>;
};

type V2Session = {
  cwd: string;
  active: boolean;
  history: v2.SessionUpdate[];
  turn?: V2Turn;
};

const v2Sessions = new Map<string, V2Session>();
const v2Agent = v2
  .agent({ name: "dual-version-example-v2" })
  .onRequest(v2.methods.agent.initialize, () => ({
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: "dual-version-example", version: "1.0.0" },
    capabilities: { session: {} },
  }))
  .onRequest(v2.methods.agent.session.new, ({ params }) => {
    const sessionId = crypto.randomUUID();
    v2Sessions.set(sessionId, {
      cwd: params.cwd,
      active: true,
      history: [],
    });
    return { sessionId };
  })
  .onRequest(v2.methods.agent.session.list, ({ params }) => ({
    sessions: [...v2Sessions]
      .filter(([, session]) => params.cwd == null || session.cwd === params.cwd)
      .map(([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
      })),
  }))
  .onRequest(v2.methods.agent.session.resume, async ({ params, client }) => {
    const session = requireV2Session(params.sessionId);
    if (session.cwd !== params.cwd) {
      throw v2.RequestError.invalidParams(
        `Session ${params.sessionId} belongs to ${session.cwd}`,
      );
    }

    if (params.replayFrom?.type === "start") {
      for (const update of session.history) {
        await client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
      }
    } else if (params.replayFrom) {
      throw v2.RequestError.invalidParams(
        `Unsupported replay cursor ${params.replayFrom.type}`,
      );
    }

    session.active = true;
    return {};
  })
  .onRequest(v2.methods.agent.session.close, async ({ params }) => {
    const session = requireActiveV2Session(params.sessionId);
    await cancelV2Turn(session);
    session.active = false;
  })
  .onRequest(v2.methods.agent.session.prompt, ({ params, client }) => {
    const session = requireActiveV2Session(params.sessionId);
    if (session.turn) {
      throw v2.RequestError.invalidRequest(
        `Session ${params.sessionId} is already processing a prompt`,
      );
    }

    const controller = new AbortController();
    const turn: V2Turn = {
      controller,
      done: Promise.resolve(),
    };
    turn.done = runV2Turn(params, client, session, controller.signal)
      .catch((error) => {
        console.error("v2 example turn failed", error);
      })
      .finally(() => {
        if (session.turn === turn) {
          session.turn = undefined;
        }
      });
    session.turn = turn;
  })
  .onNotification(v2.methods.agent.session.cancel, async ({ params }) => {
    await cancelV2Turn(requireActiveV2Session(params.sessionId));
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = v1.ndJsonStream(output, input);

v2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream);

function requireSession(sessions: Set<string>, sessionId: string): void {
  if (!sessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} not found`);
  }
}

function requireV2Session(sessionId: string): V2Session {
  const session = v2Sessions.get(sessionId);
  if (!session) {
    throw v2.RequestError.invalidParams(`Session ${sessionId} not found`);
  }
  return session;
}

function requireActiveV2Session(sessionId: string): V2Session {
  const session = requireV2Session(sessionId);
  if (!session.active) {
    throw v2.RequestError.invalidParams(`Session ${sessionId} is not active`);
  }
  return session;
}

async function cancelV2Turn(session: V2Session): Promise<void> {
  const turn = session.turn;
  if (!turn) {
    return;
  }

  turn.controller.abort();
  await turn.done;
}

function waitForWork(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runV2Turn(
  params: v2.PromptRequest,
  client: v2.AgentContext,
  session: V2Session,
  signal: AbortSignal,
): Promise<void> {
  const userMessageId = crypto.randomUUID();
  const agentMessageId = crypto.randomUUID();

  const userMessage: v2.SessionUpdate = {
    sessionUpdate: "user_message",
    messageId: userMessageId,
    content: params.prompt,
  };
  const agentMessage: v2.SessionUpdate = {
    sessionUpdate: "agent_message",
    messageId: agentMessageId,
    content: [{ type: "text", text: "Hello from the v2 implementation." }],
  };

  try {
    signal.throwIfAborted();
    session.history.push(userMessage);
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: userMessage,
    });

    signal.throwIfAborted();
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", state: "running" },
    });
    await waitForWork(signal);

    signal.throwIfAborted();
    session.history.push(agentMessage);
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: agentMessage,
    });

    signal.throwIfAborted();
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      },
    });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }

    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      },
    });
  }
}
