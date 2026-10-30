import { describe, expect, expectTypeOf, it } from "vitest";
import {
  agent as createV1AgentApp,
  methods as v1Methods,
} from "./v1/stable/acp.js";
import { AgentProtocolRouter } from "./protocol-router.js";
import {
  PROTOCOL_VERSION as V2_PROTOCOL_VERSION,
  agent as createV2AgentApp,
  methods as v2Methods,
} from "./v2/stable/acp.js";

import type { AgentApp as V1AgentApp } from "./v1/stable/acp.js";
import type {
  AgentConnectOptions,
  AgentConnectionLifecycle,
  AgentConnector,
} from "./transports/connection.js";
import type { AnyRequest, AnyResponse } from "./core/jsonrpc.js";
import type { Stream } from "./core/stream.js";
import type { AgentApp as V2AgentApp } from "./v2/stable/acp.js";

type WireMessage =
  Stream["readable"] extends ReadableStream<infer Message> ? Message : never;

describe("AgentProtocolRouter", () => {
  it("accepts both AgentApp generations as connectors", () => {
    expectTypeOf<V1AgentApp>().toMatchTypeOf<AgentConnector>();
    expectTypeOf<V2AgentApp>().toMatchTypeOf<AgentConnector>();
  });

  it("always reports when a routed connection closes", () => {
    expectTypeOf<
      ReturnType<AgentProtocolRouter["connect"]>["closed"]
    >().toEqualTypeOf<Promise<void>>();
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
          plan: {},
          auth: { terminal: true, _meta: { auth: true } },
          elicitation: { form: {}, url: { _meta: { url: true } } },
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
    const { response, close } = await rejectedConnection(
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
    await close();
  });

  it("rejects an unsupported version with the initialize request id", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const { response, close } = await rejectedConnection(
      router,
      initializeRequest(1, { clientCapabilities: {} }, "initialize-id"),
    );

    expect(response).toMatchObject({
      id: "initialize-id",
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { requested: 1, supported: [2] },
      },
    });
    expect(v2.connectionCount).toBe(0);
    await close();
  });

  it("lets the client retry initialize after a failed one", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const { response, write, close } = await rejectedConnection(
      router,
      initializeRequest(1, { clientCapabilities: {} }, "first"),
    );

    expect(response).toMatchObject({ id: "first", error: { code: -32022 } });
    expect(v2.connectionCount).toBe(0);

    await write(
      initializeRequest(
        V2_PROTOCOL_VERSION,
        { info: implementation("v2-client") },
        "retry",
      ),
    );
    expect(await v2.nextMessage()).toMatchObject({
      id: "retry",
      method: "initialize",
    });
    expect(v2.connectionCount).toBe(1);
    await close();
  });

  it("rejects a non-initialize first request and flushes the error", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const { response, close, write } = await rejectedConnection(router, {
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
    // The connection stays uninitialized and usable for initialize.
    await write(initializeRequest(1, { clientCapabilities: {} }, 42));
    expect(await v1.nextMessage()).toMatchObject({
      id: 42,
      method: "initialize",
    });
    await close();
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
    ["malformed response", { jsonrpc: "2.0", id: 41, error: null }],
  ] as const)(
    "ignores a %s before initialize and stays usable",
    async (_kind, message) => {
      const v1 = new MockAgentConnector();
      const router = new AgentProtocolRouter().withV1(v1);
      const connection = await openRoutedConnection(
        router,
        message as unknown as WireMessage,
      );
      await connection.write(initializeRequest(1, { clientCapabilities: {} }));

      expect(await v1.nextMessage()).toMatchObject({
        id: 1,
        method: "initialize",
      });
      expect(v1.connectionCount).toBe(1);
      await connection.close();
    },
  );

  it.each([
    ["v1", 1],
    ["v2", V2_PROTOCOL_VERSION],
  ] as const)(
    "rejects a first JSON array on a %s route with a single -32600",
    async (_name, version) => {
      const v1 = new MockAgentConnector();
      const v2 = new MockAgentConnector();
      const router = new AgentProtocolRouter().withV1(v1).withV2(v2);
      const initialize =
        version === 1
          ? initializeRequest(1, { clientCapabilities: {} })
          : initializeRequest(version, { info: implementation("v2-client") });

      for (const batch of [
        [initialize],
        [],
        [{ jsonrpc: "2.0", id: 1, result: {} }],
        [{ jsonrpc: "2.0", method: "_vendor/notification" }],
      ]) {
        const { response, write, close } = await rejectedConnection(
          router,
          batch as unknown as WireMessage,
        );

        expect(response).toEqual({
          jsonrpc: "2.0",
          id: null,
          error: expect.objectContaining({ code: -32600 }),
        });
        expect(v1.connectionCount + v2.connectionCount).toBe(0);

        // The batch did not initialize the connection, but it stays usable.
        await write(initialize);
        const selected = version === 1 ? v1 : v2;
        expect(await selected.nextMessage()).toMatchObject({
          method: "initialize",
        });
        await close();
        selected.connectionCount = 0;
      }
    },
  );

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

  describe("runs connect hooks before the first inbound message", () => {
    const v1Initialize = initializeRequest(1, { clientCapabilities: {} });
    const v2Initialize = initializeRequest(2, {
      info: implementation("v2-client"),
    });
    const router = (events: string[]) =>
      new AgentProtocolRouter()
        .withV1(hookedV1App(events))
        .withV2(hookedV2App(events));

    it.each([
      ["a v1 app", hookedV1App, v1Initialize],
      ["a v2 app", hookedV2App, v2Initialize],
      ["the router to a v1 app", router, v1Initialize],
      ["the router to a v2 app", router, v2Initialize],
    ] as const)("for %s", async (_, connector, initialize) => {
      const events: string[] = [];
      const [clientStream, agentStream] = memoryStreamPair();
      const writer = clientStream.writable.getWriter();
      const reader = clientStream.readable.getReader();
      // Queue `initialize` before the connection opens.
      const written = writer.write(initialize);
      const connection = connector(events).connect(
        agentStream,
      ) as AgentConnectionLifecycle;
      await written;

      const response = await reader.read();
      expect(response.value).toMatchObject({ id: 1, result: {} });
      expect(events).toEqual(["connect", "initialize"]);

      reader.releaseLock();
      await writer.close();
      writer.releaseLock();
      await connection.closed;
    });
  });

  it("drops v2 initialize params that cannot be represented in v1", async () => {
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1);
    const connection = await openRoutedConnection(
      router,
      initializeRequest(2, {
        info: { name: 42 },
        capabilities: {
          auth: { terminal: { _meta: { cannotConvert: true } } },
          elicitation: "malformed",
        },
        _meta: "malformed",
      }),
    );

    expect(await v1.nextMessage()).toEqual(
      initializeRequest(1, {
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
          plan: {},
          auth: { terminal: true },
        },
      }),
    );
    await connection.close();
  });

  it("substitutes unknown info for a newer version routed to v2", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const connection = await openRoutedConnection(
      router,
      initializeRequest(3, {
        capabilities: { auth: "malformed", elicitation: { form: {} } },
        _meta: 7,
      }),
    );

    expect(await v2.nextMessage()).toEqual(
      initializeRequest(2, {
        info: { name: "unknown", version: "unknown" },
        capabilities: { elicitation: { form: {} } },
      }),
    );
    await connection.close();
  });

  it("validates exact-version v2 initialize params strictly", async () => {
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV2(v2);
    const { response, close } = await rejectedConnection(
      router,
      initializeRequest(2, { capabilities: {} }),
    );

    expect(response).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(v2.connectionCount).toBe(0);
    await close();
  });

  it.each([null, 1.5])("rejects a %s request id on a v2 route", async (id) => {
    const v1 = new MockAgentConnector();
    const v2 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1).withV2(v2);
    const { response, close } = await rejectedConnection(
      router,
      initializeRequest(2, { info: implementation("v2-client") }, id),
    );

    expect(response).toMatchObject({ id: null, error: { code: -32600 } });
    expect(v2.connectionCount).toBe(0);
    await close();

    const v1Connection = await openRoutedConnection(
      router,
      initializeRequest(1, { clientCapabilities: {} }, id),
    );
    expect(await v1.nextMessage()).toMatchObject({ id });
    await v1Connection.close();
  });

  it("lets the selected v2 app handle a repeated initialize", async () => {
    const received: unknown[] = [];
    const v2 = createV2AgentApp().onRequest(
      v2Methods.agent.initialize,
      ({ params }) => {
        received.push(params);
        return {
          protocolVersion: V2_PROTOCOL_VERSION,
          info: implementation("v2-agent"),
        };
      },
    );
    const v1 = new MockAgentConnector();
    const router = new AgentProtocolRouter().withV1(v1).withV2(v2);
    const [clientStream, agentStream] = memoryStreamPair();
    const lifecycle = router.connect(agentStream);
    const writer = clientStream.writable.getWriter();
    const reader = clientStream.readable.getReader();

    await writer.write(
      initializeRequest(3, { info: implementation("future-client") }, 1),
    );
    await expect(reader.read()).resolves.toMatchObject({
      value: { id: 1, result: { protocolVersion: 2 } },
    });
    await writer.write(
      initializeRequest(
        2,
        {
          info: implementation("v2-client"),
          capabilities: { auth: { terminal: {} } },
        },
        2,
      ),
    );
    await expect(reader.read()).resolves.toMatchObject({
      value: { id: 2, result: { protocolVersion: 2 } },
    });
    // The router does not re-route, and a repeat must keep the selected version.
    await writer.write(initializeRequest(1, { clientCapabilities: {} }, 3));
    await expect(reader.read()).resolves.toMatchObject({
      value: { id: 3, error: { code: -32600 } },
    });

    expect(received).toEqual([
      expect.objectContaining({ info: implementation("future-client") }),
      expect.objectContaining({
        info: implementation("v2-client"),
        capabilities: { auth: { terminal: {} } },
      }),
    ]);
    expect(v1.connectionCount).toBe(0);
    reader.releaseLock();
    await writer.close();
    writer.releaseLock();
    await lifecycle.closed;
  });

  it("cancels and releases the input when connector setup throws", async () => {
    const connectError = new Error("connector setup failed");
    const router = new AgentProtocolRouter().withV1({
      connect() {
        throw connectError;
      },
    });
    let cancelReason: unknown;
    const readable = new ReadableStream<WireMessage>({
      start(controller) {
        controller.enqueue(
          initializeRequest(1, {
            clientCapabilities: {},
            clientInfo: implementation("v1-client"),
          }),
        );
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const lifecycle = router.connect({
      readable,
      writable: new WritableStream<WireMessage>(),
    });

    await lifecycle.closed;

    expect(cancelReason).toBe(connectError);
    expect(readable.locked).toBe(false);
  });

  it("finishes the lifecycle when aborting the output fails", async () => {
    const routeError = new Error("input failed");
    const abortError = new Error("output abort failed");
    let abortReason: unknown;
    const readable = new ReadableStream<WireMessage>({
      start(controller) {
        controller.error(routeError);
      },
    });
    const writable = new WritableStream<WireMessage>({
      abort(reason) {
        abortReason = reason;
        throw abortError;
      },
    });
    const lifecycle = new AgentProtocolRouter().connect({ readable, writable });

    await expect(
      Promise.race([
        lifecycle.closed,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("lifecycle remained open")), 100);
        }),
      ]),
    ).resolves.toBeUndefined();
    expect(abortReason).toBe(routeError);
    expect(readable.locked).toBe(false);
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

function hookedV1App(events: string[]): AgentConnector {
  return createV1AgentApp({ name: "hooked-v1" })
    .onConnect(() => {
      events.push("connect");
    })
    .onRequest(v1Methods.agent.initialize, () => {
      events.push("initialize");
      return { protocolVersion: 1 };
    });
}

function hookedV2App(events: string[]): AgentConnector {
  return createV2AgentApp({ name: "hooked-v2" })
    .onConnect(() => {
      events.push("connect");
    })
    .onRequest(v2Methods.agent.initialize, () => {
      events.push("initialize");
      return {
        protocolVersion: V2_PROTOCOL_VERSION,
        info: implementation("hooked-v2"),
      };
    });
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
  write(message: WireMessage): Promise<void>;
  read(): Promise<ReadableStreamReadResult<WireMessage>>;
  close(): Promise<void>;
}> {
  const [clientStream, agentStream] = memoryStreamPair();
  const lifecycle = router.connect(agentStream);
  const writer = clientStream.writable.getWriter();
  const reader = clientStream.readable.getReader();
  await writer.write(first);
  const response = await reader.read();
  if (response.done || Array.isArray(response.value)) {
    throw new Error("expected an individual JSON-RPC error response");
  }

  return {
    response: response.value as AnyResponse,
    write: (message) => writer.write(message),
    read: () => reader.read(),
    async close() {
      reader.releaseLock();
      await writer.close();
      writer.releaseLock();
      await lifecycle.closed;
    },
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
