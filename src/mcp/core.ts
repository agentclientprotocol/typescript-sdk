import { connectionContextOf } from "../core/connection-access.js";
import type { HasConnectionContext } from "../core/connection-access.js";
import { RequestError } from "../core/jsonrpc.js";
import type { ConnectionContext, MaybePromise } from "../core/jsonrpc.js";

/**
 * ACP method that carries MCP requests and request-scoped notifications.
 */
export const MCP_MESSAGE_METHOD = "mcp/message";

/**
 * The only MCP revision this binding supports.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * Inner MCP `_meta` key carrying the request's MCP protocol version.
 */
export const MCP_META_PROTOCOL_VERSION =
  "io.modelcontextprotocol/protocolVersion";

/**
 * Inner MCP `_meta` key carrying the caller's MCP client capabilities.
 */
export const MCP_META_CLIENT_CAPABILITIES =
  "io.modelcontextprotocol/clientCapabilities";

/**
 * Inner MCP `_meta` key carrying the caller's MCP client info.
 */
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

/**
 * Outer ACP error codes reserved for failures of the MCP-over-ACP binding.
 *
 * These are never inner MCP error codes. An inner MCP error travels inside a
 * successful ACP response's `error` carrier instead.
 */
export const McpBindingErrorCode = {
  /** Malformed envelope, or a duplicate active `(serverId, requestId)`. */
  invalidParams: -32602,
  /** The ACP operation was cancelled. */
  requestCancelled: -32800,
  /** A binding resource limit was exceeded. */
  resourceLimitExceeded: -33000,
  /** No registration is available for the requested server ID. */
  serverUnavailable: -33001,
  /** The backend or transport failed without a valid MCP outcome. */
  backendFailed: -33002,
} as const;

/**
 * An inner MCP error object.
 *
 * Its code is an MCP code and must never be interpreted as an ACP error code.
 */
export type McpErrorObject = {
  code: number;
  message: string;
  data?: unknown;
  [key: string]: unknown;
};

/**
 * The single inner MCP outcome carried by a successful `mcp/message` response.
 *
 * Exactly one of `result` or `error` is present. `result` may be any JSON
 * value, including `null`.
 */
export type McpOutcome =
  | { result: unknown; _meta?: Record<string, unknown> | null }
  | { error: McpErrorObject; _meta?: Record<string, unknown> | null };

/**
 * A request-scoped MCP notification received for an in-flight request.
 */
export type McpNotification = {
  /** Inner MCP notification method, such as `notifications/progress`. */
  method: string;
  /** Inner MCP notification params, if any. */
  params?: Record<string, unknown> | null;
  /** Optional outer ACP metadata from the envelope. */
  _meta?: Record<string, unknown> | null;
};

/**
 * MCP client identity sent in each request's inner `_meta`.
 */
export type McpClientInfo = {
  name: string;
  version: string;
  [key: string]: unknown;
};

/**
 * Defaults used by an MCP-over-ACP caller.
 */
export type McpCallerOptions = {
  /**
   * MCP client capabilities included in every request whose params do not
   * already supply them. Defaults to `{}`.
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * MCP client info included in every request whose params do not already
   * supply it.
   */
  clientInfo?: McpClientInfo;
};

/**
 * Options for a single MCP-over-ACP request.
 */
export type McpRequestOptions = {
  /**
   * Logical MCP request ID. Defaults to a fresh random ID. Never reuse an ID
   * that is still active for the same server on this connection.
   */
  requestId?: string;
  /**
   * Aborting this signal sends `$/cancel_request` for the outer ACP request.
   * Cancellation is best effort: the provider may still return a result.
   */
  signal?: AbortSignal;
  /**
   * Receives MCP notifications belonging to this request, such as progress
   * or subscription events. Notifications that arrive after the request
   * settles are dropped.
   */
  onNotification?: (notification: McpNotification) => void;
  /**
   * Optional outer ACP metadata for the `mcp/message` envelope. This is
   * separate from the inner MCP `_meta` inside `params`.
   */
  _meta?: Record<string, unknown>;
};

