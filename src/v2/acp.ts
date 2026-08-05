/**
 * Experimental TypeScript API for the draft ACP v2 protocol.
 *
 * @remarks
 * ACP v2 is still a draft. Its wire protocol and this API may change
 * incompatibly in any SDK release. The stable package entry point remains ACP
 * v1; consumers must opt in through
 * `@agentclientprotocol/sdk/experimental/v2`.
 *
 * @packageDocumentation
 * @experimental
 */

import * as schema from "./schema/index.js";
import * as validate from "./schema/zod.gen.js";
import * as guards from "./schema/guards.gen.js";
import { ndJsonStream as createJsonStream } from "../stream.js";
export type * from "./schema/types.gen.js";
// Runtime narrowing helpers for extensible unions, exposed as companion values
// that merge (declaration merging) with the like-named types — e.g.
// `CreateElicitationResponse.isAccept(response)`. See schema/guards.gen.ts.
//
// Listed explicitly (not `export *`) so each value+type pair merges rather than
// colliding with the `export type *` above. The guards.gen re-export test
// asserts this list stays in sync as new extensible unions are added.
export {
  AuthMethod,
  AvailableCommandInput,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DiffChange,
  ElicitationPropertySchema,
  McpServer,
  MultiSelectItems,
  NesSuggestion,
  PlanUpdateContent,
  ReplayFrom,
  RequestPermissionOutcome,
  RequestPermissionSubject,
  SessionConfigOption,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  StateUpdate,
  ToolCallContent,
} from "./schema/guards.gen.js";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from "./schema/index.js";

/**
 * Experimental draft ACP v2 transport stream supporting individual and batch
 * JSON-RPC messages.
 *
 * @experimental
 */
export type WireStream = {
  /** Outgoing individual or batch JSON-RPC messages. */
  writable: WritableStream<AnyWireMessage>;
  /** Incoming individual or batch JSON-RPC messages. */
  readable: ReadableStream<AnyWireMessage>;
};

/**
 * Consumer-facing alias for the experimental draft ACP v2 wire stream.
 *
 * @experimental
 */
export type Stream = WireStream;

/**
 * Creates an experimental draft ACP v2 stream from newline-delimited JSON.
 *
 * Individual and batch JSON-RPC messages are accepted by default.
 *
 * @experimental
 */
export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  return createJsonStream<AnyWireMessage>(output, input);
}

export { RequestError } from "../jsonrpc.js";
export {
  AgentProtocolRouter,
  agentProtocolRouter,
} from "../protocol-router.js";
export type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "../connection.js";
export type {
  AnyBatchCall,
  AnyBatchMessage,
  AnyBatchResponse,
  AnyCall,
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
  AnyWireMessage,
  BatchEntry,
  BatchNotification,
  BatchOutputs,
  BatchRequest,
  ErrorResponse,
  JsonRpcId,
  MaybePromise,
  Result,
  SendRequestOptions,
} from "../jsonrpc.js";

import {
  batchNotification as jsonRpcBatchNotification,
  batchRequest as jsonRpcBatchRequest,
  Connection,
  Handled,
  HandlerRegistration,
  RequestError,
} from "../jsonrpc.js";
import type {
  AnyWireMessage,
  BatchEntry,
  BatchNotification,
  BatchOutputs,
  BatchRequest,
  ConnectionBuilder,
  ConnectionContext,
  HandleResult,
  IncomingMessage,
  JsonRpcId,
  JsonRpcHandler,
  MaybePromise,
  SendRequestOptions,
} from "../jsonrpc.js";

/**
 * ACP v2 extension method name.
 *
 * New custom methods should begin with `_` so they cannot collide with present
 * or future protocol methods.
 *
 * @experimental
 */
export type ExtensionMethod = `_${string}`;

/**
 * A method name that is not part of the current ACP v2 draft.
 *
 * This compatibility type permits methods from older or newer unstable ACP
 * revisions while preventing current built-in method literals from falling
 * through the untyped overloads. Prefer {@link ExtensionMethod} for new custom
 * methods.
 *
 * @experimental
 */
export type UnrecognizedMethod<Method extends string> = string extends Method
  ? Method
  : Method extends
        | AgentRequestMethod
        | AgentNotificationMethod
        | ClientRequestMethod
        | ClientNotificationMethod
        | typeof schema.PROTOCOL_METHODS.cancel_request
    ? never
    : Method;

/**
 * Creates a typed request descriptor for an ACP v2 batch.
 *
 * Built-in method literals infer their params and response types. Extension
 * methods retain the low-level helper's explicit params/response generics.
 *
 * @experimental
 */
export function batchRequest<Method extends AgentRequestMethod>(
  method: Method,
  params: AgentRequestParamsByMethod[Method],
  options?: SendRequestOptions,
): BatchRequest<
  AgentRequestParamsByMethod[Method],
  AgentRequestResponsesByMethod[Method]
> & {
  readonly method: Method;
};
export function batchRequest<Method extends AgentRequestMethod, Output>(
  method: Method,
  params: AgentRequestParamsByMethod[Method],
  mapResponse: (response: AgentRequestResponsesByMethod[Method]) => Output,
  options?: SendRequestOptions,
): BatchRequest<
  AgentRequestParamsByMethod[Method],
  AgentRequestResponsesByMethod[Method],
  Output
> & {
  readonly method: Method;
};
export function batchRequest<Method extends ClientRequestMethod>(
  method: Method,
  params: ClientRequestParamsByMethod[Method],
  options?: SendRequestOptions,
): BatchRequest<
  ClientRequestParamsByMethod[Method],
  ClientRequestResponsesByMethod[Method]
> & {
  readonly method: Method;
};
export function batchRequest<Method extends ClientRequestMethod, Output>(
  method: Method,
  params: ClientRequestParamsByMethod[Method],
  mapResponse: (response: ClientRequestResponsesByMethod[Method]) => Output,
  options?: SendRequestOptions,
): BatchRequest<
  ClientRequestParamsByMethod[Method],
  ClientRequestResponsesByMethod[Method],
  Output
