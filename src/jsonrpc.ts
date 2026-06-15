import { z } from "zod/v4";
import type { Stream } from "./stream.js";

export type AnyMessage = AnyRequest | AnyResponse | AnyNotification;

export type AnyRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
};

export type AnyResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
} & Result<unknown>;

export type AnyNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type Result<T> =
  | {
      result: T;
    }
  | {
      error: ErrorResponse;
    };

export type ErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

export type RequestHandler = (
  method: string,
  params: unknown,
  cx: ConnectionContext,
) => MaybePromise<unknown>;
export type NotificationHandler = (
  method: string,
  params: unknown,
  cx: ConnectionContext,
) => MaybePromise<void>;

type ConnectionPendingResponse = {
  method: string;
  settleResult: (response: unknown) => RequestResult<unknown>;
  settleError: (error: unknown) => RequestResult<unknown>;
  callbacks: ResponseCallback<unknown>[];
};

export type MaybePromise<T> = T | Promise<T>;

export type IncomingRequest = {
  kind: "request";
  method: string;
  params: unknown;
  raw: AnyRequest;
  responder: RequestResponder<unknown>;
};

export type IncomingNotification = {
  kind: "notification";
  method: string;
  params: unknown;
  raw: AnyNotification;
};

export type IncomingMessage = IncomingRequest | IncomingNotification;

type ResponseCallback<T> = (result: RequestResult<T>) => MaybePromise<void>;

type IncomingQueueItem =
  | {
      kind: "message";
      message: IncomingMessage;
    }
  | {
      kind: "response_callbacks";
      method: string;
      id: string | number | null;
      result: RequestResult<unknown>;
      callbacks: ResponseCallback<unknown>[];
    };

export type HandleResult =
  | { handled: true }
  | { handled: false; message?: IncomingMessage; retry?: boolean };

export const Handled = {
  yes(): HandleResult {
    return { handled: true };
  },

  no(message?: IncomingMessage, retry = false): HandleResult {
    return { handled: false, message, retry };
  },
};

export interface JsonRpcHandler {
  handleMessage(
    message: IncomingMessage,
    cx: ConnectionContext,
  ): MaybePromise<HandleResult | void>;
  describe?(): string;
}

export type RequestCallback<Req, Resp> = (
  request: Req,
  responder: RequestResponder<Resp>,
  cx: ConnectionContext,
) => MaybePromise<HandleResult | void>;

export type NotificationCallback<Notif> = (
  notification: Notif,
  cx: ConnectionContext,
) => MaybePromise<HandleResult | void>;

export type RequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

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

function errorToResult<T>(error: unknown): Result<T> {
  if (error instanceof RequestError) {
    return error.toResult();
  }

  if (error instanceof z.ZodError) {
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

function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) {
    return error;
  }

  const details = errorDetails(error);
  return RequestError.internalError({ details });
}

export class RequestResponder<Resp = unknown> {
  private didRespond = false;

  constructor(
    public readonly id: string | number | null,
    private sendResult: (result: Result<Resp>) => Promise<void>,
  ) {}

  get responded(): boolean {
    return this.didRespond;
  }

  respond(response: Resp): Promise<void> {
    return this.respondWithResult({ result: (response ?? null) as Resp });
  }

  respondWithError(error: RequestError | ErrorResponse): Promise<void> {
    const errorResponse =
      error instanceof RequestError ? error.toErrorResponse() : error;
    return this.respondWithResult({ error: errorResponse });
  }

  respondWithResult(result: Result<Resp>): Promise<void> {
    if (this.didRespond) {
      return rejectedPromise(new Error("JSON-RPC request already responded"));
    }

    this.didRespond = true;
    return this.sendResult(result);
  }
}

export class HandlerRegistration {
  private active = true;

  constructor(private disposeHandler: () => void) {}

  dispose(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.disposeHandler();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  runIndefinitely(): this {
    return this;
  }
}

/**
 * Handle for an outgoing JSON-RPC request.
 *
 * Use {@link wait} or {@link response} for normal Promise-based control flow.
 * Use {@link onResponse} when response handling must stay ordered with the
 * connection's incoming message dispatch.
 */
export interface SentRequest<T> {
  /**
   * The JSON-RPC method for this request.
   */
  readonly method: string;

