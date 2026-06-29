import type { Stream } from "./stream.js";

/**
 * Any JSON-RPC message that can pass through an ACP stream.
 */
export type AnyMessage = AnyRequest | AnyResponse | AnyNotification;

/**
 * Raw JSON-RPC request message.
 */
export type AnyRequest = {
  /**
   * JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Request identifier echoed by the response.
   */
  id: string | number | null;
  /**
   * Method name to invoke.
   */
  method: string;
  /**
   * Optional method params.
   */
  params?: unknown;
};

/**
 * Raw JSON-RPC response message.
 */
export type AnyResponse = {
  /**
   * JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Request identifier this response resolves.
   */
  id: string | number | null;
} & Result<unknown>;

/**
 * Raw JSON-RPC notification message.
 */
export type AnyNotification = {
  /**
   * JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Notification method name.
   */
  method: string;
  /**
   * Optional notification params.
   */
  params?: unknown;
};

const CANCEL_REQUEST_METHOD = "$/cancel_request";

/**
 * JSON-RPC request identifier.
 */
export type JsonRpcId = string | number | null;

/**
 * Options for sending a JSON-RPC request.
 */
export type SendRequestOptions = {
  /**
   * Aborting this signal sends `$/cancel_request` for the outgoing request.
   * Cancellation is cooperative: the returned promise is still settled by the
   * peer's eventual response, which may be a normal result, partial result, or
   * `RequestError.requestCancelled()`.
   */
  cancellationSignal?: AbortSignal;
};

/**
 * JSON-RPC result payload, either a successful result or an error.
 */
export type Result<T> =
  | {
      /**
       * Successful result value.
       */
      result: T;
    }
  | {
      /**
       * JSON-RPC error result.
       */
      error: ErrorResponse;
    };

/**
 * JSON-RPC error response payload.
 */
export type ErrorResponse = {
  /**
   * JSON-RPC error code.
   */
  code: number;
  /**
   * Human-readable error message.
   */
  message: string;
  /**
   * Optional structured error data.
   */
  data?: unknown;
};

/**
 * Legacy request dispatcher callback.
 */
export type RequestHandler = (
  method: string,
  params: unknown,
  cx: ConnectionContext,
) => MaybePromise<unknown>;

/**
 * Legacy notification dispatcher callback.
 */
export type NotificationHandler = (
  method: string,
  params: unknown,
  cx: ConnectionContext,
) => MaybePromise<void>;

export function isJsonRpcMessage(value: unknown): value is AnyMessage {
  return (
    isRequestMessage(value) ||
    isResponseMessage(value) ||
    isNotificationMessage(value)
  );
}

export function isRequestMessage(value: unknown): value is AnyRequest {
  return (
    isJsonRpcEnvelope(value) &&
    "id" in value &&
    typeof value["method"] === "string" &&
    isJsonRpcId(value["id"])
  );
}

export function isResponseMessage(value: unknown): value is AnyResponse {
  if (!isJsonRpcEnvelope(value) || "method" in value) {
    return false;
  }

  if (!("id" in value) || !isJsonRpcId(value["id"])) {
    return false;
  }

  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");

  if (hasResult === hasError) {
    return false;
  }

  return !hasError || isErrorResponse(value["error"]);
}

