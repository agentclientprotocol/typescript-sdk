# Choosing stable and unstable protocol entrypoints

This guide applies to the breaking entrypoint split: the default SDK import uses
the stable ACP v1 schema, and unstable v1 features require an explicit opt-in.
The v2 experimental entrypoint follows the same schema-selection rule, but all of
v2 remains a draft. Earlier SDK releases included unstable features in both the
default v1 import and the experimental v2 import.
Consult the versioned changelog for release availability.

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
5. If you use the `AcpServer` option `createLegacyAgent` with unstable v1
   features, switch to the explicit unstable connector shown in the legacy-agent
   section.

```ts
// Stable ACP v1 types, methods, and handler validation.
import * as acp from "@agentclientprotocol/sdk";
```

```ts
// Stable ACP v1 plus the current unstable protocol features.
import * as acp from "@agentclientprotocol/sdk/unstable";
```

Stable-only v1 TypeScript applications can keep their imports unchanged.
Applications using unstable v1 features must move their protocol imports to
`/unstable`, including types, apps, connection classes, method constants, and
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
stable imports. Existing `unstable_*` method names are unchanged.

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

TypeScript can accept inferred objects and class implementations containing
extra fields or methods, and JavaScript has no compile-time check. The stable
entrypoint still does not register extra unstable legacy handlers. Review
capability advertisements alongside handler registrations so that an integration
does not advertise a feature its selected entrypoint will not handle.

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

## Transports and legacy agents

The experimental HTTP, WebSocket, server, and Node transport import paths are
unchanged. They can carry stable-feature or unstable apps for either protocol
version; select the app from the appropriate protocol entrypoint. Selecting
stable protocol features does not make these experimental transport APIs stable.

The deprecated `AcpServer` option `createLegacyAgent` now defaults to stable
v1 bindings too. To retain unstable features in an existing legacy agent, import
`AgentSideConnection` from `/unstable` and pass an explicit connector. Given an
existing `createLegacyAgent` factory:

```ts
import { AgentSideConnection } from "@agentclientprotocol/sdk/unstable";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

const server = new AcpServer({
  agent: AgentSideConnection.connector(createLegacyAgent),
});
```

The factory's protocol types must also come from `/unstable`. New implementations
should prefer the app-style `agent()` API.

## Compatibility and other experiments

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
Stable-only v1 TypeScript imports can remain unchanged.

The unversioned JSON schema export
`@agentclientprotocol/sdk/schema/schema.json` has been removed. JSON schema
consumers must choose `@agentclientprotocol/sdk/schema/v1/schema.json` for stable
v1 definitions or `@agentclientprotocol/sdk/schema/v1/schema.unstable.json` for
the full v1 schema. Legacy server integrations that need unstable features must
explicitly select the unstable connection class as shown above.

The experimental v2 entrypoint now uses the stable-feature set of the v2 draft.
Existing v2 applications using additional unstable features must switch their
protocol imports to `@agentclientprotocol/sdk/experimental/v2/unstable`. Both v2
entrypoints remain experimental; this split does not stabilize v2.