  /**
   * The JSON-RPC request id, or `undefined` if the request could not be sent.
   */
  readonly id?: string | number | null;

  /**
   * Promise for the response value.
   *
   * This settles as soon as the JSON-RPC response arrives. It is best for
   * linear code in `connectWith`, `runUntil`, or independent async work.
   * If response handling must block later incoming messages, use
   * {@link onResponse} instead.
   */
  readonly response: Promise<T>;

  /**
   * Wait for the response value.
   *
   * This is equivalent to awaiting {@link response}.
   */
  wait(): Promise<T>;

  /**
   * Run a callback when the response arrives.
   *
   * When registered before the response arrives, this callback runs from the
   * connection's incoming message queue. Later incoming messages wait until the
   * callback completes, matching the ordering behavior of Rust SDK
   * `on_receiving_result`.
   */
  onResponse(callback: (result: RequestResult<T>) => MaybePromise<void>): void;

  /**
   * Run a callback only for a successful response.
   *
   * If the request fails, the error is automatically forwarded to `responder`.
   * This is the success-only counterpart to {@link onResponse}.
   */
  onSuccess<Resp>(
    responder: RequestResponder<Resp>,
    callback: (
      value: T,
      responder: RequestResponder<Resp>,
    ) => MaybePromise<void>,
  ): void;
}

class SentRequestHandle<T> implements SentRequest<T> {
  constructor(
    private responsePromise: Promise<T>,
    public readonly method: string,
    public readonly id?: string | number | null,
    private registerResponseCallback?: (
      callback: (result: RequestResult<T>) => MaybePromise<void>,
    ) => boolean,
    private trackTask?: (task: () => Promise<void>) => void,
  ) {
    this.responsePromise.catch(() => {});
  }

  get response(): Promise<T> {
    return this.responsePromise;
  }

  wait(): Promise<T> {
    return this.responsePromise;
  }

  onResponse(callback: (result: RequestResult<T>) => MaybePromise<void>): void {
    if (this.registerResponseCallback?.(callback)) {
      return;
    }

    this.runTask(async () => {
      try {
        const value = await this.responsePromise;
        await callback({ ok: true, value });
      } catch (error) {
        await callback({ ok: false, error });
      }
    });
  }

  onSuccess<Resp>(
    responder: RequestResponder<Resp>,
    callback: (
      value: T,
      responder: RequestResponder<Resp>,
    ) => MaybePromise<void>,
  ): void {
    this.onResponse(async (result) => {
      if (result.ok) {
        await callback(result.value, responder);
      } else {
        await responder.respondWithError(toRequestError(result.error));
      }
    });
  }

  private runTask(task: () => Promise<void>): void {
    if (this.trackTask) {
      this.trackTask(task);
      return;
    }

    void task().catch(() => {});
  }
}

export class ConnectionContext {
  constructor(private connection: Connection) {}

  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): Promise<Output> {
    return this.connection.sendRequest(method, params, mapResponse);
  }

  sendRequestHandle<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): SentRequest<Output> {
    return this.connection.sendRequestHandle(method, params, mapResponse);
  }

  sendNotification<N>(method: string, params?: N): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    return this.connection.addDynamicHandler(handler);
  }

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

export type ConnectionOptions = {
  handlers?: JsonRpcHandler[];
};

export class Connection {
  private pendingResponses: Map<
    string | number | null,
    ConnectionPendingResponse
  > = new Map();
  private nextRequestId = 0;
  private staticHandlers: JsonRpcHandler[] = [];
  private dynamicHandlers: Set<JsonRpcHandler> = new Set();
  private stream!: Stream;
  private writeQueue: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private closedPromise!: Promise<void>;
  private incomingQueue: IncomingQueueItem[] = [];
  private retryQueue: IncomingMessage[] = [];
  private isDispatching = false;
  private context = new ConnectionContext(this);

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

  static builder(): ConnectionBuilder {
    return new ConnectionBuilder();
  }

