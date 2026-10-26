import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type {
  CreateMcpHandlerOptions,
  McpServerFactory,
  Server,
  ServerEventBus,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import { McpBindingErrorCode, isJsonObject, parseMcpOutcome } from "./core.js";
import type {
  McpOutcome,
  McpOperationContext,
  McpRequestHandler,
} from "./core.js";
import { RequestError } from "../core/jsonrpc.js";

/**
 * Options for {@link fromMcpServer}.
 */
export type FromMcpServerOptions = Pick<
  CreateMcpHandlerOptions,
  "bus" | "maxSubscriptions" | "onerror"
>;

/**
 * An MCP SDK server adapted to serve MCP-over-ACP requests.
 */
export type McpServerAdapter = {
  /**
   * Request handler to pass to `McpOverAcpProvider.registerServer`.
   */
  handler: McpRequestHandler;
  /**
   * Publishes change events (such as `toolsChanged()`) to open
   * `subscriptions/listen` requests.
   */
  notify: ServerNotifier;
  /** The event bus behind {@link notify}. */
  bus: ServerEventBus;
  /** Closes open subscriptions and in-flight server instances. */
  close(): Promise<void>;
};

/**
 * Serves an `@modelcontextprotocol/server` server over MCP-over-ACP.
 *
 * `factory` returns a fresh `McpServer` (or low-level `Server`) for each MCP
 * request, as the MCP SDK requires for MCP 2026-07-28; define tools,
 * resources and prompts once inside it. Each `mcp/message` request is served
 * through the SDK's own request pipeline (`createMcpHandler`, over an
 * in-process request that never touches the network), so discovery,
 * capability checks, input-required results, progress notifications and
 * subscriptions behave as they do over the SDK's HTTP transport.
 *
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/server";
 * import * as z from "zod/v4";
 * import { fromMcpServer } from "@agentclientprotocol/sdk/experimental/mcp-server";
 *
 * const tools = fromMcpServer(() => {
 *   const server = new McpServer({ name: "project-tools", version: "1.0.0" });
 *   server.registerTool(
 *     "echo",
 *     { inputSchema: z.object({ message: z.string() }) },
 *     async ({ message }) => ({ content: [{ type: "text", text: message }] }),
 *   );
 *   return server;
 * });
 * provider.registerServer(connection.agent, { name: "project-tools", handler: tools.handler });
 * ```
 */
export function fromMcpServer(
  factory: McpServerFactory,
  options: FromMcpServerOptions = {},
): McpServerAdapter {
  // Instances built ahead of their request (to derive mirrored headers) are
  // handed to the SDK pipeline for that same request.
  const prebuilt = new WeakMap<Request, McpServer | Server>();
  const mcp = createMcpHandler(
    (ctx) => (ctx.requestInfo && prebuilt.get(ctx.requestInfo)) ?? factory(ctx),
    {
      ...options,
      legacy: "reject",
      responseMode: "auto",
      // ACP framing already bounds message size.
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    },
  );
  return {
    handler: async (cx) => {
      if (!/^[\x21-\x7e]+$/.test(cx.method)) {
        // Not representable as an MCP method header, so not a known method.
        return {
          error: { code: -32601, message: `Method not found: ${cx.method}` },
        };
      }
      const product =
        cx.method === "tools/call"
          ? await factory({ era: "modern" })
          : undefined;
      const request = toRequest(cx, product);
      if (product) prebuilt.set(request, product);
      return outcomeOf(await mcp.fetch(request), cx);
    },
    notify: mcp.notify,
    bus: mcp.bus,
    close: () => mcp.close(),
  };
}

/** Body fields mirrored into `Mcp-Name`, per MCP 2026-07-28. */
const MCP_NAME_SOURCE: Record<string, string> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

/**
 * Builds the MCP 2026-07-28 HTTP exchange the SDK's pipeline expects,
 * mirroring the headers an HTTP client would send. It never leaves the
 * process, and the provider has already validated the inner metadata.
 */
function toRequest(
  cx: McpOperationContext,
  product: McpServer | Server | undefined,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": cx.protocolVersion,
    "mcp-method": cx.method,
  });
  const nameField = MCP_NAME_SOURCE[cx.method];
  const name = nameField === undefined ? undefined : cx.params?.[nameField];
  if (typeof name === "string") headers.set("mcp-name", encodeHeader(name));
  if (product instanceof McpServer && typeof cx.params?.name === "string") {
    for (const [header, value] of mcpParamHeaders(
      product,
      cx.params.name,
      cx.params.arguments,
    )) {
      headers.set(header, value);
    }
  }
  return new Request("http://mcp-over-acp.invalid/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: cx.requestId,
      method: cx.method,
      ...(cx.params === undefined ? {} : { params: cx.params }),
    }),
    signal: cx.signal,
  });
}

