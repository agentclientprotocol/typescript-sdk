import { isResponseMessage } from "./jsonrpc.js";
import {
  messageIdKey,
  sessionIdFromMessageParams,
  sessionIdFromResponseResult,
} from "./protocol.js";

import type { AnyMessage, AnyResponse, AnyWireMessage } from "./jsonrpc.js";
import type { WireStream } from "./stream.js";

/** Default for {@link ConnectionLimits.maxBufferedBytes}: 64 MiB. */
export const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Default for {@link ConnectionLimits.maxOutputStallMs}: 60 seconds. */
export const DEFAULT_MAX_OUTPUT_STALL_MS = 60_000;
/** Default for {@link ConnectionLimits.maxBufferedSessionStreams}: 1024. */
export const DEFAULT_MAX_BUFFERED_SESSION_STREAMS = 1024;
/** Default for {@link ConnectionLimits.maxIdLength}: 1024. */
export const DEFAULT_MAX_ID_LENGTH = 1024;

/** The longest a timer can wait; timers fire at once past it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Per-connection limits on the state an ACP server keeps for a client. */
export interface ConnectionLimits {
  /**
   * Maximum agent output a connection holds for its client before the client
   * reads it. When a connection reaches the limit, it stops taking output
   * from the agent and holds back client requests until the client reads;
   * see `maxOutputStallMs` for a client that does not. Only an agent that
   * awaits its sends is slowed down, and output can pass the limit by a
   * message or two.
   *
   * Streamable HTTP connections count the output queued on all their
   * streams, including streams the client has not opened, by the length of
   * its JSON text in UTF-16 code units. Text outside Latin-1 takes twice that
   * in memory. Held-back requests stay open with their bodies, so limit how
   * many requests a client may have open in the HTTP server or proxy.
   * Requests the agent has accepted but not answered are not counted; bound
   * those in the agent.
   *
   * WebSocket connections count the bytes the socket reports as not yet sent
   * (`bufferedAmount`), and do not limit output if the socket does not report
   * it. They also close when client messages waiting to be handled exceed the
   * limit, each counted as its length plus 1 KiB, so keep the WebSocket
   * server's maximum message size below it.
   * Defaults to {@link DEFAULT_MAX_BUFFERED_BYTES}.
   */
  readonly maxBufferedBytes?: number;
  /**
   * Maximum time, in milliseconds, a connection holding `maxBufferedBytes`
   * waits for its client to read any of it. The connection then closes,
   * which frees the agent, and client requests held back, from a client that
   * stopped reading or never opens the stream its output is for; memory
   * stays bounded meanwhile. On WebSocket connections, any bytes the socket
   * sends count as reading. At most 2^31 - 1 (about 24.8 days), the longest
   * a timer can wait. Defaults to {@link DEFAULT_MAX_OUTPUT_STALL_MS}.
   */
  readonly maxOutputStallMs?: number;
  /**
   * Maximum sessions per Streamable HTTP connection holding messages that no
   * client is receiving, such as responses for a session whose stream was
   * never opened. The connection closes when agent output would buffer
   * another session, or when a client leaves a session stream with messages
   * still queued past the limit. Open session streams are not counted: each
   * is backed by an open request, so the embedding HTTP server or proxy must
   * limit how many a client may hold. WebSocket connections deliver
   * everything over the socket and never buffer per session. Defaults to
   * {@link DEFAULT_MAX_BUFFERED_SESSION_STREAMS}.
   */
  readonly maxBufferedSessionStreams?: number;
  /**
   * Maximum length, in UTF-16 code units, of the session IDs and request IDs
   * a connection keeps track of. Client messages carrying a longer session ID
   * or request ID are rejected (HTTP 400, or WebSocket close code 1008), and
   * a connection whose agent issues a longer session ID is closed. Defaults
   * to {@link DEFAULT_MAX_ID_LENGTH}.
   */
  readonly maxIdLength?: number;
}

/** Raised when a client or agent exceeds a {@link ConnectionLimits} limit. */
export class ConnectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionLimitError";
  }
}

/** Error for a connection that holds more than a limit allows. */
export function connectionLimitExceeded(
  limit: "maxBufferedBytes" | "maxBufferedSessionStreams",
  limits: Required<ConnectionLimits>,
): ConnectionLimitError {
  return new ConnectionLimitError(
    `Connection exceeds ${limit} (${limits[limit]})`,
  );
}

