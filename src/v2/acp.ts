/**
 * Experimental TypeScript API for the draft ACP v2 protocol.
 *
 * @remarks
 * ACP v2 is still a draft. Its wire protocol and this API may change
 * incompatibly in any SDK release. The stable package entry point remains ACP
 * v1. The stable-feature set of the v2 draft is available through
 * `@agentclientprotocol/sdk/experimental/v2`; additional unstable protocol
 * features require `@agentclientprotocol/sdk/experimental/v2/unstable`.
 * Both entrypoints remain experimental.
 *
 * Session state updates are aggregate snapshots, not per-prompt completions.
 * Apply repeated snapshots idempotently; a repeated idle stop reason is not a
 * new completion, cancellation, or usage report. Every successful
 * `session/resume` sends a current-state snapshot after replay and before its
 * response, including when replay was not requested. The response does not
 * imply idle. Agents may send live traffic after initialization even when no
 * client request is pending.
 *
 * Top-level `_meta` on upsert updates patches stored metadata by key: omission
 * leaves it unchanged, `null` clears it, null-valued keys are removed, and other
 * values replace their key whole without nested merging. An empty object does
 * nothing. Replay uses the same rule. Metadata on chunks, content items,
 * snapshots, and `plan_update` is not an entity patch.
 *
 * Experimental operations follow their advertised capabilities; local schema
 * selection does not establish peer support. When opting into unstable
 * lifecycle `systemPrompt` instructions, only send them when the agent
 * advertises `session.systemPrompt`, and only use `override` when its
 * `mode.override` capability is advertised.
 *
 * @packageDocumentation
 * @experimental
 */

import * as schema from "./unstable/schema/index.js";
import * as validate from "./unstable/schema/zod.gen.js";
import * as guards from "./unstable/schema/guards.gen.js";
import { ndJsonStream as createJsonStream } from "../core/stream.js";
import type { NdJsonStreamOptions } from "../core/stream.js";
import {
  parseParams,
  registerAppNotification,
  registerAppRequest,
} from "../core/app-handlers.js";
import type { ParamsParser } from "../core/app-handlers.js";
export type { ParamsParser } from "../core/app-handlers.js";
export type * from "./unstable/schema/types.gen.js";
// Runtime narrowing helpers for extensible unions, exposed as companion values
// that merge (declaration merging) with the like-named types — e.g.
// `CreateElicitationResponse.isAccept(response)`. See schema/guards.gen.ts.
//
// Listed explicitly (not `export *`) so each value+type pair merges rather than
// colliding with the `export type *` above. The guards.gen re-export test
// asserts this list stays in sync as new extensible unions are added.
export {
  AuthMethod,
  AvailableCommand,
  AvailableCommandInput,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DiffChange,
  ElicitationPropertySchema,
  IdleStateUpdate,
  McpServer,
  MultiSelectItems,
  PlanUpdateContent,
  ReplayFrom,
  RequestPermissionOutcome,
  RequestPermissionSubject,
  SessionConfigOption,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  StateUpdate,
  ToolCallContent,
} from "./unstable/schema/guards.gen.js";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from "./unstable/schema/index.js";

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
  options?: NdJsonStreamOptions,
): Stream {
  return createJsonStream<AnyWireMessage>(output, input, options);
}

export { RequestError } from "../core/jsonrpc.js";
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageTooLargeError,
} from "../core/stream-limits.js";
export type { NdJsonStreamOptions } from "../core/stream.js";
export {
  AgentProtocolRouter,
  agentProtocolRouter,
} from "../protocol-router.js";
export type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "../transports/connection.js";
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
} from "../core/jsonrpc.js";

import {
  batchNotification as jsonRpcBatchNotification,
  batchRequest as jsonRpcBatchRequest,
  Connection,
  Handled,
  HandlerRegistration,
  isV2RequestId,
  requestBatchSize,
  RequestError,
  respondWithNullId,
} from "../core/jsonrpc.js";
import { connectionContextOf } from "../core/connection-access.js";
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
} from "../core/jsonrpc.js";

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

/**
 * Client info substituted when an `initialize` request written for a newer
 * protocol version has a missing or malformed `info`.
 */
const UNKNOWN_IMPLEMENTATION: schema.Implementation = {
  name: "unknown",
  version: "unknown",
};

function readInitializeProtocolVersion(
  params: unknown,
): schema.ProtocolVersion {
  return received<schema.ProtocolVersion>(validate.zProtocolVersion).parse(
    isPlainObject(params) ? params["protocolVersion"] : undefined,
  );
}

