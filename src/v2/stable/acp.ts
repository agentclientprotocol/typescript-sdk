// Generated from src/v2/acp.ts. Do not edit directly.
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
 * A `session/resume` with a `replayFrom` cursor replays history as
 * `session/update` notifications. The agent ends the replay with one
 * `replay_complete` update, after the last replayed update and before the
 * current-state snapshot and the response, also when the history is empty.
 * Every update for the session before it is replayed history, and every
 * update after it is not. A replay that ends without `replay_complete` and
 * without a successful response is truncated. Agents do not send it when
 * `replayFrom` is omitted or `null`.
 *
 * Top-level `_meta` on upsert updates patches stored metadata by key: omission
 * leaves it unchanged, `null` clears it, null-valued keys are removed, and other
 * values replace their key whole without nested merging. An empty object does
 * nothing. Replay uses the same rule. Metadata on chunks, content items,
 * snapshots, and `plan_update` is not an entity patch.
 *
 * Experimental operations follow their advertised capabilities; local schema
 * selection does not establish peer support. Only send lifecycle
 * `systemPrompt` instructions when the agent advertises
 * `session.systemPrompt`, only use `override` when its `mode.override`
 * capability is advertised, and never send an empty `content` array.
 *
 * @packageDocumentation
 * @experimental
 */
import type { AnyMessage } from "../../core/jsonrpc.js";
import { ndJsonStream as createJsonStream } from "../../core/stream.js";
import type { NdJsonStreamOptions } from "../../core/stream.js";
export * from "./bindings.js";
export { methods } from "./methods.js";
export type * from "../schema/types.gen.js";
// List guards explicitly so their value/type pairs merge rather than colliding
// with the type exports above. The guards.gen re-export test checks this list.
export {
  AuthMethod,
  AvailableCommand,
  AvailableCommandInput,
  BackgroundWork,
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
} from "../schema/guards.gen.js";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from "../schema/index.js";
/**
 * Experimental draft ACP v2 transport stream of individual JSON-RPC messages.
 *
 * ACP does not use JSON-RPC batches. A connection answers a received JSON
 * array with a single `-32600` response with `id: null`.
 *
 * @experimental
 */
export type Stream = {
  /** Outgoing JSON-RPC messages. */
  writable: WritableStream<AnyMessage>;
  /** Incoming JSON-RPC messages. */
  readable: ReadableStream<AnyMessage>;
};
/**
 * Creates an experimental draft ACP v2 stream from newline-delimited JSON.
 *
 * @experimental
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
export {
  AgentProtocolRouter,
  agentProtocolRouter,
} from "../../protocol-router.js";
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
