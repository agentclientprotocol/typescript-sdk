import {
  RequestError,
  isNotificationMessage,
  isRequestMessage,
  isResponseBatch,
  isResponseMessage,
  isResponseShapedMessage,
  isV2RequestId,
  type AnyMessage,
  type AnyRequest,
  type ErrorResponse,
  type JsonRpcId,
} from "./core/jsonrpc.js";
import { zInitializeRequest as zV1InitializeRequest } from "./v1/unstable/schema/zod.gen.js";
import {
  zImplementation as zV2Implementation,
  zInitializeRequest as zV2InitializeRequest,
} from "./v2/unstable/schema/zod.gen.js";

import type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "./transports/connection.js";
import type { ClientCapabilities as V1ClientCapabilities } from "./v1/unstable/schema/types.gen.js";
import type { WireStream as Stream } from "./core/stream.js";
import type {
  ClientAuthCapabilities as V2ClientAuthCapabilities,
  ClientCapabilities as V2ClientCapabilities,
  Implementation as V2Implementation,
  InitializeRequest as V2InitializeRequest,
} from "./v2/unstable/schema/types.gen.js";

type WireMessage =
  Stream["readable"] extends ReadableStream<infer Message> ? Message : never;
type JsonObject = Record<string, unknown>;
type AgentProtocol = 1 | 2;

const INITIALIZE_METHOD = "initialize";
const PROTOCOL_V1 = 1;
const PROTOCOL_V2 = 2;
const MAX_PROTOCOL_VERSION = 0xffff;
/**
 * Substituted for a missing or malformed `info` in a v2 `initialize` written
 * for a newer protocol version than the selected one.
 */
const UNKNOWN_IMPLEMENTATION: V2Implementation = {
  name: "unknown",
  version: "unknown",
};

/**
 * Routes a client connection to a version-specific ACP agent implementation,
 * including the experimental draft ACP v2 API.
 *
 * The router consumes the first wire item, which must be an `initialize`
 * request or a single-entry batch containing one. Endpoints exposing v2 select
 * the highest configured version at or below the requested version. V1-only
 * endpoints retain the legacy fallback to v1. Only initialize params and
 * optional batch framing are normalized. Later wire items are forwarded unchanged.
 *
 * When the requested version is newer than the selected one, initialize params
 * that do not parse under the selected version are dropped instead of
 * rejected. A missing or malformed v2 `info` becomes
 * `{ name: "unknown", version: "unknown" }`, and is omitted when downgrading
 * to v1, where `clientInfo` is optional. Requests for exactly the selected
 * version are validated strictly. On a v2 route, the first `initialize` must
 * have a string or integer ID.
 *
 * The selected implementation handles any repeated `initialize`; the router
 * never re-routes a connection. A v2 implementation accepts a repeat that
 * requests v2 or newer before any other request, and rejects one that requests
 * a lower version with `-32600`, since a repeat must use the selected version.
 *
 * @experimental
 */
export class AgentProtocolRouter implements AgentConnector {
  private v1?: AgentConnector;
  private v2?: AgentConnector;

  /** Configures the ACP v1 agent implementation. */
  withV1(agent: AgentConnector): this {
    this.v1 = agent;
    return this;
  }

  /**
   * Configures the experimental draft ACP v2 agent implementation.
   *
   * @experimental
   */
  withV2(agent: AgentConnector): this {
    this.v2 = agent;
    return this;
  }

  /**
   * Routes one ACP transport connection.
   *
   * The returned `closed` always resolves once the routed connection ends,
   * including when the client leaves before `initialize` or routing fails.
   */
  connect(
    stream: Stream,
    options: AgentConnectOptions = {},
  ): AgentConnectionLifecycle & { readonly closed: Promise<void> } {
    const lifecycle = new RoutedAgentConnection(
      options.deferConnectHandlers !== true,
    );
    void this.route(stream, lifecycle).catch(async (error: unknown) => {
      try {
        await abortWritable(stream.writable, error);
      } catch {
        // The routing failure already owns shutdown. An output abort failure
        // must not keep the connection lifecycle open or escape unobserved.
      } finally {
        lifecycle.finish();
      }
    });
    return lifecycle;
  }

