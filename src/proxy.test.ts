import { describe, expect, it, vi } from "vitest";

import { agent, client } from "./acp.js";
import { Connection, Handled, RequestError } from "./jsonrpc.js";
import type { RequestResponder } from "./jsonrpc.js";
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

    await handle.closed;
  });

  it("closes both sides through the handle", async () => {
    const { handle } = setupProxy();

    handle.close();

    await handle.closed;
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
