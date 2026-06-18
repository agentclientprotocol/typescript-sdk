# Migration Guide from v0.26.0 to v0.27.0

This guide covers migrating from the old TypeScript SDK `Agent` and `Client`
interfaces to the app-style SDK API.

The protocol types are the same. The main change is how applications wire their
agent or client implementation into a connection:

- Old code implemented the `Agent` or `Client` interface and passed it through a
  factory to `new AgentSideConnection(...)` or `new ClientSideConnection(...)`.
- New code creates an app with `acp.agent(...)` or `acp.client(...)`, registers
  typed handlers, and connects it to a stream.
- Handlers receive one context object, usually named `ctx`. Request and
  notification params are available as `ctx.params`. Agent handlers use `ctx.client`
  for outbound calls to the client. Client handlers use `ctx.agent` for outbound
  calls to the agent.

`AgentSideConnection` and `ClientSideConnection` still exist as deprecated
compatibility wrappers, but new code should use the app API.

## Quick Mapping

| Old design                                                     | New design                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `new AgentSideConnection((conn) => new MyAgent(conn), stream)` | `acp.agent({ name }).onRequest(...).onNotification(...).connect(stream)`    |
| `new ClientSideConnection((_agent) => client, stream)`         | `acp.client({ name }).onNotification(...).connectWith(stream, async ...)`   |
| Store `AgentSideConnection` on your agent class                | Use `ctx.client` in agent handlers                                          |
| Store/use `ClientSideConnection` for outgoing agent calls      | Use the `ctx` passed to `connectWith`                                       |
| Return a response from an `Agent` or `Client` method           | Return a response from the app request handler                              |
| Throw from implementation methods for JSON-RPC errors          | Throw from an app handler                                                   |
| Manually create session and prompt requests                    | Prefer `ctx.buildSession(...).withSession(...)` for common prompt workflows |

