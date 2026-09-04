import { PassThrough, Readable, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { agent, client, ndJsonStream } from "./acp.js";
import { Connection, Handled, RequestError } from "./jsonrpc.js";
import type { JsonRpcId, RequestResponder } from "./jsonrpc.js";
import { proxy } from "./proxy.js";
import type { ProxyBuilder, ProxyHandle } from "./proxy.js";
import type { AnyMessage } from "./jsonrpc.js";
import type { Stream } from "./stream.js";

function inMemoryStreamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<AnyMessage>();
  const rightToLeft = new TransformStream<AnyMessage>();
  return [
    { readable: rightToLeft.readable, writable: leftToRight.writable },
    { readable: leftToRight.readable, writable: rightToLeft.writable },
  ];
}

type ProxySetup = {
  clientStream: Stream;
  agentStream: Stream;
  builder: ProxyBuilder;
  handle: ProxyHandle;
};

function setupProxy(configure?: (p: ProxyBuilder) => void): ProxySetup {
  const [clientStream, proxyClientSide] = inMemoryStreamPair();
  const [proxyAgentSide, agentStream] = inMemoryStreamPair();
  const builder = proxy();
  configure?.(builder);
  const handle = builder.connect({
    client: proxyClientSide,
    agent: proxyAgentSide,
  });
  return { clientStream, agentStream, builder, handle };
}

