import { ConnectionRegistry } from "./connection.js";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
  isInitializeRequest,
  messageIdKey,
  methodRequiresSessionHeader,
  sessionIdFromParams,
} from "./protocol.js";
import { isJsonRpcMessage, isResponseMessage } from "./jsonrpc.js";
import { AGENT_METHODS } from "./schema/index.js";
import { serializeSseEvent, serializeSseKeepAlive } from "./sse.js";
import { handleWebSocketConnection } from "./ws-server.js";
import { AgentSideConnection } from "./acp.js";
import type {
  WebSocketServerSessionHandle,
  WebSocketServerSocket,
} from "./ws-server.js";

import type {
  AgentConnector,
  ConnectionState,
  OutboundSubscription,
  ResponseRoute,
} from "./connection.js";
import type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
} from "./jsonrpc.js";
import type { Agent, AgentApp } from "./acp.js";

export type AgentFactory = () => AgentApp;
/** @deprecated Prefer {@link AgentFactory}. */
export type LegacyAgentFactory = (conn: AgentSideConnection) => Agent;

type AgentOption =
  | {
      /** Agent app used for each accepted ACP connection. */
      readonly agent: AgentApp;
      readonly createAgent?: never;
      readonly createLegacyAgent?: never;
    }
  | {
      readonly agent?: never;
      /** Creates an agent app for each accepted ACP connection. */
      readonly createAgent: AgentFactory;
      readonly createLegacyAgent?: never;
    }
  | {
      readonly agent?: never;
      readonly createAgent?: never;
      /**
       * Creates a legacy agent implementation for each accepted ACP connection.
       *
       * @deprecated Prefer `agent` or `createAgent`.
       */
      readonly createLegacyAgent: LegacyAgentFactory;
    };

type OptionalAgentOption =
  | {
      /** Agent app used for this accepted ACP connection. */
      readonly agent?: AgentApp;
      readonly createAgent?: never;
      readonly createLegacyAgent?: never;
    }
  | {
      readonly agent?: never;
      /** Creates the agent app for this accepted ACP connection. */
      readonly createAgent?: AgentFactory;
      readonly createLegacyAgent?: never;
    }
  | {
      readonly agent?: never;
      readonly createAgent?: never;
      /**
       * Creates the legacy agent implementation for this accepted ACP connection.
       *
       * @deprecated Prefer `agent` or `createAgent`.
       */
      readonly createLegacyAgent?: LegacyAgentFactory;
    };

/** Options for creating an ACP server transport. */
export type AcpServerOptions = AgentOption;

export type HandleRequestOptions = OptionalAgentOption;

export type PrepareWebSocketUpgradeOptions = OptionalAgentOption;

export interface PreparedWebSocketUpgrade {
  readonly connectionId: string;
  accept(socket: WebSocketServerSocket): void;
  reject(): void;
}

/**
 * ACP server transport for Streamable HTTP and WebSocket connections.
 *
 * Route HTTP requests to {@link handleRequest}. For WebSocket upgrades, use
 * {@link prepareWebSocketUpgrade} so adapters can attach `Acp-Connection-Id` to
 * the `101 Switching Protocols` response.
 */
export class AcpServer {
  private readonly agent: AgentConnector;
  private readonly registry = new ConnectionRegistry();
  private readonly webSocketSessions = new Set<WebSocketServerSessionHandle>();

  constructor(options: AcpServerOptions) {
    this.agent = resolveAgent(options);
  }

  /** Handles one Streamable HTTP ACP request. */
  async handleRequest(
    req: Request,
    options: HandleRequestOptions = {},
  ): Promise<Response> {
    if (req.method === "POST") {
      return await this.handlePost(req, options);
    }

    if (req.method === "GET") {
      return this.handleGet(req);
    }

    if (req.method === "DELETE") {
      return this.handleDelete(req);
    }

    return textResponse("Method Not Allowed", 405);
  }

