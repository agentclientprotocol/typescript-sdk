#!/usr/bin/env node

/**
 * Experimental example for the draft ACP v2 API.
 *
 * Package consumers must opt in through
 * `@agentclientprotocol/sdk/experimental/v2`. The protocol and API may change
 * incompatibly while ACP v2 remains a draft.
 */

import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import * as v1 from "../v1/stable/acp.js";
import * as v2 from "../v2/stable/acp.js";

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

/** A prompt received while a turn is running, not yet inserted. */
type HeldPrompt = {
  params: v2.PromptRequest;
  client: v2.AgentContext;
  insert(response: v2.PromptResponse): void;
  reject(error: unknown): void;
};

type V2Session = {
  cwd: string;
  active: boolean;
  history: v2.SessionUpdate[];
  state: v2.StateUpdate;
  turn?: V2Turn;
  held: HeldPrompt[];
};

// No `session.mcp` transports are advertised, so `assertSupportedMcpServers`
// rejects every MCP server a client requests.
const V2_CAPABILITIES: v2.AgentCapabilities = { session: {} };

const v2Sessions = new Map<string, V2Session>();
const v2Agent = v2
  .agent({ name: "dual-version-example-v2" })
  .onRequest(v2.methods.agent.initialize, () => ({
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: "dual-version-example", version: "1.0.0" },
    capabilities: V2_CAPABILITIES,
  }))
  .onRequest(v2.methods.agent.auth.logout, () => {})
  .onRequest(v2.methods.agent.session.new, ({ params }) => {
    requireAbsoluteCwd(params.cwd);
    v2.assertSupportedMcpServers(
      params.mcpServers,
      V2_CAPABILITIES.session?.mcp,
    );
    const sessionId = crypto.randomUUID();
    v2Sessions.set(sessionId, {
      cwd: params.cwd,
      active: true,
      history: [],
      state: { state: "idle" },
      held: [],
    });
    return { sessionId };
  })
  .onRequest(v2.methods.agent.session.list, ({ params }) => {
    if (params.cwd != null) {
      requireAbsoluteCwd(params.cwd);
    }
    // The filter matches exactly that directory, not its subdirectories.
    return {
      sessions: [...v2Sessions]
        .filter(
          ([, session]) => params.cwd == null || session.cwd === params.cwd,
        )
        .map(([sessionId, session]) => ({
          sessionId,
          cwd: session.cwd,
        })),
    };
  })
  .onRequest(v2.methods.agent.session.resume, async ({ params, client }) => {
    requireAbsoluteCwd(params.cwd);
    const session = requireV2Session(params.sessionId);
    // `mcpServers` is the complete set for the resumed session; this agent
    // advertises no MCP transports, so any server is rejected.
    v2.assertSupportedMcpServers(
      params.mcpServers,
      V2_CAPABILITIES.session?.mcp,
    );
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
    // Synchronize current state after replay, even when no replay was requested.
    // History contains messages only; historical states are not live activity.
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "session_info_update" },
    });
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", ...session.state },
    });
    return {};
  })
  .onRequest(v2.methods.agent.session.close, async ({ params }) => {
    // Closing is idempotent: closing an unknown or already closed session
    // succeeds.
    const session = v2Sessions.get(params.sessionId);
    if (!session?.active) return;
    await cancelV2Turn(session);
    session.active = false;
  })
  .onRequest(v2.methods.agent.session.prompt, ({ params, client, signal }) => {
    const session = requireActiveV2Session(params.sessionId);
    rejectUnadvertisedContent(params.prompt);
    if (!session.turn) {
      return insertV2Prompt(session, params, client);
    }

    // A prompt that arrives during a turn is held, not rejected, and
    // inserted in the order received once the turn ends. Its response
    // stays pending until then.
    return new Promise<v2.PromptResponse>((resolve, reject) => {
      const held: HeldPrompt = {
        params,
        client,
        insert: resolve,
        reject,
      };
      session.held.push(held);
      // `$/cancel_request` withdraws a prompt that was not inserted yet.
      signal.addEventListener(
        "abort",
        () => {
          const index = session.held.indexOf(held);
          if (index !== -1) {
            session.held.splice(index, 1);
            reject(v2.RequestError.requestCancelled());
          }
        },
        { once: true },
      );
    });
  })
  .onNotification(v2.methods.agent.session.cancel, async ({ params }) => {
    // `session/cancel` for a session that is not active is ignored.
    const session = v2Sessions.get(params.sessionId);
    if (session?.active) {
      await cancelV2Turn(session);
    }
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = v1.ndJsonStream(output, input);

v2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream);

function requireSession(sessions: Set<string>, sessionId: string): void {
  if (!sessions.has(sessionId)) {
    throw v1.RequestError.sessionNotFound(sessionId);
  }
}

/**
 * This agent advertises no prompt capabilities (`capabilities.session.prompt`
 * is absent), so it accepts only the baseline `text` and `resource_link`
 * blocks. An image, audio or embedded resource block gets `-32602`.
 */
function rejectUnadvertisedContent(prompt: v2.ContentBlock[]): void {
  const block = prompt.find(
    (block) =>
      !v2.ContentBlock.isText(block) && !v2.ContentBlock.isResourceLink(block),
  );
  if (block) {
    throw v2.RequestError.invalidParams(
      { type: block.type },
      `Unsupported prompt content ${block.type}`,
    );
  }
}

/** `cwd` must be an absolute path in the native syntax of this machine. */
function requireAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw v2.RequestError.invalidParams(
      { cwd },
      `cwd must be an absolute path: ${cwd}`,
    );
  }
}

