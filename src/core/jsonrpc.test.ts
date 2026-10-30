import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  Connection,
  Handled,
  RequestError,
  isJsonRpcMessage,
} from "./jsonrpc.js";
import type { AnyMessage, RequestResponder } from "./jsonrpc.js";
import type { Stream } from "./stream.js";

type ConnectionInternals = {
  pendingResponses: Map<string | number | null, unknown>;
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

describe("RequestError helpers", () => {
  it("reports an unknown session as resource not found with its session ID", () => {
    const error = RequestError.sessionNotFound("sess_missing");

    expect(error).toBeInstanceOf(RequestError);
    expect(error.code).toBe(-32002);
    expect(error.data).toEqual({ sessionId: "sess_missing" });
    expect(error.toErrorResponse()).toEqual({
      code: -32002,
      message: "Resource not found",
      data: { sessionId: "sess_missing" },
    });
  });
});

describe("JSON-RPC batches", () => {
  it.each([
    ["a call batch", [{ jsonrpc: "2.0", id: 1, method: "example/test" }]],
    [
      "a mixed batch",
      [
        42,
        { jsonrpc: "2.0", id: 2, method: "example/test" },
        { jsonrpc: "2.0", method: "example/note" },
      ],
    ],
    ["a response batch", [{ jsonrpc: "2.0", id: 0, result: true }]],
    ["an empty batch", []],
  ])(
    "rejects %s with a single Invalid Request and stays open",
    async (_name, batch) => {
      const [connectionStream, peerStream] = memoryStreamPair();
      const handled: string[] = [];
      const connection = Connection.builder()
        .withHandler({
          async handleMessage(message) {
            handled.push(message.kind);
            if (message.kind === "request") {
              await message.responder.respond(true);
            }
            return Handled.yes();
          },
        })
        .connect(connectionStream);
      const writer = peerStream.writable.getWriter();
      const reader = peerStream.readable.getReader();

      try {
        const pending = connection.sendRequest("example/pending", {});
        const { value: outgoing } = await reader.read();
        expect(outgoing).toMatchObject({ id: 0, method: "example/pending" });

        await writer.write(batch as unknown as AnyMessage);
        expect((await reader.read()).value).toEqual({
          jsonrpc: "2.0",
          id: null,
          error: expect.objectContaining({ code: -32600 }),
        });

        // No entry was processed: the response batch did not settle the
        // pending request and no handler ran.
        await writer.write({
          jsonrpc: "2.0",
          id: 7,
          method: "example/test",
        });
        expect((await reader.read()).value).toEqual({
          jsonrpc: "2.0",
          id: 7,
          result: true,
        });
        expect(handled).toEqual(["request"]);
        await writer.write({ jsonrpc: "2.0", id: 0, result: "late" });
        await expect(pending).resolves.toBe("late");
      } finally {
        writer.releaseLock();
        reader.releaseLock();
        connection.close();
        await connection.closed;
      }
    },
  );
});

describe("JSON-RPC request cancellation", () => {
  it("keeps an aborted outgoing request pending for the peer response", async () => {
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
        cancellationSignal: abortController.signal,
      });
      let settled = false;
      response.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const responder = await slowResponder.promise;
      const clientInternals = client as unknown as ConnectionInternals;

      abortController.abort("user cancelled");

      await expect(cancelReceived.promise).resolves.toEqual({
        requestId: responder.id,
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(clientInternals.pendingResponses.has(responder.id)).toBe(true);

      await responder.respond({ ok: true });
      await expect(response).resolves.toEqual({ ok: true });
      expect(clientInternals.pendingResponses.has(responder.id)).toBe(false);
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

  it("sends an already-aborted cancellation signal after the request", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const slowResponder = Promise.withResolvers<RequestResponder>();
    const cancelReceived = Promise.withResolvers<{
      requestId: string | number | null;
    }>();

    const server = Connection.builder()
      .onReceiveRequest(
        "example/slow",
        (params) => params,
        (_request, responder) => {
          slowResponder.resolve(responder);
          return new Promise(() => {});
        },
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
      const response = client.sendRequest("example/slow", {}, undefined, {
        cancellationSignal: AbortSignal.abort("already cancelled"),
      });
      const responder = await slowResponder.promise;

      await expect(cancelReceived.promise).resolves.toEqual({
        requestId: responder.id,
      });

      await responder.respond({ ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    } finally {
      client.close();
      server.close();
      await Promise.all([client.closed, server.closed]);
    }
  });

  it("queues already-aborted cancellation before later writes", async () => {
    const messages: AnyMessage[] = [];
    const firstWriteStarted = Promise.withResolvers<void>();
    const unblockFirstWrite = Promise.withResolvers<void>();
    const thirdWriteCompleted = Promise.withResolvers<void>();

    let writes = 0;
    const client = Connection.builder().connect({
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({
        async write(message) {
          writes += 1;
          messages.push(message);
          if (writes === 1) {
            firstWriteStarted.resolve();
            await unblockFirstWrite.promise;
          }
          if (writes === 3) {
            thirdWriteCompleted.resolve();
          }
        },
      }),
    });

    try {
      const response = client.sendRequest("example/slow", {}, undefined, {
        cancellationSignal: AbortSignal.abort("already cancelled"),
      });
      response.catch(() => {});
      await firstWriteStarted.promise;

      const laterNotification = client.sendNotification("example/later", {});
      unblockFirstWrite.resolve();
      await thirdWriteCompleted.promise;
      await laterNotification;

      expect(messages[0]).toMatchObject({
        method: "example/slow",
      });
      expect(messages[1]).toMatchObject({
        method: "$/cancel_request",
        params: { requestId: "id" in messages[0] ? messages[0].id : undefined },
      });
      expect(messages[2]).toMatchObject({
        method: "example/later",
      });
    } finally {
      client.close();
      await client.closed;
    }
  });

  it("keeps manually cancelled requests pending for the peer response", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const slowResponder = Promise.withResolvers<RequestResponder>();
    const cancelReceived = Promise.withResolvers<{
      requestId: string | number | null;
    }>();

    const server = Connection.builder()
      .onReceiveRequest(
        "example/slow",
        (params) => params,
        (_request, responder) => {
          slowResponder.resolve(responder);
          return new Promise(() => {});
        },
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
      const response = client.sendRequest("example/slow", {});
      const responder = await slowResponder.promise;
      const clientInternals = client as unknown as ConnectionInternals;

      await client.sendCancelRequest(responder.id);

      await expect(cancelReceived.promise).resolves.toEqual({
        requestId: responder.id,
      });
      expect(clientInternals.pendingResponses.has(responder.id)).toBe(true);

      await responder.respond({ ok: true });
      await expect(response).resolves.toEqual({ ok: true });
      expect(clientInternals.pendingResponses.has(responder.id)).toBe(false);
    } finally {
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

  it("maps raw request abort errors to request cancellation", async () => {
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
          await new Promise<void>((_, reject) => {
            responder.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
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

describe("JSON-RPC malformed peer messages", () => {
  it("does not print params of invalid or failed messages", async () => {
    const secret = "SYNTHETIC_PRIVATE_CREDENTIAL";
    const mcpServers = [
      {
        name: "stdio",
        command: "/bin/server",
        args: [],
        env: [{ name: "API_KEY", value: secret }],
      },
      {
        type: "http",
        name: "http",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: secret }],
      },
    ];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const [clientStream, serverStream] = memoryStreamPair();
    const processed = Promise.withResolvers<void>();
    const client = Connection.builder()
      .onReceiveNotification(
        "example/setup",
        (params) => params,
        () => {
          throw RequestError.invalidParams({ received: secret });
        },
      )
      .onReceiveNotification(
        "example/barrier",
        (params) => params,
        () => {
          processed.resolve();
        },
      )
      .connect(clientStream);
    const serverWriter = serverStream.writable.getWriter();

    try {
      // A response-shaped message without an ID cannot be correlated.
      await serverWriter.write({
        jsonrpc: "2.0",
        result: { cwd: "/work", mcpServers },
      } as unknown as AnyMessage);
      // A notification whose handler fails.
      await serverWriter.write({
        jsonrpc: "2.0",
        method: "example/setup",
        params: { cwd: "/work", mcpServers },
      });
      await serverWriter.write({ jsonrpc: "2.0", method: "example/barrier" });
      await processed.promise;
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(2));

      expect(consoleError).toHaveBeenNthCalledWith(1, "Invalid message", {
        type: "object",
        keys: ["jsonrpc", "result"],
      });
      expect(consoleError).toHaveBeenNthCalledWith(
        2,
        "Error handling notification",
        { method: "example/setup", code: -32602, message: "Invalid params" },
      );
      // Inspect like the console does, including Error messages.
      expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain(
        secret,
      );
    } finally {
      serverWriter.releaseLock();
      consoleError.mockRestore();
      client.close();
      await client.closed;
    }
  });

  it("rejects a matching malformed response without replying to it", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const client = Connection.builder().connect(clientStream);
    const serverReader = serverStream.readable.getReader();
    const serverWriter = serverStream.writable.getWriter();

    const response = client.sendRequest("example/test", {});
    const { value: request } = await serverReader.read();
    expect(request).toMatchObject({ method: "example/test" });

    await serverWriter.write({
      jsonrpc: "2.0",
      id: (request as { id: number }).id,
      error: null,
    } as unknown as AnyMessage);

    await expect(response).rejects.toMatchObject({ code: -32600 });

    const notification = client.sendNotification("example/after-response", {});
    await expect(serverReader.read()).resolves.toMatchObject({
      value: {
        jsonrpc: "2.0",
        method: "example/after-response",
      },
    });
    await notification;

    serverReader.releaseLock();
    serverWriter.releaseLock();
    client.close();
    await client.closed;
  });

  it("does not reply to unknown malformed response-shaped messages", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const [clientStream, serverStream] = memoryStreamPair();
    const processed = Promise.withResolvers<void>();
    const client = Connection.builder()
      .onReceiveNotification(
        "example/barrier",
        (params) => params,
        () => {
          processed.resolve();
        },
      )
      .connect(clientStream);
    const serverReader = serverStream.readable.getReader();
    const serverWriter = serverStream.writable.getWriter();

    await serverWriter.write({
      jsonrpc: "2.0",
      id: 999,
      error: null,
    } as unknown as AnyMessage);
    await serverWriter.write({
      jsonrpc: "2.0",
      result: true,
    } as unknown as AnyMessage);
    await serverWriter.write({
      jsonrpc: "2.0",
      error: null,
    } as unknown as AnyMessage);
    await serverWriter.write({
      jsonrpc: "2.0",
      method: "example/barrier",
    });
    await processed.promise;

    const notification = client.sendNotification("example/after-responses", {});
    await expect(serverReader.read()).resolves.toMatchObject({
      value: {
        jsonrpc: "2.0",
        method: "example/after-responses",
      },
    });
    await notification;

    serverReader.releaseLock();
    serverWriter.releaseLock();
    consoleError.mockRestore();
    client.close();
    await client.closed;
  });

  it("returns Invalid Request for malformed call-shaped values and stays open", async () => {
    const [clientStream, serverStream] = memoryStreamPair();
    const client = Connection.builder().connect(clientStream);
    const serverReader = serverStream.readable.getReader();
    const serverWriter = serverStream.writable.getWriter();

    for (const malformed of [
      null,
      42,
      {},
      { jsonrpc: "1.0", id: 1, method: "example/test" },
      { jsonrpc: "2.0", id: 1, method: 42 },
      { jsonrpc: "2.0", id: {}, method: "example/test" },
    ]) {
      await serverWriter.write(malformed as unknown as AnyMessage);
      await expect(serverReader.read()).resolves.toMatchObject({
        value: {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600 },
        },
      });
    }

    const response = client.sendRequest("example/test", {});
    const { value: request } = await serverReader.read();
    await serverWriter.write({
      jsonrpc: "2.0",
      id: (request as { id: number }).id,
      result: { ok: true },
    } as AnyMessage);

    await expect(response).resolves.toEqual({ ok: true });

    serverReader.releaseLock();
    serverWriter.releaseLock();
    client.close();
    await client.closed;
  });
});

function memoryStreamPair(): [Stream<AnyMessage>, Stream<AnyMessage>] {
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