/**
 * Context passed to an MCP-over-ACP server handler for one operation.
 */
export type McpRequestContext = {
  /** The declared server receiving this request. */
  serverId: string;
  /** The caller's logical MCP request ID, also the inner JSON-RPC ID. */
  requestId: string;
  /** Inner MCP method, such as `tools/call` or `server/discover`. */
  method: string;
  /** Inner MCP params. `null` and omission are both `undefined`. */
  params: Record<string, unknown> | undefined;
  /** MCP protocol version from the inner `_meta`. */
  protocolVersion: string;
  /** MCP client capabilities from the inner `_meta`. */
  clientCapabilities: Record<string, unknown>;
  /** MCP client info from the inner `_meta`, if supplied. */
  clientInfo: unknown;
  /** Optional outer ACP metadata from the envelope. */
  envelopeMeta: Record<string, unknown> | undefined;
  /**
   * Aborts when the caller cancels this request, the server registration is
   * disposed, or the ACP connection closes.
   */
  signal: AbortSignal;
  /**
   * Sends an MCP notification scoped to this request. Notifications sent
   * after the request has completed are dropped.
   */
  notify(
    method: string,
    params?: Record<string, unknown> | null,
  ): Promise<void>;
};

/**
 * Handles one MCP request for a registered server.
 *
 * Return the MCP outcome. Throw an {@link McpProtocolError} to answer with an
 * inner MCP error. Any other thrown error, including a `RequestError`, is
 * reported as an outer binding failure (`-33002`), or as `-32800` when the
 * request was cancelled.
 */
export type McpRequestHandler = (
  context: McpRequestContext,
) => MaybePromise<McpOutcome>;

/**
 * Options for registering an MCP server on an ACP connection.
 */
export type McpServerOptions = {
  /** Human-readable server name used in the ACP declaration. */
  name: string;
  /** Handles MCP requests addressed to this server. */
  handler: McpRequestHandler;
  /**
   * Opaque server ID. Defaults to a fresh random ID. An ID can be registered
   * at most once per ACP connection, even after it is disposed.
   */
  serverId?: string;
  /**
   * Maximum concurrently active requests for this server. Requests over the
   * limit fail with `-33000`. Defaults to 64.
   */
  maxActiveRequests?: number;
};

/**
 * ACP declaration for an MCP server provided over the ACP connection.
 *
 * Pass it in `mcpServers` when creating or loading a session.
 */
export type McpServerAcpDeclaration = {
  type: "acp";
  name: string;
  serverId: string;
};

/**
 * Whether a session's `mcpServers` entry is a server provided over ACP.
 */
export function isMcpServerAcp(
  server: unknown,
): server is McpServerAcpDeclaration {
  return (
    isJsonObject(server) &&
    server.type === "acp" &&
    typeof server.name === "string" &&
    typeof server.serverId === "string"
  );
}

/**
 * An inner MCP protocol error thrown by an MCP-over-ACP server handler.
 *
 * It is returned in the response's `error` carrier rather than as an outer
 * ACP error.
 */
export class McpProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }

  /** Converts this error to an inner MCP error object. */
  toMcpError(): McpErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

function generateId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function routeKey(serverId: string, requestId: string): string {
  return JSON.stringify([serverId, requestId]);
}

/** Like `isRecord` from the JSON-RPC core, but rejects arrays. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalObject(
  value: unknown,
): Record<string, unknown> | undefined | false {
  if (value === undefined || value === null) return undefined;
  return isJsonObject(value) ? value : false;
}

type Envelope = {
  serverId: string;
  requestId: string;
  method: string;
  params: Record<string, unknown> | undefined;
  meta: Record<string, unknown> | undefined;
};

function envelopeOf(params: McpMessageParams): Envelope {
  return {
    serverId: params.serverId,
    requestId: params.requestId,
    method: params.method,
    params: params.params ?? undefined,
    meta: params._meta ?? undefined,
  };
}

function isMcpErrorObject(value: unknown): value is McpErrorObject {
  return (
    isJsonObject(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

/**
 * Validates an outcome before it is sent: exactly one of a defined `result`
 * or a valid `error`, as the binding requires of senders.
 */
