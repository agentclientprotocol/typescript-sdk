import * as schema from "./schema/index.js";
import * as validate from "./schema/zod.gen.js";
export type * from "./schema/types.gen.js";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from "./schema/index.js";
export * from "./stream.js";
export { RequestError } from "./jsonrpc.js";
export type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
  ErrorResponse,
  JsonRpcId,
  MaybePromise,
  Result,
  SendRequestOptions,
} from "./jsonrpc.js";

import type { Stream } from "./stream.js";
import { Connection, Handled, HandlerRegistration } from "./jsonrpc.js";
import type {
  AnyMessage,
  ConnectionBuilder,
  ConnectionContext,
  HandleResult,
  IncomingMessage,
  JsonRpcId,
  JsonRpcHandler,
  MaybePromise,
  SendRequestOptions,
} from "./jsonrpc.js";

function emptyObjectResponse<T>(response: T | null | undefined | void): T {
  return response ?? ({} as T);
}

function isStream(value: unknown): value is Stream {
  return (
    typeof value === "object" &&
    value !== null &&
    "readable" in value &&
    "writable" in value
  );
}

function memoryStreamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<AnyMessage>();
  const rightToLeft = new TransformStream<AnyMessage>();
  return [
    {
      readable: rightToLeft.readable,
      writable: leftToRight.writable,
    },
    {
      readable: leftToRight.readable,
      writable: rightToLeft.writable,
    },
  ];
}

/**
 * ACP method-name constants.
 *
 * Use these with `onRequest(...)`, `onNotification(...)`, `request(...)`, and
 * `notify(...)` when you want literal-string type inference without spelling
 * protocol strings inline.
 */
export const methods = {
  agent: {
    initialize: schema.AGENT_METHODS.initialize,
    authenticate: schema.AGENT_METHODS.authenticate,
    logout: schema.AGENT_METHODS.logout,
    providers: {
      list: schema.AGENT_METHODS.providers_list,
      set: schema.AGENT_METHODS.providers_set,
      disable: schema.AGENT_METHODS.providers_disable,
    },
    session: {
      new: schema.AGENT_METHODS.session_new,
      load: schema.AGENT_METHODS.session_load,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      fork: schema.AGENT_METHODS.session_fork,
      resume: schema.AGENT_METHODS.session_resume,
      close: schema.AGENT_METHODS.session_close,
      setMode: schema.AGENT_METHODS.session_set_mode,
      setConfigOption: schema.AGENT_METHODS.session_set_config_option,
      prompt: schema.AGENT_METHODS.session_prompt,
      cancel: schema.AGENT_METHODS.session_cancel,
    },
    nes: {
      start: schema.AGENT_METHODS.nes_start,
      suggest: schema.AGENT_METHODS.nes_suggest,
      accept: schema.AGENT_METHODS.nes_accept,
      reject: schema.AGENT_METHODS.nes_reject,
      close: schema.AGENT_METHODS.nes_close,
    },
    document: {
      didOpen: schema.AGENT_METHODS.document_did_open,
      didChange: schema.AGENT_METHODS.document_did_change,
      didClose: schema.AGENT_METHODS.document_did_close,
      didSave: schema.AGENT_METHODS.document_did_save,
      didFocus: schema.AGENT_METHODS.document_did_focus,
    },
  },
  client: {
    session: {
      requestPermission: schema.CLIENT_METHODS.session_request_permission,
      update: schema.CLIENT_METHODS.session_update,
    },
    fs: {
      writeTextFile: schema.CLIENT_METHODS.fs_write_text_file,
      readTextFile: schema.CLIENT_METHODS.fs_read_text_file,
    },
    terminal: {
      create: schema.CLIENT_METHODS.terminal_create,
      output: schema.CLIENT_METHODS.terminal_output,
      release: schema.CLIENT_METHODS.terminal_release,
      waitForExit: schema.CLIENT_METHODS.terminal_wait_for_exit,
      kill: schema.CLIENT_METHODS.terminal_kill,
    },
    elicitation: {
      create: schema.CLIENT_METHODS.elicitation_create,
      complete: schema.CLIENT_METHODS.elicitation_complete,
    },
  },
  protocol: {
    cancelRequest: schema.PROTOCOL_METHODS.cancel_request,
  },
} as const;

const startActiveSession = Symbol("startActiveSession");

/**
 * Active ACP connection returned by `AgentApp.connect(...)` and
 * `ClientApp.connect(...)`.
 *
 * Use this handle when you need a connection to stay open independently of a
 * single `connectWith(...)` operation.
 */
export interface AcpConnection {
  /**
   * AbortSignal that aborts when the connection closes.
   */
  readonly signal: AbortSignal;

  /**
   * Promise that resolves when the connection closes.
   */
  readonly closed: Promise<void>;

  /**
   * Closes the connection and rejects pending requests.
   */
  close(error?: unknown): void;
}

/**
 * Agent-side connection returned by `AgentApp.connect(...)`.
 *
 * Use `client` to call client-side ACP methods for the lifetime of the
 * connection.
 */
export interface AgentConnection extends AcpConnection {
  /**
   * Context for calling client-side ACP methods.
   */
  readonly client: AgentContext;
}

/**
 * Client-side connection returned by `ClientApp.connect(...)`.
 *
 * Use `agent` to call agent-side ACP methods and session helpers for the
 * lifetime of the connection.
 */
export interface ClientConnection extends AcpConnection {
  /**
   * Context for calling agent-side ACP methods.
   */
  readonly agent: ClientContext;
}

class AcpContext {
  /** @internal */
  constructor(
    private readonly cx: ConnectionContext,
    private readonly currentRequestId?: JsonRpcId,
  ) {}

  /**
   * JSON-RPC id of the request currently being handled.
   *
   * This is `undefined` for notification handlers and for contexts created
   * outside an inbound request, such as `connect(...)` and `connectWith(...)`.
   */
  get requestId(): JsonRpcId | undefined {
    return this.currentRequestId;
  }

  /** @internal */
  protected get connectionContext(): ConnectionContext {
    return this.cx;
  }

  /** @internal */
  protected sendRequest<Req, Resp, Output = Resp>(
    method: string,
    params?: Req,
    mapResponse?: (response: Resp) => Output,
    options?: SendRequestOptions,
  ): Promise<Output> {
    return this.cx.sendRequest(method, params, mapResponse, options);
  }

  /** @internal */
  protected sendNotification<N>(method: string, params?: N): Promise<void> {
    return this.cx.sendNotification(method, params);
  }

  /** @internal */
  protected addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    return this.cx.addDynamicHandler(handler);
  }
}

/**
 * Context passed to agent-side handlers.
 *
 * Agents use this context to call client-side ACP methods while handling
 * requests such as `session/prompt`.
 */
export class AgentContext extends AcpContext {
  private constructor(cx: ConnectionContext, requestId?: JsonRpcId) {
    super(cx, requestId);
  }

  /** @internal */
  static create(cx: ConnectionContext, requestId?: JsonRpcId): AgentContext {
    return new AgentContext(cx, requestId);
  }

  /**
   * Sends a request to the client by ACP method name.
   *
   * Built-in method literals infer their params and response types. Custom
   * methods can specify their response and params types with generics.
   */
  request<Method extends ClientRequestMethod>(
    method: Method,
    params: ClientRequestParamsByMethod[Method],
    options?: SendRequestOptions,
  ): Promise<ClientRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    const spec = clientRequestSpecsByMethod[method] as
      | AcpRequestSpec<unknown, unknown, unknown>
      | undefined;
    return this.sendRequest(method, params, spec?.mapResponse, options);
  }

  /**
   * Sends a notification to the client by ACP method name.
   *
   * Built-in method literals infer their params type. Custom notifications can
   * specify their params type with a generic.
   */
  notify<Method extends ClientNotificationMethod>(
    method: Method,
    params: ClientNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    return this.sendNotification(method, params);
  }
}

/**
 * Context used by clients to call agent-side ACP methods.
 *
 * `connectWith` passes a `ClientContext` to the callback. Client handlers also
 * receive one as `ctx.agent` when they need to call back into the agent.
 */
export class ClientContext extends AcpContext {
  private constructor(cx: ConnectionContext, requestId?: JsonRpcId) {
    super(cx, requestId);
  }

  /** @internal */
  static create(cx: ConnectionContext, requestId?: JsonRpcId): ClientContext {
    return new ClientContext(cx, requestId);
  }

  /** @internal */
  [startActiveSession](
    params: schema.NewSessionRequest,
    options?: SendRequestOptions,
  ): Promise<ActiveSession> {
    return this.sendRequest<
      schema.NewSessionRequest,
      schema.NewSessionResponse,
      ActiveSession
    >(
      schema.AGENT_METHODS.session_new,
      params,
      (response) => this.attachSession(response),
      options,
    );
  }

  /**
   * Creates a builder for starting and observing an ACP session.
   *
   * Pass a string for the common case where only `cwd` is needed, or pass a
   * full `NewSessionRequest` when you need MCP servers, `_meta`, or additional
   * session fields.
   */
  buildSession(cwd: string): SessionBuilder;
  buildSession(request: schema.NewSessionRequest): SessionBuilder;
  buildSession(
    cwdOrRequest: string | schema.NewSessionRequest,
  ): SessionBuilder {
    if (typeof cwdOrRequest === "string") {
      return SessionBuilder.create(this, {
        cwd: cwdOrRequest,
        mcpServers: [],
      });
    }

    return SessionBuilder.create(this, cwdOrRequest);
  }

  /**
   * Builds active-session helpers around a `session/new` response.
   */
  private attachSession(response: schema.NewSessionResponse): ActiveSession {
    const updates = new AsyncQueue<ActiveSessionMessage>();
    const closeSignal = this.connectionContext.signal;
    const failUpdatesOnClose = () => {
      updates.fail(closeSignal.reason ?? new Error("ACP connection closed"));
    };
    if (closeSignal.aborted) {
      failUpdatesOnClose();
    } else {
      closeSignal.addEventListener("abort", failUpdatesOnClose);
    }
    const sessionRegistration = sessionUpdateRouter(
      this.connectionContext,
    ).attach(response, updates);
    const closeRegistration = new HandlerRegistration(() => {
      closeSignal.removeEventListener("abort", failUpdatesOnClose);
    });

    return ActiveSession.create(this, response, updates, [
      sessionRegistration,
      closeRegistration,
    ]);
  }

  /**
   * Sends a request to the agent by ACP method name.
   *
   * Built-in method literals infer their params and response types. Custom
   * methods can specify their response and params types with generics.
   */
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: SendRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    const spec = agentRequestSpecsByMethod[method] as
      | AcpRequestSpec<unknown, unknown, unknown>
      | undefined;
    return this.sendRequest(method, params, spec?.mapResponse, options);
  }

  /**
   * Sends a notification to the agent by ACP method name.
   *
   * Built-in method literals infer their params type. Custom notifications can
   * specify their params type with a generic.
   */
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    return this.sendNotification(method, params);
  }
}

class AcpConnectionHandle implements AcpConnection {
  constructor(private readonly connection: Connection) {}

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  close(error?: unknown): void {
    this.connection.close(error);
  }
}

class AgentConnectionHandle
  extends AcpConnectionHandle
  implements AgentConnection
{
  readonly client: AgentContext;
  private didStartConnectHandlers = false;

  constructor(
    connection: Connection,
    private readonly connectHandlers: readonly AgentConnectHandler[] = [],
  ) {
    super(connection);
    this.client = AgentContext.create(connection.getContext());
  }

  /** @internal */
  startConnectHandlers(): void {
    if (this.didStartConnectHandlers) {
      return;
    }

    this.didStartConnectHandlers = true;
    runConnectHandlers(this, this.connectHandlers);
  }
}

class ClientConnectionHandle
  extends AcpConnectionHandle
  implements ClientConnection
{
  readonly agent: ClientContext;
  private didStartConnectHandlers = false;

  constructor(
    connection: Connection,
    private readonly connectHandlers: readonly ClientConnectHandler[] = [],
  ) {
    super(connection);
    this.agent = ClientContext.create(connection.getContext());
  }

  /** @internal */
  startConnectHandlers(): void {
    if (this.didStartConnectHandlers) {
      return;
    }

    this.didStartConnectHandlers = true;
    runConnectHandlers(this, this.connectHandlers);
  }
}

function agentConnection(
  connection: Connection,
  connectHandlers: readonly AgentConnectHandler[] = [],
): AgentConnection {
  return new AgentConnectionHandle(connection, connectHandlers);
}

function clientConnection(
  connection: Connection,
  connectHandlers: readonly ClientConnectHandler[] = [],
): ClientConnection {
  return new ClientConnectionHandle(connection, connectHandlers);
}

type AsyncQueueEntry<T> =
  | {
      kind: "value";
      value: T;
    }
  | {
      kind: "error";
      error: unknown;
    };

class AsyncQueue<T> {
  private values: Array<AsyncQueueEntry<T>> = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  private failed = false;
  private failure: unknown;

  enqueue(value: T): void {
    if (this.failed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.values.push({ kind: "value", value });
    }
  }

  reject(error: unknown): void {
    if (this.failed) {
      return;
    }

    if (this.waiters.length > 0) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
      return;
    }

