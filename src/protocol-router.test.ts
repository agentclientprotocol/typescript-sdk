import { describe, expect, expectTypeOf, it } from "vitest";
import { AgentProtocolRouter } from "./protocol-router.js";

import type { AgentApp as V1AgentApp } from "./acp.js";
import type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "./connection.js";
import type { AnyRequest, AnyResponse } from "./jsonrpc.js";
import type { WireStream as Stream } from "./stream.js";
import type { AgentApp as V2AgentApp } from "./v2/acp.js";

type WireMessage =
  Stream["readable"] extends ReadableStream<infer Message> ? Message : never;

describe("AgentProtocolRouter", () => {
  it("accepts both AgentApp generations as connectors", () => {
    expectTypeOf<V1AgentApp>().toMatchTypeOf<AgentConnector>();
    expectTypeOf<V2AgentApp>().toMatchTypeOf<AgentConnector>();
  });

  it("routes v1 and v2 clients to separate implementations", async () => {
    const v1 = new MockAgentConnector();
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1).withV2(v2);

    const first = await openRoutedConnection(
      router,
      initializeRequest(1, {
        clientCapabilities: {},
        clientInfo: implementation("v1-client"),
      }),
    );
    expect(await v1.nextMessage()).toMatchObject({
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    expect(v2.connectionCount).toBe(0);
    expect(v1.connectOptions).toEqual([{ deferConnectHandlers: true }]);
    expect(v1.connectHandlersStarted).toBe(1);
    await first.close();

    const second = await openRoutedConnection(
      router,
      initializeRequest(2, {
        info: implementation("v2-client"),
        capabilities: {},
      }),
    );
    expect(await v2.nextMessage()).toMatchObject({
      method: "initialize",
      params: { protocolVersion: 2 },
    });
    expect(v2.connectionCount).toBe(1);
    await second.close();
  });

  it("routes a future protocol version to v2 and normalizes initialize", async () => {
    const v1 = new MockAgentConnector();
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1).withV2(v2);
    const connection = await openRoutedConnection(
      router,
      initializeRequest(3, {
        info: implementation("future-client"),
        capabilities: {},
      }),
    );

    expect(await v2.nextMessage()).toEqual(
      initializeRequest(2, {
        info: implementation("future-client"),
        capabilities: {},
      }),
    );
    expect(v1.connectionCount).toBe(0);
    await connection.close();
  });

  it("downgrades v2 initialize metadata and capabilities for a v1 agent", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const connection = await openRoutedConnection(
      router,
      initializeRequest(2, {
        info: {
          ...implementation("v2-client"),
          title: "V2 Client",
          _meta: { implementation: true },
          ignored: true,
        },
        capabilities: {
          auth: { terminal: {}, _meta: { auth: true } },
          elicitation: { form: {}, url: { _meta: { url: true } } },
          nes: { jump: {}, searchAndReplace: {} },
          positionEncodings: ["invalid", "utf-8"],
          _meta: { capabilities: true },
        },
        _meta: { initialize: true },
        ignored: true,
      }),
    );

    expect(await v1.nextMessage()).toEqual(
      initializeRequest(1, {
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
          auth: { terminal: true, _meta: { auth: true } },
          elicitation: { form: {}, url: { _meta: { url: true } } },
          nes: { jump: {}, searchAndReplace: {} },
          positionEncodings: ["utf-8"],
          _meta: { capabilities: true },
        },
        clientInfo: {
          ...implementation("v2-client"),
          title: "V2 Client",
          _meta: { implementation: true },
        },
        _meta: { initialize: true },
      }),
    );
    await connection.close();
  });

  it("forwards every wire item after initialize without conversion", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const connection = await openRoutedConnection(
      router,
      initializeRequest(2, {
        info: implementation("v2-client"),
        capabilities: {},
      }),
    );
    await v1.nextMessage();

    const later = [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/workspace", v2Only: true },
      },
      {
        jsonrpc: "2.0",
        method: "_vendor/notification",
        params: { unchanged: true },
      },
    ] as unknown as WireMessage;
    await connection.write(later);

    expect(await v1.nextMessage()).toBe(later);
    await connection.close();
  });

  it.each([
    [undefined, "missing"],
    [1.5, "fractional"],
    [-1, "negative"],
    [65_536, "larger than uint16"],
    ["2", "string"],
  ])("rejects a %s protocol version (%s)", async (version, _description) => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const { response, closed } = await rejectedConnection(
      router,
      initializeRequest(version, { clientCapabilities: {} }),
    );

    expect(response).toMatchObject({
      id: 1,
      error: {
        code: -32602,
        data: "initialize.protocolVersion must be a valid ACP protocol version",
      },
    });
    expect(v1.connectionCount).toBe(0);
    await closed;
  });

  it("rejects an unsupported version with the initialize request id", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const { response, closed } = await rejectedConnection(
      router,
      initializeRequest(1, { clientCapabilities: {} }, "initialize-id"),
    );

    expect(response).toMatchObject({
      id: "initialize-id",
      error: {
        code: -32600,
        data: expect.stringContaining("supports ACP protocol version 2"),
      },
    });
    expect(v2.connectionCount).toBe(0);
    await closed;
  });

  it("rejects a non-initialize first request and flushes the error", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const { response, next, closed } = await rejectedConnection(router, {
      jsonrpc: "2.0",
      id: 41,
      method: "session/new",
      params: { cwd: "/workspace" },
    });

    expect(response).toMatchObject({
      id: 41,
      error: {
        code: -32600,
        data: "first ACP request must be initialize",
      },
    });
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await closed;
  });

  it.each([
    [
      "notification",
      {
        jsonrpc: "2.0",
        method: "_vendor/notification",
        params: { value: true },
      },
    ],
    ["response", { jsonrpc: "2.0", id: 41, result: {} }],
    [
      "notification-only batch",
      [
        {
          jsonrpc: "2.0",
          method: "_vendor/notification",
          params: { value: 1 },
        },
        {
          jsonrpc: "2.0",
          method: "_vendor/notification",
          params: { value: 2 },
        },
      ],
    ],
  ] as const)("does not respond to a first %s", async (_kind, message) => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const [clientStream, agentStream] = memoryStreamPair();
    const lifecycle = router.connect(agentStream);
    const writer = clientStream.writable.getWriter();
    const reader = clientStream.readable.getReader();

    await writer.write(message);
    writer.releaseLock();

    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    reader.releaseLock();
    expect(v1.connectionCount).toBe(0);
    await lifecycle.closed;
  });

  it("rejects a first batch instead of inspecting an initialize entry", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const batch = [
      initializeRequest(1, { clientCapabilities: {} }),
    ] as unknown as WireMessage;
    const { response, closed } = await rejectedConnection(router, batch);

    expect(response).toMatchObject({
      id: null,
      error: {
        code: -32600,
        data: "first ACP message must be an initialize request",
      },
    });
    expect(v1.connectionCount).toBe(0);
    await closed;
  });

  it("defers and starts the selected app's connect handlers exactly once", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const [clientStream, agentStream] = memoryStreamPair();
    const connection = router.connect(agentStream, {
      deferConnectHandlers: true,
    });
    const writer = clientStream.writable.getWriter();
    await writer.write(
      initializeRequest(2, {
        info: implementation("v2-client"),
        capabilities: {},
      }),
    );
    await v2.nextMessage();

    expect(v2.connectHandlersStarted).toBe(0);
    connection.startConnectHandlers?.();
    connection.startConnectHandlers?.();
    expect(v2.connectHandlersStarted).toBe(1);

    await writer.close();
    writer.releaseLock();
    await connection.closed;
  });

  it("rejects unrepresentable v2 initialize capability metadata", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const { response, closed } = await rejectedConnection(
      router,
      initializeRequest(2, {
        info: implementation("v2-client"),
        capabilities: {
          auth: { terminal: { _meta: { cannotConvert: true } } },
        },
      }),
    );

    expect(response).toMatchObject({
      id: 1,
      error: {
        code: -32602,
        data: expect.stringContaining("cannot be represented in v1"),
      },
    });
    expect(v1.connectionCount).toBe(0);
    await closed;
  });
});

