// Generated from src/v2/acp.ts. Do not edit directly.
/**
 * Experimental TypeScript API for ACP v2, which is in Preview.
 *
 * @remarks
 * ACP v2 is ready to build on, and it is not frozen. Its wire protocol and
 * this API may change incompatibly in any SDK release. The stable package
 * entry point remains ACP v1. The stable-feature set of v2 is available
 * through `@agentclientprotocol/sdk/experimental/v2`; additional unstable
 * protocol features require
 * `@agentclientprotocol/sdk/experimental/v2/unstable`.
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
 * current-state snapshot and the response, also when the replay is empty.
 * From the time the agent receives the request until it sends
 * `replay_complete`, every update it sends for the session is replayed
 * history, and every update after it is not. Sending the request does not
 * mark the start of the replay: when the session is already active on the
 * connection, a live update that the agent sent before it received the
 * request can still arrive first. A replay that ends without
 * `replay_complete` and without a successful response is truncated. Agents
 * do not send it when `replayFrom` is omitted or `null`. Do not send a
 * second `session/resume` with a `replayFrom` cursor for a session while the
 * first one is pending.
 * A replay can include child sessions. Each child that it announces gets its
 * own `replay_complete` on its own `sessionId`, and the rule applies to each
 * session separately: a parent's `replay_complete` says nothing about its
 * children.
 *
 * A `session/resume` without `replayFrom` synchronizes the session's state,
 * not its conversation. The agent sends the current `state_update` and a
 * current update for each terminal, tool call, and child session in its
 * `background` list. It does not send messages or foreground tool calls
 * again. Keep the entities you hold only when you missed no updates, and
 * request replay to have them resynchronized, for example after the
 * connection ended. You can rebuild the session's transcript from a full
 * replay. It carries the history the agent retained, which is not
 * necessarily everything you saw live, and it does not include past
 * `usage_update`, `session_info_update`, `config_option_update`, or
 * `available_commands_update` notifications. When the agent replays an
 * entity as chunks, it first sends that entity's update with the chunked
 * field emptied.
 *
 * The `session/new` and `session/resume` responses carry the session's
 * `configOptions` and `availableCommands`. Each response replaces the lists
 * you hold, including lists from updates that arrived before it. An omitted
 * list means none. A new session is `idle` until a `state_update` reports
 * otherwise, and an agent whose new session is not `idle` sends that state
 * after the `session/new` response.
 *
 * An agent announces a child session with `subagent_update` on its parent
 * and then sends the child's updates and requests with the child's
 * `sessionId`. A child is not an unknown session, although the client did
 * not create or resume it, and `session/list` does not return it. Send
 * nothing for a child except responses to its requests, `session/cancel`
 * while the child advertises `capabilities.cancel`, and `tool_call/cancel`
 * or `terminal/cancel` for an item that advertises its own. Agents answer
 * any other request that names a child with `-32602`. The `capabilities`
 * and `state` in a replayed `subagent_update` are historical. When you send
 * `session/resume`, discard the state and capabilities you hold for the
 * session's children and wait for current ones. A session's `cost` includes
 * the costs of its descendants. A child reports `idle` with
 * `stopReason: "cancelled"` also when its parent cancelled its work.
 *
 * On `session/cancel`, the agent cancels each pending permission request and
 * elicitation that the cancelled work no longer needs with
 * `$/cancel_request`, and the agent decides which requests those are. A
 * client handler whose `signal` aborts should dismiss the prompt and return
 * the `cancelled` outcome or the `cancel` action. Clients do not answer every
 * pending permission request when they send `session/cancel`.
 *
 * When `session/cancel` stops active foreground work, the agent sends that
 * work's final updates and then `idle` with `stopReason: "cancelled"`,
 * before it starts new foreground work in the session. A prompt sent after
 * `session/cancel` is not rejected because the cancellation is in progress.
 * The agent inserts it, or holds it until the cancelled work reported
 * `idle`. Work in the latest `background` list keeps running, so keep
 * accepting tool call and terminal updates after that `idle` update. Stop a
 * listed tool call or terminal with `tool_call/cancel` or `terminal/cancel`
 * while it advertises `capabilities.cancel`.
 *
 * A `selected` permission outcome is not approval by itself. The agent
 * matches its `optionId` against the options it offered in that request. A
 * `reject_once` or `reject_always` option, an `optionId` that was not
 * offered, an option kind or outcome the agent does not understand, an error
 * response, and a connection that ends before the answer all mean the
 * operation is not approved.
 *
 * A `plan_update` replaces the whole plan with its `planId`, also when the
 * plan's `type` changed or is one you do not know. Plans are `items` or
 * `markdown`, and `plan_removed` removes one. No client capability is
 * needed. Ignore `plan_removed` for a `planId` you do not hold. Show a
 * `markdown` plan from its `content`, and do not read its `path` outside the
 * session's roots without user action.
 *
 * When a response is lost, for example because the connection ended, the
 * request may still have taken effect. `session/resume`, `session/list`,
 * `session/close`, `session/delete`, `session/set_config_option`,
 * `auth/login`, `auth/logout`, `tool_call/cancel`, and `terminal/cancel` can
 * be sent again with the same parameters. Send `session/set_config_option`
 * again before you change that option further, because a late retry
 * overwrites the later change. A repeated `session/new` creates a second
 * session. A repeated `session/prompt` inserts a second user message unless
 * both attempts carry the same `idempotencyKey` and the agent still
 * recognizes it. A successful `session/resume` does not show which keys the
 * agent kept, so do not resend an unanswered prompt automatically when a
 * duplicate would matter. Tell the user that the prompt might already have
 * run and let them decide. Notifications are not sent again. A later copy of
 * `session/cancel` can cancel newer foreground work or a newly held prompt.
 * See
 * [Retrying requests](https://agentclientprotocol.com/protocol/v2/overview#retrying-requests).
 *
 * Top-level `_meta` on upsert updates, including `usage_update`, patches
 * stored metadata by key: omission leaves it unchanged, `null` clears it,
 * null-valued keys are removed, and other values replace their key whole
 * without nested merging. An empty object does nothing. Replay uses the same
 * rule. Metadata on chunks, content items, snapshots, and `plan_update` is
 * not an entity patch. `status` on `compaction_update` is a patch field too:
 * omitted leaves it unchanged, and `null` resets it to `in_progress`.
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