    this.values.push({ kind: "error", error });
  }

  clearErrors(): void {
    this.values = this.values.filter((entry) => entry.kind === "value");
  }

  fail(error: unknown): void {
    if (this.failed) {
      return;
    }

    this.failed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<T> {
    if (this.values.length > 0) {
      const entry = this.values.shift() as AsyncQueueEntry<T>;
      if (entry.kind === "error") {
        return Promise.reject(entry.error);
      }

      return Promise.resolve(entry.value);
    }

    if (this.failed) {
      return Promise.reject(this.failure);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function cloneNewSessionRequest(
  request: schema.NewSessionRequest,
): schema.NewSessionRequest {
  return {
    ...request,
    additionalDirectories: request.additionalDirectories
      ? [...request.additionalDirectories]
      : undefined,
    mcpServers: [...request.mcpServers],
  };
}

/**
 * Message produced by an `ActiveSession`.
 *
 * `session_update` messages expose the typed `session/update` notification and
 * `stop` messages report the final `session/prompt` response. A prompt turn is
 * complete once a `stop` message is returned.
 */
export type ActiveSessionMessage =
  | {
      /**
       * Indicates that this message came from a `session/update` notification.
       */
      kind: "session_update";
      /**
       * Full notification sent by the agent.
       */
      notification: schema.SessionNotification;
      /**
       * Convenience alias for `notification.update`.
       */
      update: schema.SessionUpdate;
    }
  | {
      /**
       * Indicates that the prompt turn has completed.
       */
      kind: "stop";
      /**
       * Final response from `session/prompt`.
       */
      response: schema.PromptResponse;
      /**
       * Convenience alias for `response.stopReason`.
       */
      stopReason: schema.StopReason;
    };

/**
 * Builder for creating an `ActiveSession`.
 *
 * Start from `ctx.buildSession("/absolute/cwd")` for the common case, or
 * pass a full `NewSessionRequest` to `ctx.buildSession(...)` when the session
 * needs MCP servers, `_meta`, or additional request fields. All paths in ACP
 * payloads should be absolute.
 */
export class SessionBuilder {
  private request: schema.NewSessionRequest;

  private constructor(
    private cx: ClientContext,
    request: schema.NewSessionRequest,
  ) {
    this.request = cloneNewSessionRequest(request);
  }

  /** @internal */
  static create(
    cx: ClientContext,
    request: schema.NewSessionRequest,
  ): SessionBuilder {
    return new SessionBuilder(cx, request);
  }

  /**
   * Returns the `session/new` request that will be sent.
   *
   * The returned object is a defensive copy, so mutating it does not change the
   * builder.
   */
  toRequest(): schema.NewSessionRequest {
    return cloneNewSessionRequest(this.request);
  }

  /**
   * Replaces the additional workspace roots for this session.
   *
   * `additionalDirectories` expand the session's file-system scope without
   * changing `cwd`. Each path should be absolute.
   */
  withAdditionalDirectories(additionalDirectories: string[]): this {
    this.request = {
      ...this.request,
      additionalDirectories: [...additionalDirectories],
    };
    return this;
  }

  /**
   * Adds one MCP server to the `session/new` request.
   */
  withMcpServer(mcpServer: schema.McpServer): this {
    this.request = {
      ...this.request,
      mcpServers: [...this.request.mcpServers, mcpServer],
    };
    return this;
  }

  /**
   * Starts the session and returns an `ActiveSession` for prompting and reading
   * updates.
   *
   * Call `dispose()` on the returned session when you no longer need update
   * routing, or use `withSession(...)` to scope disposal automatically.
   */
  async start(options?: SendRequestOptions): Promise<ActiveSession> {
    return this.cx[startActiveSession](this.toRequest(), options);
  }

  /**
   * Starts the session, runs `op`, and disposes the active-session update
   * routing when `op` finishes or throws.
   */
  async withSession<T>(
    op: (session: ActiveSession) => MaybePromise<T>,
  ): Promise<T> {
    const session = await this.start();
    try {
      return await op(session);
    } finally {
      session.dispose();
    }
  }
}

/**
 * Convenience wrapper for an active ACP session.
 *
 * An active session routes `session/update` notifications for one session ID
 * into an async queue. Use `prompt(...)` to send user content, then read updates
 * with `nextUpdate()` until a `stop` message is returned.
 */
export class ActiveSession {
  private constructor(
    private cx: ClientContext,
    private sessionResponse: schema.NewSessionResponse,
    private updates: {
      enqueue(value: ActiveSessionMessage): void;
      reject(error: unknown): void;
      clearErrors(): void;
      fail(error: unknown): void;
      next(): Promise<ActiveSessionMessage>;
    },
    private registrations: HandlerRegistration[],
  ) {}

  /** @internal */
  static create(
    cx: ClientContext,
    sessionResponse: schema.NewSessionResponse,
    updates: {
      enqueue(value: ActiveSessionMessage): void;
      reject(error: unknown): void;
      clearErrors(): void;
      fail(error: unknown): void;
      next(): Promise<ActiveSessionMessage>;
    },
    registrations: HandlerRegistration[],
  ): ActiveSession {
    return new ActiveSession(cx, sessionResponse, updates, registrations);
  }

  /**
   * Session ID returned by `session/new`.
   */
  get sessionId(): schema.SessionId {
    return this.sessionResponse.sessionId;
  }

  /**
   * Mode state returned when the session was created, if the agent provided it.
   */
  get modes(): schema.SessionModeState | null | undefined {
    return this.sessionResponse.modes;
  }

  /**
   * Metadata returned when the session was created.
   */
  get meta(): { [key: string]: unknown } | null | undefined {
    return this.sessionResponse._meta;
  }

  /**
   * Full response returned by `session/new`.
   */
  get newSessionResponse(): schema.NewSessionResponse {
    return this.sessionResponse;
  }

  /**
   * Sends a prompt to this session.
   *
   * Strings are converted to one text content block. A single content block is
   * wrapped in an array. The returned promise resolves with the final
   * `PromptResponse`, and the same completion is also queued as a `stop`
   * message for `nextUpdate()`.
   */
  prompt(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
    options?: SendRequestOptions,
  ): Promise<schema.PromptResponse> {
    this.updates.clearErrors();
    const response = this.cx.request(
      schema.AGENT_METHODS.session_prompt,
      {
        sessionId: this.sessionId,
        prompt: this.promptBlocks(prompt),
      },
      options,
    );
    void response.then(
      (value) => {
        this.updates.enqueue({
          kind: "stop",
          response: value,
          stopReason: value.stopReason,
        });
      },
      (error) => {
        this.updates.reject(error);
      },
    );
    return response;
  }

  /**
   * Reads the next update or stop message for this session.
   */
  nextUpdate(): Promise<ActiveSessionMessage> {
    return this.updates.next();
  }

  /**
   * Reads text chunks until the current prompt turn stops.
   *
   * Only `agent_message_chunk` updates with text content are appended. Other
   * update types are ignored by this helper; use `nextUpdate()` when you need
   * tool calls, plans, or the final `PromptResponse`.
   */
  async readText(): Promise<string> {
    let output = "";
    for (;;) {
      const message = await this.nextUpdate();
      if (message.kind === "stop") {
        return output;
      }

      const { update } = message;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        output += update.content.text;
      }
    }
  }

  /**
   * Stops routing updates to this active-session helper.
   *
   * This does not close the ACP session on the agent. Use `ClientContext`
   * session lifecycle methods when the protocol session itself should be closed
   * or deleted.
   */
  dispose(): void {
    for (const registration of this.registrations.splice(0)) {
      registration.dispose();
    }
    this.updates.fail(new Error("Active session disposed"));
  }

  /**
   * Supports explicit resource management with `using`.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private promptBlocks(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
  ): Array<schema.ContentBlock> {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt }];
    }

    if (Array.isArray(prompt)) {
      return prompt;
    }

    return [prompt];
  }
}

/**
 * Options used when creating an ACP app.
 */
export type AppOptions = {
  /**
   * Human-readable name used in JSON-RPC handler descriptions and diagnostics.
   */
  name?: string;
};

/**
 * Parser used by custom methods to validate or transform raw JSON-RPC params.
 *
 * A Zod schema can be passed directly because schemas expose a compatible
 * `parse(...)` method.
 */
export type ParamsParser<Params> =
  | {
      /**
       * Parses raw JSON-RPC params into the handler's typed params.
       */
      parse: (params: unknown) => Params;
    }
  | ((params: unknown) => Params);

/**
 * Common context passed to agent-side handlers.
 */
export type AgentHandlerContext<Params> = {
  /**
   * Parsed request or notification params.
   */
  params: Params;
  /**
   * AbortSignal for the current request, or the connection signal for
   * notifications.
   */
  signal: AbortSignal;
  /**
   * Typed client context for calling client-side ACP methods.
   */
  client: AgentContext;
};

/**
 * Context passed to agent-side request handlers.
 */
export type AgentRequestContext<Params> = AgentHandlerContext<Params> & {
  /**
   * JSON-RPC id of the request currently being handled.
   */
  requestId: JsonRpcId;
};

/**
 * Context passed to agent-side notification handlers.
 *
 * Notifications do not have JSON-RPC request ids.
 */
export type AgentNotificationContext<Params> = AgentHandlerContext<Params>;

/**
 * Common context passed to client-side handlers.
 */
export type ClientHandlerContext<Params> = {
  /**
   * Parsed request or notification params.
   */
  params: Params;
  /**
   * AbortSignal for the current request, or the connection signal for
   * notifications.
   */
  signal: AbortSignal;
  /**
   * Typed agent context for calling agent-side ACP methods.
   */
  agent: ClientContext;
};

/**
 * Context passed to client-side request handlers.
 */
export type ClientRequestContext<Params> = ClientHandlerContext<Params> & {
  /**
   * JSON-RPC id of the request currently being handled.
   */
  requestId: JsonRpcId;
};

/**
 * Context passed to client-side notification handlers.
 *
 * Notifications do not have JSON-RPC request ids.
 */
export type ClientNotificationContext<Params> = ClientHandlerContext<Params>;

/**
 * Request handler registered on an `AgentApp`.
 */
export type AgentRequestHandler<Params, Response> = (
  context: AgentRequestContext<Params>,
) => MaybePromise<Response>;

/**
 * Notification handler registered on an `AgentApp`.
 */
export type AgentNotificationHandler<Params> = (
  context: AgentNotificationContext<Params>,
) => MaybePromise<void>;

/**
 * Request handler registered on a `ClientApp`.
 */
export type ClientRequestHandler<Params, Response> = (
  context: ClientRequestContext<Params>,
) => MaybePromise<Response>;

/**
 * Notification handler registered on a `ClientApp`.
 */
export type ClientNotificationHandler<Params> = (
  context: ClientNotificationContext<Params>,
) => MaybePromise<void>;

/**
 * Handler called when an `AgentApp` opens a connection.
 */
export type AgentConnectHandler = (
  connection: AgentConnection,
) => MaybePromise<void>;

/**
 * Handler called when a `ClientApp` opens a connection.
 */
export type ClientConnectHandler = (
  connection: ClientConnection,
) => MaybePromise<void>;

function parseParams<Params>(
  parser: ParamsParser<Params> | undefined,
  params: unknown,
): Params {
  if (!parser) {
    return params as Params;
  }

  if (typeof parser === "function") {
    return parser(params);
  }

  return parser.parse(params);
}

type AcpRequestSpec<Params, Response, WireResponse = Response> = {
  method: string;
  params?: ParamsParser<Params>;
  mapResponse?: (response: Response) => WireResponse;
};

type AcpNotificationSpec<Params> = {
  method: string;
  params?: ParamsParser<Params>;
};

function requestSpec<Params, Response, WireResponse = Response>(
  method: string,
  params: ParamsParser<Params>,
  mapResponse?: (response: Response) => WireResponse,
): AcpRequestSpec<Params, Response, WireResponse> {
  return { method, params, mapResponse };
}

function notificationSpec<Params>(
  method: string,
  params: ParamsParser<Params>,
): AcpNotificationSpec<Params> {
  return { method, params };
}

function registerAppRequest<Params, Response, WireResponse, Context>(
  builder: ConnectionBuilder,
  spec: AcpRequestSpec<Params, Response, WireResponse>,
  context: (
    params: Params,
    cx: ConnectionContext,
    signal: AbortSignal,
    requestId: JsonRpcId,
  ) => Context,
  handler: (context: Context) => MaybePromise<Response>,
): void {
  builder.onReceiveRequest<Params, WireResponse>(
    spec.method,
    (params) => parseParams(spec.params, params),
    async (params, responder, cx) => {
      const response = await handler(
        context(params, cx, responder.signal, responder.id),
      );
      await responder.respond(
        (spec.mapResponse
          ? spec.mapResponse(response)
          : response) as WireResponse,
      );
    },
  );
}

function registerAppNotification<Params, Context>(
  builder: ConnectionBuilder,
  spec: AcpNotificationSpec<Params>,
  context: (
    params: Params,
    cx: ConnectionContext,
    signal: AbortSignal,
  ) => Context,
  handler: (context: Context) => MaybePromise<void>,
): void {
  builder.onReceiveNotification(
    spec.method,
    (params) => parseParams(spec.params, params),
    (params, cx) => handler(context(params, cx, cx.signal)),
  );
}

function specsByMethod<T extends Record<string, { method: string }>>(
  specs: T,
): Record<string, T[keyof T]> {
  const byMethod: Record<string, T[keyof T]> = {};
  for (const spec of Object.values(specs) as Array<T[keyof T]>) {
    byMethod[spec.method] = spec;
  }
  return byMethod;
}

const agentRequestSpecs = {
  initialize: requestSpec<schema.InitializeRequest, schema.InitializeResponse>(
    schema.AGENT_METHODS.initialize,
    validate.zInitializeRequest,
  ),
  newSession: requestSpec<schema.NewSessionRequest, schema.NewSessionResponse>(
    schema.AGENT_METHODS.session_new,
    validate.zNewSessionRequest,
  ),
  loadSession: requestSpec<
    schema.LoadSessionRequest,
    schema.LoadSessionResponse | void,
    schema.LoadSessionResponse
  >(
    schema.AGENT_METHODS.session_load,
    validate.zLoadSessionRequest,
    emptyObjectResponse,
  ),
  unstable_forkSession: requestSpec<
    schema.ForkSessionRequest,
    schema.ForkSessionResponse
  >(schema.AGENT_METHODS.session_fork, validate.zForkSessionRequest),
  listSessions: requestSpec<
    schema.ListSessionsRequest,
    schema.ListSessionsResponse
  >(schema.AGENT_METHODS.session_list, validate.zListSessionsRequest),
  deleteSession: requestSpec<
    schema.DeleteSessionRequest,
    schema.DeleteSessionResponse | void,
    schema.DeleteSessionResponse
  >(
    schema.AGENT_METHODS.session_delete,
    validate.zDeleteSessionRequest,
    emptyObjectResponse,
  ),
  resumeSession: requestSpec<
    schema.ResumeSessionRequest,
    schema.ResumeSessionResponse
  >(schema.AGENT_METHODS.session_resume, validate.zResumeSessionRequest),
  closeSession: requestSpec<
    schema.CloseSessionRequest,
    schema.CloseSessionResponse | void,
    schema.CloseSessionResponse
  >(
    schema.AGENT_METHODS.session_close,
    validate.zCloseSessionRequest,
    emptyObjectResponse,
  ),
  setSessionMode: requestSpec<
    schema.SetSessionModeRequest,
    schema.SetSessionModeResponse | void,
    schema.SetSessionModeResponse
  >(
    schema.AGENT_METHODS.session_set_mode,
    validate.zSetSessionModeRequest,
    emptyObjectResponse,
  ),
  setSessionConfigOption: requestSpec<
    schema.SetSessionConfigOptionRequest,
    schema.SetSessionConfigOptionResponse
  >(
    schema.AGENT_METHODS.session_set_config_option,
    validate.zSetSessionConfigOptionRequest,
  ),
  authenticate: requestSpec<
    schema.AuthenticateRequest,
    schema.AuthenticateResponse | void,
    schema.AuthenticateResponse
  >(
    schema.AGENT_METHODS.authenticate,
    validate.zAuthenticateRequest,
    emptyObjectResponse,
  ),
  unstable_listProviders: requestSpec<
    schema.ListProvidersRequest,
    schema.ListProvidersResponse
  >(schema.AGENT_METHODS.providers_list, validate.zListProvidersRequest),
  unstable_setProvider: requestSpec<
    schema.SetProviderRequest,
    schema.SetProviderResponse | void,
    schema.SetProviderResponse
  >(
    schema.AGENT_METHODS.providers_set,
    validate.zSetProviderRequest,
    emptyObjectResponse,
  ),
  unstable_disableProvider: requestSpec<
    schema.DisableProviderRequest,
    schema.DisableProviderResponse | void,
    schema.DisableProviderResponse
  >(
    schema.AGENT_METHODS.providers_disable,
    validate.zDisableProviderRequest,
    emptyObjectResponse,
  ),
  logout: requestSpec<
    schema.LogoutRequest,
    schema.LogoutResponse | void,
    schema.LogoutResponse
  >(schema.AGENT_METHODS.logout, validate.zLogoutRequest, emptyObjectResponse),
  prompt: requestSpec<schema.PromptRequest, schema.PromptResponse>(
    schema.AGENT_METHODS.session_prompt,
    validate.zPromptRequest,
  ),
  unstable_startNes: requestSpec<
    schema.StartNesRequest,
    schema.StartNesResponse
  >(schema.AGENT_METHODS.nes_start, validate.zStartNesRequest),
  unstable_suggestNes: requestSpec<
    schema.SuggestNesRequest,
    schema.SuggestNesResponse
  >(schema.AGENT_METHODS.nes_suggest, validate.zSuggestNesRequest),
  unstable_closeNes: requestSpec<
    schema.CloseNesRequest,
    schema.CloseNesResponse | void,
    schema.CloseNesResponse
  >(
    schema.AGENT_METHODS.nes_close,
    validate.zCloseNesRequest,
    emptyObjectResponse,
  ),
};

const agentNotificationSpecs = {
  cancel: notificationSpec<schema.CancelNotification>(
    schema.AGENT_METHODS.session_cancel,
    validate.zCancelNotification,
  ),
  unstable_didOpenDocument:
    notificationSpec<schema.DidOpenDocumentNotification>(
      schema.AGENT_METHODS.document_did_open,
      validate.zDidOpenDocumentNotification,
    ),
  unstable_didChangeDocument:
    notificationSpec<schema.DidChangeDocumentNotification>(
      schema.AGENT_METHODS.document_did_change,
      validate.zDidChangeDocumentNotification,
    ),
  unstable_didCloseDocument:
    notificationSpec<schema.DidCloseDocumentNotification>(
      schema.AGENT_METHODS.document_did_close,
      validate.zDidCloseDocumentNotification,
    ),
  unstable_didSaveDocument:
    notificationSpec<schema.DidSaveDocumentNotification>(
      schema.AGENT_METHODS.document_did_save,
      validate.zDidSaveDocumentNotification,
    ),
  unstable_didFocusDocument:
    notificationSpec<schema.DidFocusDocumentNotification>(
      schema.AGENT_METHODS.document_did_focus,
      validate.zDidFocusDocumentNotification,
    ),
  unstable_acceptNes: notificationSpec<schema.AcceptNesNotification>(
    schema.AGENT_METHODS.nes_accept,
    validate.zAcceptNesNotification,
  ),
  unstable_rejectNes: notificationSpec<schema.RejectNesNotification>(
    schema.AGENT_METHODS.nes_reject,
    validate.zRejectNesNotification,
  ),
};

const clientRequestSpecs = {
  requestPermission: requestSpec<
    schema.RequestPermissionRequest,
    schema.RequestPermissionResponse
  >(
    schema.CLIENT_METHODS.session_request_permission,
    validate.zRequestPermissionRequest,
  ),
  writeTextFile: requestSpec<
    schema.WriteTextFileRequest,
    schema.WriteTextFileResponse | void,
    schema.WriteTextFileResponse
  >(
    schema.CLIENT_METHODS.fs_write_text_file,
    validate.zWriteTextFileRequest,
    emptyObjectResponse,
  ),
  readTextFile: requestSpec<
    schema.ReadTextFileRequest,
    schema.ReadTextFileResponse
  >(schema.CLIENT_METHODS.fs_read_text_file, validate.zReadTextFileRequest),
  createTerminal: requestSpec<
    schema.CreateTerminalRequest,
    schema.CreateTerminalResponse
  >(schema.CLIENT_METHODS.terminal_create, validate.zCreateTerminalRequest),
  terminalOutput: requestSpec<
    schema.TerminalOutputRequest,
    schema.TerminalOutputResponse
  >(schema.CLIENT_METHODS.terminal_output, validate.zTerminalOutputRequest),
  releaseTerminal: requestSpec<
    schema.ReleaseTerminalRequest,
    schema.ReleaseTerminalResponse | void,
    schema.ReleaseTerminalResponse
  >(
    schema.CLIENT_METHODS.terminal_release,
    validate.zReleaseTerminalRequest,
    emptyObjectResponse,
  ),
  waitForTerminalExit: requestSpec<
    schema.WaitForTerminalExitRequest,
    schema.WaitForTerminalExitResponse
  >(
    schema.CLIENT_METHODS.terminal_wait_for_exit,
    validate.zWaitForTerminalExitRequest,
  ),
  killTerminal: requestSpec<
    schema.KillTerminalRequest,
    schema.KillTerminalResponse | void,
    schema.KillTerminalResponse
  >(
    schema.CLIENT_METHODS.terminal_kill,
    validate.zKillTerminalRequest,
    emptyObjectResponse,
  ),
  unstable_createElicitation: requestSpec<
    schema.CreateElicitationRequest,
    schema.CreateElicitationResponse
  >(
    schema.CLIENT_METHODS.elicitation_create,
    validate.zCreateElicitationRequest,
  ),
};

const clientNotificationSpecs = {
  sessionUpdate: notificationSpec<schema.SessionNotification>(
    schema.CLIENT_METHODS.session_update,
    validate.zSessionNotification,
  ),
  unstable_completeElicitation:
    notificationSpec<schema.CompleteElicitationNotification>(
      schema.CLIENT_METHODS.elicitation_complete,
      validate.zCompleteElicitationNotification,
    ),
};

const agentRequestSpecsByMethod = specsByMethod(agentRequestSpecs);
const agentNotificationSpecsByMethod = specsByMethod(agentNotificationSpecs);
const clientRequestSpecsByMethod = specsByMethod(clientRequestSpecs);
const clientNotificationSpecsByMethod = specsByMethod(clientNotificationSpecs);

/**
 * Agent request handlers keyed by ACP protocol method name.
 */
export type AgentRequestHandlersByMethod = {
  [schema.AGENT_METHODS.initialize]: AgentRequestHandler<
    schema.InitializeRequest,
    schema.InitializeResponse
  >;
  [schema.AGENT_METHODS.session_new]: AgentRequestHandler<
    schema.NewSessionRequest,
    schema.NewSessionResponse
  >;
  [schema.AGENT_METHODS.session_load]: AgentRequestHandler<
    schema.LoadSessionRequest,
    schema.LoadSessionResponse | void
  >;
  [schema.AGENT_METHODS.session_fork]: AgentRequestHandler<
    schema.ForkSessionRequest,
    schema.ForkSessionResponse
  >;
  [schema.AGENT_METHODS.session_list]: AgentRequestHandler<
    schema.ListSessionsRequest,
    schema.ListSessionsResponse
  >;
  [schema.AGENT_METHODS.session_delete]: AgentRequestHandler<
    schema.DeleteSessionRequest,
    schema.DeleteSessionResponse | void
  >;
  [schema.AGENT_METHODS.session_resume]: AgentRequestHandler<
    schema.ResumeSessionRequest,
    schema.ResumeSessionResponse
  >;
  [schema.AGENT_METHODS.session_close]: AgentRequestHandler<
    schema.CloseSessionRequest,
    schema.CloseSessionResponse | void
  >;
  [schema.AGENT_METHODS.session_set_mode]: AgentRequestHandler<
    schema.SetSessionModeRequest,
    schema.SetSessionModeResponse | void
  >;
  [schema.AGENT_METHODS.session_set_config_option]: AgentRequestHandler<
    schema.SetSessionConfigOptionRequest,
    schema.SetSessionConfigOptionResponse
  >;
  [schema.AGENT_METHODS.authenticate]: AgentRequestHandler<
    schema.AuthenticateRequest,
    schema.AuthenticateResponse | void
  >;
  [schema.AGENT_METHODS.providers_list]: AgentRequestHandler<
    schema.ListProvidersRequest,
    schema.ListProvidersResponse
  >;
  [schema.AGENT_METHODS.providers_set]: AgentRequestHandler<
    schema.SetProviderRequest,
    schema.SetProviderResponse | void
  >;
  [schema.AGENT_METHODS.providers_disable]: AgentRequestHandler<
    schema.DisableProviderRequest,
    schema.DisableProviderResponse | void
  >;
  [schema.AGENT_METHODS.logout]: AgentRequestHandler<
    schema.LogoutRequest,
    schema.LogoutResponse | void
  >;
  [schema.AGENT_METHODS.session_prompt]: AgentRequestHandler<
    schema.PromptRequest,
    schema.PromptResponse
  >;
  [schema.AGENT_METHODS.nes_start]: AgentRequestHandler<
    schema.StartNesRequest,
    schema.StartNesResponse
  >;
  [schema.AGENT_METHODS.nes_suggest]: AgentRequestHandler<
    schema.SuggestNesRequest,
    schema.SuggestNesResponse
  >;
  [schema.AGENT_METHODS.nes_close]: AgentRequestHandler<
    schema.CloseNesRequest,
    schema.CloseNesResponse | void
  >;
};

/**
 * ACP request methods that can be handled by an `AgentApp`.
 */
export type AgentRequestMethod = keyof AgentRequestHandlersByMethod & string;

/**
 * Agent notification handlers keyed by ACP protocol method name.
 */
export type AgentNotificationHandlersByMethod = {
  [schema.AGENT_METHODS
    .session_cancel]: AgentNotificationHandler<schema.CancelNotification>;
  [schema.AGENT_METHODS
    .document_did_open]: AgentNotificationHandler<schema.DidOpenDocumentNotification>;
  [schema.AGENT_METHODS
    .document_did_change]: AgentNotificationHandler<schema.DidChangeDocumentNotification>;
  [schema.AGENT_METHODS
    .document_did_close]: AgentNotificationHandler<schema.DidCloseDocumentNotification>;
  [schema.AGENT_METHODS
    .document_did_save]: AgentNotificationHandler<schema.DidSaveDocumentNotification>;
  [schema.AGENT_METHODS
    .document_did_focus]: AgentNotificationHandler<schema.DidFocusDocumentNotification>;
  [schema.AGENT_METHODS
    .nes_accept]: AgentNotificationHandler<schema.AcceptNesNotification>;
  [schema.AGENT_METHODS
    .nes_reject]: AgentNotificationHandler<schema.RejectNesNotification>;
};

/**
 * ACP notification methods that can be handled by an `AgentApp`.
 */
export type AgentNotificationMethod = keyof AgentNotificationHandlersByMethod &
  string;

/**
 * Client request handlers keyed by ACP protocol method name.
 */
export type ClientRequestHandlersByMethod = {
  [schema.CLIENT_METHODS.session_request_permission]: ClientRequestHandler<
    schema.RequestPermissionRequest,
    schema.RequestPermissionResponse
  >;
  [schema.CLIENT_METHODS.fs_write_text_file]: ClientRequestHandler<
    schema.WriteTextFileRequest,
    schema.WriteTextFileResponse | void
  >;
  [schema.CLIENT_METHODS.fs_read_text_file]: ClientRequestHandler<
    schema.ReadTextFileRequest,
    schema.ReadTextFileResponse
  >;
  [schema.CLIENT_METHODS.terminal_create]: ClientRequestHandler<
    schema.CreateTerminalRequest,
    schema.CreateTerminalResponse
  >;
  [schema.CLIENT_METHODS.terminal_output]: ClientRequestHandler<
    schema.TerminalOutputRequest,
    schema.TerminalOutputResponse
  >;
  [schema.CLIENT_METHODS.terminal_release]: ClientRequestHandler<
    schema.ReleaseTerminalRequest,
    schema.ReleaseTerminalResponse | void
  >;
  [schema.CLIENT_METHODS.terminal_wait_for_exit]: ClientRequestHandler<
    schema.WaitForTerminalExitRequest,
    schema.WaitForTerminalExitResponse
  >;
  [schema.CLIENT_METHODS.terminal_kill]: ClientRequestHandler<
    schema.KillTerminalRequest,
    schema.KillTerminalResponse | void
  >;
  [schema.CLIENT_METHODS.elicitation_create]: ClientRequestHandler<
    schema.CreateElicitationRequest,
    schema.CreateElicitationResponse
  >;
};

/**
 * ACP request methods that can be handled by a `ClientApp`.
 */
export type ClientRequestMethod = keyof ClientRequestHandlersByMethod & string;

/**
 * Client notification handlers keyed by ACP protocol method name.
 */
export type ClientNotificationHandlersByMethod = {
  [schema.CLIENT_METHODS
    .session_update]: ClientNotificationHandler<schema.SessionNotification>;
  [schema.CLIENT_METHODS
    .elicitation_complete]: ClientNotificationHandler<schema.CompleteElicitationNotification>;
};

/**
 * ACP notification methods that can be handled by a `ClientApp`.
 */
export type ClientNotificationMethod =
  keyof ClientNotificationHandlersByMethod & string;

/**
 * Agent request params keyed by ACP protocol method name.
 */
export type AgentRequestParamsByMethod = {
  [Method in AgentRequestMethod]: AgentRequestHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<unknown>
    ? Context extends { params: infer Params }
      ? Params
      : never
    : never;
};

/**
 * Agent request responses keyed by ACP protocol method name.
 */
export type AgentRequestResponsesByMethod = {
  [Method in AgentRequestMethod]: AgentRequestHandlersByMethod[Method] extends (
    context: infer _Context,
  ) => MaybePromise<infer Response>
    ? Exclude<Response, void>
    : never;
};

/**
 * Agent notification params keyed by ACP protocol method name.
 */
export type AgentNotificationParamsByMethod = {
  [Method in AgentNotificationMethod]: AgentNotificationHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<void>
    ? Context extends { params: infer Params }
      ? Params
      : never
    : never;
};

/**
 * Client request params keyed by ACP protocol method name.
 */
export type ClientRequestParamsByMethod = {
  [Method in ClientRequestMethod]: ClientRequestHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<unknown>
    ? Context extends { params: infer Params }
      ? Params
      : never
    : never;
};

/**
 * Client request responses keyed by ACP protocol method name.
 */
export type ClientRequestResponsesByMethod = {
  [Method in ClientRequestMethod]: ClientRequestHandlersByMethod[Method] extends (
    context: infer _Context,
  ) => MaybePromise<infer Response>
    ? Exclude<Response, void>
    : never;
};

/**
 * Client notification params keyed by ACP protocol method name.
 */
export type ClientNotificationParamsByMethod = {
  [Method in ClientNotificationMethod]: ClientNotificationHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<void>
    ? Context extends { params: infer Params }
      ? Params
      : never
    : never;
};

function agentRequestContext<Params>(
  params: Params,
  client: AgentContext,
  signal: AbortSignal,
  requestId: JsonRpcId,
): AgentRequestContext<Params> {
  return {
    params,
    requestId,
    signal,
    client,
  };
}

function agentNotificationContext<Params>(
  params: Params,
  client: AgentContext,
  signal: AbortSignal,
): AgentNotificationContext<Params> {
  return {
    params,
    signal,
    client,
  };
}

function clientRequestContext<Params>(
  params: Params,
  agent: ClientContext,
  signal: AbortSignal,
  requestId: JsonRpcId,
): ClientRequestContext<Params> {
  return {
    params,
    requestId,
    signal,
    agent,
  };
}

function clientNotificationContext<Params>(
  params: Params,
  agent: ClientContext,
  signal: AbortSignal,
): ClientNotificationContext<Params> {
  return {
    params,
    signal,
    agent,
  };
}

type ActiveSessionUpdateQueue = {
  enqueue(value: ActiveSessionMessage): void;
};

class SessionUpdateRouter {
  private readonly activeSessions = new Map<
    string,
    Set<ActiveSessionUpdateQueue>
  >();

  handleMessage(message: IncomingMessage): HandleResult {
    if (
      message.kind !== "notification" ||
      message.method !== schema.CLIENT_METHODS.session_update
    ) {
      return Handled.no(message);
    }

    const notification = validate.zSessionNotification.parse(message.params);
    const update = {
      kind: "session_update",
      notification,
      update: notification.update,
    } satisfies ActiveSessionMessage;
    const activeSessions = this.activeSessions.get(notification.sessionId);
    if (activeSessions && activeSessions.size > 0) {
      for (const session of activeSessions) {
        session.enqueue(update);
      }
    }

    return Handled.no(message);
  }

  attach(
    response: schema.NewSessionResponse,
    updates: ActiveSessionUpdateQueue,
  ): HandlerRegistration {
    const sessions =
      this.activeSessions.get(response.sessionId) ??
      new Set<ActiveSessionUpdateQueue>();
    sessions.add(updates);
    this.activeSessions.set(response.sessionId, sessions);

    return new HandlerRegistration(() => {
      sessions.delete(updates);
      if (sessions.size === 0) {
        this.activeSessions.delete(response.sessionId);
      }
    });
  }
}

const sessionUpdateRouters = new WeakMap<
  ConnectionContext,
  SessionUpdateRouter
>();

function sessionUpdateRouter(cx: ConnectionContext): SessionUpdateRouter {
  let router = sessionUpdateRouters.get(cx);
  if (!router) {
    router = new SessionUpdateRouter();
    sessionUpdateRouters.set(cx, router);
  }
  return router;
}

function runConnectHandlers<ConnectionHandle extends AcpConnection>(
  connection: ConnectionHandle,
  handlers: ReadonlyArray<(connection: ConnectionHandle) => MaybePromise<void>>,
): void {
  for (const handler of handlers) {
    let result: MaybePromise<void>;
    try {
      result = handler(connection);
    } catch (error) {
      connection.close(error);
      throw error;
    }

    void Promise.resolve(result).catch((error) => {
      connection.close(error);
    });
  }
}

const appBuilder = Symbol("appBuilder");
const runAgentConnectHandlers = Symbol("runAgentConnectHandlers");
const runClientConnectHandlers = Symbol("runClientConnectHandlers");

type AppConnectOptions = {
  readonly deferConnectHandlers?: boolean;
};

type AgentConnectionState = {
  rawConnection: Connection;
  connection: AgentConnection;
};

type ClientConnectionState = {
  rawConnection: Connection;
  connection: ClientConnection;
};

/**
 * Creates an agent-side app.
 *
 * Register request and notification handlers by ACP method name, then call
 * `connect(stream)` to serve an ACP client.
 */
export function agent(options?: AppOptions): AgentApp {
  return new AgentApp(options);
}

/**
 * Agent-side app builder.
 *
 * Methods on this class register typed request or notification handlers and
 * return `this`, so apps can be built with a fluent chain. Handler params are
 * parsed with the generated ACP schemas before your handler runs, and thrown
 * errors are converted to JSON-RPC errors by the connection layer.
 */
export class AgentApp {
  private readonly builder = Connection.builder();
  private readonly connectHandlers: AgentConnectHandler[] = [];

  constructor(options: AppOptions = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
  }

  /** @internal */
  [appBuilder](): ConnectionBuilder {
    return this.builder;
  }

  /** @internal */
  [runAgentConnectHandlers](connection: AgentConnection): void {
    runConnectHandlers(connection, this.connectHandlers);
  }

  /**
   * Connects this agent app to a transport stream.
   */
  connect(stream: Stream): AgentConnection;
  /** @internal */
  connect(stream: Stream, options: AppConnectOptions): AgentConnection;
  /**
   * Connects this agent app directly to a client app.
   *
   * This is useful for tests and in-process examples that do not need a
   * transport.
   */
  connect(client: ClientApp): AgentConnection;
  connect(
    target: Stream | ClientApp,
    options: AppConnectOptions = {},
  ): AgentConnection {
    return this.connectConnection(target, options).connection;
  }

  /**
   * Connects this agent app to a transport stream for the lifetime of `op`.
   *
   * The callback receives an `AgentContext` for calling client-side methods.
   * When `op` resolves or rejects, the connection is closed.
   */
  connectWith<T>(
    stream: Stream,
    op: (context: AgentContext) => MaybePromise<T>,
  ): Promise<T>;
  /**
   * Connects this agent app directly to a client app for the lifetime of `op`.
   */
  connectWith<T>(
    client: ClientApp,
    op: (context: AgentContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    target: Stream | ClientApp,
    op: (context: AgentContext) => MaybePromise<T>,
  ): Promise<T> {
    const { rawConnection, connection } = this.connectConnection(target);
    return rawConnection.runUntil(() => op(connection.client));
  }

  /**
   * Registers a handler that runs when this agent app opens a connection.
   *
   * Use this for connection-scoped work that needs to call client-side ACP
   * methods outside an inbound request handler.
   */
  onConnect(handler: AgentConnectHandler): this {
    this.connectHandlers.push(handler);
    return this;
  }

  /**
   * Registers a request handler by ACP method name.
   *
   * Built-in method literals infer their params and response types from
   * `method`. Pass a parser as the second argument to register custom extension
   * methods.
   */
  onRequest<Method extends AgentRequestMethod>(
    method: Method,
    handler: AgentRequestHandlersByMethod[Method],
  ): this;
  onRequest<Params, Response>(
    method: string,
    params: ParamsParser<Params>,
    handler: AgentRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response>(
    method: string,
    handlerOrParams:
      | AgentRequestHandlersByMethod[AgentRequestMethod]
      | ParamsParser<Params>,
    handler?: AgentRequestHandler<Params, Response>,
  ): this {
    if (handler) {
      return this.request(
        { method, params: handlerOrParams as ParamsParser<Params> },
        handler,
      );
    }

    const spec = agentRequestSpecsByMethod[method];
    if (!spec) {
      throw new Error(
        `Unknown ACP request method '${method}'. Pass a params parser for custom methods.`,
      );
    }

    return this.request(
      spec as AcpRequestSpec<unknown, unknown, unknown>,
      handlerOrParams as AgentRequestHandler<unknown, unknown>,
    );
  }

  /**
   * Registers a notification handler by ACP method name.
   *
   * Built-in method literals infer their params type from `method`. Pass a
   * parser as the second argument to register custom extension notifications.
   */
  onNotification<Method extends AgentNotificationMethod>(
    method: Method,
    handler: AgentNotificationHandlersByMethod[Method],
  ): this;
  onNotification<Params>(
    method: string,
    params: ParamsParser<Params>,
    handler: AgentNotificationHandler<Params>,
  ): this;
  onNotification<Params>(
    method: string,
    handlerOrParams:
      | AgentNotificationHandlersByMethod[AgentNotificationMethod]
      | ParamsParser<Params>,
    handler?: AgentNotificationHandler<Params>,
  ): this {
    if (handler) {
      return this.notification(
        { method, params: handlerOrParams as ParamsParser<Params> },
        handler,
      );
    }

    const spec = agentNotificationSpecsByMethod[method];
    if (!spec) {
      throw new Error(
        `Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`,
      );
    }

    return this.notification(
      spec as AcpNotificationSpec<unknown>,
      handlerOrParams as AgentNotificationHandler<unknown>,
    );
  }

  private request<Params, Response, WireResponse = Response>(
    spec: AcpRequestSpec<Params, Response, WireResponse>,
    handler: AgentRequestHandler<Params, Response>,
  ): this {
    registerAppRequest(
      this.builder,
      spec,
      (params, cx, signal, requestId) =>
        agentRequestContext(
          params,
          AgentContext.create(cx, requestId),
          signal,
          requestId,
        ),
      handler,
    );
    return this;
  }

  private notification<Params>(
    spec: AcpNotificationSpec<Params>,
    handler: AgentNotificationHandler<Params>,
  ): this {
    registerAppNotification(
      this.builder,
      spec,
      (params, cx, signal) =>
        agentNotificationContext(params, AgentContext.create(cx), signal),
      handler,
    );
    return this;
  }

  private connectConnection(
    target: Stream | ClientApp,
    options: AppConnectOptions = {},
  ): AgentConnectionState {
    if (isStream(target)) {
      const state = this.openStreamConnection(target);
      if (!options.deferConnectHandlers) {
        this[runAgentConnectHandlers](state.connection);
      }
      return state;
    }

    const [thisStream, peerStream] = memoryStreamPair();
    const peerRawConnection = target[appBuilder]().connect(peerStream);
    const peerConnection = clientConnection(peerRawConnection);
    const state = this.openStreamConnection(thisStream);
    void state.rawConnection.closed.then(() => peerConnection.close());
    void peerRawConnection.closed.then(() => state.connection.close());
    try {
      target[runClientConnectHandlers](peerConnection);
      this[runAgentConnectHandlers](state.connection);
    } catch (error) {
      peerConnection.close(error);
      state.connection.close(error);
      throw error;
    }
    return state;
  }

  private openStreamConnection(stream: Stream): AgentConnectionState {
    const rawConnection = this.builder.connect(stream);
    return {
      rawConnection,
      connection: agentConnection(rawConnection, this.connectHandlers),
    };
  }
}

/**
 * Creates a client-side app.
 *
 * Register request and notification handlers by ACP method name, then use
 * `connectWith(...)` to run the workflow that calls agent-side methods.
 */
export function client(options?: AppOptions): ClientApp {
  return new ClientApp(options);
}

/**
 * Client-side app builder.
 *
 * Methods on this class register typed client handlers and return `this`, so
 * apps can be built with a fluent chain. `connectWith(...)` is the usual entry
 * point for clients because it provides a `ClientContext` for calling
 * agent-side requests and session helpers.
 */
export class ClientApp {
  private readonly builder = Connection.builder();
  private readonly connectHandlers: ClientConnectHandler[] = [];

  constructor(options: AppOptions = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
    this.builder.withHandler({
      handleMessage: (message, cx) =>
        sessionUpdateRouter(cx).handleMessage(message),
      describe: () => "client-session-update-router",
    });
  }

  /** @internal */
  [appBuilder](): ConnectionBuilder {
    return this.builder;
  }

  /** @internal */
  [runClientConnectHandlers](connection: ClientConnection): void {
    runConnectHandlers(connection, this.connectHandlers);
  }

  /**
   * Connects this client app to a transport stream.
   */
  connect(stream: Stream): ClientConnection;
  /**
   * Connects this client app directly to an agent app.
   *
   * This is useful for tests and in-process examples that do not need a
   * transport.
   */
  connect(agent: AgentApp): ClientConnection;
  connect(target: Stream | AgentApp): ClientConnection {
    return this.connectConnection(target).connection;
  }

  /**
   * Connects this client app to a transport stream for the lifetime of `op`.
   *
   * The callback receives a `ClientContext` for calling agent-side methods.
   * When `op` resolves or rejects, the connection is closed.
   */
  connectWith<T>(
    stream: Stream,
    op: (context: ClientContext) => MaybePromise<T>,
  ): Promise<T>;
  /**
   * Connects this client app directly to an agent app for the lifetime of `op`.
   */
  connectWith<T>(
    agent: AgentApp,
    op: (context: ClientContext) => MaybePromise<T>,
  ): Promise<T>;
  connectWith<T>(
    target: Stream | AgentApp,
    op: (context: ClientContext) => MaybePromise<T>,
  ): Promise<T> {
    const { rawConnection, connection } = this.connectConnection(target);
    return rawConnection.runUntil(() => op(connection.agent));
  }

  /**
   * Registers a handler that runs when this client app opens a connection.
   *
   * Use this for connection-scoped work that needs to call agent-side ACP
   * methods outside an inbound request handler.
   */
  onConnect(handler: ClientConnectHandler): this {
    this.connectHandlers.push(handler);
    return this;
  }

  /**
   * Registers a client request handler by ACP method name.
   *
   * Built-in method literals infer their params and response types from
   * `method`. Pass a parser as the second argument to register custom extension
   * methods.
   */
  onRequest<Method extends ClientRequestMethod>(
    method: Method,
    handler: ClientRequestHandlersByMethod[Method],
  ): this;
  onRequest<Params, Response>(
    method: string,
    params: ParamsParser<Params>,
    handler: ClientRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response>(
    method: string,
    handlerOrParams:
      | ClientRequestHandlersByMethod[ClientRequestMethod]
      | ParamsParser<Params>,
    handler?: ClientRequestHandler<Params, Response>,
  ): this {
    if (handler) {
      return this.request(
        { method, params: handlerOrParams as ParamsParser<Params> },
        handler,
      );
    }

    const spec = clientRequestSpecsByMethod[method];
    if (!spec) {
      throw new Error(
        `Unknown ACP request method '${method}'. Pass a params parser for custom methods.`,
      );
    }

    return this.request(
      spec as AcpRequestSpec<unknown, unknown, unknown>,
      handlerOrParams as ClientRequestHandler<unknown, unknown>,
    );
  }

  /**
   * Registers a client notification handler by ACP method name.
   *
   * Built-in method literals infer their params type from `method`. Pass a
   * parser as the second argument to register custom extension notifications.
   */
  onNotification<Method extends ClientNotificationMethod>(
    method: Method,
    handler: ClientNotificationHandlersByMethod[Method],
  ): this;
  onNotification<Params>(
    method: string,
    params: ParamsParser<Params>,
    handler: ClientNotificationHandler<Params>,
  ): this;
  onNotification<Params>(
    method: string,
    handlerOrParams:
      | ClientNotificationHandlersByMethod[ClientNotificationMethod]
      | ParamsParser<Params>,
    handler?: ClientNotificationHandler<Params>,
  ): this {
    if (handler) {
      return this.notification(
        { method, params: handlerOrParams as ParamsParser<Params> },
        handler,
      );
    }

    const spec = clientNotificationSpecsByMethod[method];
    if (!spec) {
      throw new Error(
        `Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`,
      );
    }

    return this.notification(
      spec as AcpNotificationSpec<unknown>,
      handlerOrParams as ClientNotificationHandler<unknown>,
    );
  }

  private request<Params, Response, WireResponse = Response>(
    spec: AcpRequestSpec<Params, Response, WireResponse>,
    handler: ClientRequestHandler<Params, Response>,
  ): this {
    registerAppRequest(
      this.builder,
      spec,
      (params, cx, signal, requestId) =>
        clientRequestContext(
          params,
          ClientContext.create(cx, requestId),
          signal,
          requestId,
        ),
      handler,
    );
    return this;
  }

  private notification<Params>(
    spec: AcpNotificationSpec<Params>,
    handler: ClientNotificationHandler<Params>,
  ): this {
    registerAppNotification(
      this.builder,
      spec,
      (params, cx, signal) =>
        clientNotificationContext(params, ClientContext.create(cx), signal),
      handler,
    );
    return this;
  }

  private connectConnection(target: Stream | AgentApp): ClientConnectionState {
    if (isStream(target)) {
      const state = this.openStreamConnection(target);
      this[runClientConnectHandlers](state.connection);
      return state;
    }

    const [thisStream, peerStream] = memoryStreamPair();
    const peerRawConnection = target[appBuilder]().connect(peerStream);
    const peerConnection = agentConnection(peerRawConnection);
    const state = this.openStreamConnection(thisStream);
    void state.rawConnection.closed.then(() => peerConnection.close());
    void peerRawConnection.closed.then(() => state.connection.close());
    try {
      target[runAgentConnectHandlers](peerConnection);
      this[runClientConnectHandlers](state.connection);
    } catch (error) {
      peerConnection.close(error);
      state.connection.close(error);
      throw error;
    }
    return state;
  }

  private openStreamConnection(stream: Stream): ClientConnectionState {
    const rawConnection = this.builder.connect(stream);
    return {
      rawConnection,
      connection: clientConnection(rawConnection, this.connectHandlers),
    };
  }
}

const legacyAgentRequestMethods = new Set<string>([
  schema.AGENT_METHODS.initialize,
  schema.AGENT_METHODS.authenticate,
  schema.AGENT_METHODS.providers_list,
  schema.AGENT_METHODS.providers_set,
  schema.AGENT_METHODS.providers_disable,
  schema.AGENT_METHODS.session_new,
  schema.AGENT_METHODS.session_load,
  schema.AGENT_METHODS.session_set_mode,
  schema.AGENT_METHODS.session_set_config_option,
  schema.AGENT_METHODS.session_prompt,
  schema.AGENT_METHODS.session_list,
  schema.AGENT_METHODS.session_delete,
  schema.AGENT_METHODS.session_fork,
  schema.AGENT_METHODS.session_resume,
  schema.AGENT_METHODS.session_close,
  schema.AGENT_METHODS.logout,
  schema.AGENT_METHODS.nes_start,
  schema.AGENT_METHODS.nes_suggest,
  schema.AGENT_METHODS.nes_close,
]);

const legacyAgentNotificationMethods = new Set<string>([
  schema.AGENT_METHODS.session_cancel,
  schema.AGENT_METHODS.nes_accept,
  schema.AGENT_METHODS.nes_reject,
  schema.AGENT_METHODS.document_did_open,
  schema.AGENT_METHODS.document_did_change,
  schema.AGENT_METHODS.document_did_close,
  schema.AGENT_METHODS.document_did_save,
  schema.AGENT_METHODS.document_did_focus,
]);

const legacyClientRequestMethods = new Set<string>([
  schema.CLIENT_METHODS.session_request_permission,
  schema.CLIENT_METHODS.fs_write_text_file,
  schema.CLIENT_METHODS.fs_read_text_file,
  schema.CLIENT_METHODS.terminal_create,
  schema.CLIENT_METHODS.terminal_output,
  schema.CLIENT_METHODS.terminal_release,
  schema.CLIENT_METHODS.terminal_wait_for_exit,
  schema.CLIENT_METHODS.terminal_kill,
  schema.CLIENT_METHODS.elicitation_create,
]);

const legacyClientNotificationMethods = new Set<string>([
  schema.CLIENT_METHODS.session_update,
  schema.CLIENT_METHODS.elicitation_complete,
]);

function legacyAgentApp(implementation: Agent): AgentApp {
  const app = agent()
    .onRequest(schema.AGENT_METHODS.initialize, (ctx) =>
      implementation.initialize(ctx.params),
    )
    .onRequest(schema.AGENT_METHODS.session_new, (ctx) =>
      implementation.newSession(ctx.params),
    )
    .onRequest(
      schema.AGENT_METHODS.authenticate,
      async (ctx) => (await implementation.authenticate(ctx.params)) ?? {},
    )
    .onRequest(schema.AGENT_METHODS.session_prompt, (ctx) =>
      implementation.prompt(ctx.params),
    )
    .onNotification(schema.AGENT_METHODS.session_cancel, (ctx) =>
      implementation.cancel(ctx.params),
    );

  if (implementation.loadSession) {
    app.onRequest(schema.AGENT_METHODS.session_load, (ctx) =>
      implementation.loadSession!(ctx.params),
    );
  }
  if (implementation.listSessions) {
    app.onRequest(schema.AGENT_METHODS.session_list, (ctx) =>
      implementation.listSessions!(ctx.params),
    );
  }
  if (implementation.deleteSession) {
    app.onRequest(
      schema.AGENT_METHODS.session_delete,
      async (ctx) => (await implementation.deleteSession!(ctx.params)) ?? {},
    );
  }
  if (implementation.unstable_forkSession) {
    app.onRequest(schema.AGENT_METHODS.session_fork, (ctx) =>
      implementation.unstable_forkSession!(ctx.params),
    );
  }
  if (implementation.resumeSession) {
    app.onRequest(schema.AGENT_METHODS.session_resume, (ctx) =>
      implementation.resumeSession!(ctx.params),
    );
  }
  if (implementation.closeSession) {
    app.onRequest(
      schema.AGENT_METHODS.session_close,
      async (ctx) => (await implementation.closeSession!(ctx.params)) ?? {},
    );
  }
  if (implementation.setSessionMode) {
    app.onRequest(
      schema.AGENT_METHODS.session_set_mode,
      async (ctx) => (await implementation.setSessionMode!(ctx.params)) ?? {},
    );
  }
  if (implementation.setSessionConfigOption) {
    app.onRequest(schema.AGENT_METHODS.session_set_config_option, (ctx) =>
      implementation.setSessionConfigOption!(ctx.params),
    );
  }
  if (implementation.unstable_listProviders) {
    app.onRequest(schema.AGENT_METHODS.providers_list, (ctx) =>
      implementation.unstable_listProviders!(ctx.params),
    );
  }
  if (implementation.unstable_setProvider) {
    app.onRequest(
      schema.AGENT_METHODS.providers_set,
      async (ctx) =>
        (await implementation.unstable_setProvider!(ctx.params)) ?? {},
    );
  }
  if (implementation.unstable_disableProvider) {
    app.onRequest(
      schema.AGENT_METHODS.providers_disable,
      async (ctx) =>
        (await implementation.unstable_disableProvider!(ctx.params)) ?? {},
    );
  }
  if (implementation.logout) {
    app.onRequest(
      schema.AGENT_METHODS.logout,
      async (ctx) => (await implementation.logout!(ctx.params)) ?? {},
    );
  }
  if (implementation.unstable_startNes) {
    app.onRequest(schema.AGENT_METHODS.nes_start, (ctx) =>
      implementation.unstable_startNes!(ctx.params),
    );
  }
  if (implementation.unstable_suggestNes) {
    app.onRequest(schema.AGENT_METHODS.nes_suggest, (ctx) =>
      implementation.unstable_suggestNes!(ctx.params),
    );
  }
  if (implementation.unstable_closeNes) {
    app.onRequest(
      schema.AGENT_METHODS.nes_close,
      async (ctx) =>
        (await implementation.unstable_closeNes!(ctx.params)) ?? {},
    );
  }
  if (implementation.unstable_didOpenDocument) {
    app.onNotification(schema.AGENT_METHODS.document_did_open, (ctx) =>
      implementation.unstable_didOpenDocument!(ctx.params),
    );
  }
  if (implementation.unstable_didChangeDocument) {
    app.onNotification(schema.AGENT_METHODS.document_did_change, (ctx) =>
      implementation.unstable_didChangeDocument!(ctx.params),
    );
  }
  if (implementation.unstable_didCloseDocument) {
    app.onNotification(schema.AGENT_METHODS.document_did_close, (ctx) =>
      implementation.unstable_didCloseDocument!(ctx.params),
    );
  }
  if (implementation.unstable_didSaveDocument) {
    app.onNotification(schema.AGENT_METHODS.document_did_save, (ctx) =>
      implementation.unstable_didSaveDocument!(ctx.params),
    );
  }
  if (implementation.unstable_didFocusDocument) {
    app.onNotification(schema.AGENT_METHODS.document_did_focus, (ctx) =>
      implementation.unstable_didFocusDocument!(ctx.params),
    );
  }
  if (implementation.unstable_acceptNes) {
    app.onNotification(schema.AGENT_METHODS.nes_accept, (ctx) =>
      implementation.unstable_acceptNes!(ctx.params),
    );
  }
  if (implementation.unstable_rejectNes) {
    app.onNotification(schema.AGENT_METHODS.nes_reject, (ctx) =>
      implementation.unstable_rejectNes!(ctx.params),
    );
  }

  if (implementation.extMethod) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "request" ||
          legacyAgentRequestMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await message.responder.respond(
          await implementation.extMethod!(
            message.method,
            message.params as Record<string, unknown>,
          ),
        );
        return Handled.yes();
      },
      describe: () => "legacy-agent-extension-request",
    });
  }
  if (implementation.extNotification) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "notification" ||
          legacyAgentNotificationMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await implementation.extNotification!(
          message.method,
          message.params as Record<string, unknown>,
        );
        return Handled.yes();
      },
      describe: () => "legacy-agent-extension-notification",
    });
  }

  return app;
}

