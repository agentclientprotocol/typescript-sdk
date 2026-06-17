import { describe, expect, it } from "vitest";

import { AGENT_METHODS } from "./schema/index.js";
import {
  methodRequiresSessionHeader,
  sessionIdFromParams,
  isInitializeRequest,
  messageIdKey,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  EVENT_STREAM_MIME_TYPE,
  JSON_MIME_TYPE,
} from "./protocol.js";

import type { AnyMessage } from "./jsonrpc.js";

describe("protocol transport helpers", () => {
  it("exports HTTP transport constants", () => {
    expect(HEADER_CONNECTION_ID).toBe("Acp-Connection-Id");
    expect(HEADER_SESSION_ID).toBe("Acp-Session-Id");
    expect(EVENT_STREAM_MIME_TYPE).toBe("text/event-stream");
    expect(JSON_MIME_TYPE).toBe("application/json");
  });

  it("requires a session header for existing-session methods", () => {
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_cancel)).toBe(
      true,
    );
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_close)).toBe(true);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_load)).toBe(true);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_prompt)).toBe(
      true,
    );
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_resume)).toBe(
      true,
    );
    expect(
      methodRequiresSessionHeader(AGENT_METHODS.session_set_config_option),
    ).toBe(true);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_set_mode)).toBe(
      true,
    );
  });

  it("does not require a session header for connection-level or unsupported methods", () => {
    expect(methodRequiresSessionHeader(AGENT_METHODS.initialize)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_new)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_list)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.session_fork)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.nes_start)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.nes_suggest)).toBe(false);
    expect(methodRequiresSessionHeader(AGENT_METHODS.nes_close)).toBe(false);
  });

  it("extracts a top-level string session ID from params", () => {
    expect(sessionIdFromParams({ sessionId: "session-1" })).toBe("session-1");
  });

  it("returns undefined when params do not contain a top-level string session ID", () => {
    expect(sessionIdFromParams(undefined)).toBeUndefined();
    expect(sessionIdFromParams(null)).toBeUndefined();
    expect(sessionIdFromParams("session-1")).toBeUndefined();
    expect(sessionIdFromParams({})).toBeUndefined();
    expect(sessionIdFromParams({ sessionId: 1 })).toBeUndefined();
    expect(
      sessionIdFromParams({ nested: { sessionId: "session-1" } }),
    ).toBeUndefined();
  });

  it("detects initialize requests", () => {
    const request: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: AGENT_METHODS.initialize,
      params: { protocolVersion: 1, clientCapabilities: {} },
    };

    expect(isInitializeRequest(request)).toBe(true);
  });

  it("rejects non-initialize messages", () => {
    const notification: AnyMessage = {
      jsonrpc: "2.0",
      method: AGENT_METHODS.initialize,
      params: { protocolVersion: 1, clientCapabilities: {} },
    };
    const response: AnyMessage = { jsonrpc: "2.0", id: 1, result: {} };
    const otherRequest: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: AGENT_METHODS.session_new,
      params: { cwd: "/tmp", mcpServers: [] },
    };

    expect(isInitializeRequest(notification)).toBe(false);
    expect(isInitializeRequest(response)).toBe(false);
    expect(isInitializeRequest(otherRequest)).toBe(false);
  });

  it("normalizes JSON-RPC request IDs for map keys", () => {
    expect(messageIdKey("foo")).toBe("string:foo");
    expect(messageIdKey(1)).toBe("number:1");
    expect(messageIdKey(null)).toBe("null");
    expect(messageIdKey(undefined)).toBeUndefined();
  });
});
