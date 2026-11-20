// Generated from src/v1/acp.ts. Do not edit directly.
import type { AnyMessage } from "../../core/jsonrpc.js";
import { ndJsonStream as createJsonStream } from "../../core/stream.js";
import type { NdJsonStreamOptions } from "../../core/stream.js";
// Keep module initialization behind re-exports so a consumer pays only for
// the bindings, method table, or guards it actually uses.
export * from "./bindings.js";
export { methods } from "./methods.js";
export type * from "../schema/types.gen.js";
// List guards explicitly so their value/type pairs merge rather than colliding
// with the type exports above. The guards.gen re-export test checks this list.
export {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  IdleStateUpdate,
  MultiSelectItems,
  StateUpdate,
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
 * individual JSON-RPC messages. ACP does not use JSON-RPC batches; a connection
 * answers a received JSON array with a single `-32600` response with `id: null`.
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
export { RequestError } from "../../core/jsonrpc.js";
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageTooLargeError,
} from "../../core/stream-limits.js";
export type { NdJsonStreamOptions } from "../../core/stream.js";
export type { ParamsParser } from "../../core/app-handlers.js";
export type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "../../transports/connection.js";
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
} from "../../core/jsonrpc.js";
