import { describe, expect, it, vi } from "vitest";

import { Connection, RequestError, isJsonRpcMessage } from "./jsonrpc.js";
import type { AnyMessage, RequestResponder } from "./jsonrpc.js";
import type { Stream } from "./stream.js";

type ConnectionInternals = {
  pendingResponses: Map<string | number | null, unknown>;
  ignoredResponseIds: Array<string | number | null>;
};

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

describe("JSON-RPC request cancellation", () => {
  it("sends $/cancel_request when an outgoing request signal aborts", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const slowResponder = Promise.withResolvers<RequestResponder>();
    const cancelReceived = Promise.withResolvers<{
      requestId: string | number | null;
    }>();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const server = Connection.builder()
      .onReceiveRequest(
        "example/slow",
        (params) => params,
        (_request, responder) => {
          slowResponder.resolve(responder);
          return new Promise(() => {});
        },
      )
      .onReceiveRequest(
        "example/barrier",
        (params) => params,
        (_, responder) => responder.respond({ ok: true }),
      )
      .onReceiveNotification(
        "$/cancel_request",
        (params) => params as { requestId: string | number | null },
        (params) => {
          cancelReceived.resolve(params);
        },
      )
      .connect(serverStream);
    const client = Connection.builder().connect(clientStream);

    try {
      const abortController = new AbortController();
      const response = client.sendRequest("example/slow", {}, undefined, {
        signal: abortController.signal,
      });
      const responder = await slowResponder.promise;
      const clientInternals = client as unknown as ConnectionInternals;

      abortController.abort("user cancelled");

      await expect(response).rejects.toMatchObject({
        code: -32800,
        message: "Request cancelled",
      });
      expect(clientInternals.pendingResponses.has(responder.id)).toBe(false);
      expect(clientInternals.ignoredResponseIds).toContain(responder.id);
      await expect(cancelReceived.promise).resolves.toEqual({
        requestId: responder.id,
      });

      await responder.respond({ ok: true });
      expect(clientInternals.ignoredResponseIds).not.toContain(responder.id);
      await expect(client.sendRequest("example/barrier", {})).resolves.toEqual({
        ok: true,
      });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      client.close();
      server.close();
      await Promise.all([client.closed, server.closed]);
    }
  });

  it("aborts the incoming request signal when $/cancel_request is received", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const requestReceived = Promise.withResolvers<{
      id: string | number | null;
      signal: AbortSignal;
    }>();

    const server = Connection.builder()
      .onReceiveRequest(
        "example/slow",
        (params) => params,
        async (_request, responder) => {
          requestReceived.resolve({
            id: responder.id,
            signal: responder.signal,
          });
          await new Promise<void>((resolve) => {
            responder.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          await responder.respondWithError(RequestError.requestCancelled());
        },
      )
      .connect(serverStream);
    const client = Connection.builder().connect(clientStream);

    try {
      const response = client.sendRequest("example/slow", {});
      const { id, signal } = await requestReceived.promise;

      expect(signal.aborted).toBe(false);
      await client.sendCancelRequest(id);

      await expect(response).rejects.toMatchObject({
        code: -32800,
        message: "Request cancelled",
      });
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(RequestError);
      expect((signal.reason as RequestError).code).toBe(-32800);
    } finally {
      client.close();
      server.close();
      await Promise.all([client.closed, server.closed]);
    }
  });

  it("rejects requests started from request abort listeners during close", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const requestStarted = Promise.withResolvers<void>();
    const closeTimeRequestStarted = Promise.withResolvers<void>();
    const closeError = new Error("closing");
    let closeTimeRequest: Promise<unknown> | undefined;

    const server = Connection.builder()
      .onReceiveRequest(
        "example/slow",
        (params) => params,
        (_request, responder, cx) => {
          responder.signal.addEventListener(
            "abort",
            () => {
              closeTimeRequest = cx.sendRequest("example/after-close", {});
              closeTimeRequest.catch(() => {});
              closeTimeRequestStarted.resolve();
            },
            { once: true },
          );
          requestStarted.resolve();
          return new Promise(() => {});
        },
      )
      .connect(serverStream);
    const client = Connection.builder().connect(clientStream);

    try {
      const response = client.sendRequest("example/slow", {});
      response.catch(() => {});
      await requestStarted.promise;

      server.close(closeError);
      await closeTimeRequestStarted.promise;

      expect(
        (server as unknown as ConnectionInternals).pendingResponses.size,
      ).toBe(0);
      expect(closeTimeRequest).toBeDefined();
      await expect(closeTimeRequest!).rejects.toBe(closeError);
    } finally {
      client.close();
      server.close();
      await Promise.all([client.closed, server.closed]);
    }
  });
});

function memoryStreamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<AnyMessage>();
  const rightToLeft = new TransformStream<AnyMessage>();
  return [
    {
      readable: rightToLeft.readable,
      writable: leftToRight.writable,
    },
    {
      readable: leftToRight.readable,
      writable: rightToLeft.writable,
    },
  ];
}
