# Migration Guide

This guide covers migrating from the old TypeScript SDK `Agent` and `Client`
interfaces to the new app-style SDK design on this branch.

The protocol types are the same. The main change is how applications wire their
agent or client implementation into a connection:

- Old code implemented the `Agent` or `Client` interface and passed an instance
  to `new AgentSideConnection(...)` or `new ClientSideConnection(...)`.
- New code creates an app with `acp.agent(...)` or `acp.client(...)`, registers
  typed handlers, and connects it to a stream.
- Handlers receive one context object, usually named `c`. Request and
  notification params are available as `c.params`. Agent handlers use `c.client`
  for outbound calls to the client. Client handlers use `c.agent` for outbound
  calls to the agent.

`AgentSideConnection` and `ClientSideConnection` still exist as compatibility
wrappers, but new code should use the app API.

## Quick Mapping

| Old design                                                     | New design                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `new AgentSideConnection((conn) => new MyAgent(conn), stream)` | `acp.agent({ name }).initialize(...).prompt(...).connect(stream)`          |
| `new ClientSideConnection((_agent) => client, stream)`         | `acp.client({ name }).sessionUpdate(...).connectWith(stream, async ...)`   |
| Store `AgentSideConnection` on your agent class                | Use `c.client` in agent handlers                                           |
| Store/use `ClientSideConnection` for outgoing agent calls      | Use the `agent` passed to `connectWith`                                    |
| Return a response from an `Agent` or `Client` method           | Return a response from the app request handler                             |
| Throw from implementation methods for JSON-RPC errors          | Throw from an app handler                                                  |
| Manually create session and prompt requests                    | Prefer `agent.buildSession(...).runUntil(...)` for common prompt workflows |

## Migrating an Agent

Previously, an agent usually implemented `acp.Agent`, stored the
`AgentSideConnection`, and used that connection to send updates or requests back
to the client.

```ts
class MyAgent implements acp.Agent {
  constructor(private connection: acp.AgentSideConnection) {}

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: "session-1" };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working..." },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}
}

new acp.AgentSideConnection((conn) => new MyAgent(conn), stream);
```

With the new API, keep your implementation class if it helps, but register it
with `acp.agent(...)`. Request handlers return their response value directly.
Long-running handlers can stay `async`; while the promise is pending, the
connection continues reading other messages.

```ts
class MyAgent {
  initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  }

  newSession(): acp.NewSessionResponse {
    return { sessionId: "session-1" };
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working..." },
      },
    });

    return { stopReason: "end_turn" };
  }

  cancel(_params: acp.CancelNotification): void {}
}

const implementation = new MyAgent();

acp
  .agent({ name: "my-agent" })
  .initialize(() => implementation.initialize())
  .newSession(() => implementation.newSession())
  .prompt((c) => implementation.prompt(c.params, c.client))
  .cancel((c) => implementation.cancel(c.params))
  .connect(stream);
```

For JSON-RPC errors, throw from the handler:

```ts
acp.agent().prompt(() => {
  throw acp.RequestError.internalError({ details: "prompt failed" });
});
```

## Migrating a Client

Previously, a client implemented `acp.Client`, constructed a
`ClientSideConnection`, then called agent methods on that connection.

```ts
class MyClient implements acp.Client {
  async requestPermission(
    _params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    console.log(params.sessionId);
  }
}

const client = new MyClient();
const connection = new acp.ClientSideConnection((_agent) => client, stream);

const initialized = await connection.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
});

const session = await connection.newSession({
  cwd: "/workspace/project",
  mcpServers: [],
});

const prompt = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello" }],
});
```

With the new API, register client-side handlers on `acp.client(...)` and put the
outgoing workflow inside `connectWith`. The callback receives a typed agent
context.

```ts
class MyClient {
  requestPermission(
    _params: acp.RequestPermissionRequest,
  ): acp.RequestPermissionResponse {
    return { outcome: { outcome: "cancelled" } };
  }

  sessionUpdate(params: acp.SessionNotification): void {
    console.log(params.sessionId);
  }
}

const client = new MyClient();

const prompt = await acp
  .client({ name: "my-client" })
  .requestPermission((c) => client.requestPermission(c.params))
  .sessionUpdate((c) => client.sessionUpdate(c.params))
  .connectWith(stream, async (agent) => {
    const initialized = await agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await agent.newSession({
      cwd: "/workspace/project",
      mcpServers: [],
    });

    return agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    });
  });
```