async function withTimeout<T>(
  promise: Promise<T>,
  message = "operation timed out",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("proxy forwarding", () => {
  it("forwards client requests to the agent and responses back", async () => {
    const { clientStream, agentStream } = setupProxy();
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("echo", { value: 42 });

    expect(response).toEqual({ echoed: { value: 42 } });
  });

  it("forwards agent-initiated requests to the client", async () => {
    const { clientStream, agentStream } = setupProxy();
    Connection.builder()
      .onReceiveRequest(
        "confirm",
        (params) => params,
        (_request, responder) => responder.respond({ approved: true }),
      )
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    const response = await agentEnd.sendRequest("confirm", { action: "run" });

    expect(response).toEqual({ approved: true });
  });

  it("forwards notifications", async () => {
    const { clientStream, agentStream } = setupProxy();
    const received = vi.fn();
    const seen = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveNotification(
        "log",
        (params) => params,
        (notification) => {
          received(notification);
          seen.resolve();
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    await clientEnd.sendNotification("log", { line: "hello" });
    await seen.promise;

    expect(received).toHaveBeenCalledWith({ line: "hello" });
  });

  it("preserves error responses across the proxy", async () => {
    const { clientStream, agentStream } = setupProxy();
    Connection.builder()
      .onReceiveRequest(
        "always-fails",
        (params) => params,
        () => {
          throw new RequestError(1234, "nope", { reason: "test" });
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const failure = clientEnd.sendRequest("always-fails", {});

    await expect(failure).rejects.toMatchObject({
      code: 1234,
      message: "nope",
      data: { reason: "test" },
    });
  });

  it("responds method-not-found from the far side, not the proxy", async () => {
    const { clientStream, agentStream } = setupProxy();
    Connection.builder().connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const failure = clientEnd.sendRequest("no-such-method", {});

    await expect(failure).rejects.toMatchObject({ code: -32601 });
  });

  it("propagates cancellation to the side handling the request", async () => {
    const { clientStream, agentStream } = setupProxy();
    Connection.builder()
      .onReceiveRequest(
        "slow",
        (params) => params,
        (_request, responder) => {
          // Never respond on our own; settle only when the caller cancels.
          responder.signal.addEventListener("abort", () => {
            void responder.respondWithError(RequestError.requestCancelled());
          });
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const canceller = new AbortController();
    const failure = clientEnd.sendRequest("slow", {}, undefined, {
      cancellationSignal: canceller.signal,
    });
    canceller.abort();

    await expect(failure).rejects.toMatchObject({ code: -32800 });
  });

  it("reissues cancellation with the target ID without forwarding the source ID", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "local",
        (params) => params,
        () => ({ answered: "locally" }),
      );
    });
    const arrived = Promise.withResolvers<void>();
    const responders = new Map<
      string,
      { responder: RequestResponder<unknown>; aborted: boolean }
    >();
    const cancellations: JsonRpcId[] = [];
    Connection.builder()
      .onReceiveRequest(
        "park",
        (params) => params as { name: string },
        (request, responder) => {
          const state = { responder, aborted: false };
          responders.set(request.name, state);
          responder.signal.addEventListener("abort", () => {
            state.aborted = true;
            if (request.name === "cancelled") {
              void responder.respondWithError(RequestError.requestCancelled());
            }
          });
          if (responders.size === 2) {
            arrived.resolve();
          }
        },
      )
      .onReceiveRequest(
        "barrier",
        (params) => params,
        (_request, responder) => responder.respond({ passed: true }),
      )
      .onReceiveNotification(
        "$/cancel_request",
        (params) => params as { requestId: JsonRpcId },
        (notification) => {
          cancellations.push(notification.requestId);
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    await expect(clientEnd.sendRequest("local", {})).resolves.toEqual({
      answered: "locally",
    });

    const canceller = new AbortController();
    const cancelled = clientEnd.sendRequest(
      "park",
      { name: "cancelled" },
      undefined,
      { cancellationSignal: canceller.signal },
    );
    const unrelated = clientEnd.sendRequest("park", { name: "unrelated" });
    await arrived.promise;

    const cancelledAtAgent = responders.get("cancelled")!;
    const unrelatedAtAgent = responders.get("unrelated")!;
    // The locally answered source request consumed source ID 0 without
    // consuming a target ID, so the two connections now allocate different
    // IDs for the same forwarded request.
    expect(cancelledAtAgent.responder.id).toBe(0);
    expect(unrelatedAtAgent.responder.id).toBe(1);

    canceller.abort();
    await expect(clientEnd.sendRequest("barrier", {})).resolves.toEqual({
      passed: true,
    });
    await expect(cancelled).rejects.toMatchObject({ code: -32800 });

    expect(cancellations).toEqual([cancelledAtAgent.responder.id]);
    expect(cancelledAtAgent.aborted).toBe(true);
    expect(unrelatedAtAgent.aborted).toBe(false);

    await unrelatedAtAgent.responder.respond({ done: true });
    await expect(unrelated).resolves.toEqual({ done: true });
  });

  it("preserves notification order when an earlier handler is slow", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onNotificationFromAgent(
        "update",
        (params) => params as { tag: string; delay: number },
        async ({ params, forward }) => {
          await new Promise((resolve) => setTimeout(resolve, params.delay));
          await forward(params);
        },
      );
    });
    const received: string[] = [];
    const gotBoth = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveNotification(
        "update",
        (params) => params as { tag: string },
        (notification) => {
          received.push(notification.tag);
          if (received.length === 2) {
            gotBoth.resolve();
          }
        },
      )
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    // Without serialized dispatch the second (instant) chain would overtake
    // the first (delayed) one.
    await agentEnd.sendNotification("update", { tag: "first", delay: 25 });
    await agentEnd.sendNotification("update", { tag: "second", delay: 0 });
    await gotBoth.promise;

    expect(received).toEqual(["first", "second"]);
  });

  it("does not block later messages behind a pending request round trip", async () => {
    // `slow` goes through a typed handler that awaits forward(...), which
    // must release the dispatch loop at the send, not the response.
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "slow",
        (params) => params,
        async ({ params, forward }) => forward(params),
      );
    });
    const slowArrived = Promise.withResolvers<RequestResponder<unknown>>();
    Connection.builder()
      .onReceiveRequest(
        "slow",
        (params) => params,
        (_request, responder) => {
          // Hold the request open; it is answered after `ping` completes.
          slowArrived.resolve(responder);
        },
      )
      .onReceiveRequest(
        "ping",
        (params) => params,
        (_request, responder) => responder.respond({ pong: true }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const slow = clientEnd.sendRequest("slow", {});
    const ping = await clientEnd.sendRequest("ping", {});
    expect(ping).toEqual({ pong: true });

    const responder = await slowArrived.promise;
    await responder.respond({ done: true });
    await expect(slow).resolves.toEqual({ done: true });
  });

  it("closes the other side when one side of the proxy closes", async () => {
    const { handle } = setupProxy();

    handle.client.close(new Error("client side went away"));

    await expect(handle.closed).resolves.toBeUndefined();
    expect(handle.agent.signal.aborted).toBe(true);
    // The close reason crosses to the other side's pending requests.
    expect(handle.agent.signal.reason).toMatchObject({
      message: "client side went away",
    });
  });

  it("closes both sides when the client transport reaches EOF", async () => {
    // Over a real byte transport (stdio, sockets) a disconnect arrives as
    // EOF on the read loop, not as a close() call. Byte pipes reproduce
    // that, unlike the in-memory object streams used elsewhere.
    const clientToProxy = new PassThrough();
    const proxyToClient = new PassThrough();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const handle = proxy().connect({
      client: ndJsonStream(
        Writable.toWeb(proxyToClient),
        Readable.toWeb(clientToProxy) as ReadableStream<Uint8Array>,
      ),
      agent: proxyAgentSide,
    });
    const agentEnd = new Connection(agentStream, []);
    // In-flight traffic when the transport dies; over the in-memory agent
    // pair this pending request can never settle, so it is not awaited.
    void agentEnd.sendRequest("confirm", {}).catch(() => {});

    // The client goes away mid-request.
    clientToProxy.end();

    await expect(handle.closed).resolves.toBeUndefined();
    expect(handle.client.signal.aborted).toBe(true);
    expect(handle.agent.signal.aborted).toBe(true);
  });

  it("drains a final response through an async interceptor before propagating EOF", async () => {
    const [clientStream, proxyClientSide] = inMemoryStreamPair();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const releaseInterceptor = Promise.withResolvers<void>();
    const responseReceived = Promise.withResolvers<void>();
    const handle = proxy()
      .onRequestFromClient(
        "echo",
        (params) => params,
        async ({ params, forward }) => {
          const response = (await forward(params)) as Record<string, unknown>;
          responseReceived.resolve();
          await releaseInterceptor.promise;
          return { ...response, intercepted: true };
        },
      )
      .connect({ client: proxyClientSide, agent: proxyAgentSide });
    const clientEnd = new Connection(clientStream, []);
    const agentReader = agentStream.readable.getReader();
    const agentWriter = agentStream.writable.getWriter();

    const response = clientEnd.sendRequest("echo", { value: 42 });
    const { value: forwarded } = await agentReader.read();
    if (
      !forwarded ||
      Array.isArray(forwarded) ||
      !("id" in forwarded) ||
      !("method" in forwarded)
    ) {
      throw new Error("Expected the forwarded request");
    }

    await agentWriter.write({
      jsonrpc: "2.0",
      id: forwarded.id,
      result: { echoed: forwarded.params },
    });
    await responseReceived.promise;
    await agentWriter.close();
    await handle.agent.closed;

    expect(handle.client.signal.aborted).toBe(false);
    releaseInterceptor.resolve();
    await expect(response).resolves.toEqual({
      echoed: { value: 42 },
      intercepted: true,
    });
    await handle.closed;

    agentReader.releaseLock();
    agentWriter.releaseLock();
    clientEnd.close();
  });

  it("drains an already-received response back to a requester that reaches EOF", async () => {
    const [clientStream, proxyClientSide] = inMemoryStreamPair();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const responseReceived = Promise.withResolvers<void>();
    const releaseInterceptor = Promise.withResolvers<void>();
    const handle = proxy()
      .onRequestFromAgent(
        "ask",
        (params) => params,
        async ({ params, forward }) => {
          const response = (await forward(params)) as Record<string, unknown>;
          responseReceived.resolve();
          await releaseInterceptor.promise;
          return { ...response, intercepted: true };
        },
      )
      .connect({ client: proxyClientSide, agent: proxyAgentSide });
    const clientReader = clientStream.readable.getReader();
    const clientWriter = clientStream.writable.getWriter();
    const agentReader = agentStream.readable.getReader();
    const agentWriter = agentStream.writable.getWriter();

    try {
      await agentWriter.write({
        jsonrpc: "2.0",
        id: 91,
        method: "ask",
        params: { value: 42 },
      });
      const { value: forwarded } = await clientReader.read();
      if (
        !forwarded ||
        Array.isArray(forwarded) ||
        !("id" in forwarded) ||
        !("method" in forwarded)
      ) {
        throw new Error("Expected the forwarded request");
      }

      await clientWriter.write({
        jsonrpc: "2.0",
        id: forwarded.id,
        result: { answered: true },
      });
      await responseReceived.promise;
      await agentWriter.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handle.agent.signal.aborted).toBe(false);

      const response = agentReader.read();
      releaseInterceptor.resolve();
      await expect(withTimeout(response)).resolves.toEqual({
        done: false,
        value: {
          jsonrpc: "2.0",
          id: 91,
          result: { answered: true, intercepted: true },
        },
      });
      await withTimeout(handle.closed, "proxy did not close after response");
    } finally {
      releaseInterceptor.resolve();
      handle.close();
      await clientReader.cancel().catch(() => {});
      await agentReader.cancel().catch(() => {});
      clientReader.releaseLock();
      clientWriter.releaseLock();
      agentReader.releaseLock();
      agentWriter.releaseLock();
    }
  });

  it("drains a final notification whose interceptor has not forwarded before EOF", async () => {
    const [clientStream, proxyClientSide] = inMemoryStreamPair();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const handlerStarted = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();
    const handle = proxy()
      .onNotificationFromAgent(
        "note",
        (params) => params,
        async ({ params, forward }) => {
          handlerStarted.resolve();
          await releaseHandler.promise;
          await forward(params);
        },
      )
      .connect({ client: proxyClientSide, agent: proxyAgentSide });
    const clientReader = clientStream.readable.getReader();
    const agentWriter = agentStream.writable.getWriter();

    try {
      const notification = {
        jsonrpc: "2.0" as const,
        method: "note",
        params: { final: true },
      };
      await agentWriter.write(notification);
      await handlerStarted.promise;
      await agentWriter.close();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.agent.signal.aborted).toBe(false);
      expect(handle.client.signal.aborted).toBe(false);

      const received = clientReader.read();
      releaseHandler.resolve();
      await expect(withTimeout(received)).resolves.toEqual({
        done: false,
        value: notification,
      });
      await withTimeout(handle.closed, "proxy did not close after EOF drain");
    } finally {
      releaseHandler.resolve();
      handle.close();
      await clientReader.cancel().catch(() => {});
      clientReader.releaseLock();
      agentWriter.releaseLock();
    }
  });

  it("drains every queued notification write before propagating EOF", async () => {
    const firstWriteStarted = Promise.withResolvers<void>();
    const secondWriteStarted = Promise.withResolvers<void>();
    const releaseFirstWrite = Promise.withResolvers<void>();
    const releaseSecondWrite = Promise.withResolvers<void>();
    const written: AnyMessage[] = [];
    const proxyClientSide: Stream = {
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({
        async write(message) {
          written.push(message);
          if (written.length === 1) {
            firstWriteStarted.resolve();
            await releaseFirstWrite.promise;
          } else {
            secondWriteStarted.resolve();
            await releaseSecondWrite.promise;
          }
        },
      }),
    };
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const handle = proxy().connect({
      client: proxyClientSide,
      agent: proxyAgentSide,
    });
    const agentWriter = agentStream.writable.getWriter();

    try {
      const first = {
        jsonrpc: "2.0" as const,
        method: "note",
        params: { n: 1 },
      };
      const second = {
        jsonrpc: "2.0" as const,
        method: "note",
        params: { n: 2 },
      };
      await agentWriter.write(first);
      await agentWriter.write(second);
      await agentWriter.close();
      await withTimeout(firstWriteStarted.promise, "first write did not start");
      await withTimeout(handle.agent.closed, "agent EOF did not settle");

      expect(handle.client.signal.aborted).toBe(false);
      releaseFirstWrite.resolve();
      await withTimeout(secondWriteStarted.promise, "second write was dropped");
      expect(handle.client.signal.aborted).toBe(false);

      releaseSecondWrite.resolve();
      await withTimeout(handle.closed, "queued writes did not drain");
      expect(written).toEqual([first, second]);
    } finally {
      releaseFirstWrite.resolve();
      releaseSecondWrite.resolve();
      handle.close();
      agentWriter.releaseLock();
    }
  });

  it("propagates a protocol-error close without waiting for interceptor cleanup", async () => {
    const [clientStream, proxyClientSide] = inMemoryStreamPair();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const interceptorPaused = Promise.withResolvers<void>();
    const releaseInterceptor = Promise.withResolvers<void>();
    const handle = proxy()
      .onNotificationFromAgent(
        "note",
        (params) => params,
        async ({ params, forward }) => {
          await forward(params);
          interceptorPaused.resolve();
          await releaseInterceptor.promise;
        },
      )
      .connect({ client: proxyClientSide, agent: proxyAgentSide });
    const clientReader = clientStream.readable.getReader();
    const clientWriter = clientStream.writable.getWriter();
    const agentWriter = agentStream.writable.getWriter();

    try {
      await agentWriter.write({
        jsonrpc: "2.0",
        method: "note",
        params: { final: true },
      });
      await withTimeout(clientReader.read());
      await interceptorPaused.promise;

      await clientWriter.write([
        { jsonrpc: "2.0", method: "unsupported-batch" },
      ] as unknown as AnyMessage);
      await withTimeout(
        handle.closed,
        "protocol error waited for interceptor cleanup",
      );

      expect(handle.client.signal.reason).toBeInstanceOf(TypeError);
      expect(handle.agent.signal.reason).toBe(handle.client.signal.reason);
    } finally {
      releaseInterceptor.resolve();
      handle.close();
      await clientReader.cancel().catch(() => {});
      clientReader.releaseLock();
      clientWriter.releaseLock();
      agentWriter.releaseLock();
    }
  });

  it("propagates an explicit side close without waiting for interceptor cleanup", async () => {
    const [clientStream, proxyClientSide] = inMemoryStreamPair();
    const [proxyAgentSide, agentStream] = inMemoryStreamPair();
    const interceptorPaused = Promise.withResolvers<void>();
    const releaseInterceptor = Promise.withResolvers<void>();
    const handle = proxy()
      .onNotificationFromAgent(
        "note",
        (params) => params,
        async ({ params, forward }) => {
          await forward(params);
          interceptorPaused.resolve();
          await releaseInterceptor.promise;
        },
      )
      .connect({ client: proxyClientSide, agent: proxyAgentSide });
    const clientReader = clientStream.readable.getReader();
    const agentWriter = agentStream.writable.getWriter();

    try {
      await agentWriter.write({
        jsonrpc: "2.0",
        method: "note",
        params: { final: true },
      });
      await withTimeout(clientReader.read());
      await interceptorPaused.promise;

      const reason = new Error("client closed explicitly");
      handle.client.close(reason);
      await withTimeout(
        handle.closed,
        "explicit close waited for interceptor cleanup",
      );

      expect(handle.client.signal.reason).toBe(reason);
      expect(handle.agent.signal.reason).toBe(reason);
    } finally {
      releaseInterceptor.resolve();
      handle.close();
      await clientReader.cancel().catch(() => {});
      clientReader.releaseLock();
      agentWriter.releaseLock();
    }
  });

  it("closes both sides through the handle", async () => {
    const { handle } = setupProxy();

    handle.close();

    await expect(handle.closed).resolves.toBeUndefined();
    expect(handle.client.signal.aborted).toBe(true);
    expect(handle.agent.signal.aborted).toBe(true);
  });
});

