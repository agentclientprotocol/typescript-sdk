// Generated from src/acp.ts. Do not edit directly.
// V1 binding implementation, specialized against stable schemas by generate.js.
import * as schema from "../schema/index.js";
import * as validate from "../schema/zod.gen.js";
import type { AnyMessage } from "../jsonrpc.js";
import { ndJsonStream as createJsonStream } from "../stream.js";
export type * from "../schema/types.gen.js";
// Runtime narrowing helpers for extensible unions, exposed as companion values
// that merge (declaration merging) with the like-named types — e.g.
// `CreateElicitationResponse.isAccept(response)`. See schema/guards.gen.ts.
//
// Listed explicitly (not `export *`) so each value+type pair merges rather than
// colliding with the `export type *` above. The guards.gen re-export test
// asserts this list stays in sync as new extensible unions are added.
export {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  MultiSelectItems,
} from "../schema/guards.gen.js";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from "../schema/index.js";
/**
 * Stream interface for stable ACP v1 connections.
 *
 * This type powers bidirectional communication for an ACP connection using
 * individual JSON-RPC messages. The experimental v2 entry point exposes the
 * batch-capable stream surface.
 *
 * The most common way to create a Stream is using {@link ndJsonStream}.
 */
export type Stream = {
  /** Outgoing JSON-RPC messages written by this side of the connection. */
  writable: WritableStream<AnyMessage>;
  /** Incoming JSON-RPC messages read by this side of the connection. */
  readable: ReadableStream<AnyMessage>;
};
/**
 * Creates a stable ACP v1 stream from newline-delimited JSON streams.
 *
 * @param output - The writable stream to send encoded messages to
 * @param input - The readable stream to receive encoded messages from
 * @returns A stream for bidirectional ACP v1 communication
 */
