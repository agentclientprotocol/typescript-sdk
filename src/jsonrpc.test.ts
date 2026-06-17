import { describe, expect, it } from "vitest";

import { isJsonRpcMessage } from "./jsonrpc.js";

describe("JSON-RPC envelope validation", () => {
  it.each([
    { jsonrpc: "2.0", method: "initialized" },
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: "request-1", result: null },
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message: "Internal error",
        data: { retry: false },
      },
    },
  ])("accepts valid JSON-RPC messages: %o", (message) => {
    expect(isJsonRpcMessage(message)).toBe(true);
  });

  it.each([
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: {}, result: true },
    { jsonrpc: "2.0", id: Number.NaN, result: true },
    { jsonrpc: "2.0", id: Number.POSITIVE_INFINITY, result: true },
    {
      jsonrpc: "2.0",
      id: 1,
      result: true,
      error: { code: -32603, message: "Internal error" },
    },
    { jsonrpc: "2.0", id: 1, error: { code: "-32603", message: "Error" } },
    { jsonrpc: "2.0", id: 1, error: { code: -32603 } },
    { jsonrpc: "2.0", method: "initialize", id: {} },
  ])("rejects malformed JSON-RPC messages: %o", (message) => {
    expect(isJsonRpcMessage(message)).toBe(false);
  });
});