describe("proxy error and cancellation edges", () => {
  it("propagates cancellation through a registered handler's forward", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "slow",
        (params) => params,
        async ({ params, forward }) => forward(params),
      );
    });
    Connection.builder()
      .onReceiveRequest(
        "slow",
        (params) => params,
        (_request, responder) => {
          responder.signal.addEventListener("abort", () => {
            void responder.respondWithError(RequestError.requestCancelled());
          });
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const canceller = new AbortController();
    const failure = clientEnd.sendRequest("slow", {}, undefined, {
      cancellationSignal: canceller.signal,
    });
    canceller.abort();

    await expect(failure).rejects.toMatchObject({ code: -32800 });
  });

  it("maps a handler's abort after cancellation to request-cancelled", async () => {
    const { clientStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "watch",
        (params) => params,
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const abortError = new Error("The operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }),
      );
    });
    const clientEnd = new Connection(clientStream, []);

    const canceller = new AbortController();
    const failure = clientEnd.sendRequest("watch", {}, undefined, {
      cancellationSignal: canceller.signal,
    });
    canceller.abort();

    await expect(failure).rejects.toMatchObject({ code: -32800 });
  });

  it("answers a generic handler throw as an internal error", async () => {
    const { clientStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "boom",
        (params) => params,
        () => {
          throw new Error("kaput");
        },
      );
    });
    const clientEnd = new Connection(clientStream, []);

    await expect(clientEnd.sendRequest("boom", {})).rejects.toMatchObject({
      code: -32603,
    });
  });

  it("answers a parser failure as invalid params", async () => {
    class FakeZodError extends Error {
      name = "ZodError";
      issues: unknown[] = [];
      format(): unknown {
        return { _errors: ["expected a number"] };
      }
    }
    const { clientStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "strict",
        () => {
          throw new FakeZodError("invalid");
        },
        async ({ params, forward }) => forward(params),
      );
    });
    const clientEnd = new Connection(clientStream, []);

    await expect(
      clientEnd.sendRequest("strict", { n: "not-a-number" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("drops a throwing notification handler's message and keeps dispatching", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onNotificationFromClient(
        "log",
        (params) => params as { fail: boolean },
        async ({ params, forward }) => {
          if (params.fail) {
            throw new Error("handler exploded");
          }
          await forward(params);
        },
      );
    });
    const received = vi.fn();
    const gotSecond = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveNotification(
        "log",
        (params) => params,
        (notification) => {
          received(notification);
          gotSecond.resolve();
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    await clientEnd.sendNotification("log", { fail: true });
    await clientEnd.sendNotification("log", { fail: false });
    await gotSecond.promise;

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ fail: false });
    consoleError.mockRestore();
  });
});