function validOutgoingOutcome(outcome: unknown): McpOutcome | undefined {
  if (!isJsonObject(outcome)) return undefined;
  const hasResult = Object.hasOwn(outcome, "result");
  const hasError = Object.hasOwn(outcome, "error");
  if (hasResult === hasError) return undefined;
  if (hasResult && outcome.result === undefined) return undefined;
  if (hasError && !isMcpErrorObject(outcome.error)) return undefined;
  return parseMcpOutcome(outcome);
}

/**
 * Parses a received `mcp/message` response carrier.
 *
 * Returns `undefined` if the value is not a valid carrier. When both `result`
 * and `error` are present, `result` wins.
 */
export function parseMcpOutcome(value: unknown): McpOutcome | undefined {
  if (!isJsonObject(value)) return undefined;
  const meta = optionalObject(value._meta);
  const carrierMeta =
    meta === false || meta === undefined ? {} : { _meta: meta };
  if (Object.hasOwn(value, "result")) {
    return { result: value.result, ...carrierMeta };
  }
  if (isMcpErrorObject(value.error)) {
    return { error: value.error, ...carrierMeta };
  }
  return undefined;
}

/**
 * Adds the per-request MCP metadata required by MCP 2026-07-28, without
 * overriding values the caller already supplied.
 */
export function withMcpRequestMeta(
  params: Record<string, unknown> | null | undefined,
  options: McpCallerOptions = {},
): Record<string, unknown> {
  const base = params ?? {};
  const existing = optionalObject(base._meta);
  const meta: Record<string, unknown> = { ...(existing || {}) };
  if (!Object.hasOwn(meta, MCP_META_PROTOCOL_VERSION)) {
    meta[MCP_META_PROTOCOL_VERSION] = MCP_PROTOCOL_VERSION;
  }
  if (!Object.hasOwn(meta, MCP_META_CLIENT_CAPABILITIES)) {
    meta[MCP_META_CLIENT_CAPABILITIES] = options.clientCapabilities ?? {};
  }
  if (options.clientInfo && !Object.hasOwn(meta, MCP_META_CLIENT_INFO)) {
    meta[MCP_META_CLIENT_INFO] = options.clientInfo;
  }
  return { ...base, _meta: meta };
}

/**
 * Wire params of an `mcp/message` request or notification.
 */
export type McpMessageParams = {
  serverId: string;
  requestId: string;
  method: string;
  params?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
};

/**
 * The parts of an incoming `mcp/message` request context that
 * {@link McpOverAcpProvider.handleRequest} uses. ACP v1 and v2
 * `ClientRequestContext` values both satisfy it.
 */
export type McpMessageRequestContext = {
  params: McpMessageParams;
  signal: AbortSignal;
  agent: HasConnectionContext;
};

/**
 * The parts of an incoming `mcp/message` notification context that
 * {@link McpOverAcpCaller.handleNotification} uses. ACP v1 and v2
 * `AgentNotificationContext` values both satisfy it.
 */
export type McpMessageNotificationContext = {
  params: McpMessageParams;
  client: HasConnectionContext;
};

function connectionOf(context: HasConnectionContext): ConnectionContext {
  return context[connectionContextOf]();
}

/**
 * Per-connection state, dropped when the connection is garbage collected.
 */
class ConnectionState<T> {
  private readonly states = new WeakMap<ConnectionContext, T>();

  constructor(private readonly create: () => T) {}

  get(cx: ConnectionContext): T {
    let state = this.states.get(cx);
    if (!state) {
      state = this.create();
      this.states.set(cx, state);
    }
    return state;
  }

  peek(cx: ConnectionContext): T | undefined {
    return this.states.get(cx);
  }
}

type ActiveOperation = {
  settled: Promise<unknown>;
};

type ServerEntry = {
  serverId: string;
  handler: McpRequestHandler;
  maxActiveRequests: number;
  active: Map<string, ActiveOperation>;
  controller: AbortController;
};

