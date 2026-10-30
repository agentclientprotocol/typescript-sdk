#!/usr/bin/env node

import * as acp from "../v1/stable/acp.js";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

interface AgentSession {
  pendingPrompt: AbortController | null;
}

class ExampleAgent {
  private sessions: Map<string, AgentSession>;

  constructor() {
    this.sessions = new Map();
  }

  async initialize(
    _params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(
        { cwd: params.cwd },
        `cwd must be an absolute path: ${params.cwd}`,
      );
    }

    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.sessions.set(sessionId, {
      pendingPrompt: null,
    });

    return {
      sessionId,
    };
  }

  async authenticate(
    _params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse | void> {
    // No auth needed - return empty response
    return {};
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    if (!this.sessions.has(params.sessionId)) {
      throw acp.RequestError.sessionNotFound(params.sessionId);
    }

    // This example advertises no session modes, so every mode ID is unknown.
    throw acp.RequestError.invalidParams(
      { modeId: params.modeId },
      `Unknown session mode ${params.modeId}`,
    );
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      throw acp.RequestError.sessionNotFound(params.sessionId);
    }

    session.pendingPrompt?.abort();
    const pendingPrompt = new AbortController();
    session.pendingPrompt = pendingPrompt;

    // Tool calls reported during this turn that haven't reached a final status.
    const openToolCalls = new Set<string>();

    try {
      await this.simulateTurn(
        params.sessionId,
        pendingPrompt.signal,
        cx,
        openToolCalls,
      );
    } catch (err) {
      if (!pendingPrompt.signal.aborted) {
        throw err;
      }
    } finally {
      // If the turn ended early, give every unfinished tool call a final
      // status before responding. v1 has no `cancelled` tool call status,
      // so these end as `failed`.
      for (const toolCallId of openToolCalls) {
        await cx.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
          },
        });
      }
    }

    if (pendingPrompt.signal.aborted) {
      return { stopReason: "cancelled" };
    }

    session.pendingPrompt = null;

    return {
      stopReason: "end_turn",
    };
  }

  private async simulateTurn(
    sessionId: string,
    abortSignal: AbortSignal,
    cx: acp.AgentContext,
    openToolCalls: Set<string>,
  ): Promise<void> {
    // Send initial text chunk
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I'll help you with that. Let me start by reading some files to understand the current situation.",
        },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    // Send a tool call that doesn't need permission
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading project files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/project/README.md" }],
        rawInput: { path: "/project/README.md" },
      },
    });
    openToolCalls.add("call_1");

    await this.simulateModelInteraction(abortSignal);

    // Update tool call to completed
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "# My Project\n\nThis is a sample project...",
            },
          },
        ],
        rawOutput: { content: "# My Project\n\nThis is a sample project..." },
      },
    });
    openToolCalls.delete("call_1");

    await this.simulateModelInteraction(abortSignal);

    // Send more text
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: " Now I understand the project structure. I need to make some changes to improve it.",
        },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    // Send a tool call that DOES need permission
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
        rawInput: {
          path: "/project/config.json",
          content: '{"database": {"host": "new-host"}}',
        },
      },
    });
    openToolCalls.add("call_2");

    // Request permission for the sensitive operation
    const permissionResponse = await cx.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: "call_2",
          title: "Modifying critical configuration file",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/home/user/project/config.json" }],
          rawInput: {
            path: "/home/user/project/config.json",
            content: '{"database": {"host": "new-host"}}',
          },
        },
        options: [
          {
            kind: "allow_once",
            name: "Allow this change",
            optionId: "allow",
          },
          {
            kind: "reject_once",
            name: "Skip this change",
            optionId: "reject",
          },
        ],
      },
    );

    // A cancelled or rejected permission leaves the tool call unapproved,
    // so it ends as failed instead of staying pending.
    const failToolCall = async () => {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_2",
          status: "failed",
        },
      });
      openToolCalls.delete("call_2");
    };

    if (permissionResponse.outcome.outcome === "cancelled") {
      await failToolCall();
      return;
    }

    switch (permissionResponse.outcome.optionId) {
      case "allow": {
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_2",
            status: "completed",
            rawOutput: { success: true, message: "Configuration updated" },
          },
        });
        openToolCalls.delete("call_2");

        await this.simulateModelInteraction(abortSignal);

        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: " Perfect! I've successfully updated the configuration. The changes have been applied.",
            },
          },
        });
        break;
      }
      // "reject", or an optionId that was not offered: not approved.
      default: {
        await failToolCall();
        await this.simulateModelInteraction(abortSignal);

        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: " I understand you prefer not to make that change. I'll skip the configuration update.",
            },
          },
        });
        break;
      }
    }
  }

  private simulateModelInteraction(abortSignal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        // In a real agent, you'd pass this abort signal to the LLM client
        if (abortSignal.aborted) {
          reject();
        } else {
          resolve();
        }
      }, 1000),
    );
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const stream = acp.ndJsonStream(input, output);
const agent = new ExampleAgent();

acp
  .agent({ name: "example-agent" })
  .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
  .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
  .onRequest("authenticate", (ctx) => agent.authenticate(ctx.params))
  .onRequest("session/set_mode", (ctx) => agent.setSessionMode(ctx.params))
  .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx.client))
  .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params))
  .connect(stream);