  /** Creates a WebSocket connection before accepting the HTTP upgrade. */
  prepareWebSocketUpgrade(
    options: PrepareWebSocketUpgradeOptions = {},
  ): PreparedWebSocketUpgrade {
    const agent = agentOverride(options, this.agent);
    const connection = this.registry.createPendingConnection(agent);
    let isSettled = false;

    return {
      connectionId: connection.connectionId,
      accept: (socket) => {
        if (isSettled) {
          throw new Error("ACP WebSocket upgrade has already been settled");
        }

        isSettled = true;
        const session = handleWebSocketConnection(socket, {
          registry: this.registry,
          agent,
          connection,
        });
        this.webSocketSessions.add(session);
        void session.closed.finally(() => {
          this.webSocketSessions.delete(session);
        });
      },
      reject: () => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        this.registry.discard(connection.connectionId);
      },
    };
  }

  /** Closes all active ACP connections owned by this server. */
  async close(): Promise<void> {
    const closeConnections = this.registry.closeAll();
    const closeWebSockets = Promise.all(
      Array.from(this.webSocketSessions, (session) => session.close()),
    );

    await Promise.all([closeConnections, closeWebSockets]);
  }

  private async handlePost(
    req: Request,
    options: HandleRequestOptions,
  ): Promise<Response> {
    const contentType = req.headers.get("Content-Type");

    if (!isJsonContentType(contentType)) {
      return textResponse("Unsupported Media Type", 415);
    }

    const body = await readJson(req);

    if (!body.ok) {
      return textResponse("Invalid JSON", 400);
    }

    if (Array.isArray(body.value)) {
      return textResponse("Batch JSON-RPC requests are not implemented", 501);
    }

    if (!isJsonRpcMessage(body.value)) {
      return textResponse("Invalid JSON-RPC message", 400);
    }

    const connectionId = req.headers.get(HEADER_CONNECTION_ID);

    if (isInitializeRequest(body.value)) {
      if (!connectionId) {
        return await this.handleInitialize(body.value, req.signal, options);
      }

      return textResponse("Initialize not allowed on existing connection", 400);
    }

    if (!connectionId) {
      return textResponse("Missing Acp-Connection-Id", 400);
    }

    const connection = this.registry.get(connectionId);

    if (!connection) {
      return textResponse("Unknown Acp-Connection-Id", 404);
    }

    const forwarded = await this.forwardConnectedMessage(
      connection,
      body.value,
      req.headers,
    );
    if (!forwarded.ok) {
      return textResponse(forwarded.message, forwarded.status);
    }

    return emptyResponse(202);
  }

  private handleGet(req: Request): Response {
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return textResponse("WebSocket upgrade is not implemented", 426);
    }

    const accept = req.headers.get("Accept")?.toLowerCase();

    if (!accept?.includes(EVENT_STREAM_MIME_TYPE)) {
      return textResponse("Not Acceptable", 406);
    }

    const connectionId = req.headers.get(HEADER_CONNECTION_ID);

    if (!connectionId) {
      return textResponse("Missing Acp-Connection-Id", 400);
    }

    const connection = this.registry.get(connectionId);

    if (!connection) {
      return textResponse("Unknown Acp-Connection-Id", 404);
    }

    const sessionId = req.headers.get(HEADER_SESSION_ID);
    if (sessionId) {
      return sseResponse(connection.ensureSession(sessionId).subscribe());
    }

    return sseResponse(connection.connectionStream.subscribe());
  }

  private handleDelete(req: Request): Response {
    const connectionId = req.headers.get(HEADER_CONNECTION_ID);

    if (!connectionId) {
      return textResponse("Missing Acp-Connection-Id", 400);
    }

    if (!this.registry.remove(connectionId)) {
      return textResponse("Unknown Acp-Connection-Id", 404);
    }

    return emptyResponse(202);
  }

  private async handleInitialize(
    message: AnyMessage,
    signal: AbortSignal,
    options: HandleRequestOptions,
  ): Promise<Response> {
    if (!("id" in message) || message.id === null) {
      return textResponse("Initialize request must include an ID", 400);
    }

    if (signal.aborted) {
      return textResponse("Request aborted", 499);
    }

    let connection:
      ReturnType<ConnectionRegistry["createConnection"]> | undefined;

    try {
      connection = this.registry.createConnection(
        agentOverride(options, this.agent),
      );
      const initialResponsePromise = writeAndReceiveInitial(
        connection,
        message,
      );
      initialResponsePromise.catch(() => undefined);

      const initialResponse = await raceAbort(initialResponsePromise, signal);

      if (signal.aborted) {
        throw new RequestAbortedError();
      }

      connection.startRouter();
      connection.startConnectHandlers();

      return jsonResponse(initialResponse, 200, {
        [HEADER_CONNECTION_ID]: connection.connectionId,
      });
    } catch (error) {
      if (connection) {
        this.registry.remove(connection.connectionId);
      }

      if (error instanceof RequestAbortedError) {
        return textResponse("Request aborted", 499);
      }

      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Initialize failed",
            data: error instanceof Error ? error.message : undefined,
          },
        },
        500,
      );
    }
  }

  private async forwardConnectedMessage(
    connection: ConnectionState,
    message: AnyMessage,
    headers: Headers,
  ): Promise<ForwardResult> {
    if (isResponseMessage(message)) {
      return await forwardClientResponse(connection, message, headers);
    }

    return await forwardClientMethodMessage(connection, message, headers);
  }
}