type ProviderConnection = {
  servers: Map<string, ServerEntry>;
  /** Server IDs ever registered on this connection; never rebound. */
  usedIds: Set<string>;
};

/**
 * Serves MCP servers to an ACP peer over `mcp/message`.
 *
 * Create one provider per app, register {@link handleRequest} for
 * `mcp/message` requests, then register servers on each connection:
 *
 * ```ts
 * const mcp = new McpOverAcpProvider();
 * const app = client().onRequest(methods.client.mcp.message, mcp.handleRequest);
 * const connection = app.connect(stream);
 * const tools = mcp.registerServer(connection.agent, { name: "tools", handler });
 * await connection.agent.buildSession(cwd).withMcpServer(tools.declaration).start();
 * ```
 *
 * Several servers can be registered on the same connection; requests are
 * dispatched by `serverId`.
 */
export class McpOverAcpProvider {
  private readonly connections = new ConnectionState<ProviderConnection>(
    () => ({ servers: new Map(), usedIds: new Set() }),
  );

  /**
   * Registers an MCP server on the connection behind `context`.
   *
   * The server is ready to serve requests as soon as this returns, so publish
   * its {@link McpServerRegistration.declaration} only afterwards.
   */
  registerServer(
    context: HasConnectionContext,
    options: McpServerOptions,
  ): McpServerRegistration {
    const connection = this.connections.get(connectionOf(context));
    const serverId = options.serverId ?? generateId(options.name);
    if (connection.usedIds.has(serverId)) {
      throw new Error(
        `MCP server ID ${serverId} was already registered on this connection`,
      );
    }
    const maxActiveRequests = options.maxActiveRequests ?? 64;
    if (!Number.isInteger(maxActiveRequests) || maxActiveRequests < 1) {
      throw new RangeError("maxActiveRequests must be a positive integer");
    }
    connection.usedIds.add(serverId);
    const entry: ServerEntry = {
      serverId,
      handler: options.handler,
      maxActiveRequests,
      active: new Map(),
      controller: new AbortController(),
    };
    connection.servers.set(serverId, entry);
    return new McpServerRegistration(options.name, serverId, async () => {
      if (connection.servers.get(serverId) !== entry) return;
      connection.servers.delete(serverId);
      entry.controller.abort(
        new Error(`MCP server ${serverId} registration was disposed`),
      );
      // Wait for cleanup only; each request reports its own failure.
      await Promise.allSettled(
        [...entry.active.values()].map((operation) => operation.settled),
      );
    });
  }

  /**
   * Handles an incoming `mcp/message` request. Register it with
   * `onRequest(methods.client.mcp.message, provider.handleRequest)`.
   *
   * Resolves with the inner MCP outcome. Binding failures reject with a
   * `RequestError` carrying the binding's outer error code.
   */
  readonly handleRequest = async (
    context: McpMessageRequestContext,
  ): Promise<McpOutcome> => {
    const envelope = envelopeOf(context.params);
    const server = this.connections
      .peek(connectionOf(context.agent))
      ?.servers.get(envelope.serverId);
    if (!server) {
      throw new RequestError(
        McpBindingErrorCode.serverUnavailable,
        "MCP server registration unavailable",
        { serverId: envelope.serverId },
      );
    }
    if (server.active.has(envelope.requestId)) {
      throw RequestError.invalidParams(
        { serverId: envelope.serverId, requestId: envelope.requestId },
        "duplicate active MCP request ID",
      );
    }
    if (server.active.size >= server.maxActiveRequests) {
      throw new RequestError(
        McpBindingErrorCode.resourceLimitExceeded,
        "MCP-over-ACP active request limit exceeded",
        { serverId: envelope.serverId },
      );
    }

    // Link caller cancellation and registration disposal for this request
    // only, so the long-lived registration signal keeps no per-request state.
    const controller = new AbortController();
    const abortFrom = (source: AbortSignal) => () =>
      controller.abort(source.reason);
    const onCancel = abortFrom(context.signal);
    const onDispose = abortFrom(server.controller.signal);
    if (context.signal.aborted) onCancel();
    context.signal.addEventListener("abort", onCancel, { once: true });
    server.controller.signal.addEventListener("abort", onDispose, {
      once: true,
    });

    let done = false;
    const settled = runServerHandler(
      server,
      envelope,
      connectionOf(context.agent),
      controller.signal,
      () => done,
    );
    server.active.set(envelope.requestId, { settled });
    try {
      return await settled;
    } catch (error) {
      throw toOuterError(error, controller.signal);
    } finally {
      // Stop forwarding notifications before the final response is sent.
      done = true;
      context.signal.removeEventListener("abort", onCancel);
      server.controller.signal.removeEventListener("abort", onDispose);
      server.active.delete(envelope.requestId);
    }
  };
}

