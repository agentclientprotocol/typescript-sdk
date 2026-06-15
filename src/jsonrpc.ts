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
  resolve: (response: unknown) => void;
  reject: (error: unknown) => void;
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

export class ConnectionContext {
  constructor(private connection: Connection) {}

  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): Promise<Output> {
    return this.connection.sendRequest(method, params, mapResponse);
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

  sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
  ): Promise<Output> {
    if (this.abortController.signal.aborted) {
      return rejectedPromise(this.closedReason());
    }

    const id = this.nextRequestId++;
    const responsePromise = new Promise<Output>((resolve, reject) => {
      this.pendingResponses.set(id, {
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
      });
    });
    responsePromise.catch(() => {});
    void this.sendMessage({ jsonrpc: "2.0", id, method, params }).catch(
      () => {},
    );
    return responsePromise;
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
    for (const pendingResponse of this.pendingResponses.values()) {
      pendingResponse.reject(closeError);
    }
    this.pendingResponses.clear();
    this.abortController.abort(closeError);
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

    if ("method" in message && "id" in message) {
      void this.processIncomingMessage(this.toIncomingMessage(message)).catch(
        (error) => this.close(error),
      );
    } else if ("method" in message) {
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
      if ("result" in response) {
        pendingResponse.resolve(response.result);
      } else if ("error" in response) {
        const { code, message, data } = response.error;
        pendingResponse.reject(new RequestError(code, message, data));
      } else {
        pendingResponse.reject(RequestError.invalidRequest(response));
      }
      this.pendingResponses.delete(response.id);
    } else {
      console.error("Got response to unknown request", response.id);
    }
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
