import { Connection, Handled } from "./jsonrpc.js";
import type { JsonRpcHandler } from "./jsonrpc.js";
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
  clientToAgent?: JsonRpcHandler[];
  /**
   * Handlers run on messages arriving from the agent, in order, before the
   * proxy forwards them to the client. Same contract as `clientToAgent`.
   */
  agentToClient?: JsonRpcHandler[];
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
 * Messages can be observed, rewritten, answered, or dropped before they are
 * forwarded by passing `clientToAgent` / `agentToClient` handlers; see
 * {@link ProxyOptions}.
 *
 * This mirrors the Rust SDK's `Proxy` role: unhandled messages forward by
 * default, and handlers intercept traffic from an explicit peer. The
 * `_proxy/successor` envelope protocol used by the Rust conductor to chain
 * proxy processes over a single pipe is not needed here — this proxy owns a
 * real stream per side, so proxies chain by connecting one proxy's agent
 * stream to the next proxy's client stream.
 */
export function proxy(options: ProxyOptions): ProxyHandle {
  // Each side's handler chain ends in a forwarder that re-issues the message
  // on the opposite connection. The connections reference each other, so the
  // forwarders resolve their target lazily.
  const forwardTo = (target: () => Connection): JsonRpcHandler => ({
    handleMessage: async (message) => {
      if (message.kind === "request") {
        const result = await target().sendRequest(
          message.method,
          message.params,
          undefined,
          { cancellationSignal: message.signal },
        );
        await message.responder.respond(result);
      } else {
        await target().sendNotification(message.method, message.params);
      }

      return Handled.yes();
    },
    describe: () => "proxy:forward",
  });

  const client: Connection = new Connection(options.client, [
    ...(options.clientToAgent ?? []),
    forwardTo(() => agent),
  ]);
  const agent: Connection = new Connection(options.agent, [
    ...(options.agentToClient ?? []),
    forwardTo(() => client),
  ]);

  // When either side closes, close the other with the same reason so its
  // pending requests reject with the true cause.
  void client.closed.then(() => agent.close(client.signal.reason));
  void agent.closed.then(() => client.close(agent.signal.reason));

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
