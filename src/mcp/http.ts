import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  connectionContextOf,
  connectionOf,
} from "../core/connection-access.js";
import type { HasConnectionContext } from "../core/connection-access.js";
import { RequestError } from "../core/jsonrpc.js";
import type { ConnectionContext, MaybePromise } from "../core/jsonrpc.js";
import {
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  McpBindingErrorCode,
  generateId,
  isJsonObject,
  isMcpServerAcp,
} from "./core.js";
import { stripHeaderAnnotations } from "./header-annotations.js";
import {
  RequestBodyTooLargeError,
  drainRejectedRequest,
  readRequestBody,
} from "../transports/node-body.js";
import type {
  McpNotification,
  McpOutcome,
  McpOverAcpCaller,
  McpServerAcpDeclaration,
} from "./core.js";

/**
 * Inner `_meta` key MCP uses to correlate subscription events and results.
 */
const MCP_META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const HMAC_CONTEXT = "mcp-over-acp-http-adapter/server/v1\0";
const SSE_KEEPALIVE_MS = 15_000;

/**
 * An MCP server declaration using the HTTP transport.
 *
 * Structurally matches the ACP `McpServerHttp` declaration with
 * `type: "http"`.
 */
export type McpServerHttpDeclaration = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  _meta?: Record<string, unknown> | null;
};

/**
 * The parts of an MCP HTTP request that
 * {@link McpOverAcpHttpBridgeOptions.attribution} sees.
 */
export type McpHttpRequestInfo = {
  /**
   * The ACP connection the request will be forwarded on. One bridge can serve
   * several connections, and two of them can declare the same `serverId`.
   *
   * It is the same object for every request on one connection, and
   * {@link McpOverAcpHttpBridge.connection} returns that object for any
   * context of the connection, so it can key a `Map` or a `WeakMap`. SDK
   * helpers that take a context accept it too, for example
   * `McpOverAcpCaller.request`. It is not the context object that was passed
   * to `toHttp` or `adaptServers`.
   */
  connection: HasConnectionContext;
  /** The declared server the request is addressed to. */
  serverId: string;
  /** Inner MCP method, such as `tools/call`. */
  method: string;
  /** Inner MCP params, including the `_meta` the MCP client sent. */
  params: Record<string, unknown> | undefined;
  /**
   * Aborts when the bridge stops serving this HTTP request before it has
   * finished answering it:
   *
   * - The HTTP connection closed, as when the MCP client gives up on the
   *   request.
   * - The ACP connection closed. The bridge then closes its listener for that
   *   connection and every HTTP connection on it.
   * - The response buffered for a slow HTTP reader exceeded
   *   `maxBufferedResponseBytes`. That can only happen while the request is
   *   being forwarded, after the resolver has returned.
   *
   * It is the signal that cancels the forwarded `mcp/message` request. A
   * resolver that waits for something can stop on it.
   */
  signal: AbortSignal;
};

/**
 * The ACP session, and optionally the tool call in it, that an MCP HTTP
 * request is sent for.
 */
export type McpHttpRequestAttribution = {
  /**
   * The session whose work caused the request: the `sessionId` the agent uses
   * on `session/update` for that work. For a child session's work, the child's
   * ID.
   */
  sessionId: string;
  /**
   * The tool call in that session that the request is part of: the
   * `toolCallId` the agent reports in `session/update`.
   */
  toolCallId?: string;
};

/**
 * Options for {@link McpOverAcpHttpBridge}.
 */
