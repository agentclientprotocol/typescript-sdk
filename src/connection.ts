import { HttpBackendStreamInUseError } from "./http-backend.js";
import { isResponseMessage } from "./jsonrpc.js";
import {
  messageIdKey,
  sessionIdFromMessageParams,
  sessionIdFromResponseResult,
} from "./protocol.js";

import type {
  AnyMessage,
  AnyResponse,
  AnyWireMessage,
  JsonRpcRequestIdGenerator,
} from "./jsonrpc.js";
import type { WireStream } from "./stream.js";
import type {
  AcpHttpBackend,
  HttpBackendAcceptClientMethodMessageInput,
  HttpBackendAcceptClientResponseInput,
  HttpBackendAcceptResult,
  HttpBackendCloseConnectionInput,
  HttpBackendInitializeInput,
  HttpBackendInitializeResult,
  HttpBackendLoadConnectionInput,
  HttpBackendLoadedConnection,
  HttpBackendOpenConnectionStreamInput,
  HttpBackendOpenSessionStreamInput,
  HttpBackendTouchConnectionInput,
} from "./http-backend.js";

export interface AgentConnectOptions {
  readonly deferConnectHandlers?: boolean;
  readonly requestIdGenerator?: JsonRpcRequestIdGenerator;
}

export interface AgentConnectionLifecycle {
  readonly closed?: Promise<void>;
  startConnectHandlers?(): void;
}

export interface AgentConnector {
  connect(
    stream: WireStream,
    options?: AgentConnectOptions,
  ): AgentConnectionLifecycle | unknown;
}

export type ResponseRoute = "connection" | { readonly session: string };

export interface OutboundLease<Message extends AnyWireMessage = AnyMessage> {
  receive(): Promise<IteratorResult<Message>>;
  release(): void;
}

export class OutboundMailbox<Message extends AnyWireMessage = AnyMessage> {
  private readonly queue: Message[] = [];
  private activeLease: MailboxLease<Message> | undefined;
  private isFinished = false;
  private isAborted = false;

  constructor(private readonly enabled = true) {}

  push(message: Message): void {
    if (!this.enabled || this.isFinished) {
      return;
    }

    this.queue.push(message);
    this.activeLease?.wake();
  }

  tryAcquire(): OutboundLease<Message> | undefined {
    if (!this.enabled || this.isAborted || this.activeLease) {
      return undefined;
    }

    const lease = new MailboxLease(this);
    this.activeLease = lease;
    return lease;
  }

  finish(): void {
    if (this.isFinished) {
      return;
    }

    this.isFinished = true;
    this.activeLease?.wake();
  }

  abort(): void {
    if (this.isAborted) {
      return;
    }

    this.isAborted = true;
    this.isFinished = true;
    this.queue.length = 0;
    this.activeLease?.wake();
  }

  /** @internal */
  async receive(
    lease: MailboxLease<Message>,
  ): Promise<IteratorResult<Message>> {
    for (;;) {
      if (this.isAborted || lease.released || this.activeLease !== lease) {
        return { done: true, value: undefined };
      }

      if (this.queue.length > 0) {
        return {
          done: false,
          value: this.queue.shift() as Message,
        };
      }

      if (this.isFinished) {
        return { done: true, value: undefined };
      }

      await lease.wait();
    }
  }

  /** @internal */
  release(lease: MailboxLease<Message>): void {
    if (this.activeLease !== lease) {
      return;
    }

    this.activeLease = undefined;
    lease.markReleased();
  }
}

export type ConnectionTransport = "http" | "websocket";

export class ConnectionState {
  readonly connectionId: string;
  readonly inboundTx: WritableStream<AnyWireMessage>;
  readonly outboundRx: ReadableStream<AnyWireMessage>;
  readonly connectionStream: OutboundMailbox;
  readonly allOutbound: OutboundMailbox<AnyWireMessage>;
  readonly sessionStreams = new Map<string, OutboundMailbox>();
  readonly pendingRoutes = new Map<string, ResponseRoute>();
  readonly clientResponseRoutes = new Map<string, ResponseRoute>();
  readonly closed: Promise<void>;

