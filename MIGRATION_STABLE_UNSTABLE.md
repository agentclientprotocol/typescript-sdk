# Upgrading to stable-by-default apps

This guide applies to the breaking entrypoint split: the default SDK import uses
the stable ACP v1 schema, and unstable v1 features require an explicit opt-in.
The v2 experimental entrypoint follows the same schema-selection rule, but all of
v2 remains a draft. Earlier SDK releases included unstable features in both the
default v1 import and the experimental v2 import.
Consult the versioned changelog for release availability.

This upgrade also removes the deprecated v1 connection classes and implementation
interfaces. Both v1 entrypoints now use the app API. Opting into `/unstable` does
not restore the legacy API.

## Choose one entrypoint

| Import                                              | Protocol surface                           |
| --------------------------------------------------- | ------------------------------------------ |
| `@agentclientprotocol/sdk`                          | Stable v1                                  |
| `@agentclientprotocol/sdk/unstable`                 | Full v1, including unstable features       |
| `@agentclientprotocol/sdk/experimental/v2`          | Stable features of the v2 draft            |
| `@agentclientprotocol/sdk/experimental/v2/unstable` | Full v2 draft, including unstable features |

SDK package versions and ACP protocol versions are independent. This upgrade
does not switch your integration to ACP v2: the default import still speaks ACP
v1.

## Upgrade checklist

1. Choose the protocol version and feature set you need. If your integration
   already uses unstable features, select that version's unstable entrypoint;
   it includes the stable features too.
2. Update protocol imports together: apps, connections, types, method constants,
   and narrowing helpers should come from the selected entrypoint.
3. Audit advertised capabilities, registered handlers, and payload fields—not
   just methods named `unstable_*`. A successful TypeScript build is not enough
   to establish that an existing integration is stable-only.
4. Update JSON schema imports to the versioned paths below, even if you use only
   stable protocol features.
5. Replace legacy connection classes, implementation interfaces, extension
   callbacks, and all `createLegacyAgent` server options with the app APIs below.
   This applies to stable-only integrations too.

```ts
// Stable ACP v1 types, methods, and handler validation.
import * as acp from "@agentclientprotocol/sdk";
```

```ts
// Stable ACP v1 plus the current unstable protocol features.
import * as acp from "@agentclientprotocol/sdk/unstable";
```

Stable-only v1 applications already using the app API can keep their imports
unchanged. Legacy applications must migrate their API usage regardless of which
feature set they select.
Applications using unstable v1 features must move their protocol imports to
`/unstable`, including types, apps, peer contexts, method constants, and
narrowing helpers.

Before:

```ts
import { client, methods, type SystemPrompt } from "@agentclientprotocol/sdk";
```

After:

```ts
import {
  client,
  methods,
  type SystemPrompt,
} from "@agentclientprotocol/sdk/unstable";
```

Use the selected entrypoint consistently throughout an app and its directly
connected in-process peer. Mixing stable and unstable app classes in a direct
`connect(...)` or `connectWith(...)` call is not supported. Peers communicating
over a transport can select their SDK entrypoints independently, provided they
honor the negotiated protocol capabilities.

Each unstable entrypoint is a complete API for its protocol version, not an
add-on to the stable-feature import. Importing it does not change other modules'
stable imports. Protocol wire method names are unchanged. The deprecated
`unstable_*` connection methods are removed with the rest of the legacy API.

## Draft v2 imports

Applications using only the stable-feature set of draft v2 can keep importing from
`@agentclientprotocol/sdk/experimental/v2`. Applications using additional unstable
v2 features must move their protocol imports to
`@agentclientprotocol/sdk/experimental/v2/unstable`:

```ts
import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
```

Both v2 entrypoints remain experimental: their wire protocol and SDK APIs can
change incompatibly in any release. Here, "stable" describes the selected schema
features, not a stability guarantee for v2 itself. Both v2 surfaces retain batch
support and branded unknown variants.

## Check shared types, not just method names

The split also affects fields and variants on otherwise stable types. Examples
of APIs that require `/unstable` include:

- Session forking and provider configuration.
- MCP-over-ACP types and method constants.
- `systemPrompt` on session lifecycle requests and its advertised capabilities.
- Turn `usage` on v1 prompt responses and usage on v2 idle state updates.
- Subagent capabilities and session updates.
- Additional plan representations and `plan_removed` updates. V1's existing
  stable `plan` update and v2's stable item-based `plan_update` remain available
  from their stable-feature entrypoints. V1's ID-based `plan_update`, and v2's
  file and markdown plan representations, require the corresponding unstable
  entrypoint.

