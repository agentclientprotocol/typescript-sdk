import {
  RequestError,
  isNotificationMessage,
  isRecord,
  isRequestMessage,
  isResponseBatch,
  isResponseShapedMessage,
  protocolErrorResponse,
} from "./jsonrpc.js";
import {
  isInitializeRequest,
  messageIdKey,
  sessionIdFromParams,
} from "./protocol.js";
import { AGENT_METHODS } from "./schema/index.js";
import { onWebSocket, webSocketMessageToString } from "./ws-utils.js";
import {
  ConnectionClosedError,
  ConnectionLimitError,
  connectionLimitExceeded,
  connectionOutputStalled,
} from "./connection.js";
import type {
  AgentConnector,
  ConnectionRegistry,
  ConnectionState,
  OutboundLease,
  ResponseRoute,
} from "./connection.js";
import type { AnyCall, AnyMessage, AnyWireMessage } from "./jsonrpc.js";
import type { WebSocketLike } from "./ws-utils.js";

/** WebSocket shape accepted by prepared ACP WebSocket upgrades. */
export type WebSocketServerSocket = WebSocketLike;

// Sockets report no drain event, so a session polls `bufferedAmount` while
// its client is behind, backing off while the client stays behind.
const SOCKET_POLL_INITIAL_MS = 10;
const SOCKET_POLL_MAX_MS = 1000;

// Besides its text, a frame waiting to be handled holds the promises that
// queue it, about 350 bytes in V8, so each one counts this much more toward
// `maxBufferedBytes`. Otherwise small or empty frames would barely count.
const WAITING_FRAME_OVERHEAD = 1024;

type ForwardResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

export interface WebSocketConnectionOptions {
  readonly registry: ConnectionRegistry;
  readonly agent: AgentConnector;
  readonly connection?: ConnectionState;
}

export interface WebSocketServerSessionHandle {
  readonly closed: Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export function handleWebSocketConnection(
  socket: WebSocketLike,
  options: WebSocketConnectionOptions,
): WebSocketServerSessionHandle {
  const session = new WebSocketServerSession(socket, options);
  session.start();
  return session;
}

class WebSocketServerSession implements WebSocketServerSessionHandle {
  private connection: ConnectionState | undefined;
  private preparedConnection: ConnectionState | undefined;
  private outboundLease: OutboundLease<AnyWireMessage> | undefined;
  private inboundWriteChain: Promise<void> = Promise.resolve();
  private messageChain: Promise<void> = Promise.resolve();
  /**
   * Size of the frames waiting in `messageChain` behind the one being
   * handled, counting `WAITING_FRAME_OVERHEAD` for each; see
   * `maxBufferedBytes`.
   */
  private waitingInboundBytes = 0;
  private isClosed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed: () => void = () => {};
  private readonly detachListeners: Array<() => void> = [];

