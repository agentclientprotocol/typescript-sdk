import { isResponseMessage } from "../core/jsonrpc.js";
import { AGENT_METHODS } from "../v1/unstable/schema/index.js";
import {
  EVENT_STREAM_MIME_TYPE,
  HEADER_CONNECTION_ID,
  HEADER_SESSION_ID,
  JSON_MIME_TYPE,
  isInitializeRequest,
  messageIdKey,
  sessionIdFromMessageParams,
  sessionIdFromResponseResult,
} from "./protocol.js";
import { MemoryAcpCookieStore } from "./cookie-store.js";
import { parseSseStream } from "./sse.js";
import {
  MessageBuffer,
  MessageTooLargeError,
  resolveMaxMessageBytes,
} from "../core/stream-limits.js";

import type { AcpCookieStore } from "./cookie-store.js";
import type { AnyMessage } from "../core/jsonrpc.js";
import type { Stream } from "../core/stream.js";

interface SseLifecycle {
  readonly onOpen?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly onClose?: () => void;
}

interface SessionSse {
  readonly ready: Promise<void>;
  readonly abortController: AbortController;
}

interface PendingSessionRequest {
  readonly sessionId: string;
  readonly id: string | number | null;
}

/** Requests that ask the agent to reattach a session after it was lost. */
const SESSION_REATTACH_METHODS: ReadonlySet<string> = new Set([
  AGENT_METHODS.session_load,
  AGENT_METHODS.session_resume,
]);

export interface HttpStreamOptions {
  /** Fetch implementation to use. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Headers to include on every HTTP/SSE request. */
  readonly headers?: Record<string, string>;
  /** Cookie handling policy for transport requests. Defaults to `include`. */
  readonly cookies?: "include" | "omit";
  /**
   * Caller-owned affinity cookie store to reuse across reconnects.
   *
   * If omitted, the SDK creates an ephemeral per-stream store and clears it
   * when the stream closes/errors.
   */
  readonly cookieStore?: AcpCookieStore;
  readonly maxMessageBytes?: number;
}

export { MemoryAcpCookieStore } from "./cookie-store.js";
export type { AcpCookieStore } from "./cookie-store.js";
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageTooLargeError,
} from "../core/stream-limits.js";

/**
 * Creates an ACP Stream over Streamable HTTP.
 *
 * Uses POST for client messages and SSE GET streams for server messages.
 * Cookies are included by default. Pass a caller-owned `AcpCookieStore` to
 * retain affinity cookies across fresh streams during reconnect.
 *
 * ACP v1 reconnect creates a new transport connection; callers should save the
 * ACP `sessionId`, create a new stream with the same auth headers/cookie store,
 * call `initialize`, verify `agentCapabilities.loadSession`, then call
 * `session/load`. Agents must authorize `session/load`, and ACP v1 does not
 * replay in-flight transport messages emitted while disconnected.
 *
 * Failures scoped to a single session do not tear down the shared transport.
 * If a session's SSE stream or POST is rejected with HTTP 409, that session's
 * requests fail with JSON-RPC errors until the client reattaches it with
 * `session/load` or `session/resume`. If a session's SSE stream closes while
 * requests are in flight, those requests fail and the next message for the
 * session reopens its stream.
 */
export function createHttpStream(
  serverUrl: string,
  options: HttpStreamOptions = {},
): Stream {
  return new HttpStreamTransport(serverUrl, options).stream;
}

class HttpStreamTransport {
  readonly stream: Stream;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;
  private readonly maxMessageBytes: number;
  private readonly cookiePolicy: RequestCredentials;
  private readonly cookieStore: AcpCookieStore;
  private readonly ownsCookieStore: boolean;
  private readonly abortController = new AbortController();
  private readonly knownSessions = new Set<string>();
  private readonly sessionSse = new Map<string, SessionSse>();
  private readonly pendingResponseSessions = new Map<string, string>();
  private readonly pendingSessionRequests = new Map<
    string,
    PendingSessionRequest
  >();
  private readonly sessionErrors = new Map<string, HttpResponseError>();