class MockAgentConnector implements AgentConnector {
  readonly connectOptions: Array<AgentConnectOptions | undefined> = [];
  connectionCount = 0;
  connectHandlersStarted = 0;

  private messages: WireMessage[] = [];
  private waiters: Array<(message: WireMessage) => void> = [];

  connect(
    stream: Stream,
    options?: AgentConnectOptions,
  ): AgentConnectionLifecycle {
    this.connectionCount += 1;
    this.connectOptions.push(options);
    const closed = this.read(stream.readable);
    return {
      closed,
      startConnectHandlers: () => {
        this.connectHandlersStarted += 1;
      },
    };
  }

  nextMessage(): Promise<WireMessage> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async read(readable: ReadableStream<WireMessage>): Promise<void> {
    for await (const message of readable) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.messages.push(message);
      }
    }
  }
}

function initializeRequest(
  protocolVersion: unknown,
  params: Record<string, unknown>,
  id: string | number | null = 1,
): AnyRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion, ...params },
  };
}

function implementation(name: string) {
  return { name, version: "1.0.0" };
}

async function openRoutedConnection(
  router: AgentProtocolRouter,
  first: WireMessage,
) {
  const [clientStream, agentStream] = memoryStreamPair();
  const lifecycle = router.connect(agentStream);
  const writer = clientStream.writable.getWriter();
  await writer.write(first);

  return {
    write: (message: WireMessage) => writer.write(message),
    async close() {
      await writer.close();
      writer.releaseLock();
      await lifecycle.closed;
    },
  };
}

async function rejectedConnection(
  router: AgentProtocolRouter,
  first: WireMessage,
): Promise<{
  response: AnyResponse;
  next: Promise<ReadableStreamReadResult<WireMessage>>;
  closed: Promise<void>;
}> {
  const [clientStream, agentStream] = memoryStreamPair();
  const lifecycle = router.connect(agentStream);
  const writer = clientStream.writable.getWriter();
  const reader = clientStream.readable.getReader();
  await writer.write(first);
  writer.releaseLock();
  const response = await reader.read();
  if (response.done || Array.isArray(response.value)) {
    throw new Error("expected an individual JSON-RPC error response");
  }

  return {
    response: response.value as AnyResponse,
    next: reader.read(),
    closed: lifecycle.closed ?? Promise.resolve(),
  };
}

function memoryStreamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<WireMessage>();
  const rightToLeft = new TransformStream<WireMessage>();
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