/** Error for a connection whose client read none of its output in time. */
export function connectionOutputStalled(
  limits: Required<ConnectionLimits>,
): ConnectionLimitError {
  return new ConnectionLimitError(
    `Connection output stalled for maxOutputStallMs (${limits.maxOutputStallMs})`,
  );
}

/** Raised when a message is sent to a connection that has shut down. */
export class ConnectionClosedError extends Error {
  constructor() {
    super("ACP connection is closed");
    this.name = "ConnectionClosedError";
  }
}

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

export interface OutboundLease<Message = AnyMessage> {
  /**
   * Aborted when the stream is shut down while this lease holds it, with
   * the error as its reason or a `ConnectionClosedError` if there was none.
   * A receiver waiting on `receive()` learns this from its result; one that
   * is not, such as a response body whose client stopped reading, must stop
   * on this signal.
   */
  readonly stopped: AbortSignal;
  receive(): Promise<IteratorResult<Message>>;
  release(): void;
}

/** Follows what a stream queues, for its connection's accounting. */
export interface OutboundQueueObserver<Message> {
  /** Called as a message is queued. */
  queued?(message: Message): void;
  /** Called as a message leaves the queue, taken by a receiver or dropped. */
  dequeued(message: Message): void;
}

export class OutboundMailbox<Message = AnyMessage> {
  /** Queued messages start at `head`; see `dequeue`. */
  private queue: (Message | undefined)[] = [];
  private head = 0;
  private activeLease: MailboxLease<Message> | undefined;
  private isFinished = false;
  private isAborted = false;
  private abortError: unknown;

  constructor(
    private readonly enabled = true,
    private onReceiverChange?: () => void,
    private observer?: OutboundQueueObserver<Message>,
  ) {}

  push(message: Message): void {
    if (!this.enabled || this.isFinished) {
      return;
    }

    this.queue.push(message);
    this.observer?.queued?.(message);
    this.activeLease?.wake();
  }

  get hasReceiver(): boolean {
    return this.activeLease !== undefined;
  }

  get hasQueuedMessages(): boolean {
    return this.head < this.queue.length;
  }

  tryAcquire(): OutboundLease<Message> | undefined {
    if (!this.enabled || this.isAborted || this.activeLease) {
      return undefined;
    }

    const lease = new MailboxLease(this);
    this.activeLease = lease;
    this.onReceiverChange?.();
    return lease;
  }

  finish(): void {
    if (this.isFinished) {
      return;
    }

    this.isFinished = true;
    this.activeLease?.wake();
  }

  abort(error?: unknown): void {
    if (this.isAborted) {
      return;
    }

    this.isAborted = true;
    this.abortError = error;
    this.isFinished = true;
    while (this.hasQueuedMessages) {
      this.dequeue();
    }

    // Whatever still holds this stream, such as a stalled response body,
    // must not keep its connection reachable.
    this.observer = undefined;
    this.onReceiverChange = undefined;
    this.activeLease?.stop(error ?? new ConnectionClosedError());
  }

  /** @internal */
  async receive(
    lease: MailboxLease<Message>,
  ): Promise<IteratorResult<Message>> {
    for (;;) {
      if (lease.released || this.activeLease !== lease) {
        return { done: true, value: undefined };
      }

      if (this.isAborted) {
        if (this.abortError !== undefined) {
          throw this.abortError;
        }
        return { done: true, value: undefined };
      }

      if (this.hasQueuedMessages) {
        return { done: false, value: this.dequeue() };
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
    this.onReceiverChange?.();
  }

  /**
   * Takes the oldest queued message. `Array.prototype.shift` copies the rest
   * of a large array, which would make draining a full queue quadratic, so
   * this advances `head` instead and drops the taken prefix once the queue
   * empties or is mostly taken.
   */
  private dequeue(): Message {
    const message = this.queue[this.head] as Message;
    this.queue[this.head] = undefined;
    this.head += 1;

    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }

    this.observer?.dequeued(message);
    return message;
  }
}

export type ConnectionTransport = "http" | "websocket";

export class ConnectionState {
  readonly connectionId: string;
  readonly inboundTx: WritableStream<AnyWireMessage>;
  readonly outboundRx: ReadableStream<AnyWireMessage>;
  /** Connection-level HTTP stream, queuing each message as JSON text. */
  readonly connectionStream: OutboundMailbox<string>;
  /** Every outbound message, for WebSocket connections. */
  readonly allOutbound: OutboundMailbox<AnyWireMessage>;
  /** Session-level HTTP streams, queuing each message as JSON text. */
  readonly sessionStreams = new Map<string, OutboundMailbox<string>>();
  readonly pendingRoutes = new Map<string, ResponseRoute>();
  readonly clientResponseRoutes = new Map<string, ResponseRoute>();
  readonly closed: Promise<void>;

