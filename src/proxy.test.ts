import { describe, expect, it, vi } from "vitest";

import { agent, client, inMemoryStreamPair } from "./acp.js";
import { Connection, Handled, RequestError } from "./jsonrpc.js";
import type { JsonRpcHandler } from "./jsonrpc.js";
import { proxy } from "./proxy.js";
import type { ProxyHandle } from "./proxy.js";
import type { Stream } from "./stream.js";

type ProxySetup = {
  clientStream: Stream;
  agentStream: Stream;
  handle: ProxyHandle;
};

function setupProxy(options?: {
  clientToAgent?: JsonRpcHandler[];
  agentToClient?: JsonRpcHandler[];
}): ProxySetup {
  const [clientStream, proxyClientSide] = inMemoryStreamPair();
  const [proxyAgentSide, agentStream] = inMemoryStreamPair();
  const handle = proxy({
    client: proxyClientSide,
    agent: proxyAgentSide,
    ...options,
  });
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

  it("closes the other side when one side of the proxy closes", async () => {
    const { handle } = setupProxy();

    handle.client.close(new Error("client side went away"));

    await handle.closed;
    await expect(handle.agent.sendRequest("anything", {})).rejects.toThrow(
      "client side went away",
    );
  });

  it("closes both sides through the handle", async () => {
    const { handle } = setupProxy();

    handle.close();

    await handle.closed;
  });
});

describe("proxy interception", () => {
  it("rewrites request params before forwarding", async () => {
    const { clientStream, agentStream } = setupProxy({
      clientToAgent: [
        {
          handleMessage(message) {
            if (message.kind !== "request" || message.method !== "echo") {
              return Handled.no(message);
            }

            return Handled.no({
              ...message,
              params: { rewritten: true },
            });
          },
        },
      ],
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

  it("answers intercepted requests without the agent seeing them", async () => {
    const agentSaw = vi.fn();
    const { clientStream, agentStream } = setupProxy({
      clientToAgent: [
        {
          async handleMessage(message) {
            if (message.kind !== "request" || message.method !== "denied") {
              return Handled.no(message);
            }

            await message.responder.respondWithError(
              new RequestError(-32001, "not allowed"),
            );
            return Handled.yes();
          },
        },
      ],
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

  it("intercepts agent-to-client traffic with agentToClient handlers", async () => {
    const { clientStream, agentStream } = setupProxy({
      agentToClient: [
        {
          handleMessage(message) {
            if (
              message.kind !== "notification" ||
              message.method !== "update"
            ) {
              return Handled.no(message);
            }

            return Handled.no({
              ...message,
              params: { filtered: true },
            });
          },
        },
      ],
    });
    const received = Promise.withResolvers<unknown>();
    Connection.builder()
      .onReceiveNotification(
        "update",
        (params) => params,
        (notification) => received.resolve(notification),
      )
      .connect(clientStream);
    const agentEnd = new Connection(agentStream, []);

    await agentEnd.sendNotification("update", { secret: "value" });

    await expect(received.promise).resolves.toEqual({ filtered: true });
  });
});

describe("proxy with fluent apps", () => {
  it("connects a client app to an agent app through the proxy", async () => {
    const { clientStream, agentStream } = setupProxy();
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
    } finally {
      connection.close();
    }
  });
});