export type McpOverAcpHttpBridgeOptions = {
  /**
   * Maximum concurrently admitted HTTP requests per ACP connection. Further
   * requests fail with HTTP 429 and `-33000`. Defaults to 64.
   */
  maxActiveRequests?: number;
  /**
   * Maximum HTTP request body size in bytes. Defaults to 1 MiB.
   */
  maxRequestBodyBytes?: number;
  /**
   * Maximum response bytes buffered for a slow HTTP reader before its
   * request is cancelled with `-33000`. Defaults to 1 MiB.
   */
  maxBufferedResponseBytes?: number;
  /**
   * Names the ACP session and tool call that an HTTP request belongs to.
   *
   * An MCP HTTP request does not say which ACP session it is for, so without
   * this option the bridge sends every `mcp/message` request without
   * `sessionId` and `toolCallId`, and a provider that needs the session can
   * reject it. The HTTP client then gets a JSON-RPC error with code `-33002`
   * in an HTTP 200 response. Its message gives the provider's reason and says
   * that changing the tool arguments will not help.
   *
   * A host that runs the agent's tools can supply them. For example, it
   * records the session of each tool call before the tool runs, then looks
   * the request up by the tool-call ID that its MCP client puts in
   * `params._meta`. A host with several ACP connections on one bridge tells
   * them apart by `request.connection`.
   *
   * Return `undefined` for a request that cannot be matched. Do not infer the
   * session from the order or timing of requests, or from the session that
   * was active last.
   *
   * Called once per HTTP request, before it is forwarded. If it throws, or
   * returns a value without a string `sessionId`, the request fails with HTTP
   * 500 and `-33002` and nothing is forwarded.
   *
   * The request is not forwarded until the resolver settles, so a resolver
   * can wait, for example for a subagent's session to be announced. While it
   * waits, `request.signal` tells it that the HTTP client gave up or the ACP
   * connection closed. The bridge then stops waiting and forwards nothing:
   * there is no HTTP response left to write. Whatever the resolver returns or
   * throws after that is ignored. A resolver that ignores the signal only
   * keeps its own work running.
   */
  attribution?: (
    request: McpHttpRequestInfo,
  ) => MaybePromise<McpHttpRequestAttribution | undefined>;
};

type Listener = {
  server: Server;
  port: number;
  secret: Buffer;
  active: number;
};

/**
 * Re-exports MCP servers declared with `"type": "acp"` as loopback MCP
 * 2026-07-28 Streamable HTTP endpoints.
 *
 * Use this in an agent whose MCP client only accepts URLs. It starts one
 * listener on `127.0.0.1` per ACP connection, closed with the connection.
 * Each HTTP POST becomes one independent `mcp/message` request through the
 * given caller; closing the HTTP response cancels only that request.
 *
 * The endpoint authenticates each server with its own bearer token, sent in
 * the declaration's `Authorization` header (never in the URL). It accepts
 * MCP 2026-07-28 only: no batches, `initialize`, session headers, or GET
 * streams. Register `caller.handleNotification` on the app so progress and
 * subscription events reach their HTTP response streams.
 *
 * ```ts
 * const caller = new McpOverAcpCaller({ clientInfo });
 * const bridge = new McpOverAcpHttpBridge(caller);
 * agent()
 *   .onNotification(methods.agent.mcp.message, caller.handleNotification)
 *   .onRequest(methods.agent.session.new, async ({ params, client }) => {
 *     const mcpServers = await bridge.adaptServers(client, params.mcpServers);
 *     // Pass mcpServers to the backend; `acp` entries are now `http` ones.
 *   });
 * ```
 */
export class McpOverAcpHttpBridge {
  private readonly listeners = new WeakMap<
    ConnectionContext,
    Promise<Listener>
  >();
  /** The one object this bridge uses to stand for each connection. */
  private readonly connections = new WeakMap<
    ConnectionContext,
    HasConnectionContext
  >();
  private readonly maxActiveRequests: number;
  private readonly maxRequestBodyBytes: number;
  private readonly maxBufferedResponseBytes: number;
  private readonly attribution: McpOverAcpHttpBridgeOptions["attribution"];

  constructor(
    private readonly caller: McpOverAcpCaller,
    options: McpOverAcpHttpBridgeOptions = {},
  ) {
    this.maxActiveRequests = positiveInteger(
      "maxActiveRequests",
      options.maxActiveRequests ?? 64,
    );
    this.maxRequestBodyBytes = positiveInteger(
      "maxRequestBodyBytes",
      options.maxRequestBodyBytes ?? 1024 * 1024,
    );
    this.maxBufferedResponseBytes = positiveInteger(
      "maxBufferedResponseBytes",
      options.maxBufferedResponseBytes ?? 1024 * 1024,
    );
    this.attribution = options.attribution;
  }

  /**
   * Returns the object that stands for the ACP connection behind `context`
   * in this bridge: the `connection` that
   * {@link McpOverAcpHttpBridgeOptions.attribution} gets for an HTTP request
   * forwarded on it.
   *
   * Every context of one connection gives the same object, including the
   * `client` of each request handler, which is a new object per request. Use
   * it to key what the host knows about a connection, then look that up by
   * `request.connection`. It holds no request state, and SDK helpers that
   * take a context accept it.
   */
  connection(context: HasConnectionContext): HasConnectionContext {
    return this.connectionFor(connectionOf(context));
  }