function legacyClientApp(implementation: Client): ClientApp {
  const app = client()
    .onRequest(schema.CLIENT_METHODS.session_request_permission, (ctx) =>
      implementation.requestPermission(ctx.params),
    )
    .onNotification(schema.CLIENT_METHODS.session_update, (ctx) =>
      implementation.sessionUpdate(ctx.params),
    )
    .onRequest(
      schema.CLIENT_METHODS.fs_write_text_file,
      async (ctx) => (await implementation.writeTextFile?.(ctx.params)) ?? {},
    )
    .onRequest(
      schema.CLIENT_METHODS.fs_read_text_file,
      async (ctx) =>
        (await implementation.readTextFile?.(
          ctx.params,
        )) as schema.ReadTextFileResponse,
    )
    .onRequest(
      schema.CLIENT_METHODS.terminal_create,
      async (ctx) =>
        (await implementation.createTerminal?.(
          ctx.params,
        )) as schema.CreateTerminalResponse,
    )
    .onRequest(
      schema.CLIENT_METHODS.terminal_output,
      async (ctx) =>
        (await implementation.terminalOutput?.(
          ctx.params,
        )) as schema.TerminalOutputResponse,
    )
    .onRequest(
      schema.CLIENT_METHODS.terminal_release,
      async (ctx) => (await implementation.releaseTerminal?.(ctx.params)) ?? {},
    )
    .onRequest(
      schema.CLIENT_METHODS.terminal_wait_for_exit,
      async (ctx) =>
        (await implementation.waitForTerminalExit?.(
          ctx.params,
        )) as schema.WaitForTerminalExitResponse,
    )
    .onRequest(
      schema.CLIENT_METHODS.terminal_kill,
      async (ctx) => (await implementation.killTerminal?.(ctx.params)) ?? {},
    );

  if (implementation.unstable_createElicitation) {
    app.onRequest(schema.CLIENT_METHODS.elicitation_create, (ctx) =>
      implementation.unstable_createElicitation!(ctx.params),
    );
  }
  if (implementation.unstable_completeElicitation) {
    app.onNotification(schema.CLIENT_METHODS.elicitation_complete, (ctx) =>
      implementation.unstable_completeElicitation!(ctx.params),
    );
  }

  if (implementation.extMethod) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "request" ||
          legacyClientRequestMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await message.responder.respond(
          await implementation.extMethod!(
            message.method,
            message.params as Record<string, unknown>,
          ),
        );
        return Handled.yes();
      },
      describe: () => "legacy-client-extension-request",
    });
  }
  if (implementation.extNotification) {
    app[appBuilder]().withHandler({
      handleMessage: async (message) => {
        if (
          message.kind !== "notification" ||
          legacyClientNotificationMethods.has(message.method)
        ) {
          return Handled.no(message);
        }

        await implementation.extNotification!(
          message.method,
          message.params as Record<string, unknown>,
        );
        return Handled.yes();
      },
      describe: () => "legacy-client-extension-notification",
    });
  }

  return app;
}