export function isNotificationMessage(
  value: unknown,
): value is AnyNotification {
  return (
    isJsonRpcEnvelope(value) &&
    !("id" in value) &&
    typeof value["method"] === "string"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcEnvelope(
  value: unknown,
): value is Record<string, unknown> & { jsonrpc: "2.0" } {
  return isRecord(value) && value["jsonrpc"] === "2.0";
}

function isJsonRpcId(value: unknown): value is string | number | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function cancelRequestId(params: unknown): JsonRpcId | undefined {
  if (!isRecord(params) || !isJsonRpcId(params["requestId"])) {
    return undefined;
  }

  return params["requestId"];
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    isRecord(value) &&
    typeof value["code"] === "number" &&
    Number.isInteger(value["code"]) &&
    typeof value["message"] === "string"
  );
}

type ConnectionPendingResponse = {
  resolve: (response: unknown) => void;
  reject: (error: unknown) => void;
  cleanup?: () => void;
  cancellationSent?: boolean;
};

/**
 * Value that may be returned synchronously or through a promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Incoming request passed to JSON-RPC handlers.
 */
export type IncomingRequest = {
  /**
   * Discriminates incoming requests from notifications.
   */
  kind: "request";
  /**
   * Request method name.
   */
  method: string;
  /**
   * Raw request params.
   */
  params: unknown;
  /**
   * Original wire request.
   */
  raw: AnyRequest;
  /**
   * AbortSignal that aborts when the peer sends `$/cancel_request` for this
   * request or when the connection closes.
   */
  signal: AbortSignal;
  /**
   * Responder used to complete the request.
   */
  responder: RequestResponder<unknown>;
};

/**
 * Incoming notification passed to JSON-RPC handlers.
 */
export type IncomingNotification = {
  /**
   * Discriminates incoming notifications from requests.
   */
  kind: "notification";
  /**
   * Notification method name.
   */
  method: string;
  /**
   * Raw notification params.
   */
  params: unknown;
  /**
   * Original wire notification.
   */
  raw: AnyNotification;
};

/**
 * Incoming request or notification.
 */
export type IncomingMessage = IncomingRequest | IncomingNotification;

/**
 * Result returned by a JSON-RPC handler.
 */
export type HandleResult =
  | {
      /**
       * Indicates that no later handlers should see the message.
       */
      handled: true;
    }
  | {
      /**
       * Indicates that later handlers may try to handle the message.
       */
      handled: false;
      /**
       * Optional replacement message to pass to later handlers.
       */
      message?: IncomingMessage;
      /**
       * Requeue this message if it remains unhandled.
       */
      retry?: boolean;
    };

/**
 * Helpers for constructing `HandleResult` values.
 */
export const Handled = {
  /**
   * Marks a message as handled.
   */
  yes(): HandleResult {
    return { handled: true };
  },

  /**
   * Leaves a message unhandled so later handlers can process it.
   */
  no(message?: IncomingMessage, retry = false): HandleResult {
    return { handled: false, message, retry };
  },
};

/**
 * Handler in the lower-level JSON-RPC dispatch chain.
 */
export interface JsonRpcHandler {
  /**
   * Handles or passes through one incoming request or notification.
   */
  handleMessage(
    message: IncomingMessage,
    cx: ConnectionContext,
  ): MaybePromise<HandleResult | void>;
  /**
   * Optional label used for diagnostics.
   */
  describe?(): string;
}

/**
 * Typed request callback registered with `ConnectionBuilder.onReceiveRequest`.
 */
export type RequestCallback<Req, Resp> = (
  request: Req,
  responder: RequestResponder<Resp>,
  cx: ConnectionContext,
) => MaybePromise<HandleResult | void>;

/**
 * Typed notification callback registered with
 * `ConnectionBuilder.onReceiveNotification`.
 */
export type NotificationCallback<Notif> = (
  notification: Notif,
  cx: ConnectionContext,
) => MaybePromise<HandleResult | void>;

function rejectedPromise<T>(error: unknown): Promise<T> {
  const promise = Promise.reject<T>(error);
  promise.catch(() => {});
  return promise;
}

function errorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error != null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return undefined;
}

function isZodError(error: unknown): error is { format(): unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues) &&
    "format" in error &&
    typeof error.format === "function"
  );
}

function errorToResult<T>(error: unknown): Result<T> {
  if (error instanceof RequestError) {
    return error.toResult();
  }

  if (isZodError(error)) {
    return RequestError.invalidParams(error.format()).toResult();
  }

  const details = errorDetails(error);

  try {
    return RequestError.internalError(
      details ? JSON.parse(details as string) : {},
    ).toResult();
  } catch {
    return RequestError.internalError({ details }).toResult();
  }
}