  private readonly agentConnection: AgentConnectionLifecycle | unknown;
  /** Length of the JSON text queued on HTTP streams; see `maxBufferedBytes`. */
  private bufferedBytes = 0;
  private readonly streamObserver: OutboundQueueObserver<string> = {
    queued: (json) => {
      this.bufferedBytes += json.length;
    },
    dequeued: (json) => {
      this.bufferedBytes -= json.length;
      this.notifyOutboundProgress();
    },
  };
  /** Session streams without a receiver; see `maxBufferedSessionStreams`. */
  private bufferedSessionStreams = 0;
  /** Called when a client takes output, or the connection stops routing. */
  private readonly progressWaiters = new Set<() => void>();
  private supportsBatches = false;
  private hasStartedRouter = false;
  private hasAgentOutputEnded = false;
  private hasFinishedRouting = false;
  private hasStartedShutdown = false;
  private inboundWriteChain: Promise<void> = Promise.resolve();
  private initialReader:
    ReadableStreamDefaultReader<AnyWireMessage> | undefined;
  private outboundReader:
    ReadableStreamDefaultReader<AnyWireMessage> | undefined;
  private routerPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private hasResolvedClosed = false;
  private abortAgentInbound: (error: unknown) => void = () => {};
  private endAgentOutbound: () => void = () => {};
  private resolveClosed: () => void = () => {};

  constructor(
    agent: AgentConnector,
    private readonly transport: ConnectionTransport,
    private readonly limits: Required<ConnectionLimits>,
  ) {
    this.connectionId = globalThis.crypto.randomUUID();
    this.connectionStream = new OutboundMailbox(
      transport === "http",
      undefined,
      this.streamObserver,
    );
    // WebSocket output waits here only until the socket pump takes it; the
    // socket itself holds what the client has not read.
    this.allOutbound = new OutboundMailbox<AnyWireMessage>(
      transport === "websocket",
      undefined,
      {
        dequeued: () => {
          this.notifyOutboundProgress();
        },
      },
    );
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const inbound = new TransformStream<AnyWireMessage, AnyWireMessage>({
      start: (controller) => {
        this.abortAgentInbound = (error) => controller.error(error);
      },
    });
    const outbound = createOutboundChannel(
      (message) => {
        if (!this.supportsBatches && Array.isArray(message)) {
          throw new TypeError(
            "AcpServer transports do not support outbound JSON-RPC batch messages",
          );
        }
      },
      () => {
        // Nothing more will come from the agent, so let the router finish
        // instead of waiting for clients to make room.
        this.hasAgentOutputEnded = true;
        this.notifyOutboundProgress();
      },
    );

    this.inboundTx = inbound.writable;
    this.outboundRx = outbound.readable;
    this.endAgentOutbound = outbound.end;

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

  /** Whether shutdown has begun; a closed connection accepts no more work. */
  get isClosed(): boolean {
    return this.hasStartedShutdown;
  }

  /**
   * Whether the connection takes no more agent output for now. HTTP
   * connections hold up to `maxBufferedBytes` in their streams. WebSocket
   * connections hand each message to the socket pump, which waits while the
   * socket holds `maxBufferedBytes`, so they wait until the pump takes it.
   */
  get hasOutboundBacklog(): boolean {
    return this.transport === "http"
      ? this.bufferedBytes >= this.limits.maxBufferedBytes
      : this.allOutbound.hasQueuedMessages;
  }

  /** Throws `ConnectionLimitError` for a session ID over `maxIdLength`. */
  validateSessionId(sessionId: string): void {
    this.validateIdLength("Session ID", sessionId);
  }

  /** Throws `ConnectionLimitError` for a request ID over `maxIdLength`. */
  validateRequestId(id: unknown): void {
    if (typeof id === "string") {
      this.validateIdLength("Request ID", id);
    }
  }

  /**
   * Resolves once the connection can take more agent output, or has stopped,
   * and rejects if `signal` aborts first. Client requests wait on this, so a
   * client that is not reading cannot make the agent produce more.
   */
  async waitForOutboundCapacity(signal?: AbortSignal): Promise<void> {
    await this.waitForRoom(() => this.hasFinishedRouting, signal);
  }

  /**
   * Returns the stream that delivers messages for a session, creating one
   * that buffers them until a receiver attaches. Throws
   * `ConnectionLimitError` for an over-long ID or when no further session
   * may buffer.
   */
  ensureSession(sessionId: string): OutboundMailbox<string> {
    this.validateSessionId(sessionId);

    // WebSocket connections deliver every message over the socket.
    if (this.transport === "websocket") {
      return this.connectionStream;
    }

    const existing = this.sessionStreams.get(sessionId);
    if (existing) {
      return existing;
    }

    // A new stream has no receiver yet, so its messages are buffered.
    if (this.bufferedSessionStreams >= this.limits.maxBufferedSessionStreams) {
      throw connectionLimitExceeded("maxBufferedSessionStreams", this.limits);
    }

    return this.createSessionStream(sessionId);
  }

  /**
   * Attaches a receiver to a session's stream, or returns `undefined` if the
   * stream cannot take one. The open request backing the receiver bounds it,
   * so this is not limited by `maxBufferedSessionStreams`. Throws
   * `ConnectionLimitError` for an over-long ID, and `ConnectionClosedError`
   * for a new stream once the connection can no longer route output to it.
   */
  acquireSessionStream(sessionId: string): OutboundLease<string> | undefined {
    this.validateSessionId(sessionId);

    if (this.transport === "websocket") {
      return undefined;
    }

    const existing = this.sessionStreams.get(sessionId);
    if (existing) {
      return existing.tryAcquire();
    }

    if (this.isClosed || this.hasFinishedRouting) {
      throw new ConnectionClosedError();
    }

    return this.createSessionStream(sessionId).tryAcquire();
  }

  async shutdown(error?: unknown): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown(error);
    }