Both `connect(...)` and `connectWith(...)` accept either a `Stream` or the app
for the other side of the connection. Use streams for production transports and
direct app connections for tests or in-process examples.

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

  async authenticate(
    _params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse> {
    return {};
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

  authenticate(_params: acp.AuthenticateRequest): acp.AuthenticateResponse {
    return {};
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    await client.notify(acp.methods.client.session.update, {
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
  .onRequest("initialize", () => implementation.initialize())
  .onRequest("session/new", () => implementation.newSession())
  .onRequest("authenticate", (ctx) => implementation.authenticate(ctx.params))
  .onRequest("session/prompt", (ctx) =>
    implementation.prompt(ctx.params, ctx.client),
  )
  .onNotification("session/cancel", (ctx) => implementation.cancel(ctx.params))
  .connect(stream);
```

For JSON-RPC errors, throw from the handler:

```ts
acp.agent().onRequest("session/prompt", () => {
  throw acp.RequestError.internalError({ details: "prompt failed" });
});
```

Throw `RequestError` when you need a specific JSON-RPC error code. Other
exceptions are converted to internal errors, and validation failures from the
typed handlers are returned as invalid params errors.

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

await connection.initialize({
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
outgoing workflow inside `connectWith`. The callback receives a `ClientContext`
for calling agent methods.

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
  .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
    client.requestPermission(ctx.params),
  )
  .onNotification(acp.methods.client.session.update, (ctx) =>
    client.sessionUpdate(ctx.params),
  )
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd: "/workspace/project",
      mcpServers: [],
    });

    return ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    });
  });
```

`connectWith` owns the connection lifetime for the callback. When the callback
finishes or throws, the connection is closed. If you need the connection to stay
open independently of one operation, call `connect(stream)` and keep the
returned `AcpConnection`.

All protocol paths should be absolute. That includes `cwd`,
`additionalDirectories`, file-system request paths, terminal/tool-call
locations, and any other paths you include in ACP payloads.

## Context Objects

Agent handlers receive an `AgentHandlerContext`:

```ts
acp.agent().onRequest(acp.methods.agent.session.prompt, async (ctx) => {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Checking permissions..." },
    },
  });

  const permission = await ctx.client.request(
    acp.methods.client.session.requestPermission,
    {
      sessionId: ctx.params.sessionId,
      toolCall: {
        toolCallId: "edit-1",
        title: "Edit /workspace/project/config.json",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/workspace/project/config.json" }],
      },
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "Allow this edit",
        },
        {
          optionId: "reject",
          kind: "reject_once",
          name: "Reject this edit",
        },
      ],
    },
  );

  if (permission.outcome.outcome === "cancelled") {
    return { stopReason: "cancelled" };
  }

  return { stopReason: "end_turn" };
});
```

Client handlers receive a `ClientHandlerContext`:

```ts
acp.client().onRequest(acp.methods.client.session.requestPermission, (ctx) => {
  console.log(ctx.params.toolCall.title);
  return { outcome: { outcome: "cancelled" } };
});
```

Agent handler contexts include `params` and `client`. Client handler contexts
include `params` and `agent`.

The `connectWith` callback receives a `ClientContext`, usually named `ctx`,
with `request(...)` and `notify(...)` for talking to the agent:

```ts
await acp.client().connectWith(stream, async (ctx) => {
  await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const session = await ctx.request(acp.methods.agent.session.new, {
    cwd: "/workspace/project",
    mcpServers: [],
  });

  return ctx.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Hello" }],
  });
});
```

## Active Sessions

For common client flows, use `buildSession(...).withSession(...)` instead of
manually pairing `newSession`, `prompt`, and `session/update` handling.

```ts
const response = await acp
  .client()
  .onNotification(acp.methods.client.session.update, (ctx) => {
    console.log(ctx.params.update.sessionUpdate);
  })
  .connectWith(stream, (ctx) =>
    ctx.buildSession("/workspace/project").withSession(async (session) => {
      session.prompt("Summarize this project");

      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          return message.response;
        }

        console.log(message.update.sessionUpdate);
      }
    }),
  );
```

`withSession` disposes the active session handlers when the callback finishes,
even if the callback throws.

Use `buildSession(...)` with a full `NewSessionRequest` when you need to pass
MCP servers, `_meta`, or other `NewSessionRequest` fields. Use
`withAdditionalDirectories(...)` for additional workspace roots; those paths
should also be absolute.

For simple text collection, use `readText()`:

```ts
const text = await acp.client().connectWith(stream, (ctx) =>
  ctx.buildSession("/workspace/project").withSession(async (session) => {
    session.prompt("Explain the repo");
    return session.readText();
  }),
);
```

`readText()` collects text from `agent_message_chunk` updates and returns
when the prompt response is observed.

## Custom Methods

Use `onRequest(...)` and `onNotification(...)` for extension methods or
notifications that are not part of the typed ACP surface. Built-in ACP method
strings infer generated protocol types and normalize empty-object responses.
Use literal strings directly or the readable `acp.methods` namespace for named
constants.

```ts
import { z } from "zod";

const echoParams = z.object({ message: z.string() });

acp.client().onRequest("example.com/echo", echoParams, (ctx) => ({
  message: ctx.params.message,
}));

acp.agent().onNotification("example.com/event", echoParams, (ctx) => {
  console.log(ctx.params.message);
});
```

Pass a parser as the second argument, such as a Zod schema or a `{ parse(...) }`
object, when registering custom extension methods or notifications.

Use `request(...)` and `notify(...)` on `ctx.client` or on the `ctx` passed to
`connectWith` to call custom methods:

```ts
const response = await ctx.request<{ message: string }>("example.com/echo", {
  message: "hello",
});

await ctx.notify("example.com/event", { message: response.message });
```

Known ACP method strings infer their params and response types. Custom method
responses can be typed with a generic, as shown above. Existing legacy
`extMethod` and `extNotification` implementations can keep handling non-ACP
method names while you migrate them to method handlers.

## Sync and Async Implementations

Handlers and implementation helpers can return either values or promises. You do
not need `async` for immediate responses:

```ts
acp
  .client()
  .onRequest(acp.methods.client.session.requestPermission, () => ({
    outcome: { outcome: "cancelled" },
  }))
  .onNotification(acp.methods.client.session.update, (ctx) => {
    console.log(ctx.params.sessionId);
  });
```

The compatibility `Agent` and `Client` interfaces also accept either values or
promises, so existing helper classes can be simplified incrementally.

## Direct App Connections for Tests

Apps can connect directly to each other without constructing streams. This is
useful for tests and examples:

```ts
const testAgent = acp.agent().onRequest(acp.methods.agent.session.new, () => ({
  sessionId: "test-session",
}));

const session = await acp.client().connectWith(testAgent, (ctx) =>
  ctx.request(acp.methods.agent.session.new, {
    cwd: "/workspace/project",
    mcpServers: [],
  }),
);
```

For production transports, keep using `ndJsonStream(...)` or any compatible
`Stream`.
