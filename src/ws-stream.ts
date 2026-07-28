import { MemoryAcpCookieStore } from "./cookie-store.js";
import { RequestError, isRecord, protocolErrorResponse } from "./jsonrpc.js";
import { onWebSocket, webSocketMessageToString } from "./ws-utils.js";
import type { AcpCookieStore } from "./cookie-store.js";
import type { WebSocketLike } from "./ws-utils.js";
import type { AnyMessage, AnyWireMessage } from "./jsonrpc.js";
import type { Stream } from "./stream.js";

export interface WebSocketStreamOptions {
  /** WebSocket subprotocols to request. */
  readonly protocols?: string[];
  /**
   * Headers for WebSocket constructors that support them, such as Node `ws`.
   * Browser WebSocket constructors ignore custom headers.
   */
  readonly headers?: Record<string, string>;
  /** WebSocket constructor to use. Defaults to `globalThis.WebSocket`. */
  readonly WebSocket?: WebSocketConstructor;
  /** Cookie handling policy for transport requests. Defaults to `include`. */
  readonly cookies?: "include" | "omit";
  /**
   * Caller-owned affinity cookie store to reuse across reconnects.
   *
   * Browser WebSocket uses the platform cookie jar; Node/custom constructors
   * that support headers receive cookies from this store.
   */
  readonly cookieStore?: AcpCookieStore;
}

export { MemoryAcpCookieStore } from "./cookie-store.js";
export type { AcpCookieStore } from "./cookie-store.js";

/** Constructor shape used by `createWebSocketStream`. */
export interface WebSocketConstructor {
  new (
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ): WebSocketLike;
}

export type { WebSocketLike };

const SOCKET_OPEN = 1;

/**
 * Creates an ACP Stream over WebSocket.
 *
 * Sends and receives ACP JSON-RPC messages as WebSocket text frames. In Node,
 * pass a WebSocket constructor such as `ws.WebSocket` via `options.WebSocket`.
 * Browser WebSocket uses the platform cookie jar; Node/custom constructors
 * receive merged `Cookie` headers when supported and can store upgrade
 * `Set-Cookie` headers in a caller-owned `AcpCookieStore`.
 *
 * JSON-RPC batch arrays are supported when `Message` is a batch-capable type.
 * The default message type preserves the stable ACP v1 stream surface; draft
 * ACP v2 callers that access the stream directly can instantiate this function
 * with {@link AnyWireMessage} to write and read batches.
 *
 * ACP v1 reconnect creates a new transport connection; callers should save the
 * ACP `sessionId`, create a new stream with the same auth headers/cookie store,
 * call `initialize`, verify `agentCapabilities.loadSession`, then call
 * `session/load`. Agents must authorize `session/load`, and ACP v1 does not
 * replay in-flight transport messages emitted while disconnected.
 */
export function createWebSocketStream<
  Message extends AnyWireMessage = AnyMessage,
>(serverUrl: string, options: WebSocketStreamOptions = {}): Stream<Message> {
  return new WebSocketStreamTransport<Message>(serverUrl, options).stream;
}

class WebSocketStreamTransport<Message extends AnyWireMessage> {
  readonly stream: Stream<Message>;

  private readonly socket: WebSocketLike;
  private readonly cookieStore: AcpCookieStore;
  private readonly ownsCookieStore: boolean;
  private readableController:
    ReadableStreamDefaultController<Message> | undefined;
  private isClosed = false;
  private openPromise: Promise<void> | undefined;
  private resolveOpen: (() => void) | undefined;
  private rejectOpen: ((error: unknown) => void) | undefined;
  private readonly detachListeners: Array<() => void> = [];
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(serverUrl: string, options: WebSocketStreamOptions) {
    const WebSocketCtor = resolveWebSocket(options.WebSocket);
    const cookiePolicy = options.cookies ?? "include";
    this.cookieStore = options.cookieStore ?? new MemoryAcpCookieStore();
    this.ownsCookieStore = options.cookieStore === undefined;
    this.socket = new WebSocketCtor(serverUrl, options.protocols, {
      headers: createConstructorHeaders(
        options.headers,
        cookiePolicy,
        this.cookieStore,
      ),
    });

    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.openPromise.catch(() => undefined);

    this.detachListeners.push(
      onWebSocket(this.socket, "open", () => {
        this.resolveOpen?.();
        this.resolveOpen = undefined;
        this.rejectOpen = undefined;
        this.openPromise = undefined;
      }),
    );

    this.detachListeners.push(
      onWebSocket(this.socket, "message", (...args) => {
        this.handleSocketMessage(args);
      }),
    );

    this.detachListeners.push(
      onWebSocket(this.socket, "close", () => {
        this.closeReadable();
      }),
    );

    this.detachListeners.push(
      onWebSocket(this.socket, "error", (error) => {
        this.errorReadable(error);
      }),
    );

    if (cookiePolicy === "include") {
      this.detachListeners.push(
        onWebSocket(this.socket, "upgrade", (message) => {
          const headers = upgradeHeaders(message);
          if (headers) {
            this.cookieStore.store(headers);
          }
        }),
      );
    }

    this.stream = {
      readable: new ReadableStream<Message>({
        start: (controller) => {
          this.readableController = controller;
        },
        cancel: () => {
          this.close();
        },
      }),
      writable: new WritableStream<Message>({
        write: (message) => this.queueMessage(message),
        close: () => {
          this.close();
        },
        abort: () => {
          this.close();
        },
      }),
    };
  }