  constructor(
    private readonly socket: WebSocketLike,
    private readonly options: WebSocketConnectionOptions,
  ) {
    this.preparedConnection = options.connection;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  start(): void {
    this.detachListeners.push(
      onWebSocket(this.socket, "message", (...args) => {
        this.enqueueSocketMessage(args);
      }),
    );

    this.detachListeners.push(
      onWebSocket(this.socket, "close", () => {
        void this.closeSession();
      }),
    );

    this.detachListeners.push(
      onWebSocket(this.socket, "error", () => {
        void this.shutdown(1011, "WebSocket error");
      }),
    );
  }

  close(code = 1001, reason = "Server shutting down"): Promise<void> {
    return this.shutdown(code, reason);
  }

  private enqueueSocketMessage(args: unknown[]): void {
    if (this.isClosed) {
      return;
    }

    const text = webSocketMessageToString(args);
    if (text === undefined) {
      console.warn("Ignoring non-text ACP WebSocket frame");
      return;
    }

    // Frames wait here while an earlier one is handled, which can take a
    // while, such as during a slow initialize or while the client is behind
    // on its output, and the socket keeps delivering them meanwhile.
    const size = text.length + WAITING_FRAME_OVERHEAD;
    const { limits } = this.options.registry;
    if (
      this.waitingInboundBytes > 0 &&
      size > limits.maxBufferedBytes - this.waitingInboundBytes
    ) {
      this.closeForLimit(connectionLimitExceeded("maxBufferedBytes", limits));
      return;
    }

    this.waitingInboundBytes += size;
    const handled = this.messageChain.then(() => {
      this.waitingInboundBytes -= size;
      return this.handleSocketMessage(text);
    });
    this.messageChain = handled.catch((error) => {
      // When the connection shuts down, its outbound pump closes the socket.
      if (this.isClosed || error instanceof ConnectionClosedError) {
        return;
      }

      if (error instanceof ConnectionLimitError) {
        this.closeForLimit(error);
        return;
      }

      console.error("ACP WebSocket message handling failed:", error);
      void this.shutdown(1011, "Message handling failed");
    });
  }

  private async handleSocketMessage(text: string): Promise<void> {
    if (this.isClosed) {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      await this.waitForSocketCapacity();
      this.send(protocolErrorResponse(RequestError.parseError()));
      return;
    }

    if (!Array.isArray(value) && !isRecord(value)) {
      await this.waitForSocketCapacity();
      this.send(protocolErrorResponse(RequestError.invalidRequest(value)));
      return;
    }

    if (!this.connection && Array.isArray(value)) {
      if (value.length === 1 && isRequestMessage(value[0])) {
        await this.handleInitialize(value[0], true);
        return;
      }

      console.warn(
        "First ACP WebSocket message must be initialize or a single-entry initialize batch",
      );
      await this.shutdown(1002, "First message must be initialize");
      return;
    }

    const message = value as AnyWireMessage;

    if (!this.connection) {
      if (isResponseShapedMessage(message)) {
        return;
      }

      if (!isRequestMessage(message) && !isNotificationMessage(message)) {
        await this.waitForSocketCapacity();
        this.send(protocolErrorResponse(RequestError.invalidRequest(message)));
        return;
      }

      await this.handleInitialize(message as AnyMessage, false);
      return;
    }

    const forwarded = await this.forwardMessage(message);
    if (!forwarded.ok) {
      console.warn("Ignoring ACP WebSocket message:", forwarded.message);
    }
  }

  private async handleInitialize(
    message: AnyMessage,
    batched: boolean,
  ): Promise<void> {
    if (!isInitializeRequest(message)) {
      console.warn("First ACP WebSocket message must be initialize");
      await this.shutdown(1002, "First message must be initialize");
      return;
    }

    if (!("id" in message) || message.id === null) {
      console.warn("ACP WebSocket initialize request must include an ID");
      await this.shutdown(1002, "Initialize request must include an ID");
      return;
    }

    const connection =
      this.preparedConnection ??
      this.options.registry.createPendingConnection(this.options.agent);
    this.preparedConnection = connection;

    try {
      await writeInbound(connection, message);

      const initialResponse = await connection.recvInitial(message.id);

      if (this.isClosed) {
        this.options.registry.discard(connection.connectionId);
        return;
      }

      this.preparedConnection = undefined;
      if (negotiatedProtocolVersion(initialResponse) === 2) {
        connection.enableBatches();
      }
      this.connection = connection;
      this.options.registry.register(connection);
      connection.startRouter();
      connection.startConnectHandlers();

      this.send(
        (batched ? [initialResponse] : initialResponse) as AnyWireMessage,
      );
      this.startOutboundPump(connection);
    } catch (error) {
      this.preparedConnection = undefined;
      this.options.registry.discard(connection.connectionId);

      const response: AnyMessage = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message: "Initialize failed",
          data: error instanceof Error ? error.message : undefined,
        },
      };
      this.send((batched ? [response] : response) as AnyWireMessage);

      await this.shutdown(1011, "Initialize failed");
    }
  }