  private async route(
    stream: Stream,
    lifecycle: RoutedAgentConnection,
  ): Promise<void> {
    const reader = stream.readable.getReader();
    let first: ReadableStreamReadResult<WireMessage>;
    try {
      first = await reader.read();
    } catch (error) {
      reader.releaseLock();
      throw error;
    }

    if (first.done) {
      reader.releaseLock();
      await closeWritable(stream.writable);
      lifecycle.finish();
      return;
    }

    const firstMessage = first.value;
    if (shouldCloseWithoutResponse(firstMessage)) {
      await closeWithoutResponse(
        reader,
        stream.writable,
        RequestError.invalidRequest(
          "first ACP message must be an initialize request",
        ),
      );
      lifecycle.finish();
      return;
    }

    let batchedInitialize = false;
    let message: unknown = firstMessage;
    if (Array.isArray(firstMessage)) {
      if (
        firstMessage.length === 1 &&
        isRequestMessage(firstMessage[0]) &&
        firstMessage[0].method === INITIALIZE_METHOD
      ) {
        batchedInitialize = true;
        message = firstMessage[0];
      } else {
        await rejectInitialize(
          reader,
          stream.writable,
          null,
          RequestError.invalidRequest(
            "first ACP message must be an initialize request",
          ),
        );
        lifecycle.finish();
        return;
      }
    }

    if (!isRequestMessage(message)) {
      await rejectInitialize(
        reader,
        stream.writable,
        null,
        RequestError.invalidRequest(
          "first ACP message must be an initialize request",
        ),
      );
      lifecycle.finish();
      return;
    }

    if (message.method !== INITIALIZE_METHOD) {
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        RequestError.invalidRequest("first ACP request must be initialize"),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    if (!isJsonObject(message.params)) {
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        invalidProtocolVersion(),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    const requested = message.params["protocolVersion"];
    if (!isProtocolVersion(requested)) {
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        invalidProtocolVersion(),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    const selected = this.selectProtocol(requested);
    if (!selected) {
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        RequestError.unsupportedProtocolVersion(requested, [
          ...(this.v1 ? [PROTOCOL_V1] : []),
          ...(this.v2 ? [PROTOCOL_V2] : []),
        ]),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    if (selected === PROTOCOL_V2 && !isV2RequestId(message.id)) {
      await rejectInitialize(
        reader,
        stream.writable,
        null,
        RequestError.invalidRequest(
          undefined,
          "ACP v2 request IDs must be strings or integers",
        ),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    let params: JsonObject;
    try {
      params = rewriteInitializeParams(message.params, requested, selected);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        RequestError.invalidParams(`invalid initialize params: ${detail}`),
        batchedInitialize,
      );
      lifecycle.finish();
      return;
    }

    const initialize: AnyRequest = { ...message, params };
    const routedInitialize =
      batchedInitialize && selected === PROTOCOL_V2
        ? ([initialize] as WireMessage)
        : (initialize as WireMessage);
    const routedStream: Stream = {
      readable: routedReadable(reader, routedInitialize, lifecycle),
      writable:
        batchedInitialize && selected === PROTOCOL_V1
          ? batchInitializeResponseWritable(stream.writable, message.id)
          : stream.writable,
    };
    const agent = selected === PROTOCOL_V2 ? this.v2 : this.v1;
    if (!agent) {
      throw new Error("selected ACP protocol implementation is not configured");
    }

    try {
      const connection = agent.connect(routedStream, {
        deferConnectHandlers: true,
      });
      lifecycle.attach(connection);
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the connector failure as the routing error.
      } finally {
        reader.releaseLock();
      }
      throw error;
    }
  }

  private selectProtocol(requested: number): AgentProtocol | undefined {
    if (this.v1 && !this.v2) {
      return PROTOCOL_V1;
    }
    if (this.v2 && requested >= PROTOCOL_V2) {
      return PROTOCOL_V2;
    }
    if (this.v1 && requested >= PROTOCOL_V1) {
      return PROTOCOL_V1;
    }
    return undefined;
  }
}

function shouldCloseWithoutResponse(message: WireMessage): boolean {
  if (!Array.isArray(message)) {
    return isNotificationMessage(message) || isResponseShapedMessage(message);
  }

  return (
    message.length > 0 &&
    (isResponseBatch(message) ||
      message.every(
        (item): boolean =>
          isNotificationMessage(item) || isResponseMessage(item),
      ))
  );
}

/**
 * Creates an empty agent protocol router with experimental ACP v2 support.
 *
 * @experimental
 */
export function agentProtocolRouter(): AgentProtocolRouter {
  return new AgentProtocolRouter();
}

class RoutedAgentConnection implements AgentConnectionLifecycle {
  readonly closed: Promise<void>;

  private resolveClosed: () => void = () => {};
  private isFinished = false;
  private startRequested: boolean;
  private connectHandlersStarted = false;
  private selected?: AgentConnectionLifecycle;

  constructor(startConnectHandlers: boolean) {
    this.startRequested = startConnectHandlers;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  startConnectHandlers(): void {
    this.startRequested = true;
    this.maybeStartConnectHandlers();
  }

  attach(connection: unknown): void {
    this.selected = asAgentConnectionLifecycle(connection);
    this.maybeStartConnectHandlers();

    if (this.selected?.closed) {
      void this.selected.closed.then(
        () => this.finish(),
        () => this.finish(),
      );
    }
  }

  finish(): void {
    if (this.isFinished) {
      return;
    }
    this.isFinished = true;
    this.resolveClosed();
  }

  private maybeStartConnectHandlers(): void {
    if (
      !this.startRequested ||
      this.connectHandlersStarted ||
      !this.selected?.startConnectHandlers
    ) {
      return;
    }
    this.connectHandlersStarted = true;
    this.selected.startConnectHandlers();
  }
}

function asAgentConnectionLifecycle(
  value: unknown,
): AgentConnectionLifecycle | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const lifecycle = value as AgentConnectionLifecycle;
  if (
    lifecycle.closed === undefined &&
    lifecycle.startConnectHandlers === undefined
  ) {
    return undefined;
  }
  return lifecycle;
}

function routedReadable(
  source: ReadableStreamDefaultReader<WireMessage>,
  initialize: WireMessage,
  lifecycle: RoutedAgentConnection,
): ReadableStream<WireMessage> {
  let next: WireMessage | undefined = initialize;
  let released = false;

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    source.releaseLock();
  };

  return new ReadableStream<WireMessage>({
    async pull(controller) {
      if (next !== undefined) {
        controller.enqueue(next);
        next = undefined;
        return;
      }

      try {
        const result = await source.read();
        if (result.done) {
          release();
          controller.close();
          lifecycle.finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
        lifecycle.finish();
      }
    },
    async cancel(reason) {
      try {
        await source.cancel(reason);
      } finally {
        release();
        lifecycle.finish();
      }
    },
  });
}

function batchInitializeResponseWritable(
  destination: WritableStream<WireMessage>,
  initializeId: JsonRpcId,
): WritableStream<WireMessage> {
  let responseFramed = false;

  return new WritableStream<WireMessage>({
    async write(message) {
      let outgoing = message;
      if (
        !responseFramed &&
        !Array.isArray(message) &&
        isResponseShapedMessage(message) &&
        "id" in message &&
        message.id === initializeId
      ) {
        responseFramed = true;
        outgoing = [message] as WireMessage;
      }

      const writer = destination.getWriter();
      try {
        await writer.write(outgoing);
      } finally {
        writer.releaseLock();
      }
    },
    close: () => closeWritable(destination),
    abort: (reason) => abortWritable(destination, reason),
  });
}

async function rejectInitialize(
  reader: ReadableStreamDefaultReader<WireMessage>,
  writable: WritableStream<WireMessage>,
  id: JsonRpcId,
  error: RequestError,
  batched = false,
): Promise<void> {
  const response: AnyMessage = {
    jsonrpc: "2.0",
    id,
    error: errorResponse(error),
  };
  const writer = writable.getWriter();

  try {
    await writer.write((batched ? [response] : response) as WireMessage);
    await writer.close();
  } finally {
    writer.releaseLock();
    try {
      await reader.cancel(error);
    } finally {
      reader.releaseLock();
    }
  }
}

async function closeWithoutResponse(
  reader: ReadableStreamDefaultReader<WireMessage>,
  writable: WritableStream<WireMessage>,
  reason: unknown,
): Promise<void> {
  const writer = writable.getWriter();

  try {
    await writer.close();
  } finally {
    writer.releaseLock();
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  }
}

function errorResponse(error: RequestError): ErrorResponse {
  return {
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

function invalidProtocolVersion(): RequestError {
  return RequestError.invalidParams(
    "initialize.protocolVersion must be a valid ACP protocol version",
  );
}

async function closeWritable(writable: WritableStream<WireMessage>) {
  const writer = writable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function abortWritable(
  writable: WritableStream<WireMessage>,
  reason: unknown,
) {
  if (writable.locked) {
    return;
  }
  const writer = writable.getWriter();
  try {
    await writer.abort(reason);
  } finally {
    writer.releaseLock();
  }
}

function isProtocolVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PROTOCOL_VERSION
  );
}

function rewriteInitializeParams(
  params: JsonObject,
  requested: number,
  selected: AgentProtocol,
): JsonObject {
  if (selected === PROTOCOL_V1) {
    if (requested < PROTOCOL_V2) {
      return normalizeInitialize(
        zV1InitializeRequest.parse(params),
        PROTOCOL_V1,
      );
    }
    const { request, hasInfo } = parseNewerV2Initialize(params);
    return v2InitializeToV1(request, hasInfo);
  }
  return normalizeInitialize(
    requested > PROTOCOL_V2
      ? parseNewerV2Initialize(params).request
      : zV2InitializeRequest.parse(params),
    PROTOCOL_V2,
  );
}

/**
 * Parses a v2-shaped initialize written for a version newer than the selected
 * one, keeping what parses. The generated schema already drops malformed
 * capabilities and `_meta`; only the required `info` needs a substitute.
 */
function parseNewerV2Initialize(params: JsonObject): {
  request: V2InitializeRequest;
  hasInfo: boolean;
} {
  const info = zV2Implementation.safeParse(params["info"]);
  return {
    request: zV2InitializeRequest.parse({
      ...params,
      info: info.success ? params["info"] : UNKNOWN_IMPLEMENTATION,
    }),
    hasInfo: info.success,
  };
}

function normalizeInitialize(
  initialize: object,
  protocolVersion: AgentProtocol,
): JsonObject {
  return canonicalJsonObject({ ...initialize, protocolVersion });
}

function v2InitializeToV1(
  initialize: V2InitializeRequest,
  hasInfo: boolean,
): JsonObject {
  return canonicalJsonObject({
    protocolVersion: PROTOCOL_V1,
    clientCapabilities: v2ClientCapabilitiesToV1(initialize.capabilities),
    clientInfo: hasInfo ? initialize.info : undefined,
    _meta: initialize._meta,
  });
}

function v2ClientCapabilitiesToV1(
  capabilities: V2ClientCapabilities | undefined,
): V1ClientCapabilities {
  const result: V1ClientCapabilities = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    session: { configOptions: { boolean: {} } },
    plan: {},
    auth: v2ClientAuthCapabilitiesToV1(capabilities?.auth),
  };

  if (capabilities?.elicitation != null) {
    result.elicitation = capabilities.elicitation;
  }
  if (capabilities?._meta != null) {
    result._meta = capabilities._meta;
  }
  return result;
}

function v2ClientAuthCapabilitiesToV1(
  capabilities: V2ClientAuthCapabilities | null | undefined,
): NonNullable<V1ClientCapabilities["auth"]> {
  // v1 advertises terminal auth as a boolean, so `terminal._meta` has no v1
  // representation and is dropped like any other unparsable parameter.
  return {
    terminal: capabilities?.terminal != null,
    ...(capabilities?._meta == null ? {} : { _meta: capabilities._meta }),
  };
}

/** Mirrors serde's canonical output for the initialize schema. */
function canonicalJsonObject(value: object): JsonObject {
  const result: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (member == null) {
      continue;
    }
    if (key === "_meta") {
      result[key] = member;
      continue;
    }
    if (Array.isArray(member)) {
      if (member.length > 0) {
        result[key] = member.map(canonicalJsonValue);
      }
      continue;
    }
    result[key] = isJsonObject(member) ? canonicalJsonObject(member) : member;
  }
  return result;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  return isJsonObject(value) ? canonicalJsonObject(value) : value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