/**
 * An agent-side connection to a client.
 *
 * This class provides the agent's view of an ACP connection, allowing
 * agents to communicate with clients. It implements the {@link Client} interface
 * to provide methods for requesting permissions, accessing the file system,
 * and sending session updates.
 *
 * See protocol docs: [Agent](https://agentclientprotocol.com/protocol/overview#agent)
 *
 * @deprecated Prefer {@link agent}, which registers typed handlers with a
 * single context object and supports direct app composition.
 */
export class AgentSideConnection {
  private connection: Connection;

  /**
   * Creates a new agent-side connection to a client.
   *
   * This establishes the communication channel from the agent's perspective
   * following the ACP specification.
   *
   * @param toAgent - A function that creates an Agent handler to process incoming client requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   *
   * @deprecated Prefer `agent({ name }).connect(stream)`.
   */
  constructor(toAgent: (conn: AgentSideConnection) => Agent, stream: Stream) {
    this.connection = legacyAgentApp(toAgent(this))
      [appBuilder]()
      .connect(stream);
  }

  /**
   * Handles session update notifications from the agent.
   *
   * This is a notification endpoint (no response expected) that sends
   * real-time updates about session progress, including message chunks,
   * tool calls, and execution plans.
   *
   * Note: Clients SHOULD continue accepting tool call updates even after
   * sending a `session/cancel` notification, as the agent may send final
   * updates before responding with the cancelled stop reason.
   *
   * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
   */
  sessionUpdate(params: schema.SessionNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.CLIENT_METHODS.session_update,
      params,
    );
  }

  /**
   * Requests permission from the user for a tool call operation.
   *
   * Called by the agent when it needs user authorization before executing
   * a potentially sensitive operation. The client should present the options
   * to the user and return their decision.
   *
   * If the client cancels the prompt turn via `session/cancel`, it MUST
   * respond to this request with `RequestPermissionOutcome::Cancelled`.
   *
   * See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
   */
  requestPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.session_request_permission,
      params,
    );
  }

  /**
   * Reads content from a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.readTextFile` capability.
   * Allows the agent to access file contents within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  readTextFile(
    params: schema.ReadTextFileRequest,
  ): Promise<schema.ReadTextFileResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.fs_read_text_file,
      params,
    );
  }

  /**
   * Writes content to a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.writeTextFile` capability.
   * Allows the agent to create or modify files within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  writeTextFile(
    params: schema.WriteTextFileRequest,
  ): Promise<schema.WriteTextFileResponse> {
    return this.connection.sendRequest<
      schema.WriteTextFileRequest,
      schema.WriteTextFileResponse
    >(schema.CLIENT_METHODS.fs_write_text_file, params, emptyObjectResponse);
  }

  /**
   * Executes a command in a new terminal.
   *
   * Returns a `TerminalHandle` that can be used to get output, wait for exit,
   * kill the command, or release the terminal.
   *
   * The terminal can also be embedded in tool calls by using its ID in
   * `ToolCallContent` with type "terminal".
   *
   * @param params - The terminal creation parameters
   * @returns A handle to control and monitor the terminal
   */
  createTerminal(
    params: schema.CreateTerminalRequest,
  ): Promise<TerminalHandle> {
    return this.connection.sendRequest<
      schema.CreateTerminalRequest,
      schema.CreateTerminalResponse,
      TerminalHandle
    >(schema.CLIENT_METHODS.terminal_create, params, (response) =>
      TerminalHandle.create(
        response.terminalId,
        params.sessionId,
        this.connection,
      ),
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Creates an elicitation to request input from the user.
   *
   * @experimental
   */
  unstable_createElicitation(
    params: schema.CreateElicitationRequest,
  ): Promise<schema.CreateElicitationResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.elicitation_create,
      params,
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the client that a URL-based elicitation is complete.
   *
   * @experimental
   */
  unstable_completeElicitation(
    params: schema.CompleteElicitationNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.CLIENT_METHODS.elicitation_complete,
      params,
    );
  }

  /**
   * Sends a request to the client by ACP method name.
   *
   * Built-in method literals infer their params and response types. Custom
   * methods can specify their response and params types with generics.
   */
  request<Method extends ClientRequestMethod>(
    method: Method,
    params: ClientRequestParamsByMethod[Method],
    options?: SendRequestOptions,
  ): Promise<ClientRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    const spec = clientRequestSpecsByMethod[method] as
      | AcpRequestSpec<unknown, unknown, unknown>
      | undefined;
    return this.connection.sendRequest(
      method,
      params,
      spec?.mapResponse,
      options,
    );
  }

  /**
   * Sends a notification to the client by ACP method name.
   *
   * Built-in method literals infer their params type. Custom notifications can
   * specify their params type with a generic.
   */
  notify<Method extends ClientNotificationMethod>(
    method: Method,
    params: ClientNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  /**
   * Extension method.
   *
   * @deprecated Use {@link request}.
   */
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>, Record<string, unknown>>(
      method,
      params,
    );
  }

  /**
   * Extension notification.
   *
   * @deprecated Use {@link notify}.
   */
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.notify(method, params);
  }

  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/**
 * Handle for controlling and monitoring a terminal created via `createTerminal`.
 *
 * Provides methods to:
 * - Get current output without waiting
 * - Wait for command completion
 * - Kill the running command
 * - Release terminal resources
 *
 * **Important:** Always call `release()` when done with the terminal to free resources.

 * The terminal supports async disposal via `Symbol.asyncDispose` for automatic cleanup.

 * You can use `await using` to ensure the terminal is automatically released when it
 * goes out of scope.
 */