/**
 * Derives the `Mcp-Param-*` headers an HTTP client would mirror for a tool
 * whose input schema declares `x-mcp-header` annotations. Over ACP these
 * headers carry no extra authority; they only satisfy the SDK's HTTP checks.
 */
function mcpParamHeaders(
  server: McpServer,
  tool: string,
  args: unknown,
): Array<[string, string]> {
  // `toolInputSchemaJson` is SDK-internal; without it, annotated tools are
  // rejected by the SDK as they would be for an HTTP client omitting headers.
  const schemaOf = (
    server as {
      toolInputSchemaJson?: (
        name: string,
      ) => Record<string, unknown> | undefined;
    }
  ).toolInputSchemaJson;
  const schema =
    typeof schemaOf === "function" ? schemaOf.call(server, tool) : undefined;
  const headers: Array<[string, string]> = [];
  const visit = (node: unknown, value: unknown) => {
    if (!isJsonObject(node)) return;
    const annotation = node["x-mcp-header"];
    if (typeof annotation === "string") {
      const text =
        typeof value === "string"
          ? value
          : typeof value === "boolean" ||
              (typeof value === "number" && Number.isFinite(value))
            ? String(value)
            : undefined;
      if (text !== undefined) {
        headers.push([`mcp-param-${annotation}`, encodeHeader(text)]);
      }
    }
    // Annotations are only valid along chains of `properties`.
    if (isJsonObject(node.properties) && isJsonObject(value)) {
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, value[key]);
      }
    }
  };
  visit(schema, args);
  return headers;
}

/** Encodes a header value with the MCP Base64 sentinel, valid for any text. */
function encodeHeader(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return `=?base64?${btoa(binary)}?=`;
}

async function outcomeOf(
  response: Response,
  cx: McpOperationContext,
): Promise<McpOutcome> {
  if (cx.signal.aborted) {
    await response.body?.cancel().catch(() => {});
    throw cx.signal.reason;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/event-stream") && response.body) {
    return readEventStream(response.body, cx);
  }
  if (contentType.startsWith("application/json")) {
    return terminalOutcome(await response.json(), cx.requestId);
  }
  await response.body?.cancel().catch(() => {});
  throw new RequestError(
    McpBindingErrorCode.backendFailed,
    `MCP server returned HTTP ${response.status} without a JSON-RPC response`,
  );
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  cx: McpOperationContext,
): Promise<McpOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // The MCP SDK frames events with "\n" line endings.
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue; // comments such as keepalives
        const message: unknown = JSON.parse(data);
        if (!isJsonObject(message)) continue;
        if (
          Object.hasOwn(message, "result") ||
          Object.hasOwn(message, "error")
        ) {
          return terminalOutcome(message, cx.requestId);
        }
        // MCP 2026-07-28 has no server-to-client requests, so only
        // notifications (no `id`) are forwarded.
        if (typeof message.method === "string" && !("id" in message)) {
          await cx.notify(
            message.method,
            isJsonObject(message.params) ? message.params : undefined,
          );
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (cx.signal.aborted) throw cx.signal.reason;
  throw new RequestError(
    McpBindingErrorCode.backendFailed,
    "MCP server stream ended without a response",
  );
}

function terminalOutcome(message: unknown, requestId: string): McpOutcome {
  const outcome = isJsonObject(message) ? parseMcpOutcome(message) : undefined;
  const id = isJsonObject(message) ? message.id : undefined;
  // Pre-dispatch rejections may not echo the request ID.
  const matches =
    id === requestId || (id == null && outcome && "error" in outcome);
  if (!outcome || !matches) {
    throw new RequestError(
      McpBindingErrorCode.backendFailed,
      "MCP server returned an invalid JSON-RPC response",
    );
  }
  // Drop JSON-RPC framing; keep exactly the inner outcome.
  return "error" in outcome
    ? { error: outcome.error }
    : { result: outcome.result };
}
