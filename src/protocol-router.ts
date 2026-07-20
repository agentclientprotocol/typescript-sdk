import {
  RequestError,
  isNotificationMessage,
  isRequestMessage,
  isResponseShapedMessage,
  type AnyMessage,
  type AnyRequest,
  type ErrorResponse,
  type JsonRpcId,
} from "./jsonrpc.js";
import { zInitializeRequest as zV1InitializeRequest } from "./schema/zod.gen.js";
import { zInitializeRequest as zV2InitializeRequest } from "./v2/schema/zod.gen.js";

import type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "./connection.js";
import type { ClientCapabilities as V1ClientCapabilities } from "./schema/types.gen.js";
import type { WireStream as Stream } from "./stream.js";
import type {
  AuthCapabilities as V2AuthCapabilities,
  ClientCapabilities as V2ClientCapabilities,
  InitializeRequest as V2InitializeRequest,
} from "./v2/schema/types.gen.js";

type WireMessage =
  Stream["readable"] extends ReadableStream<infer Message> ? Message : never;
type JsonObject = Record<string, unknown>;
type AgentProtocol = 1 | 2;

const INITIALIZE_METHOD = "initialize";
const PROTOCOL_V1 = 1;
const PROTOCOL_V2 = 2;
const MAX_PROTOCOL_VERSION = 0xffff;

/**
 * Routes a client connection to a version-specific ACP agent implementation,
 * including the experimental draft ACP v2 API.
 *
 * The router consumes the first wire item, which must be an individual
 * `initialize` request, and selects the highest configured protocol version
 * that does not exceed the client's requested version. Only the initialize
 * params are normalized to the selected version; every later wire item is
 * forwarded unchanged.
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

  /** Routes one ACP transport connection. */
  connect(
    stream: Stream,
    options: AgentConnectOptions = {},
  ): AgentConnectionLifecycle {
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

    const message = first.value;
    if (shouldCloseWithoutResponse(message)) {
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

    if (Array.isArray(message) || !isRequestMessage(message)) {
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
      );
      lifecycle.finish();
      return;
    }

    const selected = this.highestCompatible(requested);
    if (!selected) {
      await rejectInitialize(
        reader,
        stream.writable,
        message.id,
        RequestError.invalidRequest(
          `unsupported ACP protocol version ${requested}; this endpoint supports ${this.supportedDescription()}`,
        ),
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
      );
      lifecycle.finish();
      return;
    }

    const initialize: AnyRequest = { ...message, params };
    const routedStream: Stream = {
      readable: routedReadable(reader, initialize as WireMessage, lifecycle),
      writable: stream.writable,
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

  private highestCompatible(requested: number): AgentProtocol | undefined {
    if (this.v2 && requested >= PROTOCOL_V2) {
      return PROTOCOL_V2;
    }
    if (this.v1 && requested >= PROTOCOL_V1) {
      return PROTOCOL_V1;
    }
    return undefined;
  }

  private supportedDescription(): string {
    if (this.v1 && this.v2) {
      return "ACP protocol versions 1 and 2";
    }
    if (this.v1) {
      return "ACP protocol version 1";
    }
    if (this.v2) {
      return "ACP protocol version 2";
    }
    return "no ACP protocol versions";
  }
}

function shouldCloseWithoutResponse(message: WireMessage): boolean {
  if (!Array.isArray(message)) {
    return isNotificationMessage(message) || isResponseShapedMessage(message);
  }

  return (
    message.length > 0 &&
    message.every(
      (item): boolean =>
        isNotificationMessage(item) || isResponseShapedMessage(item),
    )
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

async function rejectInitialize(
  reader: ReadableStreamDefaultReader<WireMessage>,
  writable: WritableStream<WireMessage>,
  id: JsonRpcId,
  error: RequestError,
): Promise<void> {
  const response: AnyMessage = {
    jsonrpc: "2.0",
    id,
    error: errorResponse(error),
  };
  const writer = writable.getWriter();

  try {
    await writer.write(response as WireMessage);
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
    return requested >= PROTOCOL_V2
      ? v2InitializeToV1(zV2InitializeRequest.parse(params))
      : normalizeInitialize(zV1InitializeRequest.parse(params), PROTOCOL_V1);
  }
  return normalizeInitialize(zV2InitializeRequest.parse(params), PROTOCOL_V2);
}

function normalizeInitialize(
  initialize: object,
  protocolVersion: AgentProtocol,
): JsonObject {
  return canonicalJsonObject({ ...initialize, protocolVersion });
}

function v2InitializeToV1(initialize: V2InitializeRequest): JsonObject {
  return canonicalJsonObject({
    protocolVersion: PROTOCOL_V1,
    clientCapabilities: v2ClientCapabilitiesToV1(initialize.capabilities),
    clientInfo: initialize.info,
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
    auth: v2AuthCapabilitiesToV1(capabilities?.auth),
  };

  if (capabilities?.elicitation != null) {
    result.elicitation = capabilities.elicitation;
  }
  if (capabilities?.nes != null) {
    result.nes = capabilities.nes;
  }
  if (capabilities?.positionEncodings?.length) {
    result.positionEncodings = capabilities.positionEncodings;
  }
  if (capabilities?._meta != null) {
    result._meta = capabilities._meta;
  }
  return result;
}

function v2AuthCapabilitiesToV1(
  capabilities: V2AuthCapabilities | null | undefined,
): NonNullable<V1ClientCapabilities["auth"]> {
  const terminal = capabilities?.terminal;
  if (terminal?._meta != null) {
    throw new Error(
      "v2 AuthCapabilities.terminal metadata cannot be represented in v1",
    );
  }

  return {
    terminal: terminal != null,
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