function requestCancelledError(reason?: unknown): RequestError {
  if (reason instanceof RequestError && reason.code === -32800) {
    return reason;
  }

  return RequestError.requestCancelled(reason);
}

function errorToRequestResult<T>(
  error: unknown,
  signal: AbortSignal,
): Result<T> {
  const requestCancelled = abortErrorToRequestCancelled(error, signal);
  return requestCancelled ? requestCancelled.toResult() : errorToResult(error);
}

function abortErrorToRequestCancelled(
  error: unknown,
  signal: AbortSignal,
): RequestError | undefined {
  if (!signal.aborted || !isAbortError(error)) {
    return undefined;
  }

  return requestCancelledError(signal.reason);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeAbortError = error as { code?: unknown; name?: unknown };
  return (
    maybeAbortError.name === "AbortError" ||
    maybeAbortError.code === "ABORT_ERR"
  );
}

/**
 * Responder for one incoming JSON-RPC request.
 *
 * Handlers may use this when they need to decide exactly when or how the
 * response is sent.
 */
export class RequestResponder<Resp = unknown> {
  private didRespond = false;

  constructor(
    /**
     * Request ID to include in the response.
     */
    public readonly id: string | number | null,
    private sendResult: (result: Result<Resp>) => Promise<void>,
    /**
     * AbortSignal for this incoming request.
     */
    public readonly signal: AbortSignal = new AbortController().signal,
    private finishRequest?: () => void,
  ) {}

  /**
   * Whether this request has already received a response.
   */
  get responded(): boolean {
    return this.didRespond;
  }

  /**
   * Sends a successful JSON-RPC response.
   */
  respond(response: Resp): Promise<void> {
    return this.respondWithResult({ result: (response ?? null) as Resp });
  }

  /**
   * Sends an error JSON-RPC response.
   */
  respondWithError(error: RequestError | ErrorResponse): Promise<void> {
    const errorResponse =
      error instanceof RequestError ? error.toErrorResponse() : error;
    return this.respondWithResult({ error: errorResponse });
  }

  /**
   * Sends a complete JSON-RPC result payload.
   */
  respondWithResult(result: Result<Resp>): Promise<void> {
    if (this.didRespond) {
      return rejectedPromise(new Error("JSON-RPC request already responded"));
    }

    this.didRespond = true;
    return this.sendResult(result).finally(() => {
      this.finishRequest?.();
    });
  }
}

/**
 * Disposable handle returned when a handler is registered dynamically.
 */
export class HandlerRegistration {
  private active = true;

  constructor(private disposeHandler: () => void) {}

  /**
   * Unregisters the associated handler.
   */
  dispose(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.disposeHandler();
  }

  /**
   * Supports explicit resource management with `using`.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Returns this registration for call sites that intentionally keep it active.
   */
  runIndefinitely(): this {
    return this;
  }
}

/**
 * Per-connection context passed to low-level JSON-RPC handlers.
 */
export class ConnectionContext {
  constructor(private connection: Connection) {}

  /**
   * Sends a request over the connection.
   */
  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
    options?: SendRequestOptions,
  ): Promise<Output> {
    return this.connection.sendRequest(method, params, mapResponse, options);
  }

  /**
   * Sends a notification over the connection.
   */
  sendNotification<N>(method: string, params?: N): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  /**
   * Sends a protocol-level request cancellation notification.
   */
  sendCancelRequest(requestId: JsonRpcId): Promise<void> {
    return this.connection.sendCancelRequest(requestId);
  }

  /**
   * Registers a handler that can be disposed independently.
   */
  addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    return this.connection.addDynamicHandler(handler);
  }

  /**
   * AbortSignal that aborts when the connection closes.
   */
  get signal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   */
  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/**
 * Options for constructing a lower-level JSON-RPC connection.
 */
export type ConnectionOptions = {
  /**
   * Extra handlers to prepend to the connection's handler chain.
   */
  handlers?: JsonRpcHandler[];
};

/**
 * Lower-level JSON-RPC connection over an ACP `Stream`.
 *
 * Most ACP integrations should use `agent(...)` or `client(...)`. Use this
 * class when building generic JSON-RPC middleware or custom dispatch behavior.
 */