export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options?: NdJsonStreamOptions,
): Stream {
  return createJsonStream(output, input, options);
}
export { RequestError } from "../jsonrpc.js";
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageTooLargeError,
} from "../stream-limits.js";
export type { NdJsonStreamOptions } from "../stream.js";
export type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "../connection.js";
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
} from "../jsonrpc.js";
import type { NdJsonStreamOptions, WireStream } from "../stream.js";
import {
  parseParams,
  registerAppNotification,
  registerAppRequest,
} from "../app-handlers.js";
import type { ParamsParser } from "../app-handlers.js";
export type { ParamsParser } from "../app-handlers.js";
import { Connection, Handled, HandlerRegistration } from "../jsonrpc.js";
import type {
  AnyWireMessage,
  ConnectionBuilder,
  ConnectionContext,
  ConnectionOptions,
  HandleResult,
  IncomingMessage,
  JsonRpcId,
  JsonRpcHandler,
  MaybePromise,
  SendRequestOptions,
} from "../jsonrpc.js";
function emptyObjectResponse<T>(response: T | null | undefined | void): T {
  return response ?? ({} as T);
}
function isStream(value: unknown): value is WireStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "readable" in value &&
    "writable" in value
  );
}
function memoryStreamPair(): [WireStream, WireStream] {
  const leftToRight = new TransformStream<AnyWireMessage>();
  const rightToLeft = new TransformStream<AnyWireMessage>();
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
    session: {
      new: schema.AGENT_METHODS.session_new,
      load: schema.AGENT_METHODS.session_load,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      resume: schema.AGENT_METHODS.session_resume,
      close: schema.AGENT_METHODS.session_close,
      setMode: schema.AGENT_METHODS.session_set_mode,
      setConfigOption: schema.AGENT_METHODS.session_set_config_option,
      prompt: schema.AGENT_METHODS.session_prompt,
      cancel: schema.AGENT_METHODS.session_cancel,
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
   * Executes a command in a new client terminal.
   *
   * Returns a handle for reading output, waiting for exit, killing the command,
   * and releasing the terminal. Check the client's terminal capability first.
   * Use `await using` or call `release()` when finished.
   */
  async createTerminal(
    params: schema.CreateTerminalRequest,
    options?: SendRequestOptions,
  ): Promise<TerminalHandle> {
    const response = await this.request(
      schema.CLIENT_METHODS.terminal_create,
      params,
      options,
    );
    return TerminalHandle.create(
      response.terminalId,
      params.sessionId,
      this.connectionContext,
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
      AcpRequestSpec<unknown, unknown, unknown> | undefined;
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
      AcpRequestSpec<unknown, unknown, unknown> | undefined;
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
  get meta():
    | {
        [key: string]: unknown;
      }
    | null
    | undefined {
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
 * Common context passed to agent-side handlers.
 */
export type AgentHandlerContext<Params> = {
  /** The method being handled, including the actual name in fallback handlers. */
  method: string;
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
  /** The method being handled, including the actual name in fallback handlers. */
  method: string;
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
  return {
    method,
    // Match Rust's empty-payload handling without bypassing required fields.
    params: (value) => parseParams(params, value ?? {}),
    mapResponse,
  };
}
function notificationSpec<Params>(
  method: string,
  params: ParamsParser<Params>,
): AcpNotificationSpec<Params> {
  return { method, params };
}
function specsByMethod<
  T extends Record<
    string,
    {
      method: string;
    }
  >,
>(specs: T): Record<string, T[keyof T]> {
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
  logout: requestSpec<
    schema.LogoutRequest,
    schema.LogoutResponse | void,
    schema.LogoutResponse
  >(schema.AGENT_METHODS.logout, validate.zLogoutRequest, emptyObjectResponse),
  prompt: requestSpec<schema.PromptRequest, schema.PromptResponse>(
    schema.AGENT_METHODS.session_prompt,
    validate.zPromptRequest,
  ),
};
const agentNotificationSpecs = {
  cancel: notificationSpec<schema.CancelNotification>(
    schema.AGENT_METHODS.session_cancel,
    validate.zCancelNotification,
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
  createElicitation: requestSpec<
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
  completeElicitation: notificationSpec<schema.CompleteElicitationNotification>(
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
  [schema.AGENT_METHODS.logout]: AgentRequestHandler<
    schema.LogoutRequest,
    schema.LogoutResponse | void
  >;
  [schema.AGENT_METHODS.session_prompt]: AgentRequestHandler<
    schema.PromptRequest,
    schema.PromptResponse
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
    ? Context extends {
        params: infer Params;
      }
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
  [
    Method in AgentNotificationMethod
  ]: AgentNotificationHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<void>
    ? Context extends {
        params: infer Params;
      }
      ? Params
      : never
    : never;
};
/**
 * Client request params keyed by ACP protocol method name.
 */
export type ClientRequestParamsByMethod = {
  [
    Method in ClientRequestMethod
  ]: ClientRequestHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<unknown>
    ? Context extends {
        params: infer Params;
      }
      ? Params
      : never
    : never;
};
/**
 * Client request responses keyed by ACP protocol method name.
 */
export type ClientRequestResponsesByMethod = {
  [
    Method in ClientRequestMethod
  ]: ClientRequestHandlersByMethod[Method] extends (
    context: infer _Context,
  ) => MaybePromise<infer Response>
    ? Exclude<Response, void>
    : never;
};
/**
 * Client notification params keyed by ACP protocol method name.
 */
export type ClientNotificationParamsByMethod = {
  [
    Method in ClientNotificationMethod
  ]: ClientNotificationHandlersByMethod[Method] extends (
    context: infer Context,
  ) => MaybePromise<void>
    ? Context extends {
        params: infer Params;
      }
      ? Params
      : never
    : never;
};
function agentRequestContext<Params>(
  params: Params,
  client: AgentContext,
  signal: AbortSignal,
  requestId: JsonRpcId,
  method: string,
): AgentRequestContext<Params> {
  return {
    method,
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
  method: string,
): AgentNotificationContext<Params> {
  return {
    method,
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
  method: string,
): ClientRequestContext<Params> {
  return {
    method,
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
  method: string,
): ClientNotificationContext<Params> {
  return {
    method,
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
const stableConnectionOptions: ConnectionOptions = { allowBatches: false };
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
  private readonly fallbackKinds = new Set<"request" | "notification">();
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
  connect(stream: WireStream, options: AppConnectOptions): AgentConnection;
  /**
   * Connects this agent app directly to a client app.
   *
   * This is useful for tests and in-process examples that do not need a
   * transport.
   */
  connect(client: ClientApp): AgentConnection;
  connect(
    target: WireStream | ClientApp,
    options: AppConnectOptions = {},
  ): AgentConnection {
    return this.connectConnection(target, options).connection;
  }
  /**
   * Connects this agent app to a stream or client app for the lifetime of `op`.
   *
   * The callback receives an `AgentContext` for calling client-side methods.
   * When `op` resolves or rejects, the connection is closed.
   */
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
   * methods outside an inbound request handler, or to set up per-connection
   * state that the request handlers use.
   *
   * Handlers are called synchronously in registration order and are not
   * awaited. A handler that throws or rejects closes the connection. When they
   * are called depends on who opens the connection:
   *
   * - `connect(...)` and `connectWith(...)` call them before the connection
   *   handles its first inbound message, and so does the experimental
   *   `AgentProtocolRouter`'s `connect(...)` when it routes to this app. Only
   *   the work a handler does before its first `await` is guaranteed to come
   *   first.
   * - The experimental `AcpServer` calls them after the client has completed
   *   `initialize`, so messages they send cannot replace the initialize
   *   response. Request handlers, including `initialize`, can run before them.
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
   * Use `"*"` without a parser for a raw fallback after normal dispatch.
   */
  onRequest(method: "*", handler: AgentRequestHandler<unknown, unknown>): this;
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
      | AgentRequestHandler<unknown, unknown>
      | ParamsParser<Params>,
    handler?: AgentRequestHandler<Params, Response>,
  ): this {
    if (method === "*") {
      if (handler)
        throw new Error(
          "Wildcard handlers receive raw params; omit the parser.",
        );
      if (this.fallbackKinds.has("request"))
        throw new Error("A request fallback is already registered.");
      this.fallbackKinds.add("request");
      return this.request(
        { method },
        handlerOrParams as AgentRequestHandler<unknown, unknown>,
      );
    }
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
   * Use `"*"` without a parser for a raw fallback after normal dispatch.
   */
  onNotification(method: "*", handler: AgentNotificationHandler<unknown>): this;
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
      | AgentNotificationHandler<unknown>
      | ParamsParser<Params>,
    handler?: AgentNotificationHandler<Params>,
  ): this {
    if (method === "*") {
      if (handler)
        throw new Error(
          "Wildcard handlers receive raw params; omit the parser.",
        );
      if (this.fallbackKinds.has("notification"))
        throw new Error("A notification fallback is already registered.");
      this.fallbackKinds.add("notification");
      return this.notification(
        { method },
        handlerOrParams as AgentNotificationHandler<unknown>,
      );
    }
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
      (params, cx, signal, requestId, method) =>
        agentRequestContext(
          params,
          AgentContext.create(cx, requestId),
          signal,
          requestId,
          method,
        ),
      handler,
      spec.mapResponse,
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
      (params, cx, signal, method) =>
        agentNotificationContext(
          params,
          AgentContext.create(cx),
          signal,
          method,
        ),
      handler,
    );
    return this;
  }
  private connectConnection(
    target: WireStream | ClientApp,
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
    const peerRawConnection = target[appBuilder]().connect(
      peerStream,
      stableConnectionOptions,
    );
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
  private openStreamConnection(stream: WireStream): AgentConnectionState {
    const rawConnection = this.builder.connect(stream, stableConnectionOptions);
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
  private readonly fallbackKinds = new Set<"request" | "notification">();
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
  connect(target: WireStream | AgentApp): ClientConnection {
    return this.connectConnection(target).connection;
  }
  /**
   * Connects this client app to a stream or agent app for the lifetime of `op`.
   *
   * The callback receives a `ClientContext` for calling agent-side methods.
   * When `op` resolves or rejects, the connection is closed.
   */
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
   * Use `"*"` without a parser for a raw fallback after normal dispatch.
   */
  onRequest(method: "*", handler: ClientRequestHandler<unknown, unknown>): this;
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
      | ClientRequestHandler<unknown, unknown>
      | ParamsParser<Params>,
    handler?: ClientRequestHandler<Params, Response>,
  ): this {
    if (method === "*") {
      if (handler)
        throw new Error(
          "Wildcard handlers receive raw params; omit the parser.",
        );
      if (this.fallbackKinds.has("request"))
        throw new Error("A request fallback is already registered.");
      this.fallbackKinds.add("request");
      return this.request(
        { method },
        handlerOrParams as ClientRequestHandler<unknown, unknown>,
      );
    }
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
   * Use `"*"` without a parser for a raw fallback after normal dispatch.
   */
  onNotification(
    method: "*",
    handler: ClientNotificationHandler<unknown>,
  ): this;
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
      | ClientNotificationHandler<unknown>
      | ParamsParser<Params>,
    handler?: ClientNotificationHandler<Params>,
  ): this {
    if (method === "*") {
      if (handler)
        throw new Error(
          "Wildcard handlers receive raw params; omit the parser.",
        );
      if (this.fallbackKinds.has("notification"))
        throw new Error("A notification fallback is already registered.");
      this.fallbackKinds.add("notification");
      return this.notification(
        { method },
        handlerOrParams as ClientNotificationHandler<unknown>,
      );
    }
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
      (params, cx, signal, requestId, method) =>
        clientRequestContext(
          params,
          ClientContext.create(cx, requestId),
          signal,
          requestId,
          method,
        ),
      handler,
      spec.mapResponse,
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
      (params, cx, signal, method) =>
        clientNotificationContext(
          params,
          ClientContext.create(cx),
          signal,
          method,
        ),
      handler,
    );
    return this;
  }
  private connectConnection(
    target: WireStream | AgentApp,
  ): ClientConnectionState {
    if (isStream(target)) {
      const state = this.openStreamConnection(target);
      this[runClientConnectHandlers](state.connection);
      return state;
    }
    const [thisStream, peerStream] = memoryStreamPair();
    const peerRawConnection = target[appBuilder]().connect(
      peerStream,
      stableConnectionOptions,
    );
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
  private openStreamConnection(stream: WireStream): ClientConnectionState {
    const rawConnection = this.builder.connect(stream, stableConnectionOptions);
    return {
      rawConnection,
      connection: clientConnection(rawConnection, this.connectHandlers),
    };
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