  private readonly agentConnection: AgentConnectionLifecycle | unknown;
  private supportsBatches = false;
  private hasStartedRouter = false;
  private inboundWriteChain: Promise<void> = Promise.resolve();
  private initialReader:
    ReadableStreamDefaultReader<AnyWireMessage> | undefined;
  private outboundReader:
    ReadableStreamDefaultReader<AnyWireMessage> | undefined;
  private routerPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private hasResolvedClosed = false;
  private finishAgentOutbound: () => void = () => {};
  private resolveClosed: () => void = () => {};

  constructor(
    agent: AgentConnector,
    private readonly transport: ConnectionTransport = "http",
    options: AgentConnectOptions = {},
  ) {
    this.connectionId = globalThis.crypto.randomUUID();
    this.connectionStream = new OutboundMailbox(transport === "http");
    this.allOutbound = new OutboundMailbox<AnyWireMessage>(
      transport === "websocket",
    );
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const inbound = new TransformStream<AnyWireMessage, AnyWireMessage>();
    const outbound = createBufferedOutboundChannel((message) => {
      if (!this.supportsBatches && Array.isArray(message)) {
        throw new TypeError(
          "AcpServer transports do not support outbound JSON-RPC batch messages",
        );
      }
    });

    this.inboundTx = inbound.writable;
    this.outboundRx = outbound.readable;
    this.finishAgentOutbound = outbound.finish;

    const stream: WireStream = {
      readable: inbound.readable,
      writable: outbound.writable,
    };

    this.agentConnection = agent.connect(stream, {
      deferConnectHandlers: true,
      requestIdGenerator: options.requestIdGenerator,
    });
    this.observeAgentConnection();
  }

  async recvInitial(initializeId: string | number): Promise<AnyResponse> {
    const reader = this.outboundRx.getReader();
    this.initialReader = reader;

    try {
      const result = await reader.read();

      if (
        result.done ||
        !result.value ||
        !isMatchingResponse(result.value, initializeId)
      ) {
        if (!this.shutdownPromise) {
          await this.shutdown();
        }

        throw new Error("Expected initialize response from agent");
      }

      return result.value;
    } finally {
      if (this.initialReader === reader) {
        this.initialReader = undefined;
      }

      reader.releaseLock();
    }
  }

  async writeInbound(message: AnyWireMessage): Promise<void> {
    if (!this.supportsBatches && Array.isArray(message)) {
      throw new TypeError(
        "AcpServer transports do not support inbound JSON-RPC batch messages",
      );
    }

    const write = this.inboundWriteChain.then(() =>
      this.writeInboundMessage(message),
    );
    this.inboundWriteChain = write.catch(() => undefined);
    await write;
  }

  startRouter(): void {
    if (this.hasStartedRouter) {
      return;
    }

    this.hasStartedRouter = true;
    this.routerPromise = this.runRouter();
  }

  startConnectHandlers(): void {
    if (
      typeof this.agentConnection === "object" &&
      this.agentConnection !== null &&
      "startConnectHandlers" in this.agentConnection &&
      typeof this.agentConnection.startConnectHandlers === "function"
    ) {
      this.agentConnection.startConnectHandlers();
    }
  }

  /** Enables JSON-RPC batch frames after ACP v2 is negotiated. */
  enableBatches(): void {
    this.supportsBatches = true;
  }

  get batchesEnabled(): boolean {
    return this.supportsBatches;
  }

  ensureSession(sessionId: string): OutboundMailbox {
    const existing = this.sessionStreams.get(sessionId);
    if (existing) {
      return existing;
    }

    const stream = new OutboundMailbox(this.transport === "http");
    this.sessionStreams.set(sessionId, stream);

    return stream;
  }

  trackPendingResponseRoute(key: string, route: ResponseRoute): void {
    this.pendingRoutes.set(key, route);
  }

  clientResponseRoute(key: string): ResponseRoute | undefined {
    return this.clientResponseRoutes.get(key);
  }