  private connectionFor(cx: ConnectionContext): HasConnectionContext {
    let connection = this.connections.get(cx);
    if (!connection) {
      connection = Object.freeze({ [connectionContextOf]: () => cx });
      this.connections.set(cx, connection);
    }
    return connection;
  }

  /**
   * Returns an HTTP declaration that serves `server` over the connection
   * behind `context`, preserving its name and metadata.
   */
  async toHttp(
    context: HasConnectionContext,
    server: McpServerAcpDeclaration & {
      _meta?: Record<string, unknown> | null;
    },
  ): Promise<McpServerHttpDeclaration> {
    const listener = await this.listener(connectionOf(context));
    const token = mac(listener.secret, server.serverId).toString("base64url");
    return {
      type: "http",
      name: server.name,
      url: `http://127.0.0.1:${listener.port}/${serverRoute(server.serverId)}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      ...(server._meta === undefined ? {} : { _meta: server._meta }),
    };
  }

  /**
   * Replaces every `"type": "acp"` entry of a session's `mcpServers` with an
   * HTTP declaration, leaving other entries unchanged.
   */
  async adaptServers<T>(
    context: HasConnectionContext,
    servers: readonly T[],
  ): Promise<Array<T | McpServerHttpDeclaration>> {
    return Promise.all(
      servers.map((server) =>
        isMcpServerAcp(server) ? this.toHttp(context, server) : server,
      ),
    );
  }

  private listener(cx: ConnectionContext): Promise<Listener> {
    if (cx.signal.aborted) {
      return Promise.reject(new Error("ACP connection is closed"));
    }
    let listener = this.listeners.get(cx);
    if (!listener) {
      listener = this.startListener(cx);
      this.listeners.set(cx, listener);
      // A failed listen is retried by the next caller.
      listener.catch(() => this.listeners.delete(cx));
    }
    return listener;
  }

  private async startListener(cx: ConnectionContext): Promise<Listener> {
    // Hold only the connection, not the caller's (possibly request-scoped)
    // context, for the listener's lifetime.
    const context = this.connectionFor(cx);
    const state: Listener = {
      server: createServer(),
      port: 0,
      secret: randomBytes(32),
      active: 0,
    };
    state.server.on("request", (req, res) => {
      void this.handle(state, context, req, res).catch((error: unknown) => {
        console.error("MCP-over-ACP HTTP bridge failed", error);
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, null, -33002, "MCP bridge failure");
        } else {
          res.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      state.server.once("error", reject);
      state.server.listen(0, "127.0.0.1", () => {
        state.server.off("error", reject);
        resolve();
      });
    });
    // Later server errors (such as EMFILE on accept) must not crash the agent.
    state.server.on("error", (error) => {
      console.error("MCP-over-ACP HTTP listener error", error);
    });
    state.port = (state.server.address() as AddressInfo).port;
    const close = () => {
      this.listeners.delete(cx);
      state.server.close();
      state.server.closeAllConnections();
    };
    if (cx.signal.aborted) close();
    else cx.signal.addEventListener("abort", close, { once: true });
    return state;
  }

  private async handle(
    listener: Listener,
    context: HasConnectionContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const checked = this.checkTransport(listener, req);
    if (!checked.ok) {
      drainRejectedRequest(req);
      sendJsonRpcError(
        res,
        checked.status,
        null,
        checked.code,
        checked.message,
        checked.headers,
      );
      return;
    }
    const { serverId } = checked;

    if (listener.active >= this.maxActiveRequests) {
      drainRejectedRequest(req);
      sendJsonRpcError(
        res,
        429,
        null,
        McpBindingErrorCode.resourceLimitExceeded,
        "Too many outstanding MCP responses",
      );
      return;
    }
    // Admission lasts until the response is finished or abandoned.
    listener.active += 1;
    res.once("close", () => {
      listener.active -= 1;
    });

    let body: string;
    try {
      body = await readRequestBody(req, this.maxRequestBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJsonRpcError(
          res,
          413,
          null,
          McpBindingErrorCode.resourceLimitExceeded,
          "Request body too large",
        );
        drainRejectedRequest(req);
      } else {
        // The client went away mid-upload; there is no one to answer.
        res.destroy();
      }
      return;
    }
    const request = parseRequest(body, req);
    if ("status" in request) {
      sendJsonRpcError(
        res,
        request.status,
        request.id,
        request.code,
        request.message,
        undefined,
        request.data,
      );
      return;
    }
    await this.forward(context, serverId, request, res);
  }

  /** Checks everything that must precede reading the body. */
  private checkTransport(
    listener: Listener,
    req: IncomingMessage,
  ): TransportCheck {
    for (const name of [
      "origin",
      "authorization",
      "mcp-protocol-version",
      "mcp-method",
      "mcp-name",
    ]) {
      if (headerCount(req, name) > 1) {
        return {
          ok: false,
          status: 400,
          code: -32020,
          message: "HeaderMismatch: duplicate routing or authentication header",
        };
      }
    }
    if (!validOrigin(req)) {
      return {
        ok: false,
        status: 403,
        code: -32600,
        message: "Invalid Origin",
      };
    }
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    const serverId = parseServerRoute(route);
    if (serverId === undefined) {
      return {
        ok: false,
        status: 404,
        code: -32601,
        message: "Unknown MCP route",
      };
    }
    if (!authorized(req.headers.authorization, listener.secret, serverId)) {
      return {
        ok: false,
        status: 401,
        code: -32600,
        message: "Unauthorized",
        headers: { "www-authenticate": "Bearer" },
      };
    }
    if (req.method !== "POST") {
      return {
        ok: false,
        status: 405,
        code: -32600,
        message: "Only POST is supported",
        headers: { allow: "POST" },
      };
    }
    if (!acceptsJsonAndSse(req.headers.accept)) {
      return {
        ok: false,
        status: 406,
        code: -32600,
        message: "Accept must include application/json and text/event-stream",
      };
    }
    const mediaType = req.headers["content-type"]?.split(";")[0]?.trim();
    if (mediaType?.toLowerCase() !== "application/json") {
      return {
        ok: false,
        status: 415,
        code: -32600,
        message: "Expected application/json",
      };
    }
    return { ok: true, serverId };
  }

  /**
   * Asks the host which session and tool call `request` belongs to. Without a
   * resolver, or for a request it does not match, the result is empty and the
   * request is forwarded without attribution.
   *
   * Returns `undefined` when `signal` aborted before the resolver settled:
   * the request was abandoned, and must not be forwarded.
   */
  private async resolveAttribution(
    connection: HasConnectionContext,
    serverId: string,
    request: ParsedRequest,
    signal: AbortSignal,
  ): Promise<{ sessionId?: string; toolCallId?: string } | undefined> {
    const resolver = this.attribution;
    if (!resolver) return {};
    let stopWaiting!: () => void;
    const abandoned = new Promise<undefined>((resolve) => {
      stopWaiting = () => resolve(undefined);
      signal.addEventListener("abort", stopWaiting, { once: true });
    });
    let attribution: McpHttpRequestAttribution | undefined;
    try {
      attribution = await Promise.race([
        // `async` so that a resolver that throws synchronously rejects here.
        // The race also handles a rejection that comes after the abort.
        (async () =>
          resolver({
            connection,
            serverId,
            method: request.method,
            params: request.params,
            signal,
          }))(),
        abandoned,
      ]);
    } catch (error) {
      // A resolver that stops on the signal usually rejects.
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      signal.removeEventListener("abort", stopWaiting);
    }
    if (signal.aborted) return undefined;
    if (attribution === undefined) return {};
    const { sessionId, toolCallId } = attribution;
    if (
      typeof sessionId !== "string" ||
      (toolCallId !== undefined && typeof toolCallId !== "string")
    ) {
      throw new TypeError(
        "The attribution resolver must return undefined or an object with a " +
          "string sessionId and an optional string toolCallId",
      );
    }
    return toolCallId === undefined ? { sessionId } : { sessionId, toolCallId };
  }

  private async forward(
    context: HasConnectionContext,
    serverId: string,
    request: ParsedRequest,
    res: ServerResponse,
  ): Promise<void> {
    const requestId = generateId("mcp-http");
    const abandon = new AbortController();
    res.once("close", () => {
      // Dropping the HTTP response cancels exactly this ACP request.
      if (!res.writableFinished) abandon.abort();
    });

    let stream: SseStream | undefined;
    const overflow = () => {
      abandon.abort();
      stream?.end(
        jsonRpcError(
          request.id,
          McpBindingErrorCode.resourceLimitExceeded,
          "MCP notification buffer overflow",
        ),
      );
    };

    const onNotification = (notification: McpNotification) => {
      if (abandon.signal.aborted) return;
      stream ??= new SseStream(res);
      const params = notification.params
        ? rewriteSubscriptionId(notification.params, requestId, request.id)
        : notification.params;
      stream.write({
        jsonrpc: "2.0",
        method: notification.method,
        ...(params === undefined ? {} : { params }),
      });
      if (res.writableLength > this.maxBufferedResponseBytes) overflow();
    };

    // A failing resolver rejects here, outside the `try` below, so `handle`'s
    // caller logs it and answers 500 instead of reporting a binding error
    // from the provider.
    const attribution = await this.resolveAttribution(
      context,
      serverId,
      request,
      abandon.signal,
    );
    // Abandoned while the host looked it up. Its HTTP response is closed.
    if (!attribution) return;

    let terminal: unknown;
    try {
      const outcome = await this.caller.request(
        context,
        serverId,
        request.method,
        request.params,
        { requestId, signal: abandon.signal, onNotification, ...attribution },
      );
      terminal = projectOutcome(outcome, request, requestId);
    } catch (error) {
      terminal = projectBindingError(error, request.id);
    }
    if (abandon.signal.aborted) return;
    if (stream) {
      stream.end(terminal);
    } else {
      const body = JSON.stringify(terminal);
      res.writeHead(terminalStatus(terminal), {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    }
  }
}

type TransportCheck =
  | { ok: true; serverId: string }
  | {
      ok: false;
      status: number;
      code: number;
      message: string;
      headers?: Record<string, string>;
    };

type ParsedRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown> | undefined;
};

type RequestRejection = {
  status: number;
  id: string | number | null;
  code: number;
  message: string;
  data?: unknown;
};

function parseRequest(
  body: string,
  req: IncomingMessage,
): ParsedRequest | RequestRejection {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { status: 400, id: null, code: -32700, message: "Parse error" };
  }
  const object = isJsonObject(value) ? value : undefined;
  const rawId = object?.id;
  const id = validRequestId(rawId) ? rawId : null;
  const reject = (
    code: number,
    message: string,
    status = 400,
    data?: unknown,
  ): RequestRejection => ({ status, id, code, message, data });
  if (
    !object ||
    object.jsonrpc !== "2.0" ||
    Object.hasOwn(object, "result") ||
    Object.hasOwn(object, "error") ||
    id === null
  ) {
    return reject(
      -32600,
      "Expected one JSON-RPC request; batches, notifications and client responses are unsupported",
    );
  }
  const method = object.method;
  if (typeof method !== "string") return reject(-32600, "Missing method");
  if (object.params !== undefined && !isJsonObject(object.params)) {
    return reject(-32602, "Parameters must be an object");
  }
  const params = object.params;
  const meta = isJsonObject(params?._meta) ? params._meta : undefined;
  const metadataVersion = meta?.[MCP_META_PROTOCOL_VERSION];
  if (typeof metadataVersion !== "string") {
    return reject(
      -32602,
      `params._meta must contain ${MCP_META_PROTOCOL_VERSION} as a string`,
    );
  }
  const version = singleHeader(req, "mcp-protocol-version");
  if (version !== metadataVersion) {
    return reject(
      -32020,
      "HeaderMismatch: MCP-Protocol-Version does not match params._meta",
    );
  }
  if (version !== MCP_PROTOCOL_VERSION) {
    return reject(-32022, "Unsupported protocol version", 400, {
      supported: [MCP_PROTOCOL_VERSION],
      requested: version,
    });
  }
  if (!isJsonObject(meta?.[MCP_META_CLIENT_CAPABILITIES])) {
    return reject(
      -32602,
      `params._meta must contain ${MCP_META_CLIENT_CAPABILITIES} as an object`,
    );
  }
  if (singleHeader(req, "mcp-method") !== method) {
    return reject(-32020, "HeaderMismatch: Mcp-Method does not match method");
  }
  if (
    method === "tools/call" ||
    method === "prompts/get" ||
    method === "resources/read"
  ) {
    const name = method === "resources/read" ? params?.uri : params?.name;
    if (typeof name !== "string") {
      return reject(-32602, "Missing params.name or params.uri");
    }
    if (!matchesMirror(singleHeader(req, "mcp-name"), name)) {
      return reject(-32020, "HeaderMismatch: Mcp-Name does not match request");
    }
  }
  // Native tools are re-exported without transport-only `x-mcp-header`
  // annotations, so mirrored parameter headers have no authority here.
  if (Object.keys(req.headers).some((key) => key.startsWith("mcp-param-"))) {
    return reject(
      -32020,
      "HeaderMismatch: Mcp-Param headers are not supported by this adapter",
    );
  }
  if (method === "initialize" || method.startsWith("notifications/")) {
    return reject(-32601, "Method not found", 404);
  }
  return { id: id, method, params };
}

function projectOutcome(
  outcome: McpOutcome,
  request: ParsedRequest,
  requestId: string,
): unknown {
  if ("error" in outcome) {
    return { jsonrpc: "2.0", id: request.id, error: outcome.error };
  }
  let result = outcome.result;
  if (request.method === "tools/list") result = stripHeaderAnnotations(result);
  if (isJsonObject(result)) {
    result = rewriteSubscriptionId(result, requestId, request.id);
  }
  return { jsonrpc: "2.0", id: request.id, result };
}

/**
 * Projects an outer ACP failure of `mcp/message` for the HTTP client.
 *
 * Codes that mean the same to an MCP client pass through. Every other code
 * becomes `-33002` with the ACP error's message.
 *
 * A `-32602` is the provider refusing the request for its ACP envelope: a
 * session it needs or rejects, or a duplicate request ID. It becomes `-33002`
 * too, because to the HTTP client `-32602` would mean that its own MCP params
 * are invalid. Its message is rewritten for the same reason: a model that
 * reads "Invalid params" retries the tool with other arguments. The new
 * message gives the provider's reason (see {@link refusalReason}) and says
 * that other arguments will not help. No `data` is forwarded.
 */
function projectBindingError(error: unknown, id: string | number): unknown {
  if (
    error instanceof RequestError &&
    error.code === McpBindingErrorCode.invalidParams
  ) {
    const reason = refusalReason(error);
    return jsonRpcError(
      id,
      McpBindingErrorCode.backendFailed,
      "The MCP server refused this request before running it. " +
        (reason === "" ? "" : `Reason: ${reason}. `) +
        "Changing the tool arguments will not help.",
    );
  }
  const code =
    error instanceof RequestError &&
    (
      [
        McpBindingErrorCode.resourceLimitExceeded,
        McpBindingErrorCode.serverUnavailable,
        McpBindingErrorCode.backendFailed,
        McpBindingErrorCode.requestCancelled,
      ] as number[]
    ).includes(error.code)
      ? error.code
      : McpBindingErrorCode.backendFailed;
  const message =
    error instanceof RequestError ? error.message : "MCP binding failure";
  return jsonRpcError(id, code, message);
}

/**
 * Why a provider answered `-32602`, as one sentence without its final
 * period, or `""` when it gave no reason.
 *
 * The reason is the error's `data` when that is a string with text in it,
 * which is where the Rust SDK puts it. Otherwise it is the error's message
 * without the leading "Invalid params: " that this SDK adds, and a bare
 * "Invalid params" is no reason.
 */
function refusalReason(error: RequestError): string {
  const stated =
    typeof error.data === "string" && error.data.trim() !== ""
      ? error.data
      : error.message.trim() === "Invalid params"
        ? ""
        : error.message.replace(/^\s*Invalid params: /, "");
  return stated.trim().replace(/\.$/, "");
}

function terminalStatus(terminal: unknown): number {
  const code = isJsonObject(terminal)
    ? (terminal.error as { code?: unknown } | undefined)?.code
    : undefined;
  switch (code) {
    case -32020:
    case -32021:
    case -32022:
    case -32602:
      return 400;
    case -32601:
      return 404;
    default:
      return 200;
  }
}

/**
 * Rewrites a subscription ID that names the logical ACP request so the HTTP
 * client sees its own request ID. Other metadata and opaque state are kept.
 */
function rewriteSubscriptionId(
  payload: Record<string, unknown>,
  requestId: string,
  httpId: string | number,
): Record<string, unknown> {
  const meta = payload._meta;
  if (!isJsonObject(meta) || meta[MCP_META_SUBSCRIPTION_ID] !== requestId) {
    return payload;
  }
  return { ...payload, _meta: { ...meta, [MCP_META_SUBSCRIPTION_ID]: httpId } };
}

class SseStream {
  private readonly keepalive: ReturnType<typeof setInterval>;

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    this.keepalive = setInterval(
      () => res.write(": keepalive\n\n"),
      SSE_KEEPALIVE_MS,
    );
    res.once("close", () => clearInterval(this.keepalive));
  }

  write(message: unknown): void {
    if (this.res.writableEnded) return;
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  end(message: unknown): void {
    this.write(message);
    clearInterval(this.keepalive);
    if (!this.res.writableEnded) this.res.end();
  }
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
  headers: Record<string, string> = {},
  data?: unknown,
): void {
  const body = JSON.stringify(jsonRpcError(id, code, message, data));
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serverRoute(serverId: string): string {
  // Even an empty opaque ID must occupy a real route segment.
  return `mcp-${Buffer.from(serverId, "utf8").toString("base64url")}`;
}

function parseServerRoute(route: string): string | undefined {
  if (route.length > 4096 || !route.startsWith("mcp-")) return undefined;
  const serverId = Buffer.from(route.slice(4), "base64url").toString("utf8");
  // Reject noncanonical encodings so each server has exactly one route.
  return serverRoute(serverId) === route ? serverId : undefined;
}

function mac(secret: Buffer, serverId: string): Buffer {
  return createHmac("sha256", secret)
    .update(HMAC_CONTEXT)
    .update(serverId, "utf8")
    .digest();
}

function authorized(
  header: string | undefined,
  secret: Buffer,
  serverId: string,
): boolean {
  const [scheme, token, ...rest] = header?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
    return false;
  }
  const supplied = Buffer.from(token, "base64url");
  if (supplied.toString("base64url") !== token) return false;
  const expected = mac(secret, serverId);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) count += 1;
  }
  return count;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function validOrigin(req: IncomingMessage): boolean {
  // Browsers send Origin; only the listener's own loopback origin is trusted.
  // Non-browser HTTP clients normally omit it.
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  return (
    host !== undefined &&
    /^127\.0\.0\.1:\d{1,5}$/.test(host) &&
    origin === `http://${host}`
  );
}

/**
 * HTTP qvalues are decimal 0..1 with at most three fractional digits.
 * Returns whether the value is positive, or `undefined` if malformed.
 */
function positiveQuality(value: string): boolean | undefined {
  const match = /^([01])(?:\.(\d{0,3}))?$/.exec(value);
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  if (match[1] === "1") return /^0*$/.test(fraction) ? true : undefined;
  return /[1-9]/.test(fraction);
}

function acceptsJsonAndSse(accept: string | undefined): boolean {
  let json = false;
  let sse = false;
  for (const item of (accept ?? "").split(",")) {
    const [media = "", ...parameters] = item.split(";");
    let quality: boolean | undefined;
    for (const parameter of parameters) {
      const [key, value] = parameter.split("=", 2);
      if (key?.trim().toLowerCase() !== "q") continue;
      const positive = positiveQuality(value?.trim() ?? "");
      if (positive === undefined || quality !== undefined) return false;
      quality = positive;
    }
    if (quality === false) continue;
    const type = media.trim().toLowerCase();
    json ||= type === "application/json";
    sse ||= type === "text/event-stream";
  }
  return json && sse;
}

/**
 * Compares a mirrored `Mcp-Name` header with the body value. Values may use
 * the `=?base64?…?=` sentinel; invalid or noncanonical Base64 is rejected so
 * intermediaries and the adapter cannot disagree on the decoded value.
 */
function matchesMirror(header: string | undefined, body: string): boolean {
  if (header === undefined) return false;
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(header);
  if (!sentinel) return header === body;
  const encoded = sentinel[1]!;
  const decoded = Buffer.from(encoded, "base64");
  return (
    decoded.toString("base64") === encoded &&
    decoded.equals(Buffer.from(body, "utf8"))
  );
}

function validRequestId(id: unknown): id is string | number {
  return typeof id === "string" || Number.isSafeInteger(id);
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