function parseV2InitializeRequest(params: unknown): schema.InitializeRequest {
  const protocolVersion = readInitializeProtocolVersion(params);
  if (protocolVersion < schema.PROTOCOL_VERSION) {
    throw RequestError.unsupportedProtocolVersion(protocolVersion, [
      schema.PROTOCOL_VERSION,
    ]);
  }
  // A request for a newer version was written for a schema this endpoint does
  // not know, so keep whatever parses under v2 instead of rejecting it.
  // Capabilities and `_meta` already drop malformed values field by field;
  // only the required `info` needs a substitute.
  const lenient =
    protocolVersion > schema.PROTOCOL_VERSION && isPlainObject(params);
  const request = received<schema.InitializeRequest>(
    validate.zInitializeRequest,
  ).parse(
    lenient && !validate.zImplementation.safeParse(params["info"]).success
      ? { ...params, info: UNKNOWN_IMPLEMENTATION }
      : params,
  );
  return structuredClone({
    ...request,
    protocolVersion: schema.PROTOCOL_VERSION,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOutgoingV2InitializeRequest(params: unknown): {
  wire: schema.InitializeRequest;
  parsed: schema.InitializeRequest;
} {
  const request =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const outgoing = {
    ...request,
    protocolVersion: schema.PROTOCOL_VERSION,
  };
  // Parsing supplies a validated local view, not the payload to transmit.
  // In particular, Zod strips future capability fields from that view.
  const parsed = parseV2InitializeRequest(outgoing);
  return {
    wire: structuredClone(outgoing) as schema.InitializeRequest,
    parsed,
  };
}

function mapV2InitializeResponse(response: unknown): schema.InitializeResponse {
  const parsed = received<schema.InitializeResponse>(
    validate.zInitializeResponse,
  ).parse(response);
  if (parsed.protocolVersion !== schema.PROTOCOL_VERSION) {
    throw RequestError.invalidRequest(
      {
        expectedProtocolVersion: schema.PROTOCOL_VERSION,
        receivedProtocolVersion: parsed.protocolVersion,
      },
      `The v2 API only supports protocol version ${schema.PROTOCOL_VERSION}`,
    );
  }
  return structuredClone(parsed);
}

function serializeV2InitializeResponse(
  response: schema.InitializeResponse,
): schema.InitializeResponse {
  // Keep validation separate from serialization, as for outgoing requests.
  mapV2InitializeResponse(response);
  return structuredClone(response);
}

/**
 * Validated initialize request and response for one ACP v2 connection.
 *
 * The snapshot becomes available only after the initialize response has been
 * validated and sent or received successfully. When the Client repeats
 * `initialize`, the latest successful exchange replaces the snapshot.
 *
 * @experimental
 */
export type InitializationSnapshot = Readonly<{
  request: schema.InitializeRequest;
  response: schema.InitializeResponse;
}>;

type InitializationPhase =
  "uninitialized" | "initializing" | "initialized" | "failed";

function cloneInitialization(
  initialization: InitializationSnapshot,
): InitializationSnapshot {
  return structuredClone(initialization);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Initialization lifecycle of one ACP v2 connection side.
 *
 * The Client may repeat `initialize` after a previous one completed, as long
 * as it has not sent any other request. A repeat that fails leaves the
 * previous initialization in effect.
 */
class InitializationState {
  private phase: InitializationPhase = "uninitialized";
  private request?: schema.InitializeRequest;
  private snapshot?: InitializationSnapshot;
  private otherRequestSeen = false;
  private attempt = deferred<void>();
  private readonly barrier = deferred<InitializationSnapshot>();

  constructor() {
    void this.barrier.promise.catch(() => {});
    this.attempt.resolve();
  }

  get status(): InitializationPhase {
    return this.phase;
  }

  get initialized(): Promise<InitializationSnapshot> {
    return this.barrier.promise
      .then(() => this.attempt.promise)
      .then(() => cloneInitialization(this.snapshot!));
  }

  /**
   * Returns why `initialize` cannot start now, or `undefined` if it can.
   */
  beginError(): RequestError | undefined {
    if (this.phase === "initializing") {
      return RequestError.invalidRequest(
        "ACP v2 initialize is already in progress",
      );
    }
    if (this.phase === "failed") {
      return RequestError.invalidRequest(
        "ACP v2 connection initialization failed",
      );
    }
    if (this.phase === "initialized" && this.otherRequestSeen) {
      return RequestError.invalidRequest(
        "ACP v2 initialize must not be repeated after other requests",
      );
    }
    return undefined;
  }

  begin(request: schema.InitializeRequest): void {
    const error = this.beginError();
    if (error) {
      throw error;
    }

    const requestSnapshot = structuredClone(request);
    this.request = requestSnapshot;
    this.phase = "initializing";
    this.attempt = deferred<void>();
  }

  complete(response: schema.InitializeResponse): void {
    if (this.phase !== "initializing" || !this.request) {
      throw RequestError.invalidRequest(
        "ACP v2 initialization is not in progress",
      );
    }

    const initialization = {
      request: structuredClone(this.request),
      response: structuredClone(response),
    };
    this.snapshot = initialization;
    this.request = undefined;
    this.phase = "initialized";
    this.barrier.resolve(initialization);
    this.attempt.resolve();
  }

  /**
   * Fails the initialize attempt in progress, or the connection before it has
   * been initialized. A failed repeat keeps the previous initialization.
   */
  fail(error?: unknown): void {
    if (this.phase === "initializing" && this.snapshot) {
      this.phase = "initialized";
      this.request = undefined;
      this.attempt.resolve();
      return;
    }
    if (this.phase === "uninitialized" || this.phase === "initializing") {
      this.phase = "failed";
      this.request = undefined;
      this.barrier.reject(
        error ??
          RequestError.invalidRequest(
            "ACP v2 connection initialization failed",
          ),
      );
      this.attempt.resolve();
    }
  }

  /**
   * Records a request other than `initialize`, after which `initialize` may
   * no longer be repeated.
   */
  noteRequest(): void {
    if (this.phase === "initializing" || this.phase === "initialized") {
      this.otherRequestSeen = true;
    }
  }

  waitUntilInitialized(method: string): Promise<void> {
    if (this.phase === "initialized") {
      return Promise.resolve();
    }
    if (this.phase === "initializing") {
      return this.snapshot
        ? this.attempt.promise.then(() => this.waitUntilInitialized(method))
        : this.barrier.promise.then(() => {});
    }
    return Promise.reject(initializationUnavailable(method));
  }
}

const initializationStates = new WeakMap<
  ConnectionContext,
  InitializationState
>();

function initializationState(cx: ConnectionContext): InitializationState {
  let state = initializationStates.get(cx);
  if (!state) {
    state = new InitializationState();
    initializationStates.set(cx, state);
    if (cx.signal.aborted) {
      state.fail(cx.signal.reason);
    } else {
      cx.signal.addEventListener("abort", () => state?.fail(cx.signal.reason), {
        once: true,
      });
    }
  }
  return state;
}

function initializationUnavailable(method: string): RequestError {
  return RequestError.invalidRequest(
    `ACP v2 connection must be initialized before '${method}'`,
  );
}

async function blockUninitializedIncoming(
  message: IncomingMessage,
  state: InitializationState,
): Promise<HandleResult> {
  const error = initializationUnavailable(message.method);
  state.fail(error);
  return rejectIncoming(message, error);
}

async function rejectIncoming(
  message: IncomingMessage,
  error: RequestError,
): Promise<HandleResult> {
  if (message.kind === "request") {
    await message.responder.respondWithError(error);
  }
  return Handled.yes();
}

/**
 * Rejects requests whose ID is `null` or a non-integer number, which ACP v2
 * does not allow. The error response uses `id: null` because the request ID
 * is unusable.
 */
async function rejectInvalidRequestId(
  message: IncomingMessage,
): Promise<HandleResult | undefined> {
  if (message.kind !== "request" || isV2RequestId(message.raw.id)) {
    return undefined;
  }
  await respondWithNullId(
    message.responder,
    RequestError.invalidRequest(
      undefined,
      "ACP v2 request IDs must be strings or integers",
    ),
  );
  return Handled.yes();
}

async function waitUntilInitializedIncoming(
  message: IncomingMessage,
  state: InitializationState,
): Promise<HandleResult> {
  if (state.status === "initialized") {
    return Handled.no(message);
  }
  if (state.status === "initializing") {
    await state.waitUntilInitialized(message.method);
    return Handled.no(message);
  }
  return blockUninitializedIncoming(message, state);
}

function agentInitializationGuard(): JsonRpcHandler {
  return {
    async handleMessage(message, cx) {
      const invalidId = await rejectInvalidRequestId(message);
      if (invalidId) {
        return invalidId;
      }

      const state = initializationState(cx);
      if (message.kind === "notification") {
        if (message.method === schema.PROTOCOL_METHODS.cancel_request) {
          return state.status === "initializing" ||
            state.status === "initialized"
            ? Handled.yes()
            : blockUninitializedIncoming(message, state);
        }
        return waitUntilInitializedIncoming(message, state);
      }

      if (message.method === schema.AGENT_METHODS.initialize) {
        // The Client may repeat initialize after the previous one completed
        // and before any other request. A repeat that fails leaves the
        // previous initialization in effect.
        const beginError = state.beginError();
        if (beginError) {
          return rejectIncoming(message, beginError);
        }
        const batchSize = requestBatchSize(message.responder);
        if (batchSize !== undefined && batchSize !== 1) {
          const error = RequestError.invalidRequest(
            "ACP v2 initialize must be the only entry in its batch",
          );
          state.fail(error);
          return rejectIncoming(message, error);
        }

        let request: schema.InitializeRequest;
        try {
          if (
            state.status === "initialized" &&
            readInitializeProtocolVersion(message.params) <
              schema.PROTOCOL_VERSION
          ) {
            // A repeat must use the version the previous response selected.
            return rejectIncoming(
              message,
              RequestError.invalidRequest(
                undefined,
                `a repeated initialize must request protocol version ${schema.PROTOCOL_VERSION} or later`,
              ),
            );
          }
          request = parseV2InitializeRequest(message.params);
        } catch (error) {
          state.fail(error);
          throw error;
        }
        state.begin(request);
        return Handled.no(message);
      }

      // Requests other than initialize must not wait for an in-flight
      // initialize: the spec requires rejecting them until it completes.
      if (state.status === "initialized") {
        state.noteRequest();
        return Handled.no(message);
      }
      if (state.status === "initializing") {
        return rejectIncoming(
          message,
          initializationUnavailable(message.method),
        );
      }
      return blockUninitializedIncoming(message, state);
    },
    describe: () => "agent-initialization",
  };
}

function clientInitializationGuard(): JsonRpcHandler {
  return {
    async handleMessage(message, cx) {
      const invalidId = await rejectInvalidRequestId(message);
      if (invalidId) {
        return invalidId;
      }

      const state = initializationState(cx);
      if (
        message.kind === "notification" &&
        message.method === schema.PROTOCOL_METHODS.cancel_request
      ) {
        return state.status === "initializing" || state.status === "initialized"
          ? Handled.yes()
          : blockUninitializedIncoming(message, state);
      }
      return waitUntilInitializedIncoming(message, state);
    },
    describe: () => "client-initialization",
  };
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
  onInitializeResponse?: (response: schema.InitializeResponse) => void,
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
      mapResponse: spec
        ? (response: unknown) => {
            const parsed = parseRequestResponse(spec, response);
            if (
              onInitializeResponse &&
              entry.method === schema.AGENT_METHODS.initialize
            ) {
              onInitializeResponse(parsed as schema.InitializeResponse);
            }
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

type McpTransportCapability = Exclude<keyof schema.McpCapabilities, "_meta">;

// Transport keys of `session.mcp`: `stdio` and `http`, plus `acp` with the
// unstable schema. Read from the schema so each entrypoint checks only the
// transports its own `McpCapabilities` type can advertise.
const MCP_TRANSPORT_CAPABILITIES: ReadonlyArray<string> = Object.keys(
  validate.zMcpCapabilities.shape,
).filter((key) => key !== "_meta");

/**
 * Throws `-32602` (Invalid params) for the first MCP server whose transport the
 * agent did not advertise in `session.mcp`.
 *
 * Call it from `session/new`, `session/resume`, or `session/fork` handlers with
 * the `capabilities.session.mcp` value the agent sent in its `initialize`
 * response. A server is accepted only when its `type` is a transport key in
 * that object with a non-null value, for example `stdio` with
 * `{ stdio: {} }`. Everything else is rejected, including v1's `sse`, unknown
 * types, and custom `_`-prefixed types; agents that support a custom
 * transport should handle those servers before calling this. The error data is
 * `{ type }` with the rejected server's transport.
 *
 * @experimental
 */
export function assertSupportedMcpServers(
  mcpServers: ReadonlyArray<schema.McpServer> | null | undefined,
  capabilities: schema.McpCapabilities | null | undefined,
): void {
  for (const server of mcpServers ?? []) {
    const { type } = server;
    if (
      !MCP_TRANSPORT_CAPABILITIES.includes(type) ||
      capabilities?.[type as McpTransportCapability] == null
    ) {
      throw RequestError.invalidParams(
        { type },
        `Unsupported MCP server transport ${type}`,
      );
    }
  }
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
  },
  client: {
    session: {
      requestPermission: schema.CLIENT_METHODS.session_request_permission,
      update: schema.CLIENT_METHODS.session_update,
    },
    mcp: {
      message: schema.CLIENT_METHODS.mcp_message,
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
const routeActiveSessionUpdate = Symbol("routeActiveSessionUpdate");

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
   * Resolves with the validated initialize exchange once initialization
   * succeeds, or rejects if initialization or the connection fails.
   *
   * After a repeated `initialize` completes, reading this again resolves with
   * the latest exchange.
   */
  readonly initialized: Promise<InitializationSnapshot>;

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
   * Validated initialize exchange, once this connection is initialized.
   */
  get initialized(): Promise<InitializationSnapshot> {
    return initializationState(this.cx).initialized;
  }

  /** @internal */
  protected get initializationLifecycle(): InitializationState {
    return initializationState(this.cx);
  }

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

  /** @hidden SDK helpers use this to identify the connection. */
  [connectionContextOf](): ConnectionContext {
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
    return this.initializationLifecycle
      .waitUntilInitialized(method)
      .then(() =>
        this.sendRequest(
          method,
          params,
          spec ? (response) => parseRequestResponse(spec, response) : undefined,
          options,
        ),
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
    return this.initializationLifecycle
      .waitUntilInitialized(method)
      .then(() => this.sendNotification(method, params));
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
    return this.initializationLifecycle
      .waitUntilInitialized("batch")
      .then(() =>
        this.sendBatch(normalizeV2Batch(entries, clientRequestSpecsByMethod)),
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
  private constructor(
    cx: ConnectionContext,
    requestId?: JsonRpcId,
    private readonly closeOnInitializationFailure?: (error: unknown) => void,
  ) {
    super(cx, requestId);
  }

  /** @internal */
  static create(
    cx: ConnectionContext,
    requestId?: JsonRpcId,
    closeOnInitializationFailure?: (error: unknown) => void,
  ): ClientContext {
    return new ClientContext(cx, requestId, closeOnInitializationFailure);
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
    const closeSignal = this.connectionContext.signal;
    const failUpdatesOnClose = () => {
      updates.fail(closeSignal.reason ?? new Error("ACP connection closed"));
    };
    if (closeSignal.aborted) {
      failUpdatesOnClose();
    } else {
      closeSignal.addEventListener("abort", failUpdatesOnClose);
    }
    const registrations: HandlerRegistration[] = [];
    const session = ActiveSession.create(
      this,
      response,
      updates,
      registrations,
    );
    registrations.push(
      sessionUpdateRouter(this.connectionContext).attach(response, {
        enqueue: (message) => session[routeActiveSessionUpdate](message),
      }),
      new HandlerRegistration(() => {
        closeSignal.removeEventListener("abort", failUpdatesOnClose);
      }),
    );

    return session;
  }

  /**
   * Sends a request to the agent by ACP method name.
   *
   * Built-in method literals infer their params and response types. Custom
   * methods can specify their response and params types with generics.
   *
   * Other requests wait until `initialize` has completed. `initialize` may be
   * repeated once the previous one completed and before any other request has
   * been sent; otherwise it throws `-32600` synchronously. A repeat that fails
   * leaves the previous initialization in effect.
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
    const state = this.initializationLifecycle;
    if (method === schema.AGENT_METHODS.initialize) {
      const { wire: request, parsed } =
        normalizeOutgoingV2InitializeRequest(params);
      state.begin(parsed);

      let response: Promise<unknown>;
      try {
        response = this.sendRequest(
          method,
          request,
          (value) => {
            const parsed = parseRequestResponse(spec!, value);
            state.complete(parsed as schema.InitializeResponse);
            return parsed;
          },
          options,
        );
      } catch (error) {
        this.failInitialization(error);
        throw error;
      }
      void response.catch((error) => {
        if (state.status !== "initialized") {
          this.failInitialization(error);
        }
      });
      return response;
    }

    state.noteRequest();
    return state
      .waitUntilInitialized(method)
      .then(() =>
        this.sendRequest(
          method,
          params,
          spec ? (response) => parseRequestResponse(spec, response) : undefined,
          options,
        ),
      );
  }

  /**
   * Fails an initialize attempt. Closes the connection unless a previous
   * initialization remains in effect.
   */
  private failInitialization(error: unknown): void {
    const state = this.initializationLifecycle;
    state.fail(error);
    if (state.status === "failed") {
      this.closeOnInitializationFailure?.(error);
    }
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
    return this.initializationLifecycle
      .waitUntilInitialized(method)
      .then(() => this.sendNotification(method, params));
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
    const initializeEntries = entries.filter(
      (entry) =>
        entry.kind === "request" &&
        entry.method === schema.AGENT_METHODS.initialize,
    );
    if (initializeEntries.length > 0) {
      if (entries.length !== 1 || initializeEntries.length !== 1) {
        return Promise.reject(
          RequestError.invalidRequest(
            "ACP v2 initialize must be the only entry in its batch",
          ),
        );
      }

      const state = this.initializationLifecycle;
      const { wire: request, parsed } = normalizeOutgoingV2InitializeRequest(
        initializeEntries[0].params,
      );
      state.begin(parsed);
      const normalizedEntries = [
        { ...initializeEntries[0], params: request },
      ] as unknown as Entries & { readonly 0: BatchEntry };

      let response: Promise<BatchOutputs<Entries>>;
      try {
        response = this.sendBatch(
          normalizeV2Batch(
            normalizedEntries,
            agentRequestSpecsByMethod,
            (value) => state.complete(value),
          ),
        );
      } catch (error) {
        this.failInitialization(error);
        throw error;
      }
      void response.catch((error) => {
        if (state.status !== "initialized") {
          this.failInitialization(error);
        }
      });
      return response;
    }

    if (entries.some((entry) => entry.kind === "request")) {
      this.initializationLifecycle.noteRequest();
    }
    return this.initializationLifecycle
      .waitUntilInitialized("batch")
      .then(() =>
        this.sendBatch(normalizeV2Batch(entries, agentRequestSpecsByMethod)),
      );
  }
}

class AcpConnectionHandle implements AcpConnection {
  constructor(private readonly connection: Connection) {}

  get initialized(): Promise<InitializationSnapshot> {
    return initializationState(this.connection.getContext()).initialized;
  }

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
    this.agent = ClientContext.create(
      connection.getContext(),
      undefined,
      (error) => connection.close(error),
    );
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

class AsyncQueue<T> {
  private values: Array<T> = [];
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
      this.values.push(value);
    }
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
      return Promise.resolve(this.values.shift() as T);
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

/**
 * Experimental draft ACP v2 `session/set_config_option` params for
 * `ActiveSession.setConfigOption(...)`; the session ID is filled in.
 *
 * @experimental
 */
export type ActiveSessionSetConfigOptionRequest =
  schema.SetSessionConfigOptionRequest extends infer Request
    ? Request extends unknown
      ? {
          [
            Key in keyof Request as Key extends "sessionId" ? never : Key
          ]: Request[Key];
        }
      : never
    : never;

type ActiveSessionQueue = Pick<
  AsyncQueue<ActiveSessionMessage>,
  "enqueue" | "fail" | "next"
>;

/**
 * Experimental draft ACP v2 message produced by an `ActiveSession`.
 *
 * `session_update` messages expose the typed `session/update` notification and
 * `stop` messages report an idle `state_update`. Both are session-scoped:
 * a `stop` message does not acknowledge processing or completion of any prompt.
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
       * Indicates an idle foreground snapshot, not necessarily a new completion.
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
      stopReason: schema.IdleStateUpdate["stopReason"];
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
 * into an async queue. Use `prompt(...)` to submit user content and
 * `nextUpdate()` to observe the session independently of prompt requests.
 * A `stop` message reports idle foreground work, not per-prompt completion.
 *
 * @experimental
 */
export class ActiveSession {
  private currentConfigOptions: Array<schema.SessionConfigOption> | undefined;

  private constructor(
    private cx: ClientContext,
    private sessionResponse: schema.NewSessionResponse,
    private updates: ActiveSessionQueue,
    private registrations: HandlerRegistration[],
  ) {
    this.currentConfigOptions = sessionResponse.configOptions ?? undefined;
  }

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
   * Current configuration options for this session, if the agent provided any.
   *
   * Starts with the `configOptions` from `session/new`. It is replaced with the
   * full list from each `config_option_update` routed to this session (applied
   * when the notification arrives, before it is read with `nextUpdate()`) and
   * from each `setConfigOption(...)` response. Updates stop after `dispose()`.
   * `newSessionResponse.configOptions` keeps the original `session/new` value.
   */
  get configOptions(): Array<schema.SessionConfigOption> | undefined {
    return this.currentConfigOptions;
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
   * wrapped in an array. The returned promise resolves with the inserted user
   * message's ID once the agent inserts it into the ACP conversation, not when
   * processing finishes. Session updates remain independent of this request;
   * an idle `state_update` does not establish that this message was processed.
   * Rejection is reported only by this promise, not by the session update queue.
   */
  prompt(
    prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
    options?: SendRequestOptions,
  ): Promise<schema.PromptResponse> {
    return this.cx.request(
      schema.AGENT_METHODS.session_prompt,
      {
        sessionId: this.sessionId,
        prompt: this.promptBlocks(prompt),
      },
      options,
    );
  }

  /**
   * Sets a configuration option for this session with
   * `session/set_config_option`.
   *
   * The response carries the agent's complete `configOptions` list, which
   * replaces `configOptions` on this session. For example,
   * `session.setConfigOption({ configId: "model", type: "id", value: "fast" })`.
   */
  async setConfigOption(
    request: ActiveSessionSetConfigOptionRequest,
    options?: SendRequestOptions,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    const response = await this.cx.request(
      schema.AGENT_METHODS.session_set_config_option,
      { ...request, sessionId: this.sessionId },
      options,
    );
    this.currentConfigOptions = response.configOptions;
    return response;
  }

  /**
   * Reads the next update or stop message for this session.
   *
   * Idle updates are always returned as `stop` messages, whether or not a prompt
   * is pending. Queued updates are consumed in arrival order. An abort signal
   * cancels this read without cancelling session work or discarding updates.
   */
  nextUpdate(signal?: AbortSignal): Promise<ActiveSessionMessage> {
    return this.updates.next(signal);
  }

  /**
   * Collects agent text from the session queue until the next idle update.
   *
   * This consumes the same queue as `nextUpdate()`, including already queued
   * updates. It does not associate output or idle with any submitted prompt,
   * skip updates when a prompt is sent, or wait for a prompt to be inserted.
   * Use one reader at a time to avoid splitting the session's updates.
   * An abort signal cancels the read without cancelling session work.
   *
   * Full `agent_message` updates replace content for their `messageId`, while
   * `agent_message_chunk` updates append to it. Non-text content and other
   * update types are ignored; use `nextUpdate()` when you need them.
   */
  async readTextUntilIdle(signal?: AbortSignal): Promise<string> {
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
      const message = await this.nextUpdate(signal);
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

  /** @internal */
  [routeActiveSessionUpdate](message: ActiveSessionMessage): void {
    if (guards.SessionUpdate.isConfigOptionUpdate(message.update)) {
      this.currentConfigOptions = message.update.configOptions;
    }
    this.updates.enqueue(message);
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

/**
 * A generated validator as the parser of received values.
 *
 * The validators type the tag of an unknown variant as a plain string, while
 * the protocol types brand it as an `UnknownVariant`, which only received
 * values have. Everything a validator parses is received, so its output has
 * the protocol type.
 */
function received<T>(validator: { parse(value: unknown): unknown }): {
  parse(value: unknown): T;
} {
  return validator as { parse(value: unknown): T };
}

function requestSpec<Params, HandlerResponse, Response = HandlerResponse>(
  method: string,
  params: ParamsParser<Params>,
  response: ParamsParser<Response>,
  serializeResponse?: (response: HandlerResponse) => Response,
): AcpRequestSpec<Params, HandlerResponse, Response> {
  return {
    method,
    // Match Rust's empty-payload handling without bypassing required fields.
    params: (value) => parseParams(params, value ?? {}),
    response,
    serializeResponse,
  };
}

function notificationSpec<Params>(
  method: string,
  params: ParamsParser<Params>,
): AcpNotificationSpec<Params> {
  return { method, params };
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
    serializeV2InitializeResponse,
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
    received(validate.zNewSessionRequest),
    received(validate.zNewSessionResponse),
  ),
  setSessionConfigOption: requestSpec<
    schema.SetSessionConfigOptionRequest,
    schema.SetSessionConfigOptionResponse
  >(
    schema.AGENT_METHODS.session_set_config_option,
    received(validate.zSetSessionConfigOptionRequest),
    received(validate.zSetSessionConfigOptionResponse),
  ),
  prompt: requestSpec<schema.PromptRequest, schema.PromptResponse>(
    schema.AGENT_METHODS.session_prompt,
    received(validate.zPromptRequest),
    received(validate.zPromptResponse),
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
    received(validate.zForkSessionRequest),
    received(validate.zForkSessionResponse),
  ),
  resumeSession: requestSpec<
    schema.ResumeSessionRequest,
    schema.ResumeSessionResponse
  >(
    schema.AGENT_METHODS.session_resume,
    received(validate.zResumeSessionRequest),
    received(validate.zResumeSessionResponse),
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
};

const clientRequestSpecs = {
  requestPermission: requestSpec<
    schema.RequestPermissionRequest,
    schema.RequestPermissionResponse
  >(
    schema.CLIENT_METHODS.session_request_permission,
    received(validate.zRequestPermissionRequest),
    received(validate.zRequestPermissionResponse),
  ),
  unstable_messageMcp: requestSpec<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
  >(
    schema.CLIENT_METHODS.mcp_message,
    validate.zMessageMcpRequest,
    validate.zMessageMcpResponse,
  ),
  createElicitation: requestSpec<
    schema.CreateElicitationRequest,
    schema.CreateElicitationResponse
  >(
    schema.CLIENT_METHODS.elicitation_create,
    received(validate.zCreateElicitationRequest),
    received(validate.zCreateElicitationResponse),
  ),
};

const clientNotificationSpecs = {
  sessionUpdate: notificationSpec<schema.UpdateSessionNotification>(
    schema.CLIENT_METHODS.session_update,
    received(validate.zUpdateSessionNotification),
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
  /**
   * Handles `initialize`.
   *
   * Runs again for each repeated `initialize`, which the Client may send after
   * a previous one completed and before any other request; the latest
   * successful exchange is authoritative. Other requests that arrive while
   * `initialize` is in flight are rejected with `-32600`.
   *
   * When the Client requests a newer protocol version than v2, params that do
   * not parse under v2 are dropped instead of rejected, and a missing or
   * malformed `info` is replaced with `{ name: "unknown", version: "unknown" }`.
   */
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
    schema.PromptResponse
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
  [schema.CLIENT_METHODS.mcp_message]: ClientRequestHandler<
    schema.MessageMcpRequest,
    schema.MessageMcpResponse
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

type ActiveSessionUpdateQueue = Pick<ActiveSessionQueue, "enqueue">;

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

    const notification = received<schema.UpdateSessionNotification>(
      validate.zUpdateSessionNotification,
    ).parse(message.params);
    const { update } = notification;
    const isIdle =
      guards.SessionUpdate.isStateUpdate(update) &&
      guards.StateUpdate.isIdle(update);
    const activeSessions = this.activeSessions.get(notification.sessionId);
    if (activeSessions && activeSessions.size > 0) {
      for (const session of activeSessions) {
        if (isIdle) {
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

function bridgeConnectionClose(source: Connection, peer: AcpConnection): void {
  void source.closed.then(async () => {
    if (initializationState(source.getContext()).status === "initialized") {
      await peer.initialized.catch(() => {});
    }
    peer.close(source.signal.reason);
  });
}

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
  private readonly fallbackKinds = new Set<"request" | "notification">();
  private hasInitializeHandler = false;

  constructor(options: AppOptions = {}) {
    this.builder.withHandler(agentInitializationGuard());
    if (options.name) {
      this.builder.name(options.name);
    }
  }

  /** @internal */
  [appBuilder](): ConnectionBuilder {
    this.assertInitializeHandler();
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
   * state that the request handlers use. Requests and notifications sent
   * through `connection.client` wait until `initialize` has completed.
   *
   * Handlers are called synchronously in registration order and are not
   * awaited. A handler that throws or rejects closes the connection. When they
   * are called depends on who opens the connection:
   *
   * - `connect(...)` and `connectWith(...)` call them before the connection
   *   handles its first inbound message, and so does
   *   {@link AgentProtocolRouter.connect} when it routes to this app. Only the
   *   work a handler does before its first `await` is guaranteed to come first.
   * - The experimental `AcpServer` calls them after the client has completed
   *   `initialize`. Request handlers, including `initialize`, can run before
   *   them.
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

    if (method === schema.AGENT_METHODS.initialize) {
      this.hasInitializeHandler = true;
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
   *
   * Handlers start in the order notifications arrive, but the connection does
   * not wait for an async handler to settle before dispatching the next
   * message, so async handlers can run concurrently. Serialize work yourself
   * when its effects must be applied in order.
   */
  onNotification(method: "*", handler: AgentNotificationHandler<unknown>): this;
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
      (params, cx, signal, requestId, method) =>
        agentRequestContext(
          params,
          AgentContext.create(cx, requestId),
          signal,
          requestId,
          method,
        ),
      handler,
      spec.serializeResponse,
      spec.method === schema.AGENT_METHODS.initialize
        ? {
            beforeResponse: (_params, response, cx) => {
              initializationState(cx).complete(
                mapV2InitializeResponse(response),
              );
            },
            onError: (cx, error) => initializationState(cx).fail(error),
          }
        : undefined,
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
    target: Stream | ClientApp,
    options: AppConnectOptions = {},
  ): AgentConnectionState {
    this.assertInitializeHandler();
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
    bridgeConnectionClose(state.rawConnection, peerConnection);
    bridgeConnectionClose(peerRawConnection, state.connection);
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

  private assertInitializeHandler(): void {
    if (!this.hasInitializeHandler) {
      throw new Error(
        "AgentApp requires an initialize request handler before connecting",
      );
    }
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
  private readonly fallbackKinds = new Set<"request" | "notification">();

  constructor(options: AppOptions = {}) {
    if (options.name) {
      this.builder.name(options.name);
    }
    this.builder.withHandler(clientInitializationGuard());
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
   * Use `"*"` without a parser for a raw fallback after normal dispatch.
   *
   * Handlers start in the order notifications arrive, but the connection does
   * not wait for an async handler to settle before dispatching the next
   * message, so async handlers can run concurrently. ACP requires a session's
   * `session/update` notifications to be applied in the order they are
   * received, so a `session/update` handler that awaits before applying an
   * update must serialize that work itself, for example by chaining it onto a
   * per-session promise. {@link ActiveSession} already queues updates in
   * arrival order.
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
      (params, cx, signal, requestId, method) =>
        clientRequestContext(
          params,
          ClientContext.create(cx, requestId),
          signal,
          requestId,
          method,
        ),
      handler,
      spec.serializeResponse,
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
    bridgeConnectionClose(state.rawConnection, peerConnection);
    bridgeConnectionClose(peerRawConnection, state.connection);
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