export class Connection {
  private pendingResponses: Map<JsonRpcId, ConnectionPendingResponse> =
    new Map();
  private incomingRequests: Map<JsonRpcId, AbortController> = new Map();
  private nextRequestId = 0;
  private staticHandlers: JsonRpcHandler[] = [];
  private dynamicHandlers: Set<JsonRpcHandler> = new Set();
  private stream!: Stream;
  private writeQueue: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private closedPromise!: Promise<void>;
  private retryQueue: IncomingMessage[] = [];
  private context = new ConnectionContext(this);
  private receiveReader?: ReadableStreamDefaultReader<AnyMessage>;

  constructor(
    requestHandler: RequestHandler,
    notificationHandler: NotificationHandler,
    stream: Stream,
    options?: ConnectionOptions,
  );
  constructor(
    stream: Stream,
    handlers: JsonRpcHandler[],
    options?: ConnectionOptions,
  );
  constructor(
    requestHandlerOrStream: RequestHandler | Stream,
    notificationHandlerOrHandlers: NotificationHandler | JsonRpcHandler[],
    streamOrOptions?: Stream | ConnectionOptions,
    options?: ConnectionOptions,
  ) {
    if (typeof requestHandlerOrStream === "function") {
      const requestHandler = requestHandlerOrStream;
      const notificationHandler =
        notificationHandlerOrHandlers as NotificationHandler;
      const stream = streamOrOptions as Stream;
      this.initialize(stream, [
        ...(options?.handlers ?? []),
        this.legacyHandler(requestHandler, notificationHandler),
      ]);
      return;
    }

    const stream = requestHandlerOrStream;
    const handlers = notificationHandlerOrHandlers as JsonRpcHandler[];
    const connectionOptions = streamOrOptions as ConnectionOptions | undefined;
    this.initialize(stream, [
      ...(connectionOptions?.handlers ?? []),
      ...handlers,
    ]);
  }

  /**
   * Creates a builder for configuring a handler-based connection.
   */
  static builder(): ConnectionBuilder {
    return new ConnectionBuilder();
  }

  /**
   * Runs an operation while the connection is open, then closes the connection.
   *
   * If the stream closes before `op` settles, the returned promise rejects with
   * the connection close reason.
   */
  runUntil<T>(op: (cx: ConnectionContext) => MaybePromise<T>): Promise<T> {
    let opSettled = false;
    const opPromise = Promise.resolve()
      .then(() => op(this.context))
      .finally(() => {
        opSettled = true;
      });
    const closedPromise = this.closed.then(() => {
      if (opSettled) {
        return new Promise<never>(() => {});
      }

      throw this.closedReason();
    });

    return Promise.race([opPromise, closedPromise]).finally(() => {
      opSettled = true;
      this.close();
    });
  }

