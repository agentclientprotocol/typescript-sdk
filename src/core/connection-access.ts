import type { ConnectionContext } from "./jsonrpc.js";

/**
 * Symbol used by protocol-agnostic helpers to reach the connection behind an
 * ACP context. It must stay in the published declarations so that
 * {@link HasConnectionContext} only accepts real ACP contexts.
 *
 * @hidden
 */
export const connectionContextOf = Symbol("connectionContextOf");

/**
 * An ACP `AgentContext` or `ClientContext`, which SDK helpers such as the
 * MCP-over-ACP provider and caller use to identify the connection.
 */
export interface HasConnectionContext {
  /** @hidden */
  [connectionContextOf](): ConnectionContext;
}
