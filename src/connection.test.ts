import { describe, expect, it, vi } from "vitest";
import {
  ConnectionRegistry,
  OutboundStream,
  type ResponseRoute,
} from "./connection.js";
import { messageIdKey } from "./protocol.js";
import { TestAgent } from "./test-support/test-agent.js";

import type {
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
} from "./acp.js";
import type { AnyMessage } from "./jsonrpc.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {},
  },
} as const;

const sessionNewRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: {
    cwd: "/tmp",
    mcpServers: [],
  },
} as const;

function createPromptRequest(id: number, sessionId: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    },
  } as const;
}

const messageOne = { jsonrpc: "2.0", id: 1, result: "one" } as const;
const messageTwo = { jsonrpc: "2.0", id: 2, result: "two" } as const;
const messageThree = { jsonrpc: "2.0", id: 3, result: "three" } as const;
const messageFour = { jsonrpc: "2.0", id: 4, result: "four" } as const;

describe("ConnectionRegistry", () => {
  it("creates retrievable connections with unique UUID connection IDs", async () => {
    const registry = new ConnectionRegistry();
    const first = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );
    const second = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );

    expect(first.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(registry.get(first.connectionId)).toBe(first);
    expect(registry.get(second.connectionId)).toBe(second);

    await registry.closeAll();
  });

  it("removes connections", () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );

    expect(registry.remove(connection.connectionId)).toBe(connection);
    expect(registry.get(connection.connectionId)).toBeUndefined();
    expect(registry.remove(connection.connectionId)).toBeUndefined();
  });

  it("receives the initialize response directly from the agent", async () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );

    await writeInbound(connection.inboundTx, initializeRequest);

    const response = await connection.recvInitial(initializeRequest.id);

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: initializeRequest.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });

    await registry.closeAll();
  });

  it("cancels a pending initialize reader during shutdown", async () => {
    const initialize = createDeferred<InitializeResponse>();
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) =>
        new DelayedInitializeAgent(conn, initialize.promise),
    );

    await writeInbound(connection.inboundTx, initializeRequest);
    const initialResponse = connection.recvInitial(initializeRequest.id);
    initialResponse.catch(() => undefined);

    await connection.shutdown();

    await expect(withTimeout(initialResponse)).rejects.toThrow(
      "Expected initialize response from agent",
    );

    await registry.closeAll();
  });

  it("waits for active and pending connection shutdowns before closeAll resolves", async () => {
    const registry = new ConnectionRegistry();
    const active = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );
    const pending = registry.createPendingConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );
    const activeShutdownStarted = createDeferred<void>();
    const pendingShutdownStarted = createDeferred<void>();
    const allowActiveShutdown = createDeferred<void>();
    const allowPendingShutdown = createDeferred<void>();
    const originalActiveShutdown = active.shutdown.bind(active);
    const originalPendingShutdown = pending.shutdown.bind(pending);
    vi.spyOn(active, "shutdown").mockImplementation(async () => {
      activeShutdownStarted.resolve();
      await allowActiveShutdown.promise;
      await originalActiveShutdown();
    });
    vi.spyOn(pending, "shutdown").mockImplementation(async () => {
      pendingShutdownStarted.resolve();
      await allowPendingShutdown.promise;
      await originalPendingShutdown();
    });
    let closeResolved = false;

    const close = registry.closeAll().then(() => {
      closeResolved = true;
    });

    await activeShutdownStarted.promise;
    await pendingShutdownStarted.promise;
    await flushMicrotasks();

    expect(registry.get(active.connectionId)).toBeUndefined();
    expect(closeResolved).toBe(false);

    allowActiveShutdown.resolve();
    await flushMicrotasks();
    expect(closeResolved).toBe(false);

    allowPendingShutdown.resolve();
    await close;
    expect(closeResolved).toBe(true);
  });

  it("routes pending responses to the connection stream and all outbound stream", async () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );

    await initializeConnection(connection);

    const connectionSubscription = connection.connectionStream.subscribe();
    const allOutboundSubscription = connection.allOutbound.subscribe();
    const key = messageIdKey(sessionNewRequest.id);

    expect(key).toBe("number:2");
    connection.pendingRoutes.set(key ?? "", "connection");

    await writeInbound(connection.inboundTx, sessionNewRequest);

    const connectionMessage = await readNext(connectionSubscription.stream);
    const allOutboundMessage = await readNext(allOutboundSubscription.stream);

    expect(connectionMessage).toMatchObject({
      jsonrpc: "2.0",
      id: sessionNewRequest.id,
      result: {
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    expect(allOutboundMessage).toMatchObject(connectionMessage);
    expect(connection.pendingRoutes.has(key ?? "")).toBe(false);

    await registry.closeAll();
  });

  it("falls back to the connection stream for responses without a pending route", async () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );

    await initializeConnection(connection);

    const subscription = connection.connectionStream.subscribe();

    await writeInbound(connection.inboundTx, sessionNewRequest);

    expect(await readNext(subscription.stream)).toMatchObject({
      jsonrpc: "2.0",
      id: sessionNewRequest.id,
      result: {
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });

    await registry.closeAll();
  });

  it("returns the same session stream for repeated ensureSession calls", async () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn),
    );
    const sessionId = globalThis.crypto.randomUUID();

    expect(connection.ensureSession(sessionId)).toBe(
      connection.ensureSession(sessionId),
    );
    expect(connection.sessionStreams.get(sessionId)).toBe(
      connection.ensureSession(sessionId),
    );

    await registry.closeAll();
  });

  it("routes session responses and notifications to the session stream", async () => {
    const registry = new ConnectionRegistry();
    const connection = registry.createConnection(
      (conn: AgentSideConnection) => new TestAgent(conn, { chunkCount: 1 }),
    );
    const sessionId = globalThis.crypto.randomUUID();
    const promptRequest = createPromptRequest(3, sessionId);

    await initializeConnection(connection);

    const sessionSubscription = connection.ensureSession(sessionId).subscribe();
    const connectionSubscription = connection.connectionStream.subscribe();
    const key = messageIdKey(promptRequest.id);

    expect(key).toBe("number:3");
    connection.pendingRoutes.set(key ?? "", { session: sessionId });

    await writeInbound(connection.inboundTx, promptRequest);

    expect(await readNext(sessionSubscription.stream)).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            text: "chunk-1",
          },
        },
      },
    });
    expect(await readNext(sessionSubscription.stream)).toMatchObject({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: {
        stopReason: "end_turn",
      },
    });
    expect(connection.pendingRoutes.has(key ?? "")).toBe(false);
    expect(
      await readNextOrUndefined(connectionSubscription.stream),
    ).toBeUndefined();

    await registry.closeAll();
  });
});