  /**
   * Adds a handler after the connection has started.
   *
   * Any messages queued with `Handled.no(message, true)` are retried after the
   * handler is added.
   */
  addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    this.dynamicHandlers.add(handler);
    if (this.retryQueue.length > 0) {
      for (const message of this.retryQueue.splice(0)) {
        void this.processIncomingMessage(message).catch((error) =>
          this.close(error),
        );
      }
    }
    return new HandlerRegistration(() => {
      this.dynamicHandlers.delete(handler);
    });
  }

  /**
   * AbortSignal that aborts when the connection closes.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  /** @internal */
  getContext(): ConnectionContext {
    return this.context;
  }

  /**
   * Sends a JSON-RPC request.
   *
   * `mapResponse` can convert the raw result before the returned promise
   * resolves.
   */
  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
    options: SendRequestOptions = {},
  ): Promise<Output> {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }

    const id = this.nextRequestId++;
    let cancel = () => {};
    const responsePromise = new Promise<Output>((resolve, reject) => {
      const pendingResponse: ConnectionPendingResponse = {
        resolve: (response) => {
          try {
            const value = mapResponse
              ? mapResponse(response as Resp)
              : (response as Output);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        reject,
      };

      cancel = () => {
        if (pendingResponse.cancellationSent) {
          return;
        }

        pendingResponse.cancellationSent = true;
        pendingResponse.cleanup?.();
        void this.sendCancelRequest(id).catch(() => {});
      };

      options.cancellationSignal?.addEventListener("abort", cancel, {
        once: true,
      });
      pendingResponse.cleanup = () => {
        options.cancellationSignal?.removeEventListener("abort", cancel);
      };
      this.pendingResponses.set(id, pendingResponse);
    });
    responsePromise.catch(() => {});
    const requestSent = this.sendMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    void requestSent.catch(() => {});
    if (options.cancellationSignal?.aborted) {
      cancel();
    }
    return responsePromise;
  }

  /**
   * Sends a protocol-level request cancellation notification.
   */
  sendCancelRequest(requestId: JsonRpcId): Promise<void> {
    return this.sendNotification(CANCEL_REQUEST_METHOD, { requestId });
  }

  /**
   * Sends a JSON-RPC notification.
   */
  sendNotification<N>(method: string, params?: N): Promise<void> {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }

    return this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * Closes the connection and rejects pending requests.
   */
  close(error?: unknown): void {
    if (this.abortController.signal.aborted) {
      return;
    }

    const closeError: unknown = error ?? new Error("ACP connection closed");
    this.abortController.abort(closeError);
    for (const pendingResponse of this.pendingResponses.values()) {
      pendingResponse.cleanup?.();
      pendingResponse.reject(closeError);
    }
    this.pendingResponses.clear();
    for (const controller of this.incomingRequests.values()) {
      controller.abort(closeError);
    }
    this.incomingRequests.clear();
    void this.receiveReader?.cancel(closeError).catch(() => {});
  }

  private initialize(stream: Stream, handlers: JsonRpcHandler[]): void {
    this.stream = stream;
    this.staticHandlers = handlers;
    this.closedPromise = new Promise((resolve) => {
      this.abortController.signal.addEventListener("abort", () => resolve());
    });
    void this.receive();
  }

  private legacyHandler(
    requestHandler: RequestHandler,
    notificationHandler: NotificationHandler,
  ): JsonRpcHandler {
    return {
      handleMessage: async (message, cx) => {
        if (message.kind === "request") {
          const result = await requestHandler(
            message.method,
            message.params,
            cx,
          );
          await message.responder.respond(result);
        } else {
          await notificationHandler(message.method, message.params, cx);
        }

        return Handled.yes();
      },
    };
  }

  private async receive(): Promise<void> {
    let closeError: unknown = undefined;

    try {
      const reader = this.stream.readable.getReader();
      this.receiveReader = reader;
      try {
        while (!this.abortController.signal.aborted) {
          const { value: message, done } = await reader.read();
          if (this.abortController.signal.aborted) {
            break;
          }
          if (done) {
            break;
          }
          if (!message) {
            continue;
          }

          this.receiveMessage(message);
        }
      } finally {
        if (this.receiveReader === reader) {
          this.receiveReader = undefined;
        }
        reader.releaseLock();
      }
    } catch (error) {
      closeError = error;
    } finally {
      this.close(closeError);
    }
  }

  private receiveMessage(message: AnyMessage): void {
    if (this.abortController.signal.aborted) {
      return;
    }

    if ("method" in message) {
      if (!("id" in message)) {
        this.handleProtocolNotification(message);
      }
      void this.processIncomingMessage(this.toIncomingMessage(message)).catch(
        (error) => this.close(error),
      );
    } else if ("id" in message) {
      this.handleResponse(message);
    } else {
      console.error("Invalid message", { message });
    }
  }

  private async processIncomingMessage(
    message: IncomingMessage,
  ): Promise<void> {
    if (this.abortController.signal.aborted) {
      return;
    }

    let current = message;
    let retry = false;

    try {
      for (const handler of [
        ...this.staticHandlers,
        ...this.dynamicHandlers.values(),
      ]) {
        if (this.abortController.signal.aborted) {
          return;
        }

        const result = (await handler.handleMessage(current, this.context)) ?? {
          handled: true,
        };
        if (result.handled) {
          return;
        }

        current = result.message ?? current;
        retry = retry || Boolean(result.retry);
      }

      if (retry) {
        this.retryQueue.push(current);
      } else if (current.kind === "request") {
        await current.responder.respondWithError(
          RequestError.methodNotFound(current.method),
        );
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }

      if (current.kind === "request" && !current.responder.responded) {
        await current.responder.respondWithResult(
          errorToRequestResult(error, current.responder.signal),
        );
      } else {
        const response = errorToResult(error);
        if ("error" in response) {
          console.error(
            "Error handling notification",
            message.raw,
            response.error,
          );
        }
      }
    }
  }

  private toIncomingMessage(
    message: AnyRequest | AnyNotification,
  ): IncomingMessage {
    if ("id" in message) {
      const abortController = new AbortController();
      this.incomingRequests.set(message.id, abortController);
      const finishRequest = () => {
        if (this.incomingRequests.get(message.id) === abortController) {
          this.incomingRequests.delete(message.id);
        }
      };

      return {
        kind: "request",
        method: message.method,
        params: message.params,
        raw: message,
        signal: abortController.signal,
        responder: new RequestResponder(
          message.id,
          (result) =>
            this.sendMessage({
              jsonrpc: "2.0",
              id: message.id,
              ...result,
            }),
          abortController.signal,
          finishRequest,
        ),
      };
    }

    return {
      kind: "notification",
      method: message.method,
      params: message.params,
      raw: message,
    };
  }

  private handleResponse(response: AnyResponse): void {
    const pendingResponse = this.pendingResponses.get(response.id);
    if (pendingResponse) {
      this.pendingResponses.delete(response.id);
      pendingResponse.cleanup?.();

      if ("result" in response) {
        pendingResponse.resolve(response.result);
      } else if ("error" in response) {
        const { code, message, data } = response.error;
        pendingResponse.reject(new RequestError(code, message, data));
      } else {
        pendingResponse.reject(RequestError.invalidRequest(response));
      }
    } else {
      console.error("Got response to unknown request", response.id);
    }
  }

  private handleProtocolNotification(message: AnyNotification): void {
    if (message.method !== CANCEL_REQUEST_METHOD) {
      return;
    }

    const requestId = cancelRequestId(message.params);
    if (requestId === undefined) {
      return;
    }

    const controller = this.incomingRequests.get(requestId);
    if (!controller || controller.signal.aborted) {
      return;
    }

    controller.abort(RequestError.requestCancelled({ requestId }));
  }

  private closedReason(): unknown {
    return (
      this.abortController.signal.reason ?? new Error("ACP connection closed")
    );
  }

  private async sendMessage(message: AnyMessage): Promise<void> {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        if (this.abortController.signal.aborted) {
          throw this.closedReason();
        }

        const writer = this.stream.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((error) => {
        this.close(error);
        throw error;
      });
    return this.writeQueue;
  }
}