describe("proxy ordering and correlation", () => {
  it("preserves request send order through an async registered handler", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "echo",
        (params) => params as { n: number },
        async ({ params, forward }) => {
          // Delay before forwarding; serialization must keep send order.
          await new Promise((resolve) => setTimeout(resolve, 15 - params.n));
          return forward(params);
        },
      );
    });
    const arrivals: number[] = [];
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params as { n: number },
        (request, responder) => {
          arrivals.push(request.n);
          return responder.respond({ echoed: request.n });
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const [first, second] = await Promise.all([
      clientEnd.sendRequest("echo", { n: 1 }),
      clientEnd.sendRequest("echo", { n: 2 }),
    ]);

    expect(arrivals).toEqual([1, 2]);
    expect(first).toEqual({ echoed: 1 });
    expect(second).toEqual({ echoed: 2 });
  });

  it("correlates concurrent round trips answered out of order", async () => {
    const { clientStream, agentStream } = setupProxy();
    const held: Array<{ n: number; responder: RequestResponder<unknown> }> = [];
    const gotBoth = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveRequest(
        "hold",
        (params) => params as { n: number },
        (request, responder) => {
          held.push({ n: request.n, responder });
          if (held.length === 2) {
            gotBoth.resolve();
          }
        },
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const first = clientEnd.sendRequest("hold", { n: 1 });
    const second = clientEnd.sendRequest("hold", { n: 2 });
    await gotBoth.promise;

    // Answer in reverse order; each caller must still get its own response.
    await held[1]!.responder.respond({ answered: 2 });
    await held[0]!.responder.respond({ answered: 1 });

    await expect(second).resolves.toEqual({ answered: 2 });
    await expect(first).resolves.toEqual({ answered: 1 });
  });

  it("keeps pass-through traffic ordered behind a busy registered handler", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onNotificationFromAgent(
        "update",
        (params) => params,
        async ({ params, forward }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await forward(params);
        },
      );
    });
    const received: string[] = [];
    const gotBoth = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveMessage((message) => {
        received.push(message.method);
        if (received.length === 2) {
          gotBoth.resolve();
        }
        return Handled.yes();
      })
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    // "update" is registered (slow); "other" is unregistered pass-through.
    // The fast path must not let "other" overtake the busy queue.
    await agentEnd.sendNotification("update", {});
    await agentEnd.sendNotification("other", {});
    await gotBoth.promise;

    expect(received).toEqual(["update", "other"]);
  });
});