describe("OutboundStream", () => {
  it("replays buffered messages to the first subscriber", () => {
    const stream = new OutboundStream();

    stream.push(messageOne);
    stream.push(messageTwo);

    expect(stream.subscribe().replay).toEqual([messageOne, messageTwo]);
  });

  it("does not replay buffered messages to later subscribers", async () => {
    const stream = new OutboundStream();

    stream.push(messageOne);

    const first = stream.subscribe();
    const second = stream.subscribe();

    expect(first.replay).toEqual([messageOne]);
    expect(second.replay).toEqual([]);

    stream.push(messageTwo);

    expect(await readNext(first.stream)).toEqual(messageTwo);
    expect(await readNext(second.stream)).toEqual(messageTwo);
  });

  it("evicts oldest replay messages when capacity is exceeded", () => {
    const stream = new OutboundStream(2);

    stream.push(messageOne);
    stream.push(messageTwo);
    stream.push(messageThree);

    expect(stream.subscribe().replay).toEqual([messageTwo, messageThree]);
  });

  it("drops oldest queued live messages for lagging subscribers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stream = new OutboundStream(2);
    const subscription = stream.subscribe();

    stream.push(messageOne);
    stream.push(messageTwo);
    stream.push(messageThree);
    stream.push(messageFour);

    expect(await readNext(subscription.stream)).toEqual(messageOne);
    expect(await readNext(subscription.stream)).toEqual(messageThree);
    expect(await readNext(subscription.stream)).toEqual(messageFour);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it("closes subscriber streams", async () => {
    const stream = new OutboundStream();
    const reader = stream.subscribe().stream.getReader();

    stream.close();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });
});

type TestConnection = ReturnType<ConnectionRegistry["createConnection"]>;

async function initializeConnection(connection: TestConnection): Promise<void> {
  await writeInbound(connection.inboundTx, initializeRequest);
  await connection.recvInitial(initializeRequest.id);
  connection.startRouter();
}

async function writeInbound(
  stream: WritableStream<AnyMessage>,
  message: AnyMessage,
): Promise<void> {
  const writer = stream.getWriter();

  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
}

async function readNext(
  stream: ReadableStream<AnyMessage>,
): Promise<AnyMessage> {
  const reader = stream.getReader();

  try {
    const result = await reader.read();

    if (result.done) {
      throw new Error("Expected stream message");
    }

    return result.value;
  } finally {
    reader.releaseLock();
  }
}

async function readNextOrUndefined(
  stream: ReadableStream<AnyMessage>,
): Promise<AnyMessage | undefined> {
  const reader = stream.getReader();

  try {
    return await Promise.race([
      reader.read().then((result) => (result.done ? undefined : result.value)),
      delay(50).then(() => undefined),
    ]);
  } finally {
    reader.releaseLock();
  }
}

class DelayedInitializeAgent extends TestAgent {
  constructor(
    conn: AgentSideConnection,
    private readonly initializeResponse: Promise<InitializeResponse>,
  ) {
    super(conn);
  }

  initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return this.initializeResponse;
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 100,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Timed out waiting for promise"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const routeShapeCheck = "connection" satisfies ResponseRoute;
void routeShapeCheck;