  clearClientResponseRoute(key: string): void {
    this.clientResponseRoutes.delete(key);
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown();
    }

    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    try {
      this.connectionStream.abort();
      this.allOutbound.abort();

      for (const stream of this.sessionStreams.values()) {
        stream.abort();
      }

      this.sessionStreams.clear();
      this.pendingRoutes.clear();
      this.clientResponseRoutes.clear();

      await Promise.allSettled([
        this.inboundTx.close(),
        this.cancelOutboundReader(),
      ]);
    } finally {
      this.resolveClosedOnce();
    }
  }

  private observeAgentConnection(): void {
    if (
      typeof this.agentConnection !== "object" ||
      this.agentConnection === null ||
      !("closed" in this.agentConnection) ||
      !this.agentConnection.closed
    ) {
      return;
    }

    void Promise.resolve(this.agentConnection.closed).finally(async () => {
      if (!this.hasStartedRouter) {
        await this.shutdown();
        return;
      }

      this.finishAgentOutbound();
      await this.routerPromise;
    });
  }

  private cancelOutboundReader(): Promise<void> {
    const reader = this.initialReader ?? this.outboundReader;
    if (reader) {
      return reader.cancel();
    }

    return this.outboundRx.cancel();
  }

  private async writeInboundMessage(message: AnyWireMessage): Promise<void> {
    const writer = this.inboundTx.getWriter();

    try {
      await writer.write(message);
    } finally {
      writer.releaseLock();
    }
  }

  private async runRouter(): Promise<void> {
    const reader = this.outboundRx.getReader();
    this.outboundReader = reader;

    try {
      while (true) {
        const result = await reader.read();

        if (result.done) {
          return;
        }

        this.routeOutbound(result.value);
      }
    } catch (error) {
      console.error("ACP connection router stopped unexpectedly:", error);
    } finally {
      if (this.outboundReader === reader) {
        this.outboundReader = undefined;
      }

      reader.releaseLock();
      this.connectionStream.finish();
      this.allOutbound.finish();

      for (const stream of this.sessionStreams.values()) {
        stream.finish();
      }

      this.resolveClosedOnce();
    }
  }

  private resolveClosedOnce(): void {
    if (this.hasResolvedClosed) {
      return;
    }

    this.hasResolvedClosed = true;
    this.resolveClosed();
  }

  private routeOutbound(message: AnyWireMessage): void {
    this.allOutbound.push(message);

    if (Array.isArray(message)) {
      for (const item of message) {
        this.routeOutboundMessage(item);
      }
      return;
    }

    this.routeOutboundMessage(message as AnyMessage);
  }

  private routeOutboundMessage(message: AnyMessage): void {
    if (isResponseMessage(message)) {
      this.routeOutboundResponse(message);
      return;
    }

    this.routeOutboundRequestOrNotification(message);
  }

  private routeOutboundResponse(message: AnyResponse): void {
    const key = messageIdKey(message.id);
    const route = key ? this.pendingRoutes.get(key) : undefined;
    const sessionId = sessionIdFromResponseResult(message);

    if (sessionId) {
      this.ensureSession(sessionId);
    }

    if (key) {
      this.pendingRoutes.delete(key);
    }

    this.pushToRoute(route ?? "connection", message);
  }

  private routeOutboundRequestOrNotification(message: AnyMessage): void {
    const sessionId = sessionIdFromMessageParams(message);
    if (sessionId) {
      this.trackClientResponseRoute(message, { session: sessionId });
      this.ensureSession(sessionId).push(message);
      return;
    }

    this.trackClientResponseRoute(message, "connection");
    this.connectionStream.push(message);
  }

  private trackClientResponseRoute(
    message: AnyMessage,
    route: ResponseRoute,
  ): void {
    if (!("id" in message) || !("method" in message)) {
      return;
    }

    const key = messageIdKey(message.id);
    if (key) {
      this.clientResponseRoutes.set(key, route);
    }
  }

  private pushToRoute(route: ResponseRoute, message: AnyMessage): void {
    if (route === "connection") {
      this.connectionStream.push(message);
      return;
    }

    this.ensureSession(route.session).push(message);
  }
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly pendingConnections = new Map<string, ConnectionState>();

  createConnection(
    agent: AgentConnector,
    transport: ConnectionTransport = "http",
    options: AgentConnectOptions = {},
  ): ConnectionState {
    const connection = new ConnectionState(agent, transport, options);
    this.connections.set(connection.connectionId, connection);
    this.trackConnectionClose(connection);
    return connection;
  }

  createPendingConnection(
    agent: AgentConnector,
    transport: ConnectionTransport = "websocket",
    options: AgentConnectOptions = {},
  ): ConnectionState {
    const connection = new ConnectionState(agent, transport, options);
    this.pendingConnections.set(connection.connectionId, connection);
    this.trackConnectionClose(connection);
    return connection;
  }

  register(connection: ConnectionState): void {
    this.pendingConnections.delete(connection.connectionId);
    this.connections.set(connection.connectionId, connection);
  }

  get(connectionId: string): ConnectionState | undefined {
    return this.connections.get(connectionId);
  }

  remove(connectionId: string): ConnectionState | undefined {
    const connection = this.get(connectionId);

    if (!connection) {
      return undefined;
    }

    this.connections.delete(connectionId);
    void connection.shutdown();
    return connection;
  }

  discard(connectionId: string): ConnectionState | undefined {
    const connection =
      this.connections.get(connectionId) ??
      this.pendingConnections.get(connectionId);

    if (!connection) {
      return undefined;
    }

    this.connections.delete(connectionId);
    this.pendingConnections.delete(connectionId);
    void connection.shutdown();
    return connection;
  }

  async closeAll(): Promise<void> {
    const connections = new Set([
      ...this.connections.values(),
      ...this.pendingConnections.values(),
    ]);
    this.connections.clear();
    this.pendingConnections.clear();

    await Promise.all(
      Array.from(connections, (connection) => connection.shutdown()),
    );
  }

  private trackConnectionClose(connection: ConnectionState): void {
    void connection.closed.then(() => {
      if (this.connections.get(connection.connectionId) === connection) {
        this.connections.delete(connection.connectionId);
      }
      if (this.pendingConnections.get(connection.connectionId) === connection) {
        this.pendingConnections.delete(connection.connectionId);
      }
    });
  }
}