`connectWith` owns the connection lifetime for the callback. When the callback
finishes or throws, the connection is closed.

## Context Objects

Agent handlers receive an `AgentHandlerContext`:

```ts
acp.agent().prompt(async (c) => {
  await c.client.sessionUpdate({
    sessionId: c.params.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Checking permissions..." },
    },
  });

  const permission = await c.client.requestPermission({
    sessionId: c.params.sessionId,
    toolCall,
    options,
  });

  return { stopReason: "end_turn" };
});
```

Client handlers receive a `ClientHandlerContext`:

```ts
acp.client().requestPermission((c) => {
  console.log(c.params.toolCall.title);
  return { outcome: { outcome: "cancelled" } };
});
```

Agent handler contexts include `params` and `client`. Client handler contexts
include `params` and `agent`.

The `connectWith` callback receives a `ClientContext`, usually named `agent`,
with typed methods for talking to the agent:

```ts
await acp.client().connectWith(stream, async (agent) => {
  await agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const session = await agent.newSession({
    cwd: "/workspace/project",
    mcpServers: [],
  });

  return agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Hello" }],
  });
});
```

## Active Sessions

For common client flows, use `buildSession(...).runUntil(...)` instead of
manually pairing `newSession`, `prompt`, and `session/update` handling.

```ts
const response = await acp
  .client()
  .sessionUpdate((c) => {
    console.log(c.params.update.sessionUpdate);
  })
  .connectWith(stream, (agent) =>
    agent.buildSession("/workspace/project").runUntil(async (session) => {
      session.sendPrompt("Summarize this project");

      for (;;) {
        const message = await session.readUpdate();
        if (message.kind === "stop") {
          return message.response;
        }

        console.log(message.update.sessionUpdate);
      }
    }),
  );
```

`runUntil` disposes the active session handlers when the callback finishes, even
if the callback throws.

For simple text collection, use `readToString()`:

```ts
const text = await acp.client().connectWith(stream, (agent) =>
  agent.buildSession("/workspace/project").runUntil(async (session) => {
    session.sendPrompt("Explain the repo");
    return session.readToString();
  }),
);
```

## Custom Routes

Use `route(...)` for extension methods or notifications that are not part of the
typed ACP surface.

```ts
acp.client().route<Record<string, unknown>, Record<string, unknown>>({
  kind: "request",
  method: "example.com/echo",
  handler: (c) => ({ message: c.params.message }),
});

acp.agent().route<Record<string, unknown>>({
  kind: "notification",
  method: "example.com/event",
  handler: (c) => {
    console.log(c.params);
  },
});
```

## Sync and Async Implementations

Handlers and implementation helpers can return either values or promises. You do
not need `async` for immediate responses:

```ts
acp
  .client()
  .requestPermission(() => ({ outcome: { outcome: "cancelled" } }))
  .sessionUpdate((c) => {
    console.log(c.params.sessionId);
  });
```

The compatibility `Agent` and `Client` interfaces also accept either values or
promises, so existing helper classes can be simplified incrementally.

## Direct App Connections for Tests

Apps can connect directly to each other without constructing streams. This is
useful for tests and examples:

```ts
const testAgent = acp.agent().newSession(() => ({
  sessionId: "test-session",
}));

const session = await acp.client().connectWith(testAgent, (agent) =>
  agent.newSession({
    cwd: "/workspace/project",
    mcpServers: [],
  }),
);
```

For production transports, keep using `ndJsonStream(...)` or any compatible
`Stream`.

## Low-Level APIs

The branch also exports lower-level JSON-RPC primitives for advanced users:
`Connection`, `ConnectionBuilder`, `ConnectionContext`, `RequestResponder`,
`Handled`, and related handler types.

Most ACP integrations should use `acp.agent(...)` or `acp.client(...)`. Reach
for the lower-level APIs only when building generic JSON-RPC middleware, custom
dispatch, or behavior that the app API does not expose.