For each protocol version, the stable entrypoint's generated types and validators
come from upstream's `schema.json` and `meta.json`. Its unstable entrypoint uses
`schema.unstable.json` and `meta.unstable.json`, including their unstable additions
to shared types.

TypeScript can accept inferred capability objects containing extra fields, and
JavaScript has no compile-time check. Review capability advertisements alongside
explicit handler registrations so that an integration does not advertise a
feature its selected entrypoint will not handle.

Passing unstable fields through untyped code is not a substitute for opting in:
stable-feature request parsing can strip those fields, and stable built-in
handlers do not include unstable methods. Explicit custom-method APIs remain
available.

## JSON schema consumers

In the repository, schema inputs are organized by protocol version under
`schema/v1/` and `schema/v2/`. Each directory uses the same upstream filenames:
`schema.json`, `schema.unstable.json`, `meta.json`, and `meta.unstable.json`.
The JSON schemas are public package exports; metadata files are generation
inputs, not additional public imports.

The canonical stable v1 JSON schema import is:

```text
@agentclientprotocol/sdk/schema/v1/schema.json
```

The previous unversioned `@agentclientprotocol/sdk/schema/schema.json` export has
been removed. JSON schema consumers must update their imports to a versioned
path, even when using only stable definitions.

Tools that need the full v1 schema must switch to:

```text
@agentclientprotocol/sdk/schema/v1/schema.unstable.json
```

V2 schema consumers can choose the stable-feature schema for the v2 draft:

```text
@agentclientprotocol/sdk/schema/v2/schema.json
```

The existing full v2 schema export remains available and unchanged:

```text
@agentclientprotocol/sdk/schema/v2/schema.unstable.json
```

## Apps replace the legacy v1 API

The following APIs are removed from both v1 entrypoints and the NES re-exports:

| Removed API                                                                       | Replacement                                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AgentSideConnection`                                                             | `agent().onRequest(...).onNotification(...).connect(...)`                                                             |
| `ClientSideConnection`                                                            | `client().onRequest(...).onNotification(...).connect(...)` or `connectWith(...)`                                      |
| `Agent` / `Client` implementation interfaces                                      | Typed app callbacks; handler maps are available as `AgentRequestHandlersByMethod` and `ClientRequestHandlersByMethod` |
| Named outbound methods such as `newSession(...)` and `sessionUpdate(...)`         | Peer-context `request(methods.agent.session.new, params)` and `notify(methods.client.session.update, params)`         |
| Outbound `extMethod(...)` / `extNotification(...)`                                | Peer-context `request(...)` / `notify(...)`                                                                           |
| Incoming `extMethod` / `extNotification` callbacks                                | Explicit custom-method handlers or the raw fallback hooks below                                                       |
| `AgentSideConnection.connector(...)` / `LegacyAgentFactory` / `createLegacyAgent` | An app or router supplied through `agent` or `createAgent`                                                            |

`connect(...)` returns a lifecycle handle with `signal` and `closed`. Use its
`.client` context on the agent side, or `.agent` context on the client side, to
call the peer. `connectWith(...)` passes that peer context directly and closes
the connection when the callback finishes. Handler contexts expose the actual
method as `ctx.method`, including in custom and fallback handlers.

### Raw fallback handlers

Use explicit method handlers when the method names are known. If an existing
extension dispatcher needs a catch-all, both agent and client apps support:

```ts
import * as acp from "@agentclientprotocol/sdk";

const app = acp
  .agent()
  .onRequest("*", ({ method, params }) => {
    if (method === "_example/echo") return { echoed: params };
    throw acp.RequestError.methodNotFound(method);
  })
  .onNotification("*", ({ method }) => {
    console.error("Ignoring unregistered notification:", method);
  });
```

Exact handlers take precedence regardless of registration order. Fallbacks run
after normal dispatch, including dynamically registered handlers and protocol
guards. They receive raw `unknown` params, without a parser argument; validate
untrusted input before using it. Register at most one fallback per kind per app.
Without a fallback, unhandled requests still receive Method Not Found and
unhandled notifications are ignored. A fallback does not bypass v2 initialization:
v2 agents still need an explicit `initialize` handler.

### Terminal handles

For v1 client-managed terminals, use `AgentContext.createTerminal(...)` to retain
the handle and disposal ergonomics of the old connection helper:

```ts
import * as acp from "@agentclientprotocol/sdk";