/**
 * Builder for a lower-level handler-based JSON-RPC connection.
 */
export class ConnectionBuilder {
  private handlers: JsonRpcHandler[] = [];
  private connectionName?: string;

  /**
   * Sets a diagnostic name used by handlers created from this builder.
   */
  name(name: string): this {
    this.connectionName = name;
    return this;
  }

  /**
   * Adds a raw JSON-RPC handler to the handler chain.
   */
  withHandler(handler: JsonRpcHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * Adds a handler that can inspect every incoming request or notification.
   *
   * Observer callbacks that return void pass the message through to later
   * handlers. Return `Handled.yes()` to stop dispatch explicitly.
   */
  onReceiveMessage(
    handler: (
      message: IncomingMessage,
      cx: ConnectionContext,
    ) => MaybePromise<HandleResult | void>,
  ): this {
    return this.withHandler({
      handleMessage: async (message, cx) =>
        (await handler(message, cx)) ?? Handled.no(message),
      describe: () => this.connectionName ?? "onReceiveMessage",
    });
  }

  /**
   * Adds a typed request handler for one method.
   */
  onReceiveRequest<Req, Resp = unknown>(
    method: string,
    parse: (params: unknown) => Req,
    handler: RequestCallback<Req, Resp>,
  ): this {
    return this.withHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "request" || message.method !== method) {
          return Handled.no(message);
        }

        const request = parse(message.params);
        return (
          (await handler(
            request,
            message.responder as RequestResponder<Resp>,
            cx,
          )) ?? Handled.yes()
        );
      },
      describe: () => `${this.connectionName ?? "request"}:${method}`,
    });
  }

  /**
   * Adds a typed notification handler for one method.
   */
  onReceiveNotification<Notif>(
    method: string,
    parse: (params: unknown) => Notif,
    handler: NotificationCallback<Notif>,
  ): this {
    return this.withHandler({
      handleMessage: async (message, cx) => {
        if (message.kind !== "notification" || message.method !== method) {
          return Handled.no(message);
        }

        const notification = parse(message.params);
        return (await handler(notification, cx)) ?? Handled.yes();
      },
      describe: () => `${this.connectionName ?? "notification"}:${method}`,
    });
  }

  /**
   * Connects the configured handlers to a stream.
   */
  connect(stream: Stream, options?: ConnectionOptions): Connection {
    return new Connection(stream, this.handlers, options);
  }

  /**
   * Connects to a stream for the lifetime of `op`, then closes the connection.
   */
  connectWith<T>(
    stream: Stream,
    op: (cx: ConnectionContext) => MaybePromise<T>,
    options?: ConnectionOptions,
  ): Promise<T> {
    return this.connect(stream, options).runUntil(op);
  }
}