  static withHandlers(
    stream: Stream,
    handlers: JsonRpcHandler[],
    options?: ConnectionOptions,
  ): Connection {
    return new Connection(stream, handlers, options);
  }

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

  private trackTask(task: Promise<void> | (() => MaybePromise<void>)): void {
    const promise =
      typeof task === "function" ? Promise.resolve().then(task) : task;
    promise.catch((error) => {
      this.close(error);
    });
  }

  addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    this.dynamicHandlers.add(handler);
    if (this.retryQueue.length > 0) {
      this.incomingQueue.push(
        ...this.retryQueue
          .splice(0)
          .map((message): IncomingQueueItem => ({ kind: "message", message })),
      );
      void this.drainIncomingQueue();
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

  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): Promise<Output> {
    return this.sendRequestHandle(method, params, mapResponse).wait();
  }

  sendRequestHandle<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): SentRequest<Output> {
    if (this.abortController.signal.aborted) {
      return new SentRequestHandle(
        rejectedPromise(this.closedReason()),
        method,
        undefined,
        undefined,
        (task) => this.trackTask(task),
      );
    }

    const id = this.nextRequestId++;
    const callbacks: ResponseCallback<unknown>[] = [];
    const responsePromise = new Promise<Output>((resolve, reject) => {
      this.pendingResponses.set(id, {
        method,
        callbacks,
        settleResult: (response) => {
          try {
            const value = mapResponse
              ? mapResponse(response as Resp)
              : (response as Output);
            resolve(value);
            return { ok: true, value };
          } catch (error) {
            reject(error);
            return { ok: false, error };
          }
        },
        settleError: (error) => {
          reject(error);
          return { ok: false, error };
        },
      });
    });
    responsePromise.catch(() => {});
    void this.sendMessage({ jsonrpc: "2.0", id, method, params }).catch(
      () => {},
    );
    return new SentRequestHandle(
      responsePromise,
      method,
      id,
      (callback) =>
        this.addResponseCallback(id, callback as ResponseCallback<unknown>),
      (task) => this.trackTask(task),
    );
  }

  sendNotification<N>(method: string, params?: N): Promise<void> {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }

    return this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  close(error?: unknown): void {
    if (this.abortController.signal.aborted) {
      return;
    }

    const closeError: unknown = error ?? new Error("ACP connection closed");
    const queuedCallbacks = this.takeQueuedResponseCallbacks();
    for (const [id, pendingResponse] of this.pendingResponses) {
      const result = pendingResponse.settleError(closeError);
      this.trackResponseCallbacks({
        kind: "response_callbacks",
        method: pendingResponse.method,
        id,
        result,
        callbacks: pendingResponse.callbacks.splice(0),
      });
    }
    this.pendingResponses.clear();
    this.abortController.abort(closeError);
    for (const queuedCallback of queuedCallbacks) {
      this.trackResponseCallbacks(queuedCallback);
    }
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
      try {
        while (!this.abortController.signal.aborted) {
          const { value: message, done } = await reader.read();
          if (done) {
            break;
          }
          if (!message) {
            continue;
          }

          this.receiveMessage(message);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      closeError = error;
    } finally {
      this.close(closeError);
    }
  }

  private receiveMessage(message: AnyMessage): void {
    if ("method" in message && "id" in message) {
      this.incomingQueue.push({
        kind: "message",
        message: this.toIncomingMessage(message),
      });
      void this.drainIncomingQueue();
    } else if ("method" in message) {
      this.incomingQueue.push({
        kind: "message",
        message: this.toIncomingMessage(message),
      });
      void this.drainIncomingQueue();
    } else if ("id" in message) {
      this.handleResponse(message);
    } else {
      console.error("Invalid message", { message });
    }
  }

  private async drainIncomingQueue(): Promise<void> {
    if (this.isDispatching) {
      return;
    }

    this.isDispatching = true;
    try {
      while (
        this.incomingQueue.length > 0 &&
        !this.abortController.signal.aborted
      ) {
        const item = this.incomingQueue.shift();
        if (!item) {
          continue;
        }

        if (item.kind === "message") {
          await this.processIncomingMessage(item.message);
        } else {
          await this.processResponseCallbacks(item);
        }
      }
    } finally {
      this.isDispatching = false;
      if (
        this.incomingQueue.length > 0 &&
        !this.abortController.signal.aborted
      ) {
        void this.drainIncomingQueue();
      }
    }
  }

  private async processIncomingMessage(
    message: IncomingMessage,
  ): Promise<void> {
    let current = message;
    let retry = false;

    try {
      for (const handler of [
        ...this.staticHandlers,
        ...this.dynamicHandlers.values(),
      ]) {
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
      if (current.kind === "request" && !current.responder.responded) {
        await current.responder.respondWithResult(errorToResult(error));
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
      return {
        kind: "request",
        method: message.method,
        params: message.params,
        raw: message,
        responder: new RequestResponder(message.id, (result) =>
          this.sendMessage({
            jsonrpc: "2.0",
            id: message.id,
            ...result,
          }),
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
      let result: RequestResult<unknown>;
      if ("result" in response) {
        result = pendingResponse.settleResult(response.result);
      } else if ("error" in response) {
        const { code, message, data } = response.error;
        result = pendingResponse.settleError(
          new RequestError(code, message, data),
        );
      } else {
        result = pendingResponse.settleError(
          RequestError.invalidRequest(response),
        );
      }
      this.pendingResponses.delete(response.id);

      const callbacks = pendingResponse.callbacks.splice(0);
      if (callbacks.length > 0) {
        this.incomingQueue.push({
          kind: "response_callbacks",
          method: pendingResponse.method,
          id: response.id,
          result,
          callbacks,
        });
        void this.drainIncomingQueue();
      }
    } else {
      console.error("Got response to unknown request", response.id);
    }
  }

  private addResponseCallback(
    id: string | number | null,
    callback: ResponseCallback<unknown>,
  ): boolean {
    const pendingResponse = this.pendingResponses.get(id);
    if (!pendingResponse) {
      return false;
    }

    pendingResponse.callbacks.push(callback);
    return true;
  }

  private trackResponseCallbacks(
    item: Extract<IncomingQueueItem, { kind: "response_callbacks" }>,
  ): void {
    if (item.callbacks.length === 0) {
      return;
    }

    this.trackTask(() => this.processResponseCallbacks(item));
  }

  private takeQueuedResponseCallbacks(): Array<
    Extract<IncomingQueueItem, { kind: "response_callbacks" }>
  > {
    const callbacks: Array<
      Extract<IncomingQueueItem, { kind: "response_callbacks" }>
    > = [];
    const remaining: IncomingQueueItem[] = [];
    for (const item of this.incomingQueue) {
      if (item.kind === "response_callbacks") {
        callbacks.push(item);
      } else {
        remaining.push(item);
      }
    }
    this.incomingQueue = remaining;
    return callbacks;
  }

  private async processResponseCallbacks(
    item: Extract<IncomingQueueItem, { kind: "response_callbacks" }>,
  ): Promise<void> {
    try {
      for (const callback of item.callbacks) {
        await callback(item.result);
      }
    } catch (error) {
      this.close(error);
    }
  }

  private closedReason(): unknown {
    return (
      this.abortController.signal.reason ?? new Error("ACP connection closed")
    );
  }

  private async sendMessage(message: AnyMessage): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
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

export class ConnectionBuilder {
  private handlers: JsonRpcHandler[] = [];
  private connectionName?: string;

  name(name: string): this {
    this.connectionName = name;
    return this;
  }

  withHandler(handler: JsonRpcHandler): this {
    this.handlers.push(handler);
    return this;
  }

  onReceiveMessage(
    handler: (
      message: IncomingMessage,
      cx: ConnectionContext,
    ) => MaybePromise<HandleResult | void>,
  ): this {
    return this.withHandler({
      handleMessage: handler,
      describe: () => this.connectionName ?? "onReceiveMessage",
    });
  }

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

  connect(stream: Stream, options?: ConnectionOptions): Connection {
    return Connection.withHandlers(stream, this.handlers, options);
  }

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
  data?: unknown;

  constructor(
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

  toResult<T>(): Result<T> {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data,
      },
    };
  }

  toErrorResponse(): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}