describe("proxy agent-side interception", () => {
  it("intercepts agent-initiated requests with onRequestFromAgent", async () => {
    const clientSaw = vi.fn();
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromAgent(
        "confirm",
        (params) => params as { action: string },
        // Answer in the proxy; the client must never be consulted.
        ({ params }) => ({ approved: params.action === "safe" }),
      );
    });
    Connection.builder()
      .onReceiveMessage((message) => {
        clientSaw(message.method);
        return Handled.no(message);
      })
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    await expect(
      agentEnd.sendRequest("confirm", { action: "safe" }),
    ).resolves.toEqual({
      approved: true,
    });
    await expect(
      agentEnd.sendRequest("confirm", { action: "risky" }),
    ).resolves.toEqual({ approved: false });

    expect(clientSaw).not.toHaveBeenCalled();
  });

  it("parses params with an object-form (schema-style) parser", async () => {
    const parsed: unknown[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "strict",
        // Object form, like a zod schema: { parse(input) { ... } }.
        {
          parse: (input: unknown) => {
            const record = input as { n: number };
            return { n: record.n * 10 };
          },
        },
        async ({ params, forward }) => {
          parsed.push(params);
          return forward(params);
        },
      );
    });
    Connection.builder()
      .onReceiveRequest(
        "strict",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("strict", { n: 4 });

    expect(parsed).toEqual([{ n: 40 }]);
    expect(response).toEqual({ echoed: { n: 40 } });
  });
});