> & {
  readonly method: Method;
};
export function batchRequest<Params, Response>(
  method: ExtensionMethod,
  params?: Params,
  options?: SendRequestOptions,
): BatchRequest<Params, Response> & {
  readonly method: ExtensionMethod;
};
export function batchRequest<Params, Response, Output>(
  method: ExtensionMethod,
  params: Params | undefined,
  mapResponse: (response: Response) => Output,
  options?: SendRequestOptions,
): BatchRequest<Params, Response, Output> & {
  readonly method: ExtensionMethod;
};
export function batchRequest<
  Params = unknown,
  Response = unknown,
  const Method extends string = never,
>(
  method: UnrecognizedMethod<Method>,
  params?: Params,
  options?: SendRequestOptions,
): BatchRequest<Params, Response> & {
  readonly method: Method;
};
export function batchRequest<
  Params = unknown,
  Response = unknown,
  Output = Response,
  const Method extends string = never,
>(
  method: UnrecognizedMethod<Method>,
  params: Params | undefined,
  mapResponse: (response: Response) => Output,
  options?: SendRequestOptions,
): BatchRequest<Params, Response, Output> & {
  readonly method: Method;
};
export function batchRequest<Params, Response>(
  method: string,
  params?: Params,
  mapResponseOrOptions?: ((response: Response) => unknown) | SendRequestOptions,
  options?: SendRequestOptions,
): BatchRequest<Params, Response, unknown> & {
  readonly method: string;
} {
  const request =
    typeof mapResponseOrOptions === "function"
      ? jsonRpcBatchRequest(method, params, mapResponseOrOptions, options)
      : jsonRpcBatchRequest(method, params, mapResponseOrOptions);
  return request;
}

/**
 * Creates a typed notification descriptor for an ACP v2 batch.
 *
 * @experimental
 */
export function batchNotification<Method extends AgentNotificationMethod>(
  method: Method,
  params: AgentNotificationParamsByMethod[Method],
): BatchNotification<AgentNotificationParamsByMethod[Method]> & {
  readonly method: Method;
};
export function batchNotification<Method extends ClientNotificationMethod>(
  method: Method,
  params: ClientNotificationParamsByMethod[Method],
): BatchNotification<ClientNotificationParamsByMethod[Method]> & {
  readonly method: Method;
};
export function batchNotification(
  method: typeof schema.PROTOCOL_METHODS.cancel_request,
  params: schema.CancelRequestNotification,
): BatchNotification<schema.CancelRequestNotification> & {
  readonly method: typeof schema.PROTOCOL_METHODS.cancel_request;
};
export function batchNotification<Params>(
  method: ExtensionMethod,
  params?: Params,
): BatchNotification<Params> & {
  readonly method: ExtensionMethod;
};
export function batchNotification<
  Params = unknown,
  const Method extends string = never,
>(
  method: UnrecognizedMethod<Method>,
  params?: Params,
): BatchNotification<Params> & {
  readonly method: Method;
};
export function batchNotification<Params>(
  method: string,
  params?: Params,
): BatchNotification<Params> & {
  readonly method: string;
} {
  return jsonRpcBatchNotification(method, params);
}

function emptyObjectResponse<T>(response: T | null | undefined | void): T {
  return response ?? ({} as T);
}

const knownProtocolMethods = new Set<string>([
  ...Object.values(schema.AGENT_METHODS),
  ...Object.values(schema.CLIENT_METHODS),
  ...Object.values(schema.PROTOCOL_METHODS),
]);

function assertV2MethodDirection(
  method: string,
  builtIns: Record<string, unknown>,
  kind: "request" | "notification",
  allowProtocolNotification = false,
): void {
  if (
    Object.hasOwn(builtIns, method) ||
    (allowProtocolNotification &&
      method === schema.PROTOCOL_METHODS.cancel_request)
  ) {
    return;
  }
  if (knownProtocolMethods.has(method)) {
    throw new TypeError(
      `ACP v2 ${kind} method '${method}' is not valid in this direction`,
    );
  }
}

function assertUnrecognizedV2Method(
  method: string,
  kind: "request" | "notification",
): void {
  if (knownProtocolMethods.has(method)) {
    throw new TypeError(
      `Cannot replace the built-in ACP v2 ${kind} parser for '${method}'`,
    );
  }
}

function assertV2BatchMethods(
  entries: readonly BatchEntry[],
  requestMethods: Record<string, unknown>,
  notificationMethods: Record<string, unknown>,
): void {
  for (const entry of entries) {
    assertV2MethodDirection(
      entry.method,
      entry.kind === "request" ? requestMethods : notificationMethods,
      entry.kind,
      entry.kind === "notification",
    );
  }
}

function parseV2InitializeRequest(params: unknown): schema.InitializeRequest {
  const request = validate.zInitializeRequest.parse(params);
  if (request.protocolVersion !== schema.PROTOCOL_VERSION) {
    throw RequestError.invalidParams(
      {
        expectedProtocolVersion: schema.PROTOCOL_VERSION,
        receivedProtocolVersion: request.protocolVersion,
      },
      `The v2 API only supports protocol version ${schema.PROTOCOL_VERSION}`,
    );
  }
  return request;
}

function normalizeOutgoingV2InitializeRequest(
  params: unknown,
): schema.InitializeRequest {
  const request =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return parseV2InitializeRequest({
    ...request,
    protocolVersion: schema.PROTOCOL_VERSION,
  });
}

function mapV2InitializeResponse(response: unknown): schema.InitializeResponse {
  const parsed = validate.zInitializeResponse.parse(response);
  if (parsed.protocolVersion !== schema.PROTOCOL_VERSION) {
    throw RequestError.invalidRequest(
      {
        expectedProtocolVersion: schema.PROTOCOL_VERSION,
        receivedProtocolVersion: parsed.protocolVersion,
      },
      `The v2 API only supports protocol version ${schema.PROTOCOL_VERSION}`,
    );
  }
  return parsed;
}