async function runServerHandler(
  server: ServerEntry,
  envelope: Envelope,
  cx: ConnectionContext,
  signal: AbortSignal,
  isDone: () => boolean,
): Promise<McpOutcome> {
  // Yield so the operation is recorded as active before the handler starts.
  await Promise.resolve();
  const meta = optionalObject(envelope.params?._meta);
  const protocolVersion = meta ? meta[MCP_META_PROTOCOL_VERSION] : undefined;
  const clientCapabilities = meta
    ? meta[MCP_META_CLIENT_CAPABILITIES]
    : undefined;
  if (typeof protocolVersion !== "string") {
    return invalidMcpParams(
      `missing ${MCP_META_PROTOCOL_VERSION} in params._meta`,
    );
  }
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    return {
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: {
          supported: [MCP_PROTOCOL_VERSION],
          requested: protocolVersion,
        },
      },
    };
  }
  if (!isJsonObject(clientCapabilities)) {
    return invalidMcpParams(
      `missing ${MCP_META_CLIENT_CAPABILITIES} in params._meta`,
    );
  }
  if (signal.aborted) {
    // Work reported as cancelled before execution never starts.
    throw signal.reason;
  }

  const { serverId, requestId } = envelope;
  let outcome: McpOutcome;
  try {
    outcome = await server.handler({
      serverId,
      requestId,
      method: envelope.method,
      params: envelope.params,
      protocolVersion,
      clientCapabilities,
      clientInfo: meta ? meta[MCP_META_CLIENT_INFO] : undefined,
      envelopeMeta: envelope.meta,
      signal,
      async notify(method, params) {
        if (isDone()) return;
        await cx.sendNotification(MCP_MESSAGE_METHOD, {
          serverId,
          requestId,
          method,
          ...(params === undefined ? {} : { params }),
        });
      },
    });
  } catch (error) {
    if (!(error instanceof McpProtocolError)) throw error;
    outcome = { error: error.toMcpError() };
  }
  const valid = validOutgoingOutcome(outcome);
  if (!valid) {
    throw new BindingFailure(
      "MCP server handler produced an invalid outcome: expected exactly one of a defined `result` or an `error` with an integer `code` and string `message`",
    );
  }
  return valid;
}

/** A failure detected by the binding itself, reported as `-33002`. */
class BindingFailure extends Error {}

function invalidMcpParams(message: string): McpOutcome {
  return { error: { code: -32602, message: `Invalid params: ${message}` } };
}

function toOuterError(error: unknown, signal: AbortSignal): RequestError {
  if (
    signal.aborted ||
    (error instanceof RequestError &&
      error.code === McpBindingErrorCode.requestCancelled)
  ) {
    return RequestError.requestCancelled();
  }
  // Never let a handler's own ACP error pose as a binding error code.
  return new RequestError(
    McpBindingErrorCode.backendFailed,
    error instanceof BindingFailure
      ? error.message
      : "MCP server handler failed",
    error instanceof BindingFailure
      ? undefined
      : {
          details: error instanceof Error ? error.message : String(error),
          ...(error instanceof RequestError ? { code: error.code } : {}),
        },
  );
}

/**
 * A registered MCP server provided over an ACP connection.
 */