  private async forwardMessage(
    message: AnyWireMessage,
  ): Promise<ForwardResult> {
    const connection = this.connection;

    if (!connection) {
      return {
        ok: false,
        message: "ACP WebSocket connection is not initialized",
      };
    }

    if (Array.isArray(message)) {
      if (!connection.batchesEnabled) {
        await this.shutdown(1002, "JSON-RPC batches require ACP v2");
        return {
          ok: false,
          message: "JSON-RPC batches require ACP v2",
        };
      }

      if (message.some(isDuplicateInitializeRequest)) {
        await this.shutdown(
          1002,
          "Initialize not allowed on existing connection",
        );
        return {
          ok: false,
          message: "Initialize not allowed on existing connection",
        };
      }

      for (const item of message) {
        this.trackInboundRoutes(item);
      }

      return await this.forwardToAgent(connection, message);
    }

    if (isRequestMessage(message) && isInitializeRequest(message)) {
      await this.waitForSocketCapacity();
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32600,
          message: "Initialize not allowed on existing connection",
        },
      });
      return {
        ok: false,
        message: "Initialize not allowed on existing connection",
      };
    }

    this.trackInboundRoutes(message as AnyMessage);
    return await this.forwardToAgent(connection, message);
  }

  private async forwardToAgent(
    connection: ConnectionState,
    message: AnyWireMessage,
  ): Promise<ForwardResult> {
    // A reply adds output, so first wait until the client has read enough to
    // make room: a client that is not reading cannot make the agent produce
    // more.
    if (needsReply(message)) {
      await connection.waitForOutboundCapacity();
      await this.waitForSocketCapacity();
    }

    await this.writeInbound(message);
    return { ok: true };
  }

  /**
   * Resolves once the socket holds less than `maxBufferedBytes` that it has
   * not sent, or the session closes. A client that reads none of it for
   * `maxOutputStallMs` is not coming back for it, so the session closes.
   */
  private async waitForSocketCapacity(): Promise<void> {
    const { limits } = this.options.registry;
    let pollMs = SOCKET_POLL_INITIAL_MS;
    let unsentBytes = this.socket.bufferedAmount ?? 0;
    let stalledMs = 0;

    while (!this.isClosed && unsentBytes >= limits.maxBufferedBytes) {
      if (stalledMs >= limits.maxOutputStallMs) {
        this.closeForLimit(connectionOutputStalled(limits));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      stalledMs += pollMs;
      pollMs = Math.min(pollMs * 2, SOCKET_POLL_MAX_MS);

      const previousUnsentBytes = unsentBytes;
      unsentBytes = this.socket.bufferedAmount ?? 0;
      if (unsentBytes < previousUnsentBytes) {
        // The client read some of it.
        stalledMs = 0;
      }
    }
  }

  private trackInboundRoutes(message: unknown): void {
    const connection = this.connection;

    if (!connection) {
      return;
    }

    if (isRequestMessage(message)) {
      const route = determineWebSocketRoute(message);

      if (route !== "connection") {
        connection.validateSessionId(route.session);
      }
      connection.validateRequestId(message.id);

      const key = messageIdKey(message.id);
      if (key) {
        connection.pendingRoutes.set(
          key,
          message.method === AGENT_METHODS.session_load ? "connection" : route,
        );
      }
      return;
    }

    if (isNotificationMessage(message)) {
      const route = determineWebSocketRoute(message);
      if (route !== "connection") {
        connection.validateSessionId(route.session);
      }
      return;
    }

    if (isResponseShapedMessage(message)) {
      const id = message["id"];
      const key =
        id === null ||
        typeof id === "string" ||
        (typeof id === "number" && Number.isFinite(id))
          ? messageIdKey(id)
          : undefined;
      if (key) {
        connection.clientResponseRoutes.delete(key);
      }
    }
  }

  private async writeInbound(message: AnyWireMessage): Promise<void> {
    const connection = this.connection;

    if (!connection) {
      throw new Error("ACP WebSocket connection is not initialized");
    }

    const write = this.inboundWriteChain.then(() =>
      writeInbound(connection, message),
    );
    this.inboundWriteChain = write.catch(() => undefined);
    await write;
  }

  private startOutboundPump(connection: ConnectionState): void {
    const lease = connection.allOutbound.tryAcquire();
    if (!lease) {
      void this.shutdown(
        1011,
        "Outbound stream already has an active receiver",
      );
      return;
    }
    this.outboundLease = lease;

    // The connection stops the lease when it shuts down, even while the pump
    // waits for the client to read, so close the socket then.
    lease.stopped.addEventListener(
      "abort",
      () => {
        void this.closeForStoppedConnection(lease.stopped.reason);
      },
      { once: true },
    );

    void (async () => {
      try {
        while (!this.isClosed) {
          const result = await lease.receive();

          if (result.done) {
            return;
          }

          if (!this.send(result.value)) {
            return;
          }

          // Take nothing more from the router while the client is behind,
          // which in turn makes the agent's sends wait.
          await this.waitForSocketCapacity();
        }
      } catch (error) {
        // receive() fails once the connection stops the lease, and the
        // connection logs why; anything else is unexpected.
        if (!lease.stopped.aborted) {
          console.error("ACP WebSocket outbound pump failed:", error);
        }
        await this.closeForStoppedConnection(error);
      } finally {
        if (this.outboundLease === lease) {
          this.outboundLease = undefined;
        }

        lease.release();

        if (!this.isClosed) {
          void this.shutdown();
        }
      }
    })();
  }

  private send(message: AnyWireMessage): boolean {
    if (this.isClosed) {
      return false;
    }

    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.warn("Failed to send ACP WebSocket message:", error);
      void this.shutdown(1011, "Failed to send message");
      return false;
    }
  }

  private closeForLimit(error: ConnectionLimitError): void {
    const connectionId =
      this.connection?.connectionId ?? this.preparedConnection?.connectionId;
    const label = connectionId
      ? `ACP connection ${connectionId}`
      : "ACP connection";
    console.warn(`Closing ${label}:`, error.message);
    void this.shutdown(1008, error.message);
  }

  /**
   * Closes the socket for the reason its connection shut down, which the
   * connection has already logged if it broke a limit.
   */
  private async closeForStoppedConnection(reason: unknown): Promise<void> {
    if (this.isClosed) {
      return;
    }

    if (reason instanceof ConnectionLimitError) {
      await this.shutdown(1008, reason.message);
    } else if (reason instanceof ConnectionClosedError) {
      await this.shutdown();
    } else {
      await this.shutdown(1011, "Internal error");
    }
  }

  private async shutdownIfUninitialized(
    code?: number,
    reason?: string,
  ): Promise<void> {
    if (this.connection) {
      return;
    }

    await this.shutdown(code, reason);
  }

  private async shutdown(code?: number, reason?: string): Promise<void> {
    this.closeSocket(code, reason);
    await this.closeSession();
  }

  private closeSocket(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason);
    } catch (error) {
      console.warn("Failed to close ACP WebSocket:", error);
    }
  }

  private async closeSession(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    try {
      for (const detach of this.detachListeners.splice(0)) {
        detach();
      }

      const outboundLease = this.outboundLease;
      this.outboundLease = undefined;

      outboundLease?.release();

      if (this.connection) {
        this.options.registry.discard(this.connection.connectionId);
        this.connection = undefined;
      }

      if (this.preparedConnection) {
        this.options.registry.discard(this.preparedConnection.connectionId);
        this.preparedConnection = undefined;
      }
    } finally {
      this.resolveClosed();
    }
  }
}

