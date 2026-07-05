import type {
  AgentConnector,
  OutboundSubscription,
  ResponseRoute,
} from "./connection.js";
import type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
} from "./jsonrpc.js";

export type HttpBackendServerRequestIdGenerator = () => string | number;

export class AcpHttpBackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpHttpBackendError";
  }
}

export function isAcpHttpBackendError(
  error: unknown,
): error is AcpHttpBackendError {
  return error instanceof AcpHttpBackendError;
}

export interface HttpBackendInitializeInput {
  readonly agent: AgentConnector;
  readonly message: AnyMessage;
  readonly signal: AbortSignal;
}

export interface HttpBackendInitializeResult {
  readonly connectionId: string;
  readonly response: AnyResponse;
}

export interface HttpBackendLoadConnectionInput {
  readonly connectionId: string;
}

export interface HttpBackendTouchConnectionInput {
  readonly connectionId: string;
}

export interface HttpBackendCloseConnectionInput {
  readonly connectionId: string;
}

export interface HttpBackendAcceptClientMethodMessageInput {
  readonly connectionId: string;
  readonly message: AnyRequest | AnyNotification;
  readonly route: ResponseRoute;
  readonly responseRoute: ResponseRoute;
}

export interface HttpBackendAcceptClientResponseInput {
  readonly connectionId: string;
  readonly message: AnyResponse;
  readonly headerSessionId: string | null;
}

export interface HttpBackendOpenConnectionStreamInput {
  readonly connectionId: string;
  readonly cursor?: string;
}

export interface HttpBackendOpenSessionStreamInput {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly cursor?: string;
}

export type HttpBackendAcceptResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    };

export interface HttpBackendLoadedConnection {
  readonly connectionId: string;
}

export interface AcpHttpBackend {
  /**
   * Allocates JSON-RPC request IDs for server-originated client requests.
   *
   * Distributed HTTP backends should provide IDs that do not collide across
   * server instances. The in-memory backend intentionally keeps the existing
   * monotonically increasing numeric behavior.
   */
  readonly generateServerRequestId?: HttpBackendServerRequestIdGenerator;

  /**
   * Creates a new HTTP connection, forwards initialize to the agent, and only
   * exposes the connection for subsequent connected HTTP requests once
   * initialize succeeds.
   */
  initialize(
    input: HttpBackendInitializeInput,
  ): Promise<HttpBackendInitializeResult>;

  /**
   * Loads connection metadata/state. Backends may also use this as the activity
   * touch point for connected HTTP requests.
   */
  loadConnection(
    input: HttpBackendLoadConnectionInput,
  ): Promise<HttpBackendLoadedConnection | undefined>;

  /**
   * Refreshes connection metadata after accepted activity.
   */
  touchConnection(input: HttpBackendTouchConnectionInput): Promise<void>;

  /**
   * Accepts any client-originated ACP request/notification after the HTTP
   * server has performed protocol-generic route determination.
   */
  acceptClientMethodMessage(
    input: HttpBackendAcceptClientMethodMessageInput,
  ): Promise<HttpBackendAcceptResult>;

  /**
   * Accepts any client response to a server-originated request and validates
   * response routing against the backend-owned server request route map.
   */
  acceptClientResponse(
    input: HttpBackendAcceptClientResponseInput,
  ): Promise<HttpBackendAcceptResult>;

  /**
   * Opens the connection-level hot stream.
   */
  openConnectionStream(
    input: HttpBackendOpenConnectionStreamInput,
  ): Promise<OutboundSubscription | undefined>;

  /**
   * Opens a session-level hot stream.
   */
  openSessionStream(
    input: HttpBackendOpenSessionStreamInput,
  ): Promise<OutboundSubscription | undefined>;

  /**
   * Closes a connection and releases transport state.
   *
   * Returns false when the connection is unknown.
   */
  closeConnection(input: HttpBackendCloseConnectionInput): Promise<boolean>;

  /**
   * Closes backend-owned resources.
   */
  close(): Promise<void>;
}