export class McpServerRegistration {
  /** @internal */
  constructor(
    /** Human-readable server name. */
    public readonly name: string,
    /** Opaque server ID, unique for the lifetime of the ACP connection. */
    public readonly serverId: string,
    private readonly release: () => Promise<void>,
  ) {}

  /** ACP declaration to include in a session's `mcpServers`. */
  get declaration(): McpServerAcpDeclaration {
    return { type: "acp", name: this.name, serverId: this.serverId };
  }

  /**
   * Removes the registration. Future requests fail with `-33001`; active
   * requests are cancelled, and the returned promise resolves once their
   * handlers have settled.
   */
  dispose(): Promise<void> {
    return this.release();
  }

  /** Supports explicit resource management with `await using`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

type NotificationListener = (notification: McpNotification) => void;

/**
 * Calls MCP servers that an ACP peer declared with `"type": "acp"`.
 *
 * Create one caller per app and register {@link handleNotification} for
 * `mcp/message` notifications so progress and subscription events reach the
 * request that owns them:
 *
 * ```ts
 * const mcp = new McpOverAcpCaller({ clientInfo: { name: "my-agent", version: "1" } });
 * agent()
 *   .onNotification(methods.agent.mcp.message, mcp.handleNotification)
 *   .onRequest(methods.agent.session.prompt, async ({ client }) => {
 *     const outcome = await mcp.request(client, serverId, "tools/call", { name, arguments: {} });
 *     // ...
 *   });
 * ```
 */
export class McpOverAcpCaller {
  private readonly connections = new ConnectionState<
    Map<string, NotificationListener>
  >(() => new Map());

  constructor(private readonly options: McpCallerOptions = {}) {}

  /**
   * Sends one MCP request to a declared server over the connection behind
   * `context`, and returns its inner outcome.
   *
   * Required MCP 2026-07-28 metadata is added to `params._meta` unless already
   * present. Outer ACP failures, including cancellation and binding errors,
   * reject with a `RequestError`; inner MCP errors resolve as `{ error }`.
   */
  async request(
    context: HasConnectionContext,
    serverId: string,
    method: string,
    params?: Record<string, unknown> | null,
    options: McpRequestOptions = {},
  ): Promise<McpOutcome> {
    const cx = connectionOf(context);
    const routes = this.connections.get(cx);
    const requestId = options.requestId ?? generateId("mcp-request");
    const key = routeKey(serverId, requestId);
    if (routes.has(key)) {
      throw new Error(
        `MCP request ${requestId} is already active for server ${serverId}`,
      );
    }
    routes.set(key, options.onNotification ?? (() => {}));
    try {
      const response = await cx.sendRequest<McpMessageParams, unknown>(
        MCP_MESSAGE_METHOD,
        {
          serverId,
          requestId,
          method,
          params: withMcpRequestMeta(params, this.options),
          ...(options._meta ? { _meta: options._meta } : {}),
        },
        undefined,
        options.signal ? { cancellationSignal: options.signal } : undefined,
      );
      const outcome = parseMcpOutcome(response);
      if (!outcome) {
        throw new RequestError(
          McpBindingErrorCode.backendFailed,
          "Invalid MCP-over-ACP response carrier",
          { response },
        );
      }
      return outcome;
    } finally {
      routes.delete(key);
    }
  }

  /**
   * Handles an incoming `mcp/message` notification. Register it with
   * `onNotification(methods.agent.mcp.message, caller.handleNotification)`.
   *
   * Notifications for unknown or already completed requests are dropped.
   */
  readonly handleNotification = (
    context: McpMessageNotificationContext,
  ): void => {
    const envelope = envelopeOf(context.params);
    const listener = this.connections
      .peek(connectionOf(context.client))
      ?.get(routeKey(envelope.serverId, envelope.requestId));
    if (!listener) return;
    try {
      listener({
        method: envelope.method,
        ...(envelope.params === undefined ? {} : { params: envelope.params }),
        ...(envelope.meta === undefined ? {} : { _meta: envelope.meta }),
      });
    } catch (error) {
      console.error("MCP-over-ACP notification listener failed", error);
    }
  };
}
