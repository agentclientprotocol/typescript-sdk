import { Connection, Handled, errorToResult, linkClosed } from "./jsonrpc.js";
import type { HandleResult, JsonRpcHandler } from "./jsonrpc.js";
import type { Stream } from "./stream.js";

/**
 * Options for {@link proxy}.
 */
export type ProxyOptions = {
  /**
   * Stream connected to the client side. The proxy presents as an agent on
   * this stream.
   */
  client: Stream;
  /**
   * Stream connected to the agent side. The proxy presents as a client on
   * this stream.
   */
  agent: Stream;
  /**
   * Handlers run on messages arriving from the client, in order, before the
   * proxy forwards them to the agent.
   *
   * Return `Handled.no(message)` with a replacement message to rewrite a
   * request or notification in flight. Return `Handled.yes()` after
   * responding through `message.responder` to intercept a request without
   * the agent ever seeing it (for example to deny it). Handlers that return
   * `Handled.no()` without a replacement pass the message through untouched.
   */
  fromClient?: JsonRpcHandler[];
  /**
   * Handlers run on messages arriving from the agent, in order, before the
   * proxy forwards them to the client. Same contract as `fromClient`.
   */
  fromAgent?: JsonRpcHandler[];
};

/**
 * Handle to a running proxy returned by {@link proxy}.
 */
export type ProxyHandle = {
  /**
   * Connection facing the client stream. Requests sent here go to the client.
   */
  readonly client: Connection;
  /**
   * Connection facing the agent stream. Requests sent here go to the agent.
   */
  readonly agent: Connection;
  /**
   * Promise that resolves once both sides of the proxy have closed.
   */
  readonly closed: Promise<void>;
  /**
   * Closes both sides of the proxy and rejects pending requests.
   */
  close(error?: unknown): void;
};

/**
 * Runs an ACP proxy between a client stream and an agent stream.
 *
 * The proxy terminates the protocol on both sides: each side is a full
 * JSON-RPC connection, so forwarded requests are re-issued with the proxy's
 * own request ids and their responses are correlated back to the original
 * caller automatically. This works in both directions — client-initiated
 * requests such as `session/prompt` flow toward the agent, and
 * agent-initiated requests such as `session/request_permission` flow toward
 * the client.
 *
 * Forwarding preserves the observable protocol behavior of a direct
 * connection:
 *
 * - Error responses pass through with their original code, message, and data.
 * - `$/cancel_request` from the original caller is propagated to the side
 *   handling the request, and the eventual response (which may be a normal
 *   result) still settles the original request.
 * - When either side closes, the other side is closed and its pending
 *   requests are rejected.
 *
 * Each side processes messages one at a time in arrival order, matching the
 * Rust SDK's dispatch loop: the next message is not dispatched until the
 * previous handler chain completes. A forwarded request releases the loop
 * once it has been sent rather than holding it across the round trip (the
 * Rust `forward_response_to` pattern), so a pending request never blocks
 * later messages such as `session/cancel`.
 *
 * Messages can be observed, rewritten, answered, or dropped before they are
 * forwarded by passing `fromClient` / `fromAgent` handlers; see
 * {@link ProxyOptions}.
 *
 * This mirrors the Rust SDK's `Proxy` role: a proxy sits between a client
 * and an agent, intercepting messages in both directions; messages it does
 * not handle are forwarded by default, and handlers intercept traffic from
 * an explicit peer (`fromClient` / `fromAgent`, like the Rust builder's
 * `on_receive_request_from(Client | Agent, ...)`). The
 * `_proxy/successor` envelope protocol used by the Rust conductor to chain
 * proxy processes over a single pipe is not needed here — this proxy owns a
 * real stream per side, so proxies chain by connecting one proxy's agent
 * stream to the next proxy's client stream.
 */
export function proxy(options: ProxyOptions): ProxyHandle {
  const client: Connection = new Connection(options.client, [
    serialDispatch([...(options.fromClient ?? []), forwardTo(() => agent)]),
  ]);
  const agent: Connection = new Connection(options.agent, [
    serialDispatch([...(options.fromAgent ?? []), forwardTo(() => client)]),
  ]);
  linkClosed(client, agent);

  return {
    client,
    agent,
    closed: Promise.all([client.closed, agent.closed]).then(() => {}),
    close(error?: unknown): void {
      client.close(error);
      agent.close(error);
    },
  };
}

/**
 * Runs one side's handler chain one message at a time, in arrival order.
 *
 * The underlying `Connection` dispatches each incoming message as its own
 * async task, which would let chains with slow handlers overtake each other.
 * The Rust SDK guarantees sequential dispatch, so the proxy provides the
 * same: the next message is not dispatched until the previous chain settles.
 * A handler that throws fails only its own message (the connection converts
 * the error to a response or log line); the queue continues.
 */
function serialDispatch(handlers: JsonRpcHandler[]): JsonRpcHandler {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    handleMessage(message, cx) {
      const result = queue.then(async (): Promise<HandleResult> => {
        let current = message;
        for (const handler of handlers) {
          const outcome =
            (await handler.handleMessage(current, cx)) ?? Handled.yes();
          if (outcome.handled) {
            return Handled.yes();
          }
          current = outcome.message ?? current;
        }

        // Unreachable: the forwarder at the end of the chain always handles.
        return Handled.yes();
      });
      queue = result.catch(() => {});
      return result;
    },
    describe: () => "proxy:serial-dispatch",
  };
}

/**
 * Terminal handler for one proxy side: re-issues the incoming message on the
 * opposite connection and relays the response back. The two connections
 * reference each other, so the target is resolved lazily.
 *
 * Requests are forwarded split-phase: the outgoing request is sent
 * synchronously (preserving send order), the response continuation is
 * registered, and the dispatch queue is released immediately so the round
 * trip never blocks later messages.
 */
function forwardTo(target: () => Connection): JsonRpcHandler {
  return {
    handleMessage(message) {
      if (message.kind !== "request") {
        return target()
          .sendNotification(message.method, message.params)
          .then(() => Handled.yes());
      }

      const { responder } = message;
      target()
        .sendRequest(message.method, message.params, undefined, {
          cancellationSignal: message.signal,
        })
        .then(
          (result) => responder.respond(result),
          (error) => responder.respondWithResult(errorToResult(error)),
        )
        // The response cannot be delivered when the caller's side is already
        // closed; there is nowhere left to report it.
        .catch(() => {});
      return Handled.yes();
    },
    describe: () => "proxy:forward",
  };
}