describe("proxy composition", () => {
  it("chains two proxies, each rewriting in flight", async () => {
    const [clientStream, firstClientSide] = inMemoryStreamPair();
    const [firstAgentSide, secondClientSide] = inMemoryStreamPair();
    const [secondAgentSide, agentStream] = inMemoryStreamPair();
    proxy()
      .onRequestFromClient(
        "echo",
        (params) => params as Record<string, unknown>,
        async ({ params, forward }) => forward({ ...params, hop1: true }),
      )
      .connect({ client: firstClientSide, agent: firstAgentSide });
    proxy()
      .onRequestFromClient(
        "echo",
        (params) => params as Record<string, unknown>,
        async ({ params, forward }) => forward({ ...params, hop2: true }),
      )
      .connect({ client: secondClientSide, agent: secondAgentSide });
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("echo", { original: true });

    expect(response).toEqual({
      echoed: { original: true, hop1: true, hop2: true },
    });
  });

  it("connects one configured builder to multiple stream pairs independently", async () => {
    const builder = proxy().onRequestFromClient(
      "echo",
      (params) => params as Record<string, unknown>,
      async ({ params, forward }) => forward({ ...params, stamped: true }),
    );

    for (const label of ["a", "b"]) {
      const [clientStream, proxyClientSide] = inMemoryStreamPair();
      const [proxyAgentSide, agentStream] = inMemoryStreamPair();
      builder.connect({ client: proxyClientSide, agent: proxyAgentSide });
      Connection.builder()
        .onReceiveRequest(
          "echo",
          (params) => params,
          (request, responder) => responder.respond({ echoed: request }),
        )
        .connect(agentStream);
      const clientEnd = new Connection(clientStream, []);

      await expect(
        clientEnd.sendRequest("echo", { via: label }),
      ).resolves.toEqual({ echoed: { via: label, stamped: true } });
    }
  });
});