interface AgentOptions {
  readonly agent?: AgentApp;
  readonly createAgent?: AgentFactory;
  readonly createLegacyAgent?: LegacyAgentFactory;
}

function agentOverride(
  options: AgentOptions,
  fallback: AgentConnector,
): AgentConnector {
  if (!hasAgent(options)) {
    return fallback;
  }

  return resolveAgent(options);
}

function hasAgent(options: AgentOptions): boolean {
  return Boolean(
    options.agent || options.createAgent || options.createLegacyAgent,
  );
}

function resolveAgent(options: AgentOptions): AgentConnector {
  const sourceCount =
    (options.agent ? 1 : 0) +
    (options.createAgent ? 1 : 0) +
    (options.createLegacyAgent ? 1 : 0);

  if (sourceCount !== 1) {
    throw new Error(
      "AcpServer requires exactly one of agent, createAgent, or createLegacyAgent",
    );
  }

  if (options.agent) {
    return options.agent;
  }

  if (options.createAgent) {
    return {
      connect: (stream, connectOptions) =>
        options.createAgent!().connect(stream, connectOptions ?? {}),
    };
  }

  return {
    connect: (stream) => {
      new AgentSideConnection(options.createLegacyAgent!, stream);
    },
  };
}

type ForwardResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

type JsonResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    };

type RouteResult =
  | {
      ok: true;
      value: ResponseRoute;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

type ClientMethodMessage = AnyRequest | AnyNotification;

class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted");
    this.name = "RequestAbortedError";
  }
}

async function readJson(req: Request): Promise<JsonResult> {
  try {
    return {
      ok: true,
      value: await req.json(),
    };
  } catch {
    return {
      ok: false,
    };
  }
}

async function writeInbound(
  connection: ConnectionState,
  message: AnyMessage,
): Promise<void> {
  await connection.writeInbound(message);
}

async function writeAndReceiveInitial(
  connection: ConnectionState,
  message: AnyMessage,
): Promise<AnyResponse> {
  await writeInbound(connection, message);

  if (!("id" in message) || message.id === null) {
    throw new Error("Initialize request must include an ID");
  }

  return await connection.recvInitial(message.id);
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new RequestAbortedError();
  }

  let removeAbortListener: () => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new RequestAbortedError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    removeAbortListener();
  }
}

async function forwardClientMethodMessage(
  connection: ConnectionState,
  message: ClientMethodMessage,
  headers: Headers,
): Promise<ForwardResult> {
  const route = determineRoute(message, headers);

  if (!route.ok) {
    return route;
  }

  if (route.value !== "connection") {
    connection.ensureSession(route.value.session);
  }

  const key = "id" in message ? messageIdKey(message.id) : undefined;

  if (key) {
    connection.pendingRoutes.set(
      key,
      pendingResponseRoute(message, route.value),
    );
  }

  await writeInbound(connection, message);
  return { ok: true };
}