/**
 * JSON-RPC error object.
 *
 * Represents an error that occurred during method execution, following the
 * JSON-RPC 2.0 error object specification with optional additional data.
 *
 * See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
 */
export class RequestError extends Error {
  /**
   * Additional JSON-RPC error data.
   */
  data?: unknown;

  constructor(
    /**
     * JSON-RPC error code.
     */
    public code: number,
    message: string,
    data?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
    this.data = data;
  }

  /**
   * Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
   */
  static parseError(data?: unknown, additionalMessage?: string): RequestError {
    return new RequestError(
      -32700,
      `Parse error${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * The JSON sent is not a valid Request object.
   */
  static invalidRequest(
    data?: unknown,
    additionalMessage?: string,
  ): RequestError {
    return new RequestError(
      -32600,
      `Invalid request${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * The method does not exist / is not available.
   */
  static methodNotFound(method: string): RequestError {
    return new RequestError(-32601, `"Method not found": ${method}`, {
      method,
    });
  }

  /**
   * Invalid method parameter(s).
   */
  static invalidParams(
    data?: unknown,
    additionalMessage?: string,
  ): RequestError {
    return new RequestError(
      -32602,
      `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * Internal JSON-RPC error.
   */
  static internalError(
    data?: unknown,
    additionalMessage?: string,
  ): RequestError {
    return new RequestError(
      -32603,
      `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * Execution of the request was aborted.
   */
  static requestCancelled(
    data?: unknown,
    additionalMessage?: string,
  ): RequestError {
    return new RequestError(
      -32800,
      `Request cancelled${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * Authentication required.
   */
  static authRequired(
    data?: unknown,
    additionalMessage?: string,
  ): RequestError {
    return new RequestError(
      -32000,
      `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`,
      data,
    );
  }

  /**
   * Resource, such as a file, was not found
   */
  static resourceNotFound(uri?: string): RequestError {
    return new RequestError(
      -32002,
      `Resource not found${uri ? `: ${uri}` : ""}`,
      uri && { uri },
    );
  }

  /**
   * Converts this error to a JSON-RPC result object.
   */
  toResult<T>(): Result<T> {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data,
      },
    };
  }

  /**
   * Converts this error to a JSON-RPC error response payload.
   */
  toErrorResponse(): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}
