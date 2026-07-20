import { isResponseMessage } from "./jsonrpc.js";
import {
  messageIdKey,
  sessionIdFromMessageParams,
  sessionIdFromResponseResult,
} from "./protocol.js";

import type { AnyMessage, AnyResponse, AnyWireMessage } from "./jsonrpc.js";
import type { WireStream } from "./stream.js";

export interface AgentConnectOptions {
  readonly deferConnectHandlers?: boolean;
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

export interface OutboundSubscription<
  Message extends AnyWireMessage = AnyMessage,
> {
  readonly replay: readonly Message[];
  readonly stream: ReadableStream<Message>;
}

export class OutboundStream<Message extends AnyWireMessage = AnyMessage> {
  private readonly subscribers = new Set<OutboundSubscriber<Message>>();
  private replayBuffer: Message[] = [];
  private hasSubscriber = false;
  private isClosed = false;

  constructor(private readonly capacity = 1024) {}

  push(message: Message): void {
    if (this.isClosed) {
      return;
    }

    if (!this.hasSubscriber) {
      this.replayBuffer.push(message);

      if (this.replayBuffer.length > this.capacity) {
        this.replayBuffer.shift();
      }

      return;
    }

    for (const subscriber of this.subscribers) {
      subscriber.push(message);
    }
  }

  subscribe(): OutboundSubscription<Message> {
    const replay = this.hasSubscriber ? [] : [...this.replayBuffer];
    this.replayBuffer = [];
    this.hasSubscriber = true;

    const subscriber = new OutboundSubscriber<Message>(
      this.capacity,
      (item) => {
        this.subscribers.delete(item);
      },
    );

    this.subscribers.add(subscriber);

    if (this.isClosed) {
      subscriber.close();
    }

    return {
      replay,
      stream: subscriber.stream,
    };
  }

  close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.replayBuffer = [];

    for (const subscriber of this.subscribers) {
      subscriber.close();
    }

    this.subscribers.clear();
  }
}

export class ConnectionState {
  readonly connectionId: string;
  readonly inboundTx: WritableStream<AnyWireMessage>;
  readonly outboundRx: ReadableStream<AnyWireMessage>;
  readonly connectionStream = new OutboundStream();
  readonly allOutbound = new OutboundStream<AnyWireMessage>();
  readonly sessionStreams = new Map<string, OutboundStream>();
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
  private shutdownPromise: Promise<void> | undefined;
  private resolveClosed: () => void = () => {};

  constructor(agent: AgentConnector) {
    this.connectionId = globalThis.crypto.randomUUID();
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const inbound = new TransformStream<AnyWireMessage, AnyWireMessage>();
    const outbound = new TransformStream<AnyWireMessage, AnyWireMessage>({
      transform: (message, controller) => {
        if (!this.supportsBatches && Array.isArray(message)) {
          throw new TypeError(
            "AcpServer transports do not support outbound JSON-RPC batch messages",
          );
        }

        controller.enqueue(message);
      },
    });

    this.inboundTx = inbound.writable;
    this.outboundRx = outbound.readable;

    const stream: WireStream = {
      readable: inbound.readable,
      writable: outbound.writable,
    };

    this.agentConnection = agent.connect(stream, {
      deferConnectHandlers: true,
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
    void this.runRouter();
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

  ensureSession(sessionId: string): OutboundStream {
    const existing = this.sessionStreams.get(sessionId);
    if (existing) {
      return existing;
    }

    const stream = new OutboundStream();
    this.sessionStreams.set(sessionId, stream);

    return stream;
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown();
    }

    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    try {
      this.connectionStream.close();
      this.allOutbound.close();

      for (const stream of this.sessionStreams.values()) {
        stream.close();
      }

      this.sessionStreams.clear();
      this.pendingRoutes.clear();
      this.clientResponseRoutes.clear();

      await Promise.allSettled([
        this.inboundTx.close(),
        this.cancelOutboundReader(),
      ]);
    } finally {
      this.resolveClosed();
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

    void Promise.resolve(this.agentConnection.closed).finally(() => {
      void this.shutdown();
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
      this.connectionStream.close();
      this.allOutbound.close();

      for (const stream of this.sessionStreams.values()) {
        stream.close();
      }
    }
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

  createConnection(agent: AgentConnector): ConnectionState {
    const connection = new ConnectionState(agent);
    this.connections.set(connection.connectionId, connection);
    this.trackConnectionClose(connection);
    return connection;
  }

  createPendingConnection(agent: AgentConnector): ConnectionState {
    const connection = new ConnectionState(agent);
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

class OutboundSubscriber<Message extends AnyWireMessage> {
  readonly stream: ReadableStream<Message>;

  private controller: ReadableStreamDefaultController<Message> | undefined;
  private queue: Message[] = [];
  private isClosed = false;
  private hasWarnedAboutOverflow = false;

  constructor(
    private readonly capacity: number,
    private readonly onCancel: (
      subscriber: OutboundSubscriber<Message>,
    ) => void,
  ) {
    this.stream = new ReadableStream<Message>({
      start: (controller) => {
        this.controller = controller;
        this.flush();
      },
      pull: () => {
        this.flush();
      },
      cancel: () => {
        this.cancel();
      },
    });
  }

  push(message: Message): void {
    if (this.isClosed) {
      return;
    }

    this.queue.push(message);

    if (this.queue.length > this.capacity) {
      this.queue.shift();

      if (!this.hasWarnedAboutOverflow) {
        console.warn("ACP outbound subscriber lagged; dropping oldest message");
        this.hasWarnedAboutOverflow = true;
      }
    }

    this.flush();
  }

  close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.queue = [];
    this.controller?.close();
  }

  private cancel(): void {
    this.isClosed = true;
    this.queue = [];
    this.onCancel(this);
  }

  private flush(): void {
    if (!this.controller) {
      return;
    }

    while (
      this.queue.length > 0 &&
      this.controller.desiredSize !== null &&
      this.controller.desiredSize > 0
    ) {
      const message = this.queue.shift();

      if (!message) {
        return;
      }

      this.controller.enqueue(message);
    }

    if (this.queue.length === 0) {
      this.hasWarnedAboutOverflow = false;
    }
  }
}

function isMatchingResponse(
  msg: AnyWireMessage,
  id: string | number,
): msg is AnyResponse {
  return (
    !Array.isArray(msg) && "id" in msg && !("method" in msg) && msg.id === id
  );
}