async function forwardClientResponse(
  connection: ConnectionState,
  message: AnyResponse,
  headers: Headers,
): Promise<ForwardResult> {
  const key = messageIdKey(message.id);
  const route = key ? connection.clientResponseRoutes.get(key) : undefined;
  const headerSessionId = headers.get(HEADER_SESSION_ID);

  if (route && route !== "connection" && !headerSessionId) {
    return {
      ok: false,
      status: 400,
      message: "Missing Acp-Session-Id",
    };
  }

  if (route && route !== "connection" && headerSessionId !== route.session) {
    return {
      ok: false,
      status: 400,
      message: "Mismatched Acp-Session-Id",
    };
  }

  if (key) {
    connection.clientResponseRoutes.delete(key);
  }

  await writeInbound(connection, message);
  return { ok: true };
}

function pendingResponseRoute(
  message: ClientMethodMessage,
  route: ResponseRoute,
): ResponseRoute {
  return message.method === AGENT_METHODS.session_load ? "connection" : route;
}

function determineRoute(
  message: ClientMethodMessage,
  headers: Headers,
): RouteResult {
  const headerSessionId = headers.get(HEADER_SESSION_ID);
  const paramsSessionId = sessionIdFromParams(message.params);

  if (methodRequiresSessionHeader(message.method) && !headerSessionId) {
    return {
      ok: false,
      status: 400,
      message: "Missing Acp-Session-Id",
    };
  }

  if (
    headerSessionId !== null &&
    paramsSessionId !== undefined &&
    headerSessionId !== paramsSessionId
  ) {
    return {
      ok: false,
      status: 400,
      message: "Mismatched Acp-Session-Id",
    };
  }

  if (headerSessionId) {
    return {
      ok: true,
      value: { session: headerSessionId },
    };
  }

  if (paramsSessionId) {
    return {
      ok: true,
      value: { session: paramsSessionId },
    };
  }

  return {
    ok: true,
    value: "connection",
  };
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === JSON_MIME_TYPE;
}

function sseResponse(subscription: OutboundSubscription): Response {
  return new Response(createSseBody(subscription), {
    status: 200,
    headers: {
      "Content-Type": EVENT_STREAM_MIME_TYPE,
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function createSseBody(
  subscription: OutboundSubscription,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const replay = [...subscription.replay];
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<AnyMessage> | undefined;
  let pendingMessage: AnyMessage | undefined;
  let isClosed = false;

  const clearKeepAlive = (): void => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
  };

  const enqueueText = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): boolean => {
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      return false;
    }
  };

  const hasDemand = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => controller.desiredSize !== null && controller.desiredSize > 0;

  const closeBody = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    clearKeepAlive();

    try {
      controller.close();
    } catch {
      // Stream may already be cancelled by the consumer.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      keepAliveTimer = setInterval(() => {
        if (isClosed || pendingMessage || !hasDemand(controller)) {
          return;
        }

        if (!enqueueText(controller, serializeSseKeepAlive())) {
          closeBody(controller);
        }
      }, 15_000);
    },
    async pull(controller) {
      if (isClosed || reader || !hasDemand(controller)) {
        return;
      }

      const replayMessage = replay.shift();
      if (replayMessage) {
        if (!enqueueText(controller, serializeSseEvent(replayMessage))) {
          closeBody(controller);
        }

        return;
      }

      if (pendingMessage) {
        const message = pendingMessage;
        pendingMessage = undefined;

        if (!enqueueText(controller, serializeSseEvent(message))) {
          closeBody(controller);
        }

        return;
      }

      const currentReader = subscription.stream.getReader();
      reader = currentReader;

      try {
        const result = await currentReader.read();

        if (isClosed) {
          return;
        }

        if (result.done) {
          closeBody(controller);
          return;
        }

        if (!hasDemand(controller)) {
          pendingMessage = result.value;
          return;
        }

        if (!enqueueText(controller, serializeSseEvent(result.value))) {
          closeBody(controller);
        }
      } catch (error) {
        if (!isClosed) {
          isClosed = true;
          clearKeepAlive();
          controller.error(error);
        }
      } finally {
        if (reader === currentReader) {
          reader = undefined;
        }

        currentReader.releaseLock();
      }
    },
    cancel() {
      isClosed = true;
      clearKeepAlive();

      if (reader) {
        void reader.cancel();
      } else {
        void subscription.stream.cancel();
      }
    },
  });
}

function jsonResponse(
  value: unknown,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": JSON_MIME_TYPE,
      ...headers,
    },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}