function parseRequestResponse(
  spec: { response?: ParamsParser<unknown> },
  response: unknown,
): unknown {
  return parseParams(spec.response, response);
}

function normalizeV2Batch<const Entries extends readonly BatchEntry[]>(
  entries: Entries & { readonly 0: BatchEntry },
  requestSpecs: Record<
    string,
    { response?: ParamsParser<unknown> } | undefined
  >,
  normalizeInitialize = false,
): Entries & { readonly 0: BatchEntry } {
  return entries.map((entry) => {
    if (entry.kind !== "request") {
      return entry;
    }

    const spec = requestSpecs[entry.method];
    const mapResponse = entry.mapResponse as
      ((response: unknown) => unknown) | undefined;
    return {
      ...entry,
      params:
        normalizeInitialize && entry.method === schema.AGENT_METHODS.initialize
          ? normalizeOutgoingV2InitializeRequest(entry.params)
          : entry.params,
      mapResponse: spec
        ? (response: unknown) => {
            const parsed = parseRequestResponse(spec, response);
            return mapResponse ? mapResponse(parsed) : parsed;
          }
        : mapResponse,
    };
  }) as unknown as Entries & { readonly 0: BatchEntry };
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
 * ACP method-name constants for the experimental draft v2 API.
 *
 * Use these with `onRequest(...)`, `onNotification(...)`, `request(...)`, and
 * `notify(...)` when you want literal-string type inference without spelling
 * protocol strings inline.
 *
 * @experimental
 */
export const methods = {
  agent: {
    initialize: schema.AGENT_METHODS.initialize,
    auth: {
      login: schema.AGENT_METHODS.auth_login,
      logout: schema.AGENT_METHODS.auth_logout,
    },
    providers: {
      list: schema.AGENT_METHODS.providers_list,
      set: schema.AGENT_METHODS.providers_set,
      disable: schema.AGENT_METHODS.providers_disable,
    },
    session: {
      new: schema.AGENT_METHODS.session_new,
      list: schema.AGENT_METHODS.session_list,
      delete: schema.AGENT_METHODS.session_delete,
      fork: schema.AGENT_METHODS.session_fork,
      resume: schema.AGENT_METHODS.session_resume,
      close: schema.AGENT_METHODS.session_close,
      setConfigOption: schema.AGENT_METHODS.session_set_config_option,
      prompt: schema.AGENT_METHODS.session_prompt,
      cancel: schema.AGENT_METHODS.session_cancel,
    },
    mcp: {
      message: schema.AGENT_METHODS.mcp_message,
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
    mcp: {
      connect: schema.CLIENT_METHODS.mcp_connect,
      message: schema.CLIENT_METHODS.mcp_message,
      disconnect: schema.CLIENT_METHODS.mcp_disconnect,
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
 * Experimental draft ACP v2 connection returned by `AgentApp.connect(...)` and
 * `ClientApp.connect(...)`.
 *
 * Use this handle when you need a connection to stay open independently of a
 * single `connectWith(...)` operation.
 *
 * @experimental
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
 * Experimental draft ACP v2 agent-side connection returned by
 * `AgentApp.connect(...)`.
 *
 * Use `client` to call client-side ACP methods for the lifetime of the
 * connection.
 *
 * @experimental
 */
export interface AgentConnection extends AcpConnection {
  /**
   * Context for calling client-side ACP methods.
   */
  readonly client: AgentContext;
}

/**
 * Experimental draft ACP v2 client-side connection returned by
 * `ClientApp.connect(...)`.
 *
 * Use `agent` to call agent-side ACP methods and session helpers for the
 * lifetime of the connection.
 *
 * @experimental
 */
export interface ClientConnection extends AcpConnection {
  /**
   * Context for calling agent-side ACP methods.
   */
  readonly agent: ClientContext;
}

/**
 * One batch entry sent to an ACP v2 agent.
 *
 * @experimental
 */
export type AgentBatchEntry<Method extends string = string> =
  | {
      [Method in AgentRequestMethod]: BatchRequest<
        AgentRequestParamsByMethod[Method],
        AgentRequestResponsesByMethod[Method],
        unknown
      > & {
        readonly method: Method;
      };
    }[AgentRequestMethod]
  | {
      [Method in AgentNotificationMethod]: BatchNotification<
        AgentNotificationParamsByMethod[Method]
      > & {
        readonly method: Method;
      };
    }[AgentNotificationMethod]
  | (BatchNotification<schema.CancelRequestNotification> & {
      readonly method: typeof schema.PROTOCOL_METHODS.cancel_request;
    })
  | (BatchRequest<unknown, never, unknown> & {
      readonly method: ExtensionMethod | UnrecognizedMethod<Method>;
    })
  | (BatchNotification<unknown> & {
      readonly method: ExtensionMethod | UnrecognizedMethod<Method>;
    });

/**
 * One batch entry sent to an ACP v2 client.
 *
 * @experimental
 */
export type ClientBatchEntry<Method extends string = string> =
  | {
      [Method in ClientRequestMethod]: BatchRequest<
        ClientRequestParamsByMethod[Method],
        ClientRequestResponsesByMethod[Method],
        unknown
      > & {
        readonly method: Method;
      };
    }[ClientRequestMethod]
  | {
      [Method in ClientNotificationMethod]: BatchNotification<
        ClientNotificationParamsByMethod[Method]
      > & {
        readonly method: Method;
      };
    }[ClientNotificationMethod]
  | (BatchNotification<schema.CancelRequestNotification> & {
      readonly method: typeof schema.PROTOCOL_METHODS.cancel_request;
    })
  | (BatchRequest<unknown, never, unknown> & {
      readonly method: ExtensionMethod | UnrecognizedMethod<Method>;
    })
  | (BatchNotification<unknown> & {
      readonly method: ExtensionMethod | UnrecognizedMethod<Method>;
    });

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
  protected sendBatch<const Entries extends readonly BatchEntry[]>(
    entries: Entries & { readonly 0: BatchEntry },
  ): Promise<BatchOutputs<Entries>> {
    return this.cx.sendBatch(entries);
  }

  /** @internal */
  protected addDynamicHandler(handler: JsonRpcHandler): HandlerRegistration {
    return this.cx.addDynamicHandler(handler);
  }
}

/**
 * Experimental draft ACP v2 context passed to agent-side handlers.
 *
 * Agents use this context to call client-side ACP methods while handling
 * requests such as `session/prompt`.
 *
 * @experimental
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
    method: ExtensionMethod,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request<
    Response = unknown,
    Params = unknown,
    const Method extends string = never,
  >(
    method: UnrecognizedMethod<Method>,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    assertV2MethodDirection(method, clientRequestSpecsByMethod, "request");
    const spec = clientRequestSpecsByMethod[method] as
      AcpRequestSpec<unknown, unknown, unknown> | undefined;
    return this.sendRequest(
      method,
      params,
      spec ? (response) => parseRequestResponse(spec, response) : undefined,
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
  notify(
    method: typeof schema.PROTOCOL_METHODS.cancel_request,
    params: schema.CancelRequestNotification,
  ): Promise<void>;
  notify<Params = unknown>(
    method: ExtensionMethod,
    params?: Params,
  ): Promise<void>;
  notify<Params = unknown, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
    params?: Params,
  ): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    assertV2MethodDirection(
      method,
      clientNotificationSpecsByMethod,
      "notification",
      true,
    );
    return this.sendNotification(method, params);
  }

  /**
   * Sends requests and notifications to the client as one JSON-RPC batch.
   */
  batch<const Entries extends readonly BatchEntry[]>(
    entries: Entries & { readonly 0: BatchEntry } & {
      [Index in keyof Entries]: Entries[Index] extends BatchEntry
        ? string extends Entries[Index]["method"]
          ? Entries[Index]
          : Entries[Index]["method"] extends
                | AgentRequestMethod
                | AgentNotificationMethod
                | ClientRequestMethod
                | ClientNotificationMethod
                | typeof schema.PROTOCOL_METHODS.cancel_request
            ? Entries[Index] extends ClientBatchEntry<never>
              ? Entries[Index]
              : never
            : Entries[Index]
        : never;
    },
  ): Promise<BatchOutputs<Entries>> {
    assertV2BatchMethods(
      entries,
      clientRequestSpecsByMethod,
      clientNotificationSpecsByMethod,
    );
    return this.sendBatch(
      normalizeV2Batch(entries, clientRequestSpecsByMethod),
    );
  }
}

/**
 * Experimental draft ACP v2 context used by clients to call agent-side ACP
 * methods.
 *
 * `connectWith` passes a `ClientContext` to the callback. Client handlers also
 * receive one as `ctx.agent` when they need to call back into the agent.
 *
 * @experimental
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
    return this.request(schema.AGENT_METHODS.session_new, params, options).then(
      (response) => this.attachSession(response),
    );
  }

  /**
   * Creates a builder for starting and observing an ACP session.
   *
   * Pass an absolute path for the common case where only `cwd` is needed, or
   * pass a full `NewSessionRequest` when you need MCP servers, `_meta`, or
   * additional session fields.
   */
  buildSession(cwd: schema.AbsolutePath): SessionBuilder;
  buildSession(request: schema.NewSessionRequest): SessionBuilder;
  buildSession(
    cwdOrRequest: schema.AbsolutePath | schema.NewSessionRequest,
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
    const activePrompts = new Set<ActivePrompt>();
    const activeSessionQueue: ActiveSessionQueue = {
      enqueue: (value) => updates.enqueue(value),
      reject: (error) => updates.reject(error),
      clearErrors: () => updates.clearErrors(),
      fail: (error) => updates.fail(error),
      next: () => updates.next(),
      nextAfter: (cursor, signal) => updates.nextAfter(cursor, signal),
      beginPrompt: () => {
        const prompt = {
          updateCursor: updates.cursor(),
          overlapController: new AbortController(),
        };
        if (activePrompts.size > 0) {
          const error = new Error(
            "readText() cannot attribute updates across overlapping prompts; use nextUpdate() instead",
          );
          for (const activePrompt of activePrompts) {
            activePrompt.overlapController.abort(error);
          }
          prompt.overlapController.abort(error);
        }
        activePrompts.add(prompt);
        return prompt;
      },
      cancelPrompt: (prompt) => activePrompts.delete(prompt),
      isAwaitingPromptCompletion: () => activePrompts.size > 0,
      completePrompt: () => {
        activePrompts.clear();
      },
    };
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
    ).attach(response, activeSessionQueue);
    const closeRegistration = new HandlerRegistration(() => {
      closeSignal.removeEventListener("abort", failUpdatesOnClose);
    });

    return ActiveSession.create(this, response, activeSessionQueue, [
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
    method: ExtensionMethod,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request<
    Response = unknown,
    Params = unknown,
    const Method extends string = never,
  >(
    method: UnrecognizedMethod<Method>,
    params?: Params,
    options?: SendRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    assertV2MethodDirection(method, agentRequestSpecsByMethod, "request");
    const spec = agentRequestSpecsByMethod[method] as
      AcpRequestSpec<unknown, unknown, unknown> | undefined;
    const wireParams =
      method === schema.AGENT_METHODS.initialize
        ? normalizeOutgoingV2InitializeRequest(params)
        : params;
    return this.sendRequest(
      method,
      wireParams,
      spec ? (response) => parseRequestResponse(spec, response) : undefined,
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
  notify(
    method: typeof schema.PROTOCOL_METHODS.cancel_request,
    params: schema.CancelRequestNotification,
  ): Promise<void>;
  notify<Params = unknown>(
    method: ExtensionMethod,
    params?: Params,
  ): Promise<void>;
  notify<Params = unknown, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
    params?: Params,
  ): Promise<void>;
  notify(method: string, params?: unknown): Promise<void> {
    assertV2MethodDirection(
      method,
      agentNotificationSpecsByMethod,
      "notification",
      true,
    );
    return this.sendNotification(method, params);
  }

  /**
   * Sends requests and notifications to the agent as one JSON-RPC batch.
   */
  batch<const Entries extends readonly BatchEntry[]>(
    entries: Entries & { readonly 0: BatchEntry } & {
      [Index in keyof Entries]: Entries[Index] extends BatchEntry
        ? string extends Entries[Index]["method"]
          ? Entries[Index]
          : Entries[Index]["method"] extends
                | AgentRequestMethod
                | AgentNotificationMethod
                | ClientRequestMethod
                | ClientNotificationMethod
                | typeof schema.PROTOCOL_METHODS.cancel_request
            ? Entries[Index] extends AgentBatchEntry<never>
              ? Entries[Index]
              : never
            : Entries[Index]
        : never;
    },
  ): Promise<BatchOutputs<Entries>> {
    assertV2BatchMethods(
      entries,
      agentRequestSpecsByMethod,
      agentNotificationSpecsByMethod,
    );
    return this.sendBatch(
      normalizeV2Batch(entries, agentRequestSpecsByMethod, true),
    );
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
      sequence: number;
    }
  | {
      kind: "error";
      error: unknown;
      sequence: number;
    };

class AsyncQueue<T> {
  private values: Array<AsyncQueueEntry<T>> = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  private failed = false;
  private failure: unknown;
  private nextSequence = 0;

  enqueue(value: T): void {
    if (this.failed) {
      return;
    }

    const sequence = this.nextSequence++;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.values.push({ kind: "value", value, sequence });
    }
  }

  reject(error: unknown): void {
    if (this.failed) {
      return;
    }

    const sequence = this.nextSequence++;
    if (this.waiters.length > 0) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
      return;
    }

    this.values.push({ kind: "error", error, sequence });
  }

  clearErrors(): void {
    this.values = this.values.filter((entry) => entry.kind === "value");
  }

  cursor(): number {
    return this.nextSequence;
  }

  nextAfter(cursor: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    while (this.values[0] && this.values[0].sequence < cursor) {
      this.values.shift();
    }
    return this.next(signal);
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

  next(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

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
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter = {
        resolve: (value: T): void => {
          cleanup();
          resolve(value);
        },
        reject: (error: unknown): void => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        waiter.reject(signal?.reason);
      };

      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

function cloneNewSessionRequest(
  request: schema.NewSessionRequest,
): schema.NewSessionRequest {
  return structuredClone(request);
}

type ActiveSessionQueue = {
  enqueue(value: ActiveSessionMessage): void;
  reject(error: unknown): void;
  clearErrors(): void;
  fail(error: unknown): void;
  next(): Promise<ActiveSessionMessage>;
  nextAfter(
    cursor: number,
    signal?: AbortSignal,
  ): Promise<ActiveSessionMessage>;
  beginPrompt(): ActivePrompt;
  cancelPrompt(prompt: ActivePrompt): boolean;
  isAwaitingPromptCompletion(): boolean;
  completePrompt(): void;
};

type ActivePrompt = {
  updateCursor: number;
  overlapController: AbortController;
};

/**
 * Experimental draft ACP v2 message produced by an `ActiveSession`.
 *
 * `session_update` messages expose the typed `session/update` notification and
 * `stop` messages report an idle `state_update`. A prompt turn is complete once
 * a `stop` message is returned.
 *
 * @experimental
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
      notification: schema.UpdateSessionNotification;
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
       * Full notification containing the idle state update.
       */
      notification: schema.UpdateSessionNotification;
      /**
       * Convenience alias for `notification.update`.
       */
      update: schema.SessionUpdate;
      /**
       * Stop reason reported by the idle state, when provided.
       */
      stopReason: schema.StopReason | null | undefined;
    };

/**
 * Experimental draft ACP v2 builder for creating an `ActiveSession`.
 *
 * Start from `ctx.buildSession("/absolute/cwd")` for the common case, or
 * pass a full `NewSessionRequest` to `ctx.buildSession(...)` when the session
 * needs MCP servers, `_meta`, or additional request fields. All paths in ACP
 * payloads should be absolute.
 *
 * @experimental
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
  withAdditionalDirectories(
    additionalDirectories: schema.AbsolutePath[],
  ): this {
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
      mcpServers: [
        ...(this.request.mcpServers ?? []),
        structuredClone(mcpServer),
      ],
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
 * Experimental draft ACP v2 convenience wrapper for an active session.
 *
 * An active session routes `session/update` notifications for one session ID
 * into an async queue. Use `prompt(...)` to send user content, then read updates
 * with `nextUpdate()` until a `stop` message is returned.
 *
 * @experimental
 */
export class ActiveSession {
  private latestPrompt?: ActivePrompt;

  private constructor(
    private cx: ClientContext,
    private sessionResponse: schema.NewSessionResponse,
    private updates: ActiveSessionQueue,
    private registrations: HandlerRegistration[],
  ) {}

  /** @internal */
  static create(
    cx: ClientContext,
    sessionResponse: schema.NewSessionResponse,
    updates: ActiveSessionQueue,
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
   * Configuration options returned when the session was created, if provided.
   */
  get configOptions(): Array<schema.SessionConfigOption> | undefined {
    return this.sessionResponse.configOptions;
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
   * wrapped in an array. The returned promise resolves when the agent accepts
   * the prompt. Completion is reported separately by an idle `state_update`,
   * which is queued as a `stop` message for `nextUpdate()`.
   */
  prompt(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
    options?: SendRequestOptions,
  ): Promise<schema.PromptResponse> {
    this.updates.clearErrors();
    const activePrompt = this.updates.beginPrompt();
    this.latestPrompt = activePrompt;
    const response = this.cx.request(
      schema.AGENT_METHODS.session_prompt,
      {
        sessionId: this.sessionId,
        prompt: this.promptBlocks(prompt),
      },
      options,
    );
    void response.catch((error) => {
      if (this.updates.cancelPrompt(activePrompt)) {
        this.updates.reject(error);
      }
    });
    return response;
  }

  /**
   * Reads the next update or stop message for this session.
   */
  nextUpdate(): Promise<ActiveSessionMessage> {
    return this.updates.next();
  }

  /**
   * Reads agent text until the current prompt turn stops.
   *
   * Updates queued before the most recent call to `prompt(...)` are skipped.
   * Call prompts serially, after the preceding turn reports `stop`: session
   * updates do not carry a prompt ID and cannot be attributed across overlapping
   * prompt requests. Use `nextUpdate()` when coordinating requests directly.
   *
   * Full `agent_message` updates replace content for their `messageId`, while
   * `agent_message_chunk` updates append to it. Non-text content and other
   * update types are ignored; use `nextUpdate()` when you need them.
   */
  async readText(): Promise<string> {
    const activePrompt = this.latestPrompt;
    const updateCursor = activePrompt?.updateCursor;
    const messageOrder: schema.MessageId[] = [];
    const messageContent = new Map<
      schema.MessageId,
      Array<schema.ContentBlock>
    >();
    const ensureMessage = (
      messageId: schema.MessageId,
    ): Array<schema.ContentBlock> => {
      let content = messageContent.get(messageId);
      if (!content) {
        content = [];
        messageOrder.push(messageId);
        messageContent.set(messageId, content);
      }
      return content;
    };

    for (;;) {
      const message =
        updateCursor === undefined
          ? await this.nextUpdate()
          : await this.updates.nextAfter(
              updateCursor,
              activePrompt?.overlapController.signal,
            );
      if (message.kind === "stop") {
        return messageOrder
          .flatMap((messageId) => messageContent.get(messageId) ?? [])
          .filter(guards.ContentBlock.isText)
          .map((content) => content.text)
          .join("");
      }

      const { update } = message;
      if (guards.SessionUpdate.isAgentMessage(update)) {
        ensureMessage(update.messageId);
        if (update.content !== undefined) {
          messageContent.set(update.messageId, update.content ?? []);
        }
      } else if (guards.SessionUpdate.isAgentMessageChunk(update)) {
        ensureMessage(update.messageId).push(update.content);
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

type AcpRequestSpec<Params, HandlerResponse, Response = HandlerResponse> = {
  method: string;
  params?: ParamsParser<Params>;
  response?: ParamsParser<Response>;
  serializeResponse?: (response: HandlerResponse) => Response;
};

type AcpNotificationSpec<Params> = {
  method: string;
  params?: ParamsParser<Params>;
};

function requestSpec<Params, HandlerResponse, Response = HandlerResponse>(
  method: string,
  params: ParamsParser<Params>,
  response: ParamsParser<Response>,
  serializeResponse?: (response: HandlerResponse) => Response,
): AcpRequestSpec<Params, HandlerResponse, Response> {
  return { method, params, response, serializeResponse };
}

function notificationSpec<Params>(
  method: string,
  params: ParamsParser<Params>,
): AcpNotificationSpec<Params> {
  return { method, params };
}

function registerAppRequest<Params, HandlerResponse, Response, Context>(
  builder: ConnectionBuilder,
  spec: AcpRequestSpec<Params, HandlerResponse, Response>,
  context: (
    params: Params,
    cx: ConnectionContext,
    signal: AbortSignal,
    requestId: JsonRpcId,
  ) => Context,
  handler: (context: Context) => MaybePromise<HandlerResponse>,
): void {
  builder.onReceiveRequest<Params, Response>(
    spec.method,
    (params) => parseParams(spec.params, params),
    async (params, responder, cx) => {
      const response = await handler(
        context(params, cx, responder.signal, responder.id),
      );
      await responder.respond(
        spec.serializeResponse
          ? spec.serializeResponse(response)
          : (response as unknown as Response),
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
  const byMethod = Object.create(null) as Record<string, T[keyof T]>;
  for (const spec of Object.values(specs) as Array<T[keyof T]>) {
    byMethod[spec.method] = spec;
  }
  return byMethod;
}

const agentRequestSpecs = {
  initialize: requestSpec<schema.InitializeRequest, schema.InitializeResponse>(
    schema.AGENT_METHODS.initialize,
    parseV2InitializeRequest,
    mapV2InitializeResponse,
    mapV2InitializeResponse,
  ),
  loginAuth: requestSpec<
    schema.LoginAuthRequest,
    schema.LoginAuthResponse | void,
    schema.LoginAuthResponse
  >(
    schema.AGENT_METHODS.auth_login,
    validate.zLoginAuthRequest,
    validate.zLoginAuthResponse,
    emptyObjectResponse,
  ),
  unstable_listProviders: requestSpec<
    schema.ListProvidersRequest,
    schema.ListProvidersResponse
  >(
    schema.AGENT_METHODS.providers_list,
    validate.zListProvidersRequest,
    validate.zListProvidersResponse,
  ),
  unstable_setProvider: requestSpec<
    schema.SetProviderRequest,
    schema.SetProviderResponse | void,
    schema.SetProviderResponse
  >(
    schema.AGENT_METHODS.providers_set,
    validate.zSetProviderRequest,
    validate.zSetProviderResponse,
    emptyObjectResponse,
  ),
  unstable_disableProvider: requestSpec<
    schema.DisableProviderRequest,
    schema.DisableProviderResponse | void,
    schema.DisableProviderResponse
  >(
    schema.AGENT_METHODS.providers_disable,
    validate.zDisableProviderRequest,
    validate.zDisableProviderResponse,
    emptyObjectResponse,
  ),
  newSession: requestSpec<schema.NewSessionRequest, schema.NewSessionResponse>(
    schema.AGENT_METHODS.session_new,
    validate.zNewSessionRequest,
    validate.zNewSessionResponse,
  ),
  setSessionConfigOption: requestSpec<
    schema.SetSessionConfigOptionRequest,
    schema.SetSessionConfigOptionResponse
  >(
    schema.AGENT_METHODS.session_set_config_option,
    validate.zSetSessionConfigOptionRequest,
    validate.zSetSessionConfigOptionResponse,
  ),
  prompt: requestSpec<
    schema.PromptRequest,
    schema.PromptResponse | void,
    schema.PromptResponse
  >(
    schema.AGENT_METHODS.session_prompt,
    validate.zPromptRequest,
    validate.zPromptResponse,
    emptyObjectResponse,
  ),
  unstable_messageMcp: requestSpec<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
  >(
    schema.AGENT_METHODS.mcp_message,
    validate.zMessageMcpRequest,
    validate.zMessageMcpResponse,
  ),
  listSessions: requestSpec<
    schema.ListSessionsRequest,
    schema.ListSessionsResponse
  >(
    schema.AGENT_METHODS.session_list,
    validate.zListSessionsRequest,
    validate.zListSessionsResponse,
  ),
  deleteSession: requestSpec<
    schema.DeleteSessionRequest,
    schema.DeleteSessionResponse | void,
    schema.DeleteSessionResponse
  >(
    schema.AGENT_METHODS.session_delete,
    validate.zDeleteSessionRequest,
    validate.zDeleteSessionResponse,
    emptyObjectResponse,
  ),
  unstable_forkSession: requestSpec<
    schema.ForkSessionRequest,
    schema.ForkSessionResponse
  >(
    schema.AGENT_METHODS.session_fork,
    validate.zForkSessionRequest,
    validate.zForkSessionResponse,
  ),
  resumeSession: requestSpec<
    schema.ResumeSessionRequest,
    schema.ResumeSessionResponse
  >(
    schema.AGENT_METHODS.session_resume,
    validate.zResumeSessionRequest,
    validate.zResumeSessionResponse,
  ),
  closeSession: requestSpec<
    schema.CloseSessionRequest,
    schema.CloseSessionResponse | void,
    schema.CloseSessionResponse
  >(
    schema.AGENT_METHODS.session_close,
    validate.zCloseSessionRequest,
    validate.zCloseSessionResponse,
    emptyObjectResponse,
  ),
  logoutAuth: requestSpec<
    schema.LogoutAuthRequest,
    schema.LogoutAuthResponse | void,
    schema.LogoutAuthResponse
  >(
    schema.AGENT_METHODS.auth_logout,
    validate.zLogoutAuthRequest,
    validate.zLogoutAuthResponse,
    emptyObjectResponse,
  ),
  unstable_startNes: requestSpec<
    schema.StartNesRequest,
    schema.StartNesResponse
  >(
    schema.AGENT_METHODS.nes_start,
    validate.zStartNesRequest,
    validate.zStartNesResponse,
  ),
  unstable_suggestNes: requestSpec<
    schema.SuggestNesRequest,
    schema.SuggestNesResponse
  >(
    schema.AGENT_METHODS.nes_suggest,
    validate.zSuggestNesRequest,
    validate.zSuggestNesResponse,
  ),
  unstable_closeNes: requestSpec<
    schema.CloseNesRequest,
    schema.CloseNesResponse | void,
    schema.CloseNesResponse
  >(
    schema.AGENT_METHODS.nes_close,
    validate.zCloseNesRequest,
    validate.zCloseNesResponse,
    emptyObjectResponse,
  ),
};

const agentNotificationSpecs = {
  cancelSession: notificationSpec<schema.CancelSessionNotification>(
    schema.AGENT_METHODS.session_cancel,
    validate.zCancelSessionNotification,
  ),
  unstable_messageMcp: notificationSpec<schema.MessageMcpNotification>(
    schema.AGENT_METHODS.mcp_message,
    validate.zMessageMcpNotification,
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
    validate.zRequestPermissionResponse,
  ),
  unstable_connectMcp: requestSpec<
    schema.ConnectMcpRequest,
    schema.ConnectMcpResponse
  >(
    schema.CLIENT_METHODS.mcp_connect,
    validate.zConnectMcpRequest,
    validate.zConnectMcpResponse,
  ),
  unstable_messageMcp: requestSpec<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
  >(
    schema.CLIENT_METHODS.mcp_message,
    validate.zMessageMcpRequest,
    validate.zMessageMcpResponse,
  ),
  unstable_disconnectMcp: requestSpec<
    schema.DisconnectMcpRequest,
    schema.DisconnectMcpResponse | void,
    schema.DisconnectMcpResponse
  >(
    schema.CLIENT_METHODS.mcp_disconnect,
    validate.zDisconnectMcpRequest,
    validate.zDisconnectMcpResponse,
    emptyObjectResponse,
  ),
  unstable_createElicitation: requestSpec<
    schema.CreateElicitationRequest,
    schema.CreateElicitationResponse
  >(
    schema.CLIENT_METHODS.elicitation_create,
    validate.zCreateElicitationRequest,
    validate.zCreateElicitationResponse,
  ),
};

const clientNotificationSpecs = {
  sessionUpdate: notificationSpec<schema.UpdateSessionNotification>(
    schema.CLIENT_METHODS.session_update,
    validate.zUpdateSessionNotification,
  ),
  unstable_messageMcp: notificationSpec<schema.MessageMcpNotification>(
    schema.CLIENT_METHODS.mcp_message,
    validate.zMessageMcpNotification,
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
  [schema.AGENT_METHODS.auth_login]: AgentRequestHandler<
    schema.LoginAuthRequest,
    schema.LoginAuthResponse | void
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
  [schema.AGENT_METHODS.session_new]: AgentRequestHandler<
    schema.NewSessionRequest,
    schema.NewSessionResponse
  >;
  [schema.AGENT_METHODS.session_set_config_option]: AgentRequestHandler<
    schema.SetSessionConfigOptionRequest,
    schema.SetSessionConfigOptionResponse
  >;
  [schema.AGENT_METHODS.session_prompt]: AgentRequestHandler<
    schema.PromptRequest,
    schema.PromptResponse | void
  >;
  [schema.AGENT_METHODS.mcp_message]: AgentRequestHandler<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
  >;
  [schema.AGENT_METHODS.session_list]: AgentRequestHandler<
    schema.ListSessionsRequest,
    schema.ListSessionsResponse
  >;
  [schema.AGENT_METHODS.session_delete]: AgentRequestHandler<
    schema.DeleteSessionRequest,
    schema.DeleteSessionResponse | void
  >;
  [schema.AGENT_METHODS.session_fork]: AgentRequestHandler<
    schema.ForkSessionRequest,
    schema.ForkSessionResponse
  >;
  [schema.AGENT_METHODS.session_resume]: AgentRequestHandler<
    schema.ResumeSessionRequest,
    schema.ResumeSessionResponse
  >;
  [schema.AGENT_METHODS.session_close]: AgentRequestHandler<
    schema.CloseSessionRequest,
    schema.CloseSessionResponse | void
  >;
  [schema.AGENT_METHODS.auth_logout]: AgentRequestHandler<
    schema.LogoutAuthRequest,
    schema.LogoutAuthResponse | void
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
    .session_cancel]: AgentNotificationHandler<schema.CancelSessionNotification>;
  [schema.AGENT_METHODS
    .mcp_message]: AgentNotificationHandler<schema.MessageMcpNotification>;
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
  [schema.CLIENT_METHODS.mcp_connect]: ClientRequestHandler<
    schema.ConnectMcpRequest,
    schema.ConnectMcpResponse
  >;
  [schema.CLIENT_METHODS.mcp_message]: ClientRequestHandler<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
  >;
  [schema.CLIENT_METHODS.mcp_disconnect]: ClientRequestHandler<
    schema.DisconnectMcpRequest,
    schema.DisconnectMcpResponse | void
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
    .session_update]: ClientNotificationHandler<schema.UpdateSessionNotification>;
  [schema.CLIENT_METHODS
    .mcp_message]: ClientNotificationHandler<schema.MessageMcpNotification>;
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
  [
    Method in AgentNotificationMethod
  ]: AgentNotificationHandlersByMethod[Method] extends (
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
  [
    Method in ClientRequestMethod
  ]: ClientRequestHandlersByMethod[Method] extends (
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

type ActiveSessionUpdateQueue = Pick<
  ActiveSessionQueue,
  "enqueue" | "isAwaitingPromptCompletion" | "completePrompt"
>;

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

    const notification = validate.zUpdateSessionNotification.parse(
      message.params,
    );
    const { update } = notification;
    const isIdle =
      guards.SessionUpdate.isStateUpdate(update) &&
      guards.StateUpdate.isIdle(update);
    const activeSessions = this.activeSessions.get(notification.sessionId);
    if (activeSessions && activeSessions.size > 0) {
      for (const session of activeSessions) {
        if (isIdle && session.isAwaitingPromptCompletion()) {
          session.completePrompt();
          session.enqueue({
            kind: "stop",
            notification,
            update,
            stopReason: update.stopReason,
          });
        } else {
          session.enqueue({
            kind: "session_update",
            notification,
            update,
          });
        }
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
 * Creates an agent-side app for the experimental draft ACP v2 API.
 *
 * Register request and notification handlers by ACP method name, then call
 * `connect(stream)` to serve an ACP client.
 *
 * @experimental
 */
export function agent(options?: AppOptions): AgentApp {
  return new AgentApp(options);
}

/**
 * Agent-side app builder for the experimental draft ACP v2 API.
 *
 * Methods on this class register typed request or notification handlers and
 * return `this`, so apps can be built with a fluent chain. Handler params are
 * parsed with the generated ACP schemas before your handler runs, and thrown
 * errors are converted to JSON-RPC errors by the connection layer.
 *
 * @experimental
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
    method: ExtensionMethod,
    params: ParamsParser<Params>,
    handler: AgentRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
    params: ParamsParser<Params>,
    handler: AgentRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response>(
    method: string,
    handlerOrParams:
      AgentRequestHandlersByMethod[AgentRequestMethod] | ParamsParser<Params>,
    handler?: AgentRequestHandler<Params, Response>,
  ): this {
    if (handler) {
      assertUnrecognizedV2Method(method, "request");
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
    method: ExtensionMethod,
    params: ParamsParser<Params>,
    handler: AgentNotificationHandler<Params>,
  ): this;
  onNotification<Params, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
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
      assertUnrecognizedV2Method(method, "notification");
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
 * Creates a client-side app for the experimental draft ACP v2 API.
 *
 * Register request and notification handlers by ACP method name, then use
 * `connectWith(...)` to run the workflow that calls agent-side methods.
 *
 * @experimental
 */
export function client(options?: AppOptions): ClientApp {
  return new ClientApp(options);
}

/**
 * Client-side app builder for the experimental draft ACP v2 API.
 *
 * Methods on this class register typed client handlers and return `this`, so
 * apps can be built with a fluent chain. `connectWith(...)` is the usual entry
 * point for clients because it provides a `ClientContext` for calling
 * agent-side requests and session helpers.
 *
 * @experimental
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
    method: ExtensionMethod,
    params: ParamsParser<Params>,
    handler: ClientRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
    params: ParamsParser<Params>,
    handler: ClientRequestHandler<Params, Response>,
  ): this;
  onRequest<Params, Response>(
    method: string,
    handlerOrParams:
      ClientRequestHandlersByMethod[ClientRequestMethod] | ParamsParser<Params>,
    handler?: ClientRequestHandler<Params, Response>,
  ): this {
    if (handler) {
      assertUnrecognizedV2Method(method, "request");
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
    method: ExtensionMethod,
    params: ParamsParser<Params>,
    handler: ClientNotificationHandler<Params>,
  ): this;
  onNotification<Params, const Method extends string = never>(
    method: UnrecognizedMethod<Method>,
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
      assertUnrecognizedV2Method(method, "notification");
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