async function writeInbound(
  connection: ConnectionState,
  message: AnyWireMessage,
): Promise<void> {
  await connection.writeInbound(message);
}

function determineWebSocketRoute(message: AnyCall): ResponseRoute {
  const sessionId = sessionIdFromParams(message.params);

  if (sessionId) {
    return {
      session: sessionId,
    };
  }

  return "connection";
}

/**
 * Whether the agent replies to a message, so forwarding it adds output. This
 * follows how the agent answers: an empty batch is an error, and a batch of
 * calls gets a reply for each entry that is not a notification.
 */
function needsReply(message: unknown): boolean {
  if (Array.isArray(message)) {
    return (
      message.length === 0 ||
      (!isResponseBatch(message) &&
        !message.every((entry) => isNotificationMessage(entry)))
    );
  }

  return !isNotificationMessage(message) && !isResponseShapedMessage(message);
}

function isDuplicateInitializeRequest(message: unknown): boolean {
  return isRequestMessage(message) && isInitializeRequest(message);
}

function negotiatedProtocolVersion(response: AnyMessage): number | undefined {
  if (!("result" in response) || !isRecord(response.result)) {
    return undefined;
  }

  const protocolVersion = response.result["protocolVersion"];
  return typeof protocolVersion === "number" ? protocolVersion : undefined;
}