    return this.shutdownPromise;
  }

  private async runShutdown(error?: unknown): Promise<void> {
    try {
      this.hasStartedShutdown = true;
      this.notifyOutboundProgress();
      this.connectionStream.abort(error);
      this.allOutbound.abort(error);

      for (const stream of this.sessionStreams.values()) {
        stream.abort(error);
      }

      this.sessionStreams.clear();
      this.bufferedSessionStreams = 0;
      this.pendingRoutes.clear();
      this.clientResponseRoutes.clear();

      await Promise.allSettled([
        this.closeInbound(error),
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

      this.endAgentOutbound();
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

  private closeInbound(error?: unknown): Promise<void> {
    if (error !== undefined || this.inboundTx.locked) {
      this.abortAgentInbound(error ?? new ConnectionClosedError());
      return Promise.resolve();
    }

    return this.inboundTx.close();
  }

  private async writeInboundMessage(message: AnyWireMessage): Promise<void> {
    // Once routing has finished, the agent can no longer answer, such as a
    // request that waited for room while the agent exited.
    if (this.isClosed || this.hasFinishedRouting) {
      throw new ConnectionClosedError();
    }

    const writer = this.inboundTx.getWriter();

    try {
      await writer.write(message);
    } catch (error) {
      // Shutdown aborts a write that was still waiting on the agent.
      if (this.isClosed) {
        throw new ConnectionClosedError();
      }

      throw error;
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

        if (result.done || this.isClosed) {
          return;
        }

        this.routeOutbound(result.value);
        // Take no more output, which makes the agent's sends wait, until
        // clients read what is queued. Once the agent's output has ended,
        // nothing waits on the router, so it routes what is left.
        await this.waitForRoom(() => this.hasAgentOutputEnded);
      }
    } catch (error) {
      // Output can no longer be routed, so close the connection rather than
      // leave the agent and its client waiting on it.
      if (error instanceof ConnectionLimitError) {
        this.closeForLimit(error);
      } else {
        console.error(
          `ACP connection ${this.connectionId} router stopped unexpectedly:`,
          error,
        );
        void this.shutdown(error);
      }
    } finally {
      this.hasFinishedRouting = true;
      this.notifyOutboundProgress();

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

  /**
   * Waits while the connection holds `maxBufferedBytes` of output, until
   * `stopWaiting()` holds or the connection closes, and rejects if `signal`
   * aborts first. An HTTP client that takes none of the output for
   * `maxOutputStallMs`, having stopped reading or never opened the stream it
   * is for, is not coming back for it, so the connection closes rather than
   * keep the agent or the client's own requests waiting. A WebSocket session
   * times out its socket itself, where it can see each byte the client reads.
   */
  private async waitForRoom(
    stopWaiting: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!this.isClosed && !stopWaiting() && this.hasOutboundBacklog) {
      if (!(await this.waitForProgress(signal))) {
        this.closeForLimit(connectionOutputStalled(this.limits));
        return;
      }
    }
  }

  /**
   * Resolves `true` the next time a client takes output or the connection
   * stops routing, or on HTTP, `false` if `maxOutputStallMs` passes first.
   * Rejects if `signal` aborts first, leaving nothing behind.
   */
  private waitForProgress(signal?: AbortSignal): Promise<boolean> {
    const timeoutMs =
      this.transport === "http" ? this.limits.maxOutputStallMs : undefined;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        this.progressWaiters.delete(onProgress);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
      };
      const onProgress = (): void => {
        settle();
        resolve(true);
      };
      const onAbort = (): void => {
        settle();
        reject(signal?.reason);
      };

      this.progressWaiters.add(onProgress);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle();
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  private notifyOutboundProgress(): void {
    for (const onProgress of [...this.progressWaiters]) {
      onProgress();
    }
  }

  private routeOutbound(message: AnyWireMessage): void {
    if (Array.isArray(message)) {
      for (const item of message) {
        this.routeOutboundMessage(item);
      }
    } else {
      this.routeOutboundMessage(message as AnyMessage);
    }

    this.allOutbound.push(message);
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
      // Never hand out a session ID this connection would refuse to route.
      this.validateSessionId(sessionId);
    }

    if (key) {
      this.pendingRoutes.delete(key);
    }

    this.pushToRoute(route ?? "connection", message);
  }

  private createSessionStream(sessionId: string): OutboundMailbox<string> {
    const stream: OutboundMailbox<string> = new OutboundMailbox(
      true,
      () => {
        this.onSessionReceiverChange(sessionId, stream);
      },
      this.streamObserver,
    );
    this.sessionStreams.set(sessionId, stream);
    this.bufferedSessionStreams += 1;

    return stream;
  }

  /**
   * Keeps `bufferedSessionStreams` in step as receivers attach and leave. A
   * stream a receiver leaves is kept only while messages still wait on it.
   */
  private onSessionReceiverChange(
    sessionId: string,
    stream: OutboundMailbox<string>,
  ): void {
    // Shutdown discards every stream and resets the count itself.
    if (this.isClosed) {
      return;
    }

    if (stream.hasReceiver) {
      this.bufferedSessionStreams -= 1;
      return;
    }

    if (!stream.hasQueuedMessages) {
      this.sessionStreams.delete(sessionId);
      stream.abort();
      return;
    }

    this.bufferedSessionStreams += 1;
    // Once routing has finished, nothing more can be buffered.
    if (
      !this.hasFinishedRouting &&
      this.bufferedSessionStreams > this.limits.maxBufferedSessionStreams
    ) {
      this.closeForLimit(
        connectionLimitExceeded("maxBufferedSessionStreams", this.limits),
      );
    }
  }

  private closeForLimit(error: ConnectionLimitError): void {
    console.warn(`Closing ACP connection ${this.connectionId}:`, error.message);
    void this.shutdown(error);
  }

  private validateIdLength(label: string, id: string): void {
    if (id.length > this.limits.maxIdLength) {
      throw new ConnectionLimitError(
        `${label} exceeds maxIdLength (${this.limits.maxIdLength})`,
      );
    }
  }

  private routeOutboundRequestOrNotification(message: AnyMessage): void {
    const sessionId = sessionIdFromMessageParams(message);
    if (sessionId) {
      const stream = this.ensureSession(sessionId);
      this.trackClientResponseRoute(message, { session: sessionId });
      this.deliver(stream, message);
      return;
    }

    this.trackClientResponseRoute(message, "connection");
    this.deliver(this.connectionStream, message);
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
      this.deliver(this.connectionStream, message);
      return;
    }

    this.deliver(this.ensureSession(route.session), message);
  }

  /**
   * Queues a message on an HTTP stream as JSON text, which is all a stream
   * delivers and all `maxBufferedBytes` needs to count. WebSocket
   * connections deliver through `allOutbound` instead.
   */
  private deliver(stream: OutboundMailbox<string>, message: AnyMessage): void {
    if (this.transport === "http") {
      stream.push(JSON.stringify(message));
    }
  }
}

export class ConnectionRegistry {
  readonly limits: Required<ConnectionLimits>;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly pendingConnections = new Map<string, ConnectionState>();

  constructor(options: ConnectionLimits = {}) {
    this.limits = resolveConnectionLimits(options);
  }

  createConnection(
    agent: AgentConnector,
    transport: ConnectionTransport = "http",
  ): ConnectionState {
    const connection = new ConnectionState(agent, transport, this.limits);
    this.connections.set(connection.connectionId, connection);
    this.trackConnectionClose(connection);
    return connection;
  }

  createPendingConnection(
    agent: AgentConnector,
    transport: ConnectionTransport = "websocket",
  ): ConnectionState {
    const connection = new ConnectionState(agent, transport, this.limits);
    this.pendingConnections.set(connection.connectionId, connection);
    this.trackConnectionClose(connection);
    return connection;
  }

  register(connection: ConnectionState): void {
    this.pendingConnections.delete(connection.connectionId);
    this.connections.set(connection.connectionId, connection);
  }

  get(connectionId: string): ConnectionState | undefined {
    const connection = this.connections.get(connectionId);
    return connection?.isClosed ? undefined : connection;
  }

  remove(connectionId: string): ConnectionState | undefined {
    // Unlike `get`, include a connection that is already shutting down, so
    // DELETE still succeeds until its shutdown completes.
    const connection = this.connections.get(connectionId);

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

function resolveConnectionLimits(
  options: ConnectionLimits,
): Required<ConnectionLimits> {
  const limits = {
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxOutputStallMs: options.maxOutputStallMs ?? DEFAULT_MAX_OUTPUT_STALL_MS,
    maxBufferedSessionStreams:
      options.maxBufferedSessionStreams ?? DEFAULT_MAX_BUFFERED_SESSION_STREAMS,
    maxIdLength: options.maxIdLength ?? DEFAULT_MAX_ID_LENGTH,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }

  if (limits.maxOutputStallMs > MAX_TIMER_MS) {
    throw new RangeError(`maxOutputStallMs must be at most ${MAX_TIMER_MS}`);
  }

  return limits;
}

class MailboxLease<Message> implements OutboundLease<Message> {
  released = false;

  private readonly stoppedController = new AbortController();
  private receiving = false;
  private wakePromise: Promise<void> | undefined;
  private resolveWake: (() => void) | undefined;

  constructor(private readonly mailbox: OutboundMailbox<Message>) {}

  get stopped(): AbortSignal {
    return this.stoppedController.signal;
  }

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

  stop(reason: unknown): void {
    this.stoppedController.abort(reason);
    this.wake();
  }
}

/**
 * Carries the agent's output to the router. A write resolves at once if the
 * router is waiting for a message, and otherwise once the router takes it
 * and asks for the next one, so an agent that awaits its sends goes no
 * faster than the router, which pauses while clients are behind.
 */
function createOutboundChannel(
  validate: (message: AnyWireMessage) => void,
  onEnd: () => void,
): {
  readonly readable: ReadableStream<AnyWireMessage>;
  readonly writable: WritableStream<AnyWireMessage>;
  readonly end: () => void;
} {
  let controller: ReadableStreamDefaultController<AnyWireMessage> | undefined;
  let isFinished = false;
  let isEnding = false;
  let resumeWriter: (() => void) | undefined;

  const resume = (): void => {
    const resolve = resumeWriter;
    resumeWriter = undefined;
    resolve?.();
  };
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
    resume();
    onEnd();
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
    resume();
    onEnd();
  };
  /**
   * Ends the channel for an agent that closed without closing its stream, as
   * a connector whose `closed` resolves on its own may. Writes it made before
   * closing can still be queued in the writable stream, which hands them
   * over one per microtask, so they stop waiting for the router and the
   * channel finishes after them.
   */
  const end = (): void => {
    if (isFinished || isEnding) {
      return;
    }

    isEnding = true;
    resume();
    setTimeout(finish, 0);
  };

  return {
    readable: new ReadableStream<AnyWireMessage>(
      {
        start(readableController) {
          controller = readableController;
        },
        // With no high-water mark, this runs only once the router is waiting
        // on an empty queue, which means it took the last message.
        pull: resume,
        cancel() {
          isFinished = true;
          resume();
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream<AnyWireMessage>({
      async write(message) {
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

        // The message went straight to a waiting router unless it is queued.
        if (!isFinished && !isEnding && (controller?.desiredSize ?? 0) < 0) {
          await new Promise<void>((resolve) => {
            resumeWriter = resolve;
          });
        }
      },
      close: finish,
      abort: fail,
    }),
    end,
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