/**
 * Inserts a prompt's user message and starts its turn. When the turn ends,
 * the next held prompt is inserted.
 */
function insertV2Prompt(
  session: V2Session,
  params: v2.PromptRequest,
  client: v2.AgentContext,
): v2.PromptResponse {
  const controller = new AbortController();
  const turn: V2Turn = {
    controller,
    done: Promise.resolve(),
  };
  const userMessageId = crypto.randomUUID();
  const userMessage: v2.SessionUpdate = {
    sessionUpdate: "user_message",
    messageId: userMessageId,
    content: params.prompt,
  };
  session.history.push(userMessage);

  // The framework sends the prompt response after it is returned. The user
  // message is already inserted; start notifications and processing in the
  // next event-loop task so the insertion receipt is sent first.
  const responseQueued = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  turn.done = responseQueued
    .then(() =>
      runV2Turn(params, client, session, controller.signal, userMessage),
    )
    .catch((error) => {
      // Completion could not be delivered, for example after a transport failure.
      console.error("v2 example could not report turn completion", error);
    })
    .finally(() => {
      if (session.turn === turn) {
        session.turn = undefined;
        const next = session.held.shift();
        if (next && session.active) {
          next.insert(insertV2Prompt(session, next.params, next.client));
        }
      }
    });
  session.turn = turn;
  return { messageId: userMessageId };
}

function requireV2Session(sessionId: string): V2Session {
  const session = v2Sessions.get(sessionId);
  if (!session) {
    throw v2.RequestError.sessionNotFound(sessionId);
  }
  return session;
}

function requireActiveV2Session(sessionId: string): V2Session {
  const session = requireV2Session(sessionId);
  if (!session.active) {
    throw v2.RequestError.sessionNotFound(sessionId);
  }
  return session;
}

/**
 * Cancels the running turn. Prompts held before the cancellation are never
 * inserted, so they get `-32800`.
 */
async function cancelV2Turn(session: V2Session): Promise<void> {
  for (const held of session.held.splice(0)) {
    held.reject(v2.RequestError.requestCancelled());
  }
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
  userMessage: v2.SessionUpdate,
): Promise<void> {
  try {
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: userMessage,
    });

    signal.throwIfAborted();
    session.state = { state: "running" };
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", ...session.state },
    });
    await waitForWork(signal);

    signal.throwIfAborted();
    const agentMessage: v2.SessionUpdate = {
      sessionUpdate: "agent_message",
      messageId: crypto.randomUUID(),
      content: [{ type: "text", text: "Hello from the v2 implementation." }],
    };
    session.history.push(agentMessage);
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: agentMessage,
    });

    signal.throwIfAborted();
    session.state = { state: "idle", stopReason: "end_turn" };
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", ...session.state },
    });
  } catch (error) {
    // Insertion already succeeded. Report failures on idle, not on the prompt RPC.
    const completion: v2.IdleStateUpdate = signal.aborted
      ? { stopReason: "cancelled" }
      : {
          stopReason: "error",
          error: (error instanceof v2.RequestError
            ? error
            : v2.RequestError.internalError(
                undefined,
                error instanceof Error ? error.message : undefined,
              )
          ).toErrorResponse(),
        };

    session.state = { state: "idle", ...completion };
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", ...session.state },
    });
  }
}
