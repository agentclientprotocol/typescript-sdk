import { describe, expect, it, vi } from "vitest";

import { agent, client, inMemoryStreamPair } from "./acp.js";
import { Connection, Handled, RequestError } from "./jsonrpc.js";
import type { RequestResponder } from "./jsonrpc.js";
import { proxy } from "./proxy.js";
import type { ProxyBuilder, ProxyHandle } from "./proxy.js";
import type { Stream } from "./stream.js";

type ProxySetup = {
  clientStream: Stream;
  agentStream: Stream;
  handle: ProxyHandle;
};

function setupProxy(configure?: (p: ProxyBuilder) => void): ProxySetup {
  const [clientStream, proxyClientSide] = inMemoryStreamPair();
  const [proxyAgentSide, agentStream] = inMemoryStreamPair();
  const p = proxy();
  configure?.(p);
  const handle = p.connect({ client: proxyClientSide, agent: proxyAgentSide });
  return { clientStream, agentStream, handle };
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
      p.agent.onNotification(
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
      p.client.onRequest(
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
    const agentSide = handle.agent as Connection;
    await expect(agentSide.sendRequest("anything", {})).rejects.toThrow(
      "client side went away",
    );
  });

  it("closes both sides through the handle", async () => {
    const { handle } = setupProxy();

    handle.close();

    await handle.closed;
  });
});

describe("proxy typed registration", () => {
  it("rewrites request params before forwarding", async () => {
    const { clientStream, agentStream } = setupProxy((p) => {
      p.client.onRequest(
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
      p.client.onRequest(
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
      p.client.onRequest(
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
      p.client.onRequest(
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
      p.agent.onNotification(
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
      p.client
        .onRequest(
          "specific",
          (params) => params,
          () => ({ via: "specific" }),
        )
        .onRequest("*", ({ method, params, forward }) => {
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

  it("rejects duplicate registrations for the same method", () => {
    const p = proxy();
    p.client.onRequest(
      "echo",
      (params) => params,
      async ({ params, forward }) => forward(params),
    );

    expect(() =>
      p.client.onRequest(
        "echo",
        (params) => params,
        async ({ params, forward }) => forward(params),
      ),
    ).toThrow("already registered");
  });

  it("routes unclaimed notifications to '*'", async () => {
    const wildcardSaw: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.client.onNotification("*", async ({ method, params, forward }) => {
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
  it("connects a client app to an agent app through the proxy", async () => {
    const promptsSeen: string[] = [];
    const { clientStream, agentStream } = setupProxy((p) => {
      p.client.onRequest(
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