async function runCommand(client: acp.AgentContext, sessionId: string) {
  await using terminal = await client.createTerminal({
    sessionId,
    command: "echo",
    args: ["hello"],
  });
  await terminal.waitForExit();
  return await terminal.currentOutput();
}
```

Check the peer's advertised terminal capability before calling it. The handle
retains `currentOutput()`, `waitForExit()`, `kill()`, `release()`, and async disposal.
For raw responses or per-operation request options, use the corresponding
`request(methods.client.terminal.*, ...)` calls.

### Server factories

The experimental HTTP, WebSocket, server, and Node transport import paths are
unchanged. They can carry stable-feature or unstable apps for either protocol
version; select the app from the appropriate protocol entrypoint. Selecting
stable protocol features does not make these experimental transport APIs stable.

Replace `createLegacyAgent` with a factory returning an app, not an object
implementing the old `Agent` interface. Register each supported method explicitly.
This minimal example uses stable v1; select `/unstable` if the app needs it:

```ts
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

const server = new AcpServer({
  createAgent: () =>
    acp.agent().onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    })),
});
```

Use `agent: app` when intentionally sharing an app across connections, or a
`createAgent` factory that constructs a new app for each connection. Replace per-request and
per-WebSocket-upgrade `createLegacyAgent` overrides too; they are rejected rather
than silently falling back to the default app.

## Development and package contents

`npm run typecheck` checks production code, tests, fixtures, and examples without
emitting files. `npm run build` cleans `dist` and emits production code only.
`npm test` runs source tests once rather than discovering compiled duplicates.
Examples remain in `src/examples` and can be run with `tsx` from a repository
checkout; compiled examples and test helpers are no longer shipped in npm.
`npm run package:check` verifies the packed file allowlist, public exports, and
relative runtime and declaration dependencies. CI runs this check.

## Compatibility and other experiments

The supported Zod versions are `^3.25.76 || ^4.0.0`. Zod 3 users should upgrade
to at least 3.25.76 before installing this SDK. Earlier 3.25.x versions are not
part of the supported range; in particular, 3.25.0 advertises a `zod/v4` export
whose compiled entrypoint is missing.

This is an SDK API boundary, not a new wire protocol version. Both v1 entrypoints
speak ACP v1, and both v2 entrypoints speak the v2 draft. Selecting an unstable
entrypoint does not automatically advertise support or establish peer support:
advertise and check capabilities before using features that require them.

The default v1 entrypoint follows the SDK's normal versioning guarantees. Unstable
features can change or be removed in any SDK release, including non-major
releases.

The existing `@agentclientprotocol/sdk/experimental/nes` entrypoint remains
separate. Importing `/unstable` does not opt into draft v2 or the frozen NES
compatibility APIs.

## Release note summary

**Breaking change:** The default SDK entrypoint now contains only stable ACP v1
definitions. Applications using unstable protocol methods, fields, or variants
must import their protocol API from `@agentclientprotocol/sdk/unstable`.
Stable-only v1 applications already using the app API can keep their imports.
The deprecated `AgentSideConnection`, `ClientSideConnection`, `Agent`, and
`Client` APIs have been removed from both v1 profiles. Use app builders, typed
handlers, and peer-context calls instead. Raw extension fallbacks and v1
terminal-handle helpers are available without the compatibility layer.

The unversioned JSON schema export
`@agentclientprotocol/sdk/schema/schema.json` has been removed. JSON schema
consumers must choose `@agentclientprotocol/sdk/schema/v1/schema.json` for stable
v1 definitions or `@agentclientprotocol/sdk/schema/v1/schema.unstable.json` for
the full v1 schema. Server integrations must replace `createLegacyAgent` and its
connector helper with an app or router through `agent` or `createAgent`.

The experimental v2 entrypoint now uses the stable-feature set of the v2 draft.
Existing v2 applications using additional unstable features must switch their
protocol imports to `@agentclientprotocol/sdk/experimental/v2/unstable`. Both v2
entrypoints remain experimental; this split does not stabilize v2.