export class TerminalHandle {
  /**
   * Terminal identifier returned by `terminal/create`.
   */
  public id: string;
  private sessionId: string;
  private connection: Pick<Connection, "sendRequest">;

  private constructor(
    id: string,
    sessionId: string,
    conn: Pick<Connection, "sendRequest">,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.connection = conn;
  }

  /** @internal */
  static create(
    id: string,
    sessionId: string,
    conn: Pick<Connection, "sendRequest">,
  ): TerminalHandle {
    return new TerminalHandle(id, sessionId, conn);
  }

  /**
   * Gets the current terminal output without waiting for the command to exit.
   */
  currentOutput(): Promise<schema.TerminalOutputResponse> {
    return this.connection.sendRequest(schema.CLIENT_METHODS.terminal_output, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  /**
   * Waits for the terminal command to complete and returns its exit status.
   */
  waitForExit(): Promise<schema.WaitForTerminalExitResponse> {
    return this.connection.sendRequest(
      schema.CLIENT_METHODS.terminal_wait_for_exit,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
    );
  }

  /**
   * Kills the terminal command without releasing the terminal.
   *
   * The terminal remains valid after killing, allowing you to:
   * - Get the final output with `currentOutput()`
   * - Check the exit status
   * - Release the terminal when done
   *
   * Useful for implementing timeouts or cancellation.
   */
  kill(): Promise<schema.KillTerminalResponse> {
    return this.connection.sendRequest<
      schema.KillTerminalRequest,
      schema.KillTerminalResponse
    >(
      schema.CLIENT_METHODS.terminal_kill,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
      emptyObjectResponse,
    );
  }

  /**
   * Releases the terminal and frees all associated resources.
   *
   * If the command is still running, it will be killed.
   * After release, the terminal ID becomes invalid and cannot be used
   * with other terminal methods.
   *
   * Tool calls that already reference this terminal will continue to
   * display its output.
   *
   * **Important:** Always call this method when done with the terminal.
   */
  release(): Promise<schema.ReleaseTerminalResponse | void> {
    return this.connection.sendRequest<
      schema.ReleaseTerminalRequest,
      schema.ReleaseTerminalResponse | void
    >(
      schema.CLIENT_METHODS.terminal_release,
      {
        sessionId: this.sessionId,
        terminalId: this.id,
      },
      emptyObjectResponse,
    );
  }

  /**
   * Releases the terminal when used with `await using`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

/**
 * A client-side connection to an agent.
 *
 * This class provides the client's view of an ACP connection, allowing
 * clients (such as code editors) to communicate with agents. It implements
 * the {@link Agent} interface to provide methods for initializing sessions, sending
 * prompts, and managing the agent lifecycle.
 *
 * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
 *
 * @deprecated Prefer {@link client}, which registers typed handlers with a
 * single context object and supports `connectWith` and session helpers.
 */
export class ClientSideConnection implements Agent {
  private connection: Connection;

  /**
   * Creates a new client-side connection to an agent.
   *
   * This establishes the communication channel between a client and agent
   * following the ACP specification.
   *
   * @param toClient - A function that creates a Client handler to process incoming agent requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   *
   * @deprecated Prefer `client({ name }).connectWith(stream, async (ctx) => ...)`.
   */
  constructor(toClient: (agent: Agent) => Client, stream: Stream) {
    this.connection = legacyClientApp(toClient(this))
      [appBuilder]()
      .connect(stream);
  }

  /**
   * Establishes the connection with a client and negotiates protocol capabilities.
   *
   * This method is called once at the beginning of the connection to:
   * - Negotiate the protocol version to use
   * - Exchange capability information between client and agent
   * - Determine available authentication methods
   *
   * The agent should respond with its supported protocol version and capabilities.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  initialize(
    params: schema.InitializeRequest,
  ): Promise<schema.InitializeResponse> {
    return this.connection.sendRequest(schema.AGENT_METHODS.initialize, params);
  }

  /**
   * Creates a new conversation session with the agent.
   *
   * Sessions represent independent conversation contexts with their own history and state.
   *
   * The agent should:
   * - Create a new session context
   * - Connect to any specified MCP servers
   * - Return a unique session ID for future requests
   *
   * The request may include `additionalDirectories` to expand the session's filesystem
   * scope beyond `cwd` without changing the base for relative paths.
   *
   * May return an `auth_required` error if the agent requires authentication.
   *
   * See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
   */
  newSession(
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_new,
      params,
    );
  }

  /**
   * Loads an existing session to resume a previous conversation.
   *
   * This method is only available if the agent advertises the `loadSession` capability.
   *
   * The agent should:
   * - Restore the session context and conversation history
   * - Connect to the specified MCP servers
   * - Stream the entire conversation history back to the client via notifications
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the loaded session.
   *
   * See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
   */
  loadSession(
    params: schema.LoadSessionRequest,
  ): Promise<schema.LoadSessionResponse> {
    return this.connection.sendRequest<
      schema.LoadSessionRequest,
      schema.LoadSessionResponse
    >(schema.AGENT_METHODS.session_load, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Forks an existing session to create a new independent session.
   *
   * Creates a new session based on the context of an existing one, allowing
   * operations like generating summaries without affecting the original session's history.
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the forked session.
   *
   * This method is only available if the agent advertises the `session.fork` capability.
   *
   * @experimental
   */
  unstable_forkSession(
    params: schema.ForkSessionRequest,
  ): Promise<schema.ForkSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_fork,
      params,
    );
  }

  /**
   * Lists existing sessions from the agent.
   *
   * This method is only available if the agent advertises the `listSessions` capability.
   *
   * Returns a list of sessions with metadata like session ID, working directory,
   * title, and last update time. Supports filtering by working directory,
   * `additionalDirectories`, and cursor-based pagination.
   */
  listSessions(
    params: schema.ListSessionsRequest,
  ): Promise<schema.ListSessionsResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_list,
      params,
    );
  }

