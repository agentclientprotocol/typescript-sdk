import { Connection, Handled, errorToResult, linkClosed } from "./jsonrpc.js";
import type {
  HandleResult,
  IncomingNotification,
  IncomingRequest,
  JsonRpcHandler,
  MaybePromise,
} from "./jsonrpc.js";
import type { Stream } from "./stream.js";
import type {
  AgentNotificationParamsByMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ClientNotificationParamsByMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ParamsParser,
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

type Registration = {
  parse?: (params: unknown) => unknown;
  handler: (context: never) => MaybePromise<unknown>;
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

  /** @internal */
  constructor() {}

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
    handlerOrParams:
      ((context: never) => MaybePromise<unknown>) | ParamsParser<unknown>,
    handler?: (context: never) => MaybePromise<unknown>,
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
    handlerOrParams:
      ((context: never) => MaybePromise<unknown>) | ParamsParser<unknown>,
    handler?: (context: never) => MaybePromise<unknown>,
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
    handlerOrParams: object | ((context: never) => MaybePromise<unknown>),
    handler?: (context: never) => MaybePromise<unknown>,
  ): void {
    if (table.has(method)) {
      throw new Error(`Proxy ${kind} handler already registered: ${method}`);
    }

    if (handler) {
      const parser = handlerOrParams as ParamsParser<unknown>;
      const parse =
        typeof parser === "function" ? parser : parser.parse.bind(parser);
      table.set(method, { parse, handler });
      return;
    }

    table.set(method, {
      handler: handlerOrParams as (context: never) => MaybePromise<unknown>,
    });
  }

  /** @internal */
  buildChain(target: () => Connection): JsonRpcHandler[] {
    // Snapshot so registrations made after connect(...) apply only to
    // subsequent connects — the same semantics as the fluent app builders.
    return [
      typedDispatch(
        new Map(this.requests),
        new Map(this.notifications),
        target,
      ),
      forwardTo(target),
    ];
  }
}

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
      serialDispatch(this.client.buildChain(() => agent)),
    ]);
    const agent: Connection = new Connection(streams.agent, [
      serialDispatch(this.agent.buildChain(() => client)),
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
 * directions — this mirrors the Rust SDK's `Proxy` role. The proxy
 * terminates the protocol on both sides: each side is a full JSON-RPC
 * connection, so forwarded requests are re-issued with the proxy's own
 * request ids and their responses are correlated back to the original
 * caller automatically. Client-initiated requests such as `session/prompt`
 * flow toward the agent, and agent-initiated requests such as
 * `session/request_permission` flow toward the client.
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
 * Each side processes messages one at a time in arrival order, matching the
 * Rust SDK's dispatch loop: the next message is not dispatched until the
 * previous handler completes. Request handlers release the loop as soon as
 * they forward (or settle without forwarding) rather than holding it across
 * the round trip — the Rust `forward_response_to` pattern — so a pending
 * request never blocks later messages such as `session/cancel`.
 *
 * The `_proxy/successor` envelope protocol used by the Rust conductor to
 * chain proxy processes over a single pipe is not needed here — this proxy
 * owns a real stream per side, so proxies chain by connecting one proxy's
 * agent stream to the next proxy's client stream.
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
 * Chain handler dispatching typed registrations and the fallback.
 *
 * Unregistered traffic returns `Handled.no` so the terminal forwarder
 * relays it untouched. Request handlers run detached from the dispatch
 * queue once they forward: the returned promise resolves when the request
 * has been forwarded or answered — not when the handler finishes waiting on
 * the round trip — so the loop keeps its ordering guarantee without a
 * pending request blocking later messages.
 */
function typedDispatch(
  requests: Map<string, Registration>,
  notifications: Map<string, Registration>,
  target: () => Connection,
): JsonRpcHandler {
  const runRequest = (
    message: IncomingRequest,
    run: (
      context: ProxyRequestContext<unknown, unknown>,
    ) => MaybePromise<unknown>,
    parse?: (params: unknown) => unknown,
  ): Promise<HandleResult> => {
    const released = Promise.withResolvers<void>();
    void (async () => {
      try {
        const response = await run({
          method: message.method,
          params: parse ? parse(message.params) : message.params,
          signal: message.signal,
          forward: (params: unknown) => {
            const sent = target().sendRequest(
              message.method,
              params,
              undefined,
              { cancellationSignal: message.signal },
            );
            released.resolve();
            return sent;
          },
        });
        await message.responder.respond(response ?? null);
      } catch (error) {
        await message.responder
          .respondWithResult(errorToResult(error))
          .catch(() => {});
      } finally {
        released.resolve();
      }
    })();
    return released.promise.then(() => Handled.yes());
  };

  const runNotification = async (
    message: IncomingNotification,
    run: (context: ProxyNotificationContext<unknown>) => MaybePromise<unknown>,
    parse?: (params: unknown) => unknown,
  ): Promise<HandleResult> => {
    await run({
      method: message.method,
      params: parse ? parse(message.params) : message.params,
      forward: (params: unknown) =>
        target().sendNotification(message.method, params),
    });
    return Handled.yes();
  };

  return {
    handleMessage(message) {
      const table = message.kind === "request" ? requests : notifications;
      // Most-specific wins: an exact method registration beats "*", and "*"
      // catches only otherwise-unclaimed traffic.
      const registration = table.get(message.method) ?? table.get("*");
      if (!registration) {
        return Handled.no(message);
      }

      const run = registration.handler as (
        context: unknown,
      ) => MaybePromise<unknown>;
      return message.kind === "request"
        ? runRequest(message, run, registration.parse)
        : runNotification(message, run, registration.parse);
    },
    describe: () => "proxy:typed-dispatch",
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