describe("proxy typed registration", () => {
  it("rewrites request params before forwarding", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "echo",
        (params) => params as Record<string, unknown>,
        async ({ forward }) => forward({ rewritten: true }),
      );
    });
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("echo", { original: true });

    expect(response).toEqual({ echoed: { rewritten: true } });
  });

  it("rewrites responses on the way back", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "echo",
        (params) => params,
        async ({ params, forward }) => {
          const response = (await forward(params)) as Record<string, unknown>;
          return { ...response, stamped: true };
        },
      );
    });
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("echo", { value: 1 });

    expect(response).toEqual({ echoed: { value: 1 }, stamped: true });
  });

  it("answers intercepted requests without the agent seeing them", async () => {
    const agentSaw = vi.fn();
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "denied",
        (params) => params,
        () => {
          throw new RequestError(-32001, "not allowed");
        },
      );
    });
    Connection.builder()
      .onReceiveMessage((message) => {
        agentSaw(message.method);
        return Handled.no(message);
      })
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    const denied = clientEnd.sendRequest("denied", {});
    await expect(denied).rejects.toMatchObject({ code: -32001 });

    // A permitted request afterwards proves the denied one never crossed.
    await clientEnd.sendRequest("allowed", {}).catch(() => {});
    expect(agentSaw).toHaveBeenCalledWith("allowed");
    expect(agentSaw).not.toHaveBeenCalledWith("denied");
  });

  it("answers without forwarding when the handler returns its own response", async () => {
    const { clientStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "cached",
        (params) => params,
        () => ({ fromProxy: true }),
      );
    });
    const clientEnd = new Connection(clientStream, []);

    const response = await clientEnd.sendRequest("cached", {});

    expect(response).toEqual({ fromProxy: true });
  });

  it("drops notifications when the handler skips forward", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onNotificationFromAgent(
        "update",
        (params) => params as { secret: boolean },
        async ({ params, forward }) => {
          if (!params.secret) {
            await forward(params);
          }
        },
      );
    });
    const received = vi.fn();
    const gotPublic = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveNotification(
        "update",
        (params) => params,
        (notification) => {
          received(notification);
          gotPublic.resolve();
        },
      )
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    await agentEnd.sendNotification("update", { secret: true });
    await agentEnd.sendNotification("update", { secret: false });
    await gotPublic.promise;

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ secret: false });
  });

  it("routes unclaimed traffic to '*' with exact registrations winning", async () => {
    const wildcardSaw: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "specific",
        (params) => params,
        () => ({ via: "specific" }),
      ).onRequestFromClient("*", ({ method, params, forward }) => {
        wildcardSaw.push(method);
        return forward(params);
      });
    });
    Connection.builder()
      .onReceiveRequest(
        "other",
        (params) => params,
        (_request, responder) => responder.respond({ via: "agent" }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    await expect(clientEnd.sendRequest("specific", {})).resolves.toEqual({
      via: "specific",
    });
    await expect(clientEnd.sendRequest("other", {})).resolves.toEqual({
      via: "agent",
    });

    expect(wildcardSaw).toEqual(["other"]);
  });

  it("snapshots registrations at connect", async () => {
    const { clientStream, agentStream, builder } = setupProxy();
    Connection.builder()
      .onReceiveRequest(
        "echo",
        (params) => params,
        (request, responder) => responder.respond({ echoed: request }),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    // Registering after connect is allowed but must not affect the
    // already-connected proxy — same semantics as the fluent app builders.
    builder.onRequestFromClient(
      "echo",
      (params) => params as Record<string, unknown>,
      async ({ forward }) => forward({ late: true }),
    );

    await expect(clientEnd.sendRequest("echo", { n: 1 })).resolves.toEqual({
      echoed: { n: 1 },
    });
  });

  it("rejects duplicate registrations for the same method", () => {
    const p = proxy();
    p.onRequestFromClient(
      "echo",
      (params) => params,
      async ({ params, forward }) => forward(params),
    );

    expect(() =>
      p.onRequestFromClient(
        "echo",
        (params) => params,
        async ({ params, forward }) => forward(params),
      ),
    ).toThrow("already registered");
  });

  it("routes unclaimed notifications to '*'", async () => {
    const wildcardSaw: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onNotificationFromClient("*", async ({ method, params, forward }) => {
        wildcardSaw.push(method);
        await forward(params);
      });
    });
    const seen = Promise.withResolvers<void>();
    Connection.builder()
      .onReceiveNotification(
        "log",
        (params) => params,
        () => seen.resolve(),
      )
      .connect(agentStream);
    const clientEnd = new Connection(clientStream, []);

    await clientEnd.sendNotification("log", { line: "hi" });
    await seen.promise;

    expect(wildcardSaw).toEqual(["log"]);
  });
});

