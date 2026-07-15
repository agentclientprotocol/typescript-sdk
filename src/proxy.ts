import { Connection, Handled, linkClosed, parseParams } from "./jsonrpc.js";
import type {
  HandleResult,
  IncomingMessage,
  IncomingNotification,
  IncomingRequest,
  JsonRpcHandler,
  MaybePromise,
  ParamsParser,
} from "./jsonrpc.js";
import type { Stream } from "./stream.js";
import type {
  AgentNotificationParamsByMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ClientNotificationParamsByMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "./acp.js";

/**
 * Context passed to a typed proxy request handler.
 */
export type ProxyRequestContext<Params, Response> = {
  /**
   * Method name of the intercepted request.
   */
  method: string;
  /**
   * Request params as received on the wire.
   *
   * Built-in method literals type the params for convenience, but the proxy
   * does not validate or normalize them — schema validation happens at the
   * destination app, and a proxy that re-parsed params would strip unknown
   * extension fields from traffic it relays. Register with a parser when you
   * want runtime validation.
   */
  params: Params;
  /**
   * Aborts when the caller cancels this request or the connection closes.
   */
  signal: AbortSignal;
  /**
   * Forwards the request to the other side and resolves with its response.
   *
   * Pass the received params to forward unchanged, or a modified copy to
   * rewrite the request in flight. Cancellation by the original caller is
   * propagated automatically.
   */
  forward(params: Params): Promise<Response>;
};

/**
 * Typed proxy request handler.
 *
 * The caller is waiting on a response, so the handler must produce one:
 * return `forward(params)`'s result (unchanged or modified) to relay the
 * request, return your own response without calling `forward` to answer in
 * the proxy, or throw a `RequestError` to reject with a specific JSON-RPC
 * error. Unlike notifications, a request can never be silently dropped.
 */
export type ProxyRequestHandler<Params, Response> = (
  context: ProxyRequestContext<Params, Response>,
) => MaybePromise<Response>;

/**
 * Context passed to a typed proxy notification handler.
 */
export type ProxyNotificationContext<Params> = {
  /**
   * Method name of the intercepted notification.
   */
  method: string;
  /**
   * Notification params as received on the wire (see
   * {@link ProxyRequestContext.params} on validation).
   */
  params: Params;
  /**
   * Forwards the notification to the other side.
   */
  forward(params: Params): Promise<void>;
};

/**
 * Typed proxy notification handler.
 *
 * Call `forward(params)` to deliver the notification to the other side,
 * unchanged or rewritten. Returning without calling `forward` drops the
 * notification: it is never delivered, and — as with any JSON-RPC
 * notification — neither side is told, which makes skipping `forward` the
 * intentional way to filter traffic.
 */
export type ProxyNotificationHandler<Params> = (
  context: ProxyNotificationContext<Params>,
) => MaybePromise<void>;

/**
 * Handler with its context type erased for storage; dispatch restores the
 * matching context shape per registration kind.
 */
type ErasedHandler = (context: never) => MaybePromise<unknown>;

type Registration = {
  params?: ParamsParser<unknown>;
  handler: ErasedHandler;
};

/**
 * Registration surface for one side of a proxy.
 *
 * `proxy().client` registers handlers for traffic arriving from the client
 * (agent-bound methods such as `session/prompt`); `proxy().agent` registers
 * handlers for traffic arriving from the agent (client-bound methods such as
 * `session/request_permission`). The type parameters select the matching
 * ByMethod maps so built-in method literals infer their params and response
 * types, mirroring `agent(...)`/`client(...)` registration.
 *
 * Handlers claim their method: at most one typed handler runs per message.
 * Register `"*"` to catch traffic no exact registration claims
 * (most-specific wins); anything still unclaimed is forwarded untouched.
 *
 * Each `connect(...)` snapshots the registrations, exactly like the
 * `agent(...)`/`client(...)` builders: registering afterwards is allowed but
 * applies only to subsequent connects, never to already-connected proxies.
 * For behavior that changes mid-session, keep the changing state in your
 * handler's closure instead of changing the registrations.
 */
export class ProxySideBuilder<
  RequestParams extends Record<string, unknown>,
  RequestResponses extends Record<string, unknown>,
  NotificationParams extends Record<string, unknown>,
> {
  private readonly requests = new Map<string, Registration>();
  private readonly notifications = new Map<string, Registration>();

  /**
   * Registers a typed handler for requests arriving from this side's peer.
   *
   * Built-in method literals infer their params and response types from
   * `method`. Pass a parser as the second argument for custom extension
   * methods or to opt into runtime validation. Register `"*"` to catch any
   * request no exact registration claims.
   */
  onRequest<Method extends keyof RequestParams & string>(
    method: Method,
    handler: ProxyRequestHandler<
      RequestParams[Method],
      Method extends keyof RequestResponses ? RequestResponses[Method] : never
    >,
  ): this;
  onRequest(method: "*", handler: ProxyRequestHandler<unknown, unknown>): this;
  onRequest<Params, Response>(
    method: string,
    params: ParamsParser<Params>,
    handler: ProxyRequestHandler<Params, Response>,
  ): this;
  onRequest(
    method: string,
    handlerOrParams: ErasedHandler | ParamsParser<unknown>,
    handler?: ErasedHandler,
  ): this {
    this.register(this.requests, "request", method, handlerOrParams, handler);
    return this;
  }

  /**
   * Registers a typed handler for notifications arriving from this side's
   * peer. Same registration forms as `onRequest`.
   */
  onNotification<Method extends keyof NotificationParams & string>(
    method: Method,
    handler: ProxyNotificationHandler<NotificationParams[Method]>,
  ): this;
  onNotification(method: "*", handler: ProxyNotificationHandler<unknown>): this;
  onNotification<Params>(
    method: string,
    params: ParamsParser<Params>,
    handler: ProxyNotificationHandler<Params>,
  ): this;
  onNotification(
    method: string,
    handlerOrParams: ErasedHandler | ParamsParser<unknown>,
    handler?: ErasedHandler,
  ): this {
    this.register(
      this.notifications,
      "notification",
      method,
      handlerOrParams,
      handler,
    );
    return this;
  }

  private register(
    table: Map<string, Registration>,
    kind: "request" | "notification",
    method: string,
    handlerOrParams: ErasedHandler | ParamsParser<unknown>,
    handler?: ErasedHandler,
  ): void {
    if (table.has(method)) {
      throw new Error(`Proxy ${kind} handler already registered: ${method}`);
    }

    if (handler) {
      table.set(method, {
        params: handlerOrParams as ParamsParser<unknown>,
        handler,
      });
      return;
    }

    table.set(method, { handler: handlerOrParams as ErasedHandler });
  }

  /** @internal */
  buildHandler(target: () => Connection): JsonRpcHandler {
    // Snapshot so registrations made after connect(...) apply only to
    // subsequent connects — the same semantics as the fluent app builders.
    return serialize(
      dispatcher(new Map(this.requests), new Map(this.notifications), target),
    );
  }
}

/**
 * The wildcard-only view of a proxy side — what a side-agnostic tap
 * (logger, metrics, authorization gate) needs. Both `proxy().client` and
 * `proxy().agent` are assignable to it.
 */
export type ProxyTap = {
  onRequest(
    method: "*",
    handler: ProxyRequestHandler<unknown, unknown>,
  ): ProxyTap;
  onNotification(
    method: "*",
    handler: ProxyNotificationHandler<unknown>,
  ): ProxyTap;
};

/**
 * Streams accepted by `ProxyBuilder.connect(...)`.
 */
export type ProxyStreams = {
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
};

/**
 * One side of a running proxy.
 */
export type ProxySideConnection = {
  /**
   * Promise that resolves when this side's connection closes.
   */
  readonly closed: Promise<void>;
  /**
   * Closes this side. The other side is closed with the same reason.
   */
  close(error?: unknown): void;
};

/**
 * Handle to a running proxy returned by `ProxyBuilder.connect(...)`.
 */
export type ProxyHandle = {
  /**
   * The side facing the client stream.
   */
  readonly client: ProxySideConnection;
  /**
   * The side facing the agent stream.
   */
  readonly agent: ProxySideConnection;
  /**
   * Promise that resolves once both sides of the proxy have closed. Either
   * side closing (for example the client stream ending) closes the other,
   * propagating the close reason to its pending requests.
   */
  readonly closed: Promise<void>;
  /**
   * Closes both sides of the proxy and rejects pending requests.
   */
  close(error?: unknown): void;
};

/**
 * Builder for an ACP proxy between a client stream and an agent stream.
 *
 * Register handlers on `client` (traffic from the client) and `agent`
 * (traffic from the agent), then call `connect(...)`.
 */
export class ProxyBuilder {
  /**
   * Registration surface for traffic arriving from the client — agent-bound
   * methods, typed by the agent request/notification maps.
   */
  readonly client = new ProxySideBuilder<
    AgentRequestParamsByMethod,
    AgentRequestResponsesByMethod,
    AgentNotificationParamsByMethod
  >();

  /**
   * Registration surface for traffic arriving from the agent — client-bound
   * methods, typed by the client request/notification maps.
   */
  readonly agent = new ProxySideBuilder<
    ClientRequestParamsByMethod,
    ClientRequestResponsesByMethod,
    ClientNotificationParamsByMethod
  >();

  /**
   * Connects the proxy between the two streams and starts relaying.
   */
  connect(streams: ProxyStreams): ProxyHandle {
    const client: Connection = new Connection(streams.client, [
      this.client.buildHandler(() => agent),
    ]);
    const agent: Connection = new Connection(streams.agent, [
      this.agent.buildHandler(() => client),
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
}

/**
 * Creates an ACP proxy builder.
 *
 * A proxy sits between a client and an agent, intercepting messages in both
 * directions. The proxy terminates the protocol on both sides: each side is
 * a full JSON-RPC connection, so forwarded requests are re-issued with the
 * proxy's own request ids and their responses are correlated back to the
 * original caller automatically. Client-initiated requests such as
 * `session/prompt` flow toward the agent, and agent-initiated requests such
 * as `session/request_permission` flow toward the client. The design
 * matches the `Proxy` role in ACP's other SDKs.
 *
 * Messages that no handler claims are forwarded untouched, preserving the
 * observable protocol behavior of a direct connection:
 *
 * - Error responses pass through with their original code, message, and data.
 * - `$/cancel_request` from the original caller is propagated to the side
 *   handling the request, and the eventual response (which may be a normal
 *   result) still settles the original request.
 * - When either side closes, the other side is closed and its pending
 *   requests are rejected.
 *
 * Each side processes messages one at a time in arrival order: the next
 * message is not dispatched until the previous handler completes. Request
 * handlers release the loop as soon as they forward (or settle without
 * forwarding) rather than holding it across the round trip, so a pending
 * request never blocks later messages such as `session/cancel`.
 *
 * Proxies chain by connecting one proxy's agent stream to the next proxy's
 * client stream.
 *
 * @example
 * ```ts
 * const p = proxy();
 * p.client.onRequest("session/prompt", async ({ params, forward }) => {
 *   audit(params);
 *   return forward(params);
 * });
 * p.agent.onNotification("session/update", async ({ params, forward }) => {
 *   if (!redacted(params)) await forward(params);
 * });
 * const handle = p.connect({ client: clientStream, agent: agentStream });
 * ```
 */
export function proxy(): ProxyBuilder {
  return new ProxyBuilder();
}

/**
 * Builds the dispatch function for one proxy side.
 *
 * Each message runs the most specific registration — exact method, then
 * `"*"` — or, unclaimed, is forwarded untouched on a fully synchronous fast
 * path (the send is enqueued in arrival order and the loop is never held).
 *
 * Request registrations run detached from the dispatch loop once they
 * forward or settle: the loop resumes when the request has been sent (or
 * answered), not when the handler finishes waiting on the round trip, so a
 * pending request never blocks later messages. Notification registrations
 * hold the loop until the handler settles, which is what preserves
 * delivery ordering across async handlers.
 */
function dispatcher(
  requests: Map<string, Registration>,
  notifications: Map<string, Registration>,
  target: () => Connection,
): (message: IncomingMessage) => MaybePromise<HandleResult> {
  const runRequest = (
    message: IncomingRequest,
    registration: Registration,
  ): MaybePromise<HandleResult> => {
    const { responder } = message;
    let released = false;
    let resolveReleased: (() => void) | undefined;
    const release = () => {
      released = true;
      resolveReleased?.();
    };
    const run = registration.handler as (
      context: ProxyRequestContext<unknown, unknown>,
    ) => MaybePromise<unknown>;

    void (async () => {
      try {
        const response = await run({
          method: message.method,
          params: parseParams(registration.params, message.params),
          signal: message.signal,
          forward: (params: unknown) => {
            const sent = target().sendRequest(
              message.method,
              params,
              undefined,
              { cancellationSignal: message.signal },
            );
            release();
            return sent;
          },
        });
        await responder.respond(response ?? null);
      } catch (error) {
        await responder.respondWithThrown(error).catch(() => {});
      } finally {
        release();
      }
    })();

    // A handler that forwards before its first await has already released;
    // skip the promise entirely so the loop continues on the same tick.
    if (released) {
      return Handled.yes();
    }

    return new Promise((resolve) => {
      resolveReleased = () => resolve(Handled.yes());
    });
  };

  const runNotification = async (
    message: IncomingNotification,
    registration: Registration,
  ): Promise<HandleResult> => {
    const run = registration.handler as (
      context: ProxyNotificationContext<unknown>,
    ) => MaybePromise<unknown>;
    await run({
      method: message.method,
      params: parseParams(registration.params, message.params),
      forward: (params: unknown) =>
        target().sendNotification(message.method, params),
    });
    return Handled.yes();
  };

  return (message) => {
    const table = message.kind === "request" ? requests : notifications;
    // Most-specific wins: an exact method registration beats "*", and "*"
    // catches only otherwise-unclaimed traffic.
    const registration = table.get(message.method) ?? table.get("*");

    if (!registration) {
      // Pass-through: the send is enqueued synchronously (so send order is
      // arrival order) and the loop is never held.
      if (message.kind === "request") {
        const { responder } = message;
        target()
          .sendRequest(message.method, message.params, undefined, {
            cancellationSignal: message.signal,
          })
          .then(
            (result) => responder.respond(result),
            (error) => responder.respondWithThrown(error),
          )
          // The response cannot be delivered when the caller's side is
          // already closed; there is nowhere left to report it.
          .catch(() => {});
      } else {
        // Write failures close the connection via the write queue; there is
        // no per-notification error to report.
        void target()
          .sendNotification(message.method, message.params)
          .catch(() => {});
      }

      return Handled.yes();
    }

    return message.kind === "request"
      ? runRequest(message, registration)
      : runNotification(message, registration);
  };
}

/**
 * Serializes one side's dispatch: messages run one at a time, in arrival
 * order. The underlying `Connection` dispatches each message as its own
 * async task, which would let slow handlers be overtaken. Synchronous
 * dispatches (pass-through traffic, handlers that forward immediately)
 * bypass the queue entirely; a rejected dispatch fails only its own
 * message.
 */
function serialize(
  dispatch: (message: IncomingMessage) => MaybePromise<HandleResult>,
): JsonRpcHandler {
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const track = (result: Promise<HandleResult>): Promise<HandleResult> => {
    pending++;
    tail = result.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return result;
  };

  return {
    handleMessage(message) {
      if (pending === 0) {
        const result = dispatch(message);
        return result instanceof Promise ? track(result) : result;
      }

      return track(tail.then(() => dispatch(message)));
    },
    describe: () => "proxy:dispatch",
  };
}