export class InMemoryAcpHttpBackend implements AcpHttpBackend {
  constructor(
    private readonly registry = new ConnectionRegistry(),
    readonly generateServerRequestId?: JsonRpcRequestIdGenerator,
  ) {}

  async initialize({
    agent,
    message,
    signal,
  }: HttpBackendInitializeInput): Promise<HttpBackendInitializeResult> {
    if (!("id" in message) || message.id === null) {
      throw new Error("Initialize request must include an ID");
    }

    const connection = this.registry.createPendingConnection(agent, "http", {
      requestIdGenerator: this.generateServerRequestId,
    });

    try {
      await connection.writeInbound(message);
      const response = await connection.recvInitial(message.id);

      if (signal.aborted) {
        throw new Error("Request aborted");
      }

      connection.startRouter();
      this.registry.register(connection);
      connection.startConnectHandlers();

      return {
        connectionId: connection.connectionId,
        response,
      };
    } catch (error) {
      this.registry.discard(connection.connectionId);
      throw error;
    }
  }

  async loadConnection({
    connectionId,
  }: HttpBackendLoadConnectionInput): Promise<
    HttpBackendLoadedConnection | undefined
  > {
    const connection = this.registry.get(connectionId);

    if (!connection) {
      return undefined;
    }

    return { connectionId };
  }

  async touchConnection(
    _input: HttpBackendTouchConnectionInput,
  ): Promise<void> {
    // In-memory connections do not need TTL refresh.
  }

  async acceptClientMethodMessage({
    connectionId,
    message,
    route,
    responseRoute,
  }: HttpBackendAcceptClientMethodMessageInput): Promise<HttpBackendAcceptResult> {
    const connection = this.registry.get(connectionId);

    if (!connection) {
      return {
        ok: false,
        status: 404,
        message: "Unknown Acp-Connection-Id",
      };
    }

    if (route !== "connection") {
      connection.ensureSession(route.session);
    }

    const key = "id" in message ? messageIdKey(message.id) : undefined;
    if (key) {
      connection.trackPendingResponseRoute(key, responseRoute);
    }

    await connection.writeInbound(message);
    return { ok: true };
  }