  private readableController:
    ReadableStreamDefaultController<AnyMessage> | undefined;
  private connectionId: string | undefined;
  private isClosed = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly serverUrl: string,
    options: HttpStreamOptions,
  ) {
    this.maxMessageBytes = resolveMaxMessageBytes(options.maxMessageBytes);
    this.fetchImpl = resolveFetch(options.fetch);
    this.headers = options.headers ?? {};
    this.cookiePolicy = options.cookies ?? "include";
    this.cookieStore = options.cookieStore ?? new MemoryAcpCookieStore();
    this.ownsCookieStore = options.cookieStore === undefined;

    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.readableController = controller;
        },
        cancel: () => this.close(),
      }),
      writable: new WritableStream<AnyMessage>({
        write: (message) => {
          this.writeChain = this.writeChain.then(() =>
            this.writeMessage(message),
          );
          return this.writeChain;
        },
        close: () => this.close(),
        abort: () => this.close(),
      }),
    };
  }

  private async writeMessage(message: AnyMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error("ACP HTTP stream is closed");
    }

    if (Array.isArray(message)) {
      throw new TypeError(
        "ACP HTTP transport does not support JSON-RPC batch messages",
      );
    }

    if (!this.connectionId) {
      await this.postInitialize(message);
      return;
    }

    await this.postConnectedMessage(message);
  }

  private async postInitialize(message: AnyMessage): Promise<void> {
    let cleanupConnectionId: string | undefined;

    try {
      if (!isInitializeRequest(message)) {
        throw new Error("ACP HTTP stream first message must be initialize");
      }

      const response = await this.fetchRequest({
        method: "POST",
        headers: {
          "Content-Type": JSON_MIME_TYPE,
        },
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw await httpError(
          "ACP initialize failed",
          response,
          this.maxMessageBytes,
        );
      }

      const connectionId = response.headers.get(HEADER_CONNECTION_ID);
      if (!connectionId) {
        throw new Error("ACP initialize response missing Acp-Connection-Id");
      }

      cleanupConnectionId = connectionId;
      this.throwIfClosedDuringInitialize();

      const body: unknown = JSON.parse(
        await readResponseText(response, this.maxMessageBytes),
      );
      this.throwIfClosedDuringInitialize();

      if (!isResponseMessage(body)) {
        throw new Error("ACP initialize response was not a JSON-RPC response");
      }

      const responseIdKey = messageIdKey(body.id);
      const requestIdKey =
        "id" in message ? messageIdKey(message.id) : undefined;
      if (responseIdKey !== requestIdKey) {
        throw new Error(
          "ACP initialize response id did not match initialize request",
        );
      }

      this.connectionId = connectionId;
      this.openConnectionSse();
      this.enqueue(body);
    } catch (error) {
      if (this.isClosed && cleanupConnectionId) {
        await this.deleteConnection(cleanupConnectionId).catch(() => undefined);
        this.clearOwnedCookieStore();
      } else {
        this.errorReadable(error, cleanupConnectionId);
      }

      throw error;
    }
  }

  private throwIfClosedDuringInitialize(): void {
    if (this.isClosed) {
      throw new Error("ACP HTTP stream is closed");
    }
  }

  private async postConnectedMessage(message: AnyMessage): Promise<void> {
    const connectionId = this.connectionId;
    if (!connectionId) {
      throw new Error("ACP HTTP stream is not initialized");
    }

    const sessionId = this.sessionIdForOutboundMessage(message);
    if (sessionId) {
      if ("method" in message && SESSION_REATTACH_METHODS.has(message.method)) {
        this.sessionErrors.delete(sessionId);
      }

      try {
        await this.openSessionSse(sessionId);
      } catch (error) {
        if (!isSessionConflict(error)) {
          throw error;
        }

        this.dropSessionMessage(message, error);
        return;
      }
    }

    const pendingSessionRequestKey =
      sessionId && "method" in message && "id" in message
        ? messageIdKey(message.id)
        : undefined;

    if (sessionId && pendingSessionRequestKey && "id" in message) {
      this.pendingSessionRequests.set(pendingSessionRequestKey, {
        sessionId,
        id: message.id,
      });
    }

    try {
      const response = await this.fetchRequest({
        method: "POST",
        headers: {
          "Content-Type": JSON_MIME_TYPE,
          [HEADER_CONNECTION_ID]: connectionId,
          ...(sessionId ? { [HEADER_SESSION_ID]: sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw await httpError(
          "ACP POST failed",
          response,
          Math.min(this.maxMessageBytes, 8192),
          true,
        );
      }
      void response.body?.cancel().catch(() => {});

      if (!("method" in message) && "id" in message) {
        const key = messageIdKey(message.id);
        if (key) {
          this.pendingResponseSessions.delete(key);
        }
      }
    } catch (error) {
      if (pendingSessionRequestKey) {
        this.pendingSessionRequests.delete(pendingSessionRequestKey);
      }

      if (sessionId && isSessionConflict(error)) {
        this.failSession(sessionId, error);
        this.dropSessionMessage(message, error);
        return;
      }

      if (
        error instanceof HttpResponseError &&
        ![401, 403, 404, 410].includes(error.status) &&
        "method" in message &&
        "id" in message
      ) {
        // Reject only this request without poisoning the shared writable stream.
        // Authentication failures and lost connections still require teardown.
        this.enqueueRequestError(message.id, error);
        return;
      }

      this.errorReadable(error);
      throw error;
    }
  }

  private sessionIdForOutboundMessage(message: AnyMessage): string | undefined {
    const paramsSessionId = sessionIdFromMessageParams(message);
    if (paramsSessionId) {
      return paramsSessionId;
    }

    if (!("id" in message) || "method" in message) {
      return undefined;
    }

    const key = messageIdKey(message.id);
    return key ? this.pendingResponseSessions.get(key) : undefined;
  }

  private openConnectionSse(): void {
    const connectionId = this.connectionId;
    if (!connectionId) {
      return;
    }

    void this.openSse(
      {
        [HEADER_CONNECTION_ID]: connectionId,
      },
      this.abortController.signal,
    );
  }

  private openSessionSse(sessionId: string): Promise<void> {
    const failure = this.sessionErrors.get(sessionId);
    if (failure) {
      return Promise.reject(failure);
    }

    const existing = this.sessionSse.get(sessionId);
    if (existing) {
      return existing.ready;
    }

    if (this.knownSessions.has(sessionId)) {
      return Promise.resolve();
    }

    const connectionId = this.connectionId;
    if (!connectionId) {
      return Promise.resolve();
    }

    let isReadySettled = false;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (callback: () => void): void => {
      if (isReadySettled) {
        return;
      }

      isReadySettled = true;
      callback();
    };

    ready.catch(() => undefined);

    // Each session stream gets its own abort so a failed session can be
    // detached without tearing down the shared connection.
    const abortController = new AbortController();
    const abortSessionSse = () => abortController.abort();
    this.abortController.signal.addEventListener("abort", abortSessionSse, {
      once: true,
    });
    const entry: SessionSse = { ready, abortController };

    this.knownSessions.add(sessionId);
    this.sessionSse.set(sessionId, entry);

    void this.openSse(
      {
        [HEADER_CONNECTION_ID]: connectionId,
        [HEADER_SESSION_ID]: sessionId,
      },
      abortController.signal,
      {
        onOpen: () => {
          settleReady(resolveReady);
        },
        onError: (error) => {
          settleReady(() => {
            rejectReady(error);
          });
        },
        onClose: () => {
          this.abortController.signal.removeEventListener(
            "abort",
            abortSessionSse,
          );
          if (this.sessionSse.get(sessionId) === entry) {
            this.sessionSse.delete(sessionId);
          }
          settleReady(() => {
            rejectReady(
              new Error("ACP session SSE stream closed before opening"),
            );
          });
        },
      },
    );

    return ready;
  }

  private async openSse(
    headers: Record<string, string>,
    signal: AbortSignal,
    lifecycle: SseLifecycle = {},
  ): Promise<void> {
    const streamSessionId = headers[HEADER_SESSION_ID];

    try {
      const response = await this.fetchRequest({
        method: "GET",
        headers: {
          Accept: EVENT_STREAM_MIME_TYPE,
          ...headers,
        },
        signal,
      });

      if (!response.ok) {
        throw await httpError(
          "ACP SSE connection failed",
          response,
          this.maxMessageBytes,
        );
      }

      if (!response.body) {
        throw new Error("ACP SSE response missing body");
      }

      lifecycle.onOpen?.();

      for await (const message of parseSseStream(
        response.body,
        this.maxMessageBytes,
      )) {
        if (this.isClosed || signal.aborted) {
          return;
        }

        if (Array.isArray(message)) {
          throw new TypeError(
            "ACP HTTP transport does not support JSON-RPC batch messages",
          );
        }

        const sessionId = sessionIdFromResponseResult(message);
        if (sessionId) {
          void this.openSessionSse(sessionId).catch(() => {});
        }

        this.trackServerRequestRoute(message, headers[HEADER_SESSION_ID]);
        this.trackInboundResponse(message);
        this.enqueue(message);
      }

      if (!signal.aborted) {
        this.handleSseEof(streamSessionId);
      }
    } catch (error) {
      if (this.isClosed || signal.aborted) {
        return;
      }

      lifecycle.onError?.(error);
      if (streamSessionId && isSessionConflict(error)) {
        this.failSession(streamSessionId, error);
      } else {
        this.errorReadable(error);
      }
    } finally {
      lifecycle.onClose?.();
    }
  }

  private handleSseEof(streamSessionId: string | undefined): void {
    if (this.isClosed || this.abortController.signal.aborted) {
      return;
    }

    if (!streamSessionId) {
      this.errorReadable(new Error("ACP connection SSE stream closed"));
      return;
    }

    // Responses for this session's in-flight requests can no longer arrive.
    // Fail just those requests; the next session message reopens the stream.
    this.knownSessions.delete(streamSessionId);
    this.rejectPendingSessionRequests(
      streamSessionId,
      new Error("ACP session SSE stream closed"),
    );
  }

  private trackServerRequestRoute(
    message: AnyMessage,
    streamSessionId: string | undefined,
  ): void {
    if (!streamSessionId || !("method" in message) || !("id" in message)) {
      return;
    }

    const key = messageIdKey(message.id);
    if (key) {
      this.pendingResponseSessions.set(key, streamSessionId);
    }
  }

  private trackInboundResponse(message: AnyMessage): void {
    if (!isResponseMessage(message)) {
      return;
    }

    const key = messageIdKey(message.id);
    if (key) {
      this.pendingSessionRequests.delete(key);
    }
  }

  /**
   * Marks a session as failed after a session-scoped conflict, detaching its
   * SSE stream and failing its in-flight requests while leaving the shared
   * connection and other sessions untouched. The failure sticks until the
   * client reattaches the session with `session/load` or `session/resume`.
   */
  private failSession(sessionId: string, error: HttpResponseError): void {
    this.sessionErrors.set(sessionId, error);
    this.knownSessions.delete(sessionId);

    const stream = this.sessionSse.get(sessionId);
    if (stream) {
      this.sessionSse.delete(sessionId);
      stream.abortController.abort();
    }

    this.rejectPendingSessionRequests(sessionId, error);
  }

  private rejectPendingSessionRequests(sessionId: string, error: Error): void {
    for (const [key, pending] of this.pendingSessionRequests) {
      if (pending.sessionId === sessionId) {
        this.pendingSessionRequests.delete(key);
        this.enqueueRequestError(pending.id, error);
      }
    }
  }

  /**
   * Settles an outbound message that cannot be delivered because its session
   * failed. Requests get a JSON-RPC error response; notifications and
   * responses to server requests have nowhere to report an error, and the
   * session they belong to is already gone, so they are discarded.
   */
  private dropSessionMessage(
    message: AnyMessage,
    error: HttpResponseError,
  ): void {
    if (!("id" in message)) {
      return;
    }

    if ("method" in message) {
      this.enqueueRequestError(message.id, error);
      return;
    }

    const key = messageIdKey(message.id);
    if (key) {
      this.pendingResponseSessions.delete(key);
    }
  }

  private enqueueRequestError(id: string | number | null, error: Error): void {
    this.enqueue({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message,
        ...(error instanceof HttpResponseError
          ? { data: { status: error.status, body: parseErrorBody(error.body) } }
          : {}),
      },
    });
  }

  private async fetchRequest(init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(this.serverUrl, {
      ...init,
      credentials: this.cookiePolicy,
      headers: this.createRequestHeaders(init.headers),
    });

    if (this.cookiePolicy === "include") {
      this.cookieStore.store(response.headers);
    }

    return response;
  }

  private createRequestHeaders(headers: HeadersInit | undefined): Headers {
    const requestHeaders = new Headers(this.headers);
    const transportHeaders = new Headers(headers);

    transportHeaders.forEach((value, key) => {
      requestHeaders.set(key, value);
    });

    if (this.cookiePolicy === "include") {
      this.cookieStore.apply(requestHeaders);
    }

    return requestHeaders;
  }

  private async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.abortController.abort();

    try {
      await this.deleteConnection();
    } finally {
      this.clearOwnedCookieStore();
      this.closeReadable();
    }
  }

  private async deleteConnection(
    connectionId: string | undefined = this.connectionId,
  ): Promise<void> {
    if (!connectionId) {
      return;
    }

    const response = await this.fetchRequest({
      method: "DELETE",
      headers: {
        [HEADER_CONNECTION_ID]: connectionId,
      },
    });

    if (!response.ok) {
      throw await httpError(
        "ACP DELETE failed",
        response,
        this.maxMessageBytes,
      );
    }
    void response.body?.cancel().catch(() => {});
  }

  private clearOwnedCookieStore(): void {
    if (this.ownsCookieStore) {
      this.cookieStore.clear();
    }
  }

  private enqueue(message: AnyMessage): void {
    try {
      this.readableController?.enqueue(message);
    } catch (error) {
      this.errorReadable(error);
    }
  }

  private errorReadable(
    error: unknown,
    connectionId: string | undefined = this.connectionId,
  ): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.abortController.abort();
    void this.deleteConnection(connectionId)
      .catch(() => undefined)
      .finally(() => {
        this.clearOwnedCookieStore();
      });

    try {
      this.readableController?.error(error);
    } catch {
      // The readable side may already be closed or cancelled.
    }
  }

  private closeReadable(): void {
    try {
      this.readableController?.close();
    } catch {
      // The readable side may already be closed, cancelled, or errored.
    }
  }
}

function resolveFetch(
  fetchImpl: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  if (fetchImpl) {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return (input, init) => globalThis.fetch(input, init);
  }

  throw new Error(
    "createHttpStream requires globalThis.fetch or options.fetch",
  );
}

async function readResponseText(
  response: Response,
  maxMessageBytes: number,
  truncate = false,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const buffer = new MessageBuffer(maxMessageBytes);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return new TextDecoder().decode(buffer.take());
      }
      if (truncate && value.byteLength >= maxMessageBytes - buffer.byteLength) {
        buffer.append(value.subarray(0, maxMessageBytes - buffer.byteLength));
        void reader.cancel().catch(() => {});
        return new TextDecoder().decode(buffer.take());
      }
      buffer.append(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    buffer.clear();
    reader.releaseLock();
  }
}

/**
 * A 409 on a session-scoped request means the server rejected that session's
 * stream (e.g. it already has a receiver or must be reloaded), not the
 * connection, so only that session is failed.
 */
function isSessionConflict(error: unknown): error is HttpResponseError {
  return error instanceof HttpResponseError && error.status === 409;
}

function parseErrorBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

class HttpResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

async function httpError(
  prefix: string,
  response: Response,
  maxMessageBytes: number,
  truncate = false,
): Promise<Error> {
  let text = "";
  try {
    text = await readResponseText(response, maxMessageBytes, truncate);
  } catch (error) {
    if (error instanceof MessageTooLargeError) {
      throw error;
    }
  }

  if (text) {
    return new HttpResponseError(
      `${prefix}: ${response.status} ${response.statusText}: ${text}`,
      response.status,
      text,
    );
  }

  return new HttpResponseError(
    `${prefix}: ${response.status} ${response.statusText}`,
    response.status,
    text,
  );
}