  private queueMessage(message: AnyWireMessage): Promise<void> {
    const send = this.sendQueue.then(() => this.sendMessage(message));
    this.sendQueue = send.catch(() => {});
    return send;
  }

  private async sendMessage(message: AnyWireMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error("ACP WebSocket stream is closed");
    }

    await this.waitForOpen();

    if (this.isClosed) {
      throw new Error("ACP WebSocket stream is closed");
    }

    this.socket.send(JSON.stringify(message));
  }

  private async waitForOpen(): Promise<void> {
    if (
      this.socket.readyState === undefined ||
      this.socket.readyState === SOCKET_OPEN
    ) {
      return;
    }

    await this.openPromise;
  }

  private handleSocketMessage(args: unknown[]): void {
    if (this.isClosed) {
      return;
    }

    const text = webSocketMessageToString(args);
    if (text === undefined) {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.sendProtocolError(RequestError.parseError());
      return;
    }

    if (!isRecord(value) && !Array.isArray(value)) {
      this.sendProtocolError(RequestError.invalidRequest(value));
      return;
    }

    this.readableController?.enqueue(value as Message);
  }

  private sendProtocolError(error: RequestError): void {
    void this.queueMessage(protocolErrorResponse(error)).catch((sendError) => {
      this.errorReadable(sendError);
    });
  }

  private close(): void {
    this.closeSocket();
    this.closeReadable();
  }

  private closeSocket(): void {
    try {
      this.socket.close();
    } catch (error) {
      console.warn("Failed to close ACP WebSocket:", error);
    }
  }

  private clearOwnedCookieStore(): void {
    if (this.ownsCookieStore) {
      this.cookieStore.clear();
    }
  }

  private closeReadable(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.clearOwnedCookieStore();

    for (const detach of this.detachListeners.splice(0)) {
      detach();
    }

    this.rejectOpen?.(new Error("ACP WebSocket stream closed before open"));
    this.rejectOpen = undefined;
    this.resolveOpen = undefined;
    this.openPromise = undefined;

    try {
      this.readableController?.close();
    } catch {
      // Stream may already be closed/cancelled.
    }
  }

  private errorReadable(error: unknown): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.clearOwnedCookieStore();

    for (const detach of this.detachListeners.splice(0)) {
      detach();
    }

    this.rejectOpen?.(error);
    this.rejectOpen = undefined;
    this.resolveOpen = undefined;
    this.openPromise = undefined;

    this.readableController?.error(error);
  }
}

function createConstructorHeaders(
  headers: Record<string, string> | undefined,
  cookiePolicy: "include" | "omit",
  cookieStore: AcpCookieStore,
): Record<string, string> | undefined {
  const result: Record<string, string> = headers ? { ...headers } : {};

  if (cookiePolicy === "include") {
    const requestHeaders = new Headers(headers);
    cookieStore.apply(requestHeaders);
    const cookieHeader = requestHeaders.get("Cookie");

    if (cookieHeader) {
      result[findHeaderName(result, "Cookie") ?? "Cookie"] = cookieHeader;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function findHeaderName(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
}

function upgradeHeaders(message: unknown): Headers | undefined {
  if (message instanceof Headers) {
    return message;
  }

  if (!isRecord(message) || !("headers" in message)) {
    return undefined;
  }

  return headersFromRecord(message.headers);
}

function headersFromRecord(value: unknown): Headers | undefined {
  if (value instanceof Headers) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const headers = new Headers();

  for (const [name, headerValue] of Object.entries(value)) {
    if (Array.isArray(headerValue)) {
      for (const item of headerValue) {
        headers.append(name, String(item));
      }
      continue;
    }

    if (headerValue !== undefined) {
      headers.set(name, String(headerValue));
    }
  }

  return headers;
}

function resolveWebSocket(
  WebSocketCtor: WebSocketConstructor | undefined,
): WebSocketConstructor {
  if (WebSocketCtor) {
    return WebSocketCtor;
  }

  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket as unknown as WebSocketConstructor;
  }

  throw new Error(
    "createWebSocketStream requires globalThis.WebSocket or options.WebSocket",
  );
}