  async acceptClientResponse({
    connectionId,
    message,
    headerSessionId,
  }: HttpBackendAcceptClientResponseInput): Promise<HttpBackendAcceptResult> {
    const connection = this.registry.get(connectionId);

    if (!connection) {
      return {
        ok: false,
        status: 404,
        message: "Unknown Acp-Connection-Id",
      };
    }

    const key = messageIdKey(message.id);
    const route = key ? connection.clientResponseRoute(key) : undefined;

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
      connection.clearClientResponseRoute(key);
    }

    await connection.writeInbound(message);
    return { ok: true };
  }

  async openConnectionStream({
    connectionId,
  }: HttpBackendOpenConnectionStreamInput): Promise<OutboundLease | undefined> {
    const connection = this.registry.get(connectionId);
    if (!connection) return undefined;
    const lease = connection.connectionStream.tryAcquire();
    if (!lease) throw new HttpBackendStreamInUseError();
    return lease;
  }

  async openSessionStream({
    connectionId,
    sessionId,
  }: HttpBackendOpenSessionStreamInput): Promise<OutboundLease | undefined> {
    const connection = this.registry.get(connectionId);
    if (!connection) return undefined;
    const lease = connection.ensureSession(sessionId).tryAcquire();
    if (!lease) throw new HttpBackendStreamInUseError();
    return lease;
  }

  async closeConnection({
    connectionId,
  }: HttpBackendCloseConnectionInput): Promise<boolean> {
    return Boolean(this.registry.remove(connectionId));
  }

  async close(): Promise<void> {
    await this.registry.closeAll();
  }
}

class MailboxLease<
  Message extends AnyWireMessage,
> implements OutboundLease<Message> {
  released = false;

  private receiving = false;
  private wakePromise: Promise<void> | undefined;
  private resolveWake: (() => void) | undefined;

  constructor(private readonly mailbox: OutboundMailbox<Message>) {}

  async receive(): Promise<IteratorResult<Message>> {
    if (this.receiving) {
      throw new Error(
        "ACP outbound mailbox lease already has a pending receive",
      );
    }

    this.receiving = true;
    try {
      return await this.mailbox.receive(this);
    } finally {
      this.receiving = false;
    }
  }

  release(): void {
    this.mailbox.release(this);
  }

  wake(): void {
    this.resolveWake?.();
    this.wakePromise = undefined;
    this.resolveWake = undefined;
  }

  wait(): Promise<void> {
    if (!this.wakePromise) {
      this.wakePromise = new Promise((resolve) => {
        this.resolveWake = resolve;
      });
    }

    return this.wakePromise;
  }

  markReleased(): void {
    this.released = true;
    this.wake();
  }
}

function createBufferedOutboundChannel(
  validate: (message: AnyWireMessage) => void,
): {
  readonly readable: ReadableStream<AnyWireMessage>;
  readonly writable: WritableStream<AnyWireMessage>;
  readonly finish: () => void;
} {
  let controller: ReadableStreamDefaultController<AnyWireMessage> | undefined;
  let isFinished = false;

  const finish = (): void => {
    if (isFinished) {
      return;
    }

    isFinished = true;
    try {
      controller?.close();
    } catch {
      // The router may already have cancelled the readable side.
    }
  };
  const fail = (error: unknown): void => {
    if (isFinished) {
      return;
    }

    isFinished = true;
    try {
      controller?.error(error);
    } catch {
      // The router may already have cancelled the readable side.
    }
  };

  return {
    readable: new ReadableStream<AnyWireMessage>({
      start(readableController) {
        controller = readableController;
      },
      cancel() {
        isFinished = true;
      },
    }),
    writable: new WritableStream<AnyWireMessage>({
      write(message) {
        if (isFinished) {
          throw new Error("ACP outbound channel is closed");
        }

        try {
          validate(message);
          controller?.enqueue(message);
        } catch (error) {
          fail(error);
          throw error;
        }
      },
      close: finish,
      abort: fail,
    }),
    finish,
  };
}

function isMatchingResponse(
  msg: AnyWireMessage,
  id: string | number,
): msg is AnyResponse {
  return (
    !Array.isArray(msg) && "id" in msg && !("method" in msg) && msg.id === id
  );
}