describe("proxy with fluent apps", () => {
  it("relays a full initialize/new/prompt flow with a typed interceptor", async () => {
    const promptTexts: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient("session/prompt", async ({ params, forward }) => {
        // Typed literal: params is PromptRequest, response is PromptResponse.
        for (const block of params.prompt) {
          if (block.type === "text") {
            promptTexts.push(block.text);
          }
        }
        const response = await forward(params);
        return { ...response, _meta: { ...response._meta, proxied: true } };
      });
    });

    agent({ name: "e2e-agent" })
      .onRequest("initialize", ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: {},
      }))
      .onRequest("session/new", () => ({ sessionId: "s-1" }))
      .onRequest("session/prompt", ({ params }) => ({
        stopReason: "end_turn" as const,
        _meta: { sawSession: params.sessionId },
      }))
      .connect(agentStream);

    const connection = client({ name: "e2e-client" }).connect(clientStream);
    try {
      const init = await connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(init.protocolVersion).toBe(1);

      const session = await connection.agent.request("session/new", {
        cwd: "/tmp",
        mcpServers: [],
      });
      expect(session.sessionId).toBe("s-1");

      const result = await connection.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello through the proxy" }],
      });

      expect(result.stopReason).toBe("end_turn");
      expect(result._meta).toEqual({ sawSession: "s-1", proxied: true });
      expect(promptTexts).toEqual(["hello through the proxy"]);
    } finally {
      connection.close();
    }
  });

  it("connects a client app to an agent app through the proxy", async () => {
    const promptsSeen: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.onRequestFromClient(
        "_test/echo",
        (params) => params as { value: number },
        async ({ params, forward }) => {
          promptsSeen.push(`echo:${params.value}`);
          return forward(params);
        },
      );
    });
    agent({ name: "test-agent" })
      .onRequest(
        "_test/echo",
        (params) => params as { value: number },
        ({ params }) => ({ doubled: params.value * 2 }),
      )
      .connect(agentStream);

    const connection = client({ name: "test-client" }).connect(clientStream);
    try {
      const response = await connection.agent.request<{ doubled: number }>(
        "_test/echo",
        { value: 21 },
      );

      expect(response).toEqual({ doubled: 42 });
      expect(promptsSeen).toEqual(["echo:21"]);
    } finally {
      connection.close();
    }
  });
});

describe("proxy batch rejection", () => {
  it("closes both sides when a batch wire message arrives", async () => {
    const { clientStream, handle } = setupProxy();
    const writer = clientStream.writable.getWriter();

    await writer.write([
      { jsonrpc: "2.0", id: 1, method: "example/one" },
      { jsonrpc: "2.0", method: "example/notify" },
    ] as unknown as AnyMessage);

    await handle.closed;
    expect(handle.client.signal.reason).toBeInstanceOf(TypeError);
    expect(String(handle.client.signal.reason)).toContain(
      "batches are not supported",
    );
    expect(handle.agent.signal.reason).toBe(handle.client.signal.reason);
  });
});