  /**
   * Deletes an existing session returned by `session/list`.
   *
   * This method is only available if the agent advertises the `sessionCapabilities.delete` capability.
   */
  deleteSession(
    params: schema.DeleteSessionRequest,
  ): Promise<schema.DeleteSessionResponse> {
    return this.connection.sendRequest<
      schema.DeleteSessionRequest,
      schema.DeleteSessionResponse
    >(schema.AGENT_METHODS.session_delete, params, emptyObjectResponse);
  }

  /**
   * Resumes an existing session without returning previous messages.
   *
   * This method is only available if the agent advertises the `session.resume` capability.
   *
   * The agent should resume the session context, allowing the conversation to continue
   * without replaying the message history (unlike `session/load`).
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the resumed session.
   */
  resumeSession(
    params: schema.ResumeSessionRequest,
  ): Promise<schema.ResumeSessionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_resume,
      params,
    );
  }

  /**
   * Closes an active session and frees up any resources associated with it.
   *
   * This method is only available if the agent advertises the `session.close` capability.
   *
   * The agent must cancel any ongoing work (as if `session/cancel` was called)
   * and then free up any resources associated with the session.
   */
  closeSession(
    params: schema.CloseSessionRequest,
  ): Promise<schema.CloseSessionResponse> {
    return this.connection.sendRequest<
      schema.CloseSessionRequest,
      schema.CloseSessionResponse
    >(schema.AGENT_METHODS.session_close, params, emptyObjectResponse);
  }

  /**
   * Sets the operational mode for a session.
   *
   * Allows switching between different agent modes (e.g., "ask", "architect", "code")
   * that affect system prompts, tool availability, and permission behaviors.
   *
   * The mode must be one of the modes advertised in `availableModes` during session
   * creation or loading. Agents may also change modes autonomously and notify the
   * client via `current_mode_update` notifications.
   *
   * This method can be called at any time during a session, whether the Agent is
   * idle or actively generating a turn.
   *
   * See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
   */
  setSessionMode(
    params: schema.SetSessionModeRequest,
  ): Promise<schema.SetSessionModeResponse> {
    return this.connection.sendRequest<
      schema.SetSessionModeRequest,
      schema.SetSessionModeResponse
    >(schema.AGENT_METHODS.session_set_mode, params, emptyObjectResponse);
  }

  /**
   * Set a configuration option for a given session.
   *
   * The response contains the full set of configuration options and their current values,
   * as changing one option may affect the available values or state of other options.
   */
  setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_set_config_option,
      params,
    );
  }

  /**
   * Authenticates the client using the specified authentication method.
   *
   * Called when the agent requires authentication before allowing session creation.
   * The client provides the authentication method ID that was advertised during initialization.
   *
   * After successful authentication, the client can proceed to create sessions with
   * `newSession` without receiving an `auth_required` error.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  authenticate(
    params: schema.AuthenticateRequest,
  ): Promise<schema.AuthenticateResponse> {
    return this.connection.sendRequest<
      schema.AuthenticateRequest,
      schema.AuthenticateResponse
    >(schema.AGENT_METHODS.authenticate, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Lists providers that can be configured by the client.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_listProviders(
    params: schema.ListProvidersRequest,
  ): Promise<schema.ListProvidersResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.providers_list,
      params,
    );
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Replaces the configuration for a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_setProvider(
    params: schema.SetProviderRequest,
  ): Promise<schema.SetProviderResponse> {
    return this.connection.sendRequest<
      schema.SetProviderRequest,
      schema.SetProviderResponse
    >(schema.AGENT_METHODS.providers_set, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Disables a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_disableProvider(
    params: schema.DisableProviderRequest,
  ): Promise<schema.DisableProviderResponse> {
    return this.connection.sendRequest<
      schema.DisableProviderRequest,
      schema.DisableProviderResponse
    >(schema.AGENT_METHODS.providers_disable, params, emptyObjectResponse);
  }

  /**
   * Logout of the current authentication method.
   */
  logout(params: schema.LogoutRequest): Promise<schema.LogoutResponse> {
    return this.connection.sendRequest<
      schema.LogoutRequest,
      schema.LogoutResponse
    >(schema.AGENT_METHODS.logout, params, emptyObjectResponse);
  }

  /**
   * Processes a user prompt within a session.
   *
   * This method handles the whole lifecycle of a prompt:
   * - Receives user messages with optional context (files, images, etc.)
   * - Processes the prompt using language models
   * - Reports language model content and tool calls to the Clients
   * - Requests permission to run tools
   * - Executes any requested tool calls
   * - Returns when the turn is complete with a stop reason
   *
   * See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
   */
  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.session_prompt,
      params,
    );
  }

  /**
   * Cancels ongoing operations for a session.
   *
   * This is a notification sent by the client to cancel an ongoing prompt turn.
   *
   * Upon receiving this notification, the Agent SHOULD:
   * - Stop all language model requests as soon as possible
   * - Abort all tool call invocations in progress
   * - Send any pending `session/update` notifications
   * - Respond to the original `session/prompt` request with `StopReason::Cancelled`
   *
   * See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
   */
  cancel(params: schema.CancelNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.session_cancel,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Starts a NES (Next Edit Suggestions) session.
   *
   * @experimental
   */
  unstable_startNes(
    params: schema.StartNesRequest,
  ): Promise<schema.StartNesResponse> {
    return this.connection.sendRequest(schema.AGENT_METHODS.nes_start, params);
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Sends a NES suggestion request.
   *
   * @experimental
   */
  unstable_suggestNes(
    params: schema.SuggestNesRequest,
  ): Promise<schema.SuggestNesResponse> {
    return this.connection.sendRequest(
      schema.AGENT_METHODS.nes_suggest,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Closes a NES session.
   *
   * @experimental
   */
  unstable_closeNes(
    params: schema.CloseNesRequest,
  ): Promise<schema.CloseNesResponse> {
    return this.connection.sendRequest<
      schema.CloseNesRequest,
      schema.CloseNesResponse
    >(schema.AGENT_METHODS.nes_close, params, emptyObjectResponse);
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was opened.
   *
   * @experimental
   */
  unstable_didOpenDocument(
    params: schema.DidOpenDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_open,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was changed.
   *
   * @experimental
   */
  unstable_didChangeDocument(
    params: schema.DidChangeDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_change,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was closed.
   *
   * @experimental
   */
  unstable_didCloseDocument(
    params: schema.DidCloseDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_close,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document was saved.
   *
   * @experimental
   */
  unstable_didSaveDocument(
    params: schema.DidSaveDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_save,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a document received focus.
   *
   * @experimental
   */
  unstable_didFocusDocument(
    params: schema.DidFocusDocumentNotification,
  ): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.document_did_focus,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a NES suggestion was accepted.
   *
   * @experimental
   */
  unstable_acceptNes(params: schema.AcceptNesNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.nes_accept,
      params,
    );
  }

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Notifies the agent that a NES suggestion was rejected.
   *
   * @experimental
   */
  unstable_rejectNes(params: schema.RejectNesNotification): Promise<void> {
    return this.connection.sendNotification(
      schema.AGENT_METHODS.nes_reject,
      params,
    );
  }

  /**
   * Sends a request to the agent by ACP method name.
   *
   * Built-in method literals infer their params and response types. Custom
   * methods can specify their response and params types with generics.
   */
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    options?: SendRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    const spec = agentRequestSpecsByMethod[method] as
      | AcpRequestSpec<unknown, unknown, unknown>
      | undefined;
    return this.connection.sendRequest(
      method,
      params,
      spec?.mapResponse,
      options,
    );
  }

  /**
   * Sends a notification to the agent by ACP method name.
   *
   * Built-in method literals infer their params type. Custom notifications can
   * specify their params type with a generic.
   */
  notify<Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void>;
  notify<Params = unknown>(method: string, params?: Params): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  /**
   * Extension method.
   *
   * @deprecated Use {@link request}.
   */
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>, Record<string, unknown>>(
      method,
      params,
    );
  }

  /**
   * Extension notification.
   *
   * @deprecated Use {@link notify}.
   */
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.notify(method, params);
  }

  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal(): AbortSignal {
    return this.connection.signal;
  }

  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/**
 * The Client interface defines the interface that ACP-compliant clients must implement.
 *
 * Clients are typically code editors (IDEs, text editors) that provide the interface
 * between users and AI agents. They manage the environment, handle user interactions,
 * and control access to resources.
 */
export interface Client {
  /**
   * Requests permission from the user for a tool call operation.
   *
   * Called by the agent when it needs user authorization before executing
   * a potentially sensitive operation. The client should present the options
   * to the user and return their decision.
   *
   * If the client cancels the prompt turn via `session/cancel`, it MUST
   * respond to this request with `RequestPermissionOutcome::Cancelled`.
   *
   * See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
   */
  requestPermission(
    params: schema.RequestPermissionRequest,
  ): MaybePromise<schema.RequestPermissionResponse>;
  /**
   * Handles session update notifications from the agent.
   *
   * This is a notification endpoint (no response expected) that receives
   * real-time updates about session progress, including message chunks,
   * tool calls, and execution plans.
   *
   * Note: Clients SHOULD continue accepting tool call updates even after
   * sending a `session/cancel` notification, as the agent may send final
   * updates before responding with the cancelled stop reason.
   *
   * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
   */
  sessionUpdate(params: schema.SessionNotification): MaybePromise<void>;
  /**
   * Writes content to a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.writeTextFile` capability.
   * Allows the agent to create or modify files within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  writeTextFile?(
    params: schema.WriteTextFileRequest,
  ): MaybePromise<schema.WriteTextFileResponse | void>;
  /**
   * Reads content from a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.readTextFile` capability.
   * Allows the agent to access file contents within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  readTextFile?(
    params: schema.ReadTextFileRequest,
  ): MaybePromise<schema.ReadTextFileResponse>;

  /**
   * Creates a new terminal to execute a command.
   *
   * Only available if the `terminal` capability is set to `true`.
   *
   * The Agent must call `releaseTerminal` when done with the terminal
   * to free resources.

   * @see {@link https://agentclientprotocol.com/protocol/terminals | Terminal Documentation}
   */
  createTerminal?(
    params: schema.CreateTerminalRequest,
  ): MaybePromise<schema.CreateTerminalResponse>;

  /**
   * Gets the current output and exit status of a terminal.
   *
   * Returns immediately without waiting for the command to complete.
   * If the command has already exited, the exit status is included.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#getting-output | Getting Terminal Output}
   */
  terminalOutput?(
    params: schema.TerminalOutputRequest,
  ): MaybePromise<schema.TerminalOutputResponse>;

  /**
   * Releases a terminal and frees all associated resources.
   *
   * The command is killed if it hasn't exited yet. After release,
   * the terminal ID becomes invalid for all other terminal methods.
   *
   * Tool calls that already contain the terminal ID continue to
   * display its output.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#releasing-terminals | Releasing Terminals}
   */
  releaseTerminal?(
    params: schema.ReleaseTerminalRequest,
  ): MaybePromise<schema.ReleaseTerminalResponse | void>;

  /**
   * Waits for a terminal command to exit and returns its exit status.
   *
   * This method returns once the command completes, providing the
   * exit code and/or signal that terminated the process.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#waiting-for-exit | Waiting for Exit}
   */
  waitForTerminalExit?(
    params: schema.WaitForTerminalExitRequest,
  ): MaybePromise<schema.WaitForTerminalExitResponse>;

  /**
   * Kills a terminal command without releasing the terminal.
   *
   * While `releaseTerminal` also kills the command, this method keeps
   * the terminal ID valid so it can be used with other methods.
   *
   * Useful for implementing command timeouts that terminate the command
   * and then retrieve the final output.
   *
   * Note: Call `releaseTerminal` when the terminal is no longer needed.
   *
   * @see {@link https://agentclientprotocol.com/protocol/terminals#killing-commands | Killing Commands}
   */
  killTerminal?(
    params: schema.KillTerminalRequest,
  ): MaybePromise<schema.KillTerminalResponse | void>;

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Creates an elicitation to request input from the user.
   *
   * @experimental
   */
  unstable_createElicitation?(
    params: schema.CreateElicitationRequest,
  ): MaybePromise<schema.CreateElicitationResponse>;

  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a URL-based elicitation is complete.
   *
   * @experimental
   */
  unstable_completeElicitation?(
    params: schema.CompleteElicitationNotification,
  ): MaybePromise<void>;

  /**
   * Handles a request that is not otherwise registered by the legacy client.
   *
   * Allows the Agent to send an arbitrary request that is not part of the ACP spec.
   *
   * To help avoid conflicts, it's a good practice to prefix extension
   * methods with a unique identifier such as domain name.
   *
   * @deprecated Prefer `client().onRequest(...)` for custom methods.
   */
  extMethod?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<Record<string, unknown>>;

  /**
   * Handles a notification that is not otherwise registered by the legacy client.
   *
   * Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
   *
   * @deprecated Prefer `client().onNotification(...)` for custom notifications.
   */
  extNotification?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<void>;
}

/**
 * The Agent interface defines the interface that all ACP-compliant agents must implement.
 *
 * Agents are programs that use generative AI to autonomously modify code. They handle
 * requests from clients and execute tasks using language models and tools.
 */
export interface Agent {
  /**
   * Establishes the connection with a client and negotiates protocol capabilities.
   *
   * This method is called once at the beginning of the connection to:
   * - Negotiate the protocol version to use
   * - Exchange capability information between client and agent
   * - Determine available authentication methods
   *
   * The agent should respond with its supported protocol version and capabilities.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  initialize(
    params: schema.InitializeRequest,
  ): MaybePromise<schema.InitializeResponse>;
  /**
   * Creates a new conversation session with the agent.
   *
   * Sessions represent independent conversation contexts with their own history and state.
   *
   * The agent should:
   * - Create a new session context
   * - Connect to any specified MCP servers
   * - Return a unique session ID for future requests
   *
   * The request may include `additionalDirectories` to expand the session's filesystem
   * scope beyond `cwd` without changing the base for relative paths.
   *
   * May return an `auth_required` error if the agent requires authentication.
   *
   * See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
   */
  newSession(
    params: schema.NewSessionRequest,
  ): MaybePromise<schema.NewSessionResponse>;
  /**
   * Loads an existing session to resume a previous conversation.
   *
   * This method is only available if the agent advertises the `loadSession` capability.
   *
   * The agent should:
   * - Restore the session context and conversation history
   * - Connect to the specified MCP servers
   * - Stream the entire conversation history back to the client via notifications
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the loaded session.
   *
   * See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
   */
  loadSession?(
    params: schema.LoadSessionRequest,
  ): MaybePromise<schema.LoadSessionResponse | void>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Forks an existing session to create a new independent session.
   *
   * Creates a new session based on the context of an existing one, allowing
   * operations like generating summaries without affecting the original session's history.
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the forked session.
   *
   * This method is only available if the agent advertises the `session.fork` capability.
   *
   * @experimental
   */
  unstable_forkSession?(
    params: schema.ForkSessionRequest,
  ): MaybePromise<schema.ForkSessionResponse>;
  /**
   * Lists existing sessions from the agent.
   *
   * This method is only available if the agent advertises the `listSessions` capability.
   *
   * Returns a list of sessions with metadata like session ID, working directory,
   * title, and last update time. Supports filtering by working directory,
   * `additionalDirectories`, and cursor-based pagination.
   */
  listSessions?(
    params: schema.ListSessionsRequest,
  ): MaybePromise<schema.ListSessionsResponse>;
  /**
   * Deletes an existing session returned by `session/list`.
   *
   * This method is only available if the agent advertises the `sessionCapabilities.delete` capability.
   */
  deleteSession?(
    params: schema.DeleteSessionRequest,
  ): MaybePromise<schema.DeleteSessionResponse | void>;
  /**
   * Resumes an existing session without returning previous messages.
   *
   * This method is only available if the agent advertises the `session.resume` capability.
   *
   * The agent should resume the session context, allowing the conversation to continue
   * without replaying the message history (unlike `session/load`).
   *
   * The request may include `additionalDirectories` to set the complete list of
   * additional workspace roots for the resumed session.
   */
  resumeSession?(
    params: schema.ResumeSessionRequest,
  ): MaybePromise<schema.ResumeSessionResponse>;
  /**
   * Closes an active session and frees up any resources associated with it.
   *
   * This method is only available if the agent advertises the `session.close` capability.
   *
   * The agent must cancel any ongoing work (as if `session/cancel` was called)
   * and then free up any resources associated with the session.
   */
  closeSession?(
    params: schema.CloseSessionRequest,
  ): MaybePromise<schema.CloseSessionResponse | void>;
  /**
   * Sets the operational mode for a session.
   *
   * Allows switching between different agent modes (e.g., "ask", "architect", "code")
   * that affect system prompts, tool availability, and permission behaviors.
   *
   * The mode must be one of the modes advertised in `availableModes` during session
   * creation or loading. Agents may also change modes autonomously and notify the
   * client via `current_mode_update` notifications.
   *
   * This method can be called at any time during a session, whether the Agent is
   * idle or actively generating a turn.
   *
   * See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
   */
  setSessionMode?(
    params: schema.SetSessionModeRequest,
  ): MaybePromise<schema.SetSessionModeResponse | void>;
  /**
   * Set a configuration option for a given session.
   *
   * The response contains the full set of configuration options and their current values,
   * as changing one option may affect the available values or state of other options.
   */
  setSessionConfigOption?(
    params: schema.SetSessionConfigOptionRequest,
  ): MaybePromise<schema.SetSessionConfigOptionResponse>;
  /**
   * Authenticates the client using the specified authentication method.
   *
   * Called when the agent requires authentication before allowing session creation.
   * The client provides the authentication method ID that was advertised during initialization.
   *
   * After successful authentication, the client can proceed to create sessions with
   * `newSession` without receiving an `auth_required` error.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  authenticate(
    params: schema.AuthenticateRequest,
  ): MaybePromise<schema.AuthenticateResponse | void>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Lists providers that can be configured by the client.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_listProviders?(
    params: schema.ListProvidersRequest,
  ): MaybePromise<schema.ListProvidersResponse>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Replaces the configuration for a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_setProvider?(
    params: schema.SetProviderRequest,
  ): MaybePromise<schema.SetProviderResponse | void>;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Disables a provider.
   *
   * This method is only available if the agent advertises the `providers` capability.
   *
   * @experimental
   */
  unstable_disableProvider?(
    params: schema.DisableProviderRequest,
  ): MaybePromise<schema.DisableProviderResponse | void>;
  /**
   * Logout of the current authentication method.
   */
  logout?(
    params: schema.LogoutRequest,
  ): MaybePromise<schema.LogoutResponse | void>;
  /**
   * Processes a user prompt within a session.
   *
   * This method handles the whole lifecycle of a prompt:
   * - Receives user messages with optional context (files, images, etc.)
   * - Processes the prompt using language models
   * - Reports language model content and tool calls to the Clients
   * - Requests permission to run tools
   * - Executes any requested tool calls
   * - Returns when the turn is complete with a stop reason
   *
   * See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
   */
  prompt(params: schema.PromptRequest): MaybePromise<schema.PromptResponse>;
  /**
   * Cancels ongoing operations for a session.
   *
   * This is a notification sent by the client to cancel an ongoing prompt turn.
   *
   * Upon receiving this notification, the Agent SHOULD:
   * - Stop all language model requests as soon as possible
   * - Abort all tool call invocations in progress
   * - Send any pending `session/update` notifications
   * - Respond to the original `session/prompt` request with `StopReason::Cancelled`
   *
   * See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
   */
  cancel(params: schema.CancelNotification): MaybePromise<void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Starts a NES (Next Edit Suggestions) session.
   *
   * @experimental
   */
  unstable_startNes?(
    params: schema.StartNesRequest,
  ): MaybePromise<schema.StartNesResponse>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Sends a NES suggestion request.
   *
   * @experimental
   */
  unstable_suggestNes?(
    params: schema.SuggestNesRequest,
  ): MaybePromise<schema.SuggestNesResponse>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Closes a NES session.
   *
   * @experimental
   */
  unstable_closeNes?(
    params: schema.CloseNesRequest,
  ): MaybePromise<schema.CloseNesResponse | void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is opened.
   *
   * @experimental
   */
  unstable_didOpenDocument?(
    params: schema.DidOpenDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is changed.
   *
   * @experimental
   */
  unstable_didChangeDocument?(
    params: schema.DidChangeDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is closed.
   *
   * @experimental
   */
  unstable_didCloseDocument?(
    params: schema.DidCloseDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document is saved.
   *
   * @experimental
   */
  unstable_didSaveDocument?(
    params: schema.DidSaveDocumentNotification,
  ): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a document receives focus.
   *
   * @experimental
   */
  unstable_didFocusDocument?(
    params: schema.DidFocusDocumentNotification,
  ): MaybePromise<void>;

  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a NES suggestion is accepted.
   *
   * @experimental
   */
  unstable_acceptNes?(params: schema.AcceptNesNotification): MaybePromise<void>;
  /**
   * **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Called when a NES suggestion is rejected.
   *
   * @experimental
   */
  unstable_rejectNes?(params: schema.RejectNesNotification): MaybePromise<void>;

  /**
   * Handles a request that is not otherwise registered by the legacy agent.
   *
   * Allows the Client to send an arbitrary request that is not part of the ACP spec.
   *
   * To help avoid conflicts, it's a good practice to prefix extension
   * methods with a unique identifier such as domain name.
   *
   * @deprecated Prefer `agent().onRequest(...)` for custom methods.
   */
  extMethod?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<Record<string, unknown>>;

  /**
   * Handles a notification that is not otherwise registered by the legacy agent.
   *
   * Allows the Client to send an arbitrary notification that is not part of the ACP spec.
   *
   * @deprecated Prefer `agent().onNotification(...)` for custom notifications.
   */
  extNotification?(
    method: string,
    params: Record<string, unknown>,
  ): MaybePromise<void>;
}
