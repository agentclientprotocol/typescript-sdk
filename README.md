<a href="https://agentclientprotocol.com/" >
  <img alt="Agent Client Protocol" src="https://zed.dev/img/acp/banner-dark.webp">
</a>

# ACP TypeScript Library

The official TypeScript implementation of the Agent Client Protocol (ACP) — a standardized communication protocol between code editors and AI-powered coding agents.

Learn more at https://agentclientprotocol.com

## Installation

```bash
npm install @agentclientprotocol/sdk
```

## Choose a protocol entrypoint

| Import                                              | Provides                                   |
| --------------------------------------------------- | ------------------------------------------ |
| `@agentclientprotocol/sdk`                          | Stable ACP v1 (default)                    |
| `@agentclientprotocol/sdk/unstable`                 | Stable v1 plus unstable features           |
| `@agentclientprotocol/sdk/experimental/v2`          | Stable features of the v2 draft            |
| `@agentclientprotocol/sdk/experimental/v2/unstable` | Full v2 draft, including unstable features |

Each `/unstable` entrypoint includes the stable features for its protocol
version, plus additions that may change or be removed in any SDK release. Use
one entrypoint consistently for an app, its protocol types, and method constants.
Directly connected in-process app pairs must use the same entrypoint.

Selecting an unstable entrypoint does not automatically advertise feature support
or establish peer support: advertise and check capabilities before using them.

Upgrading an existing integration? If you use unstable features, update your
protocol imports even if your application still compiles. Read the
[migration guide](https://github.com/agentclientprotocol/typescript-sdk/blob/main/MIGRATION_STABLE_UNSTABLE.md)
for the upgrade checklist, versioned JSON schema paths, and legacy-server changes.

## Experimental ACP v2

> **Warning:** Both v2 entrypoints remain experimental. "Stable" describes the
> selected feature set, not a stability guarantee for the v2 protocol or SDK API.
> The v2 wire protocol and these SDK APIs may change incompatibly in any release.

The default SDK import remains ACP v1. To select the stable features of the v2
draft, use:

```ts
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
```

Browse the [experimental v2 TypeScript API reference](https://agentclientprotocol.github.io/typescript-sdk/v2/)
and the [draft ACP v2 protocol documentation](https://agentclientprotocol.com/protocol/v2/draft/overview)
for the current SDK and protocol designs.

In v2, the extensible unions (`SessionUpdate`, `ContentBlock`, and so on) also
accept variants this SDK does not know, such as ones added by a newer ACP
version. Only received values can be such an `UnknownVariant`, so a value you
build is checked field by field at any depth, and a custom variant needs a tag
that starts with `_`. Received values pass on unchanged, for example when an
agent echoes a prompt's content into its user message.

## Get Started

### Understand the Protocol

Start by reading the [official ACP documentation](https://agentclientprotocol.com) to understand the core concepts and protocol specification.

### Try the Examples

The [examples directory](https://github.com/agentclientprotocol/typescript-sdk/tree/main/src/examples) contains simple implementations of both Agents and Clients in TypeScript. These examples can be run from your terminal or from an ACP Client like [Zed](https://zed.dev), making them great starting points for your own integration!

### Explore the API

Browse the [TypeScript library reference](https://agentclientprotocol.github.io/typescript-sdk) for detailed API documentation.

If you're building an [Agent](https://agentclientprotocol.com/protocol/overview#agent), start with `agent({ name })`, register handlers with `onRequest(methods.agent.initialize, handler)` and the other method constants, then call `connect(stream)`.

If you're building a [Client](https://agentclientprotocol.com/protocol/overview#client), start with `client({ name })`, register client-side handlers with `onRequest(...)` and `onNotification(...)`, then run your agent workflow with `connectWith(stream, async (ctx) => ...)`. Call the peer with `ctx.request(methods.agent.session.new, params)` and the other method constants.

### Study a Production Implementation

For a complete, production-ready implementation, check out the [Gemini CLI Agent](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/zed-integration/zedIntegration.ts).

## Resources

- [Library docs](https://agentclientprotocol.github.io/typescript-sdk)
- [Examples](https://github.com/agentclientprotocol/typescript-sdk/tree/main/src/examples)
- [Protocol Documentation](https://agentclientprotocol.com)
- [GitHub Repository](https://github.com/agentclientprotocol/typescript-sdk)
- [NPM Package](https://www.npmjs.com/package/@agentclientprotocol/sdk)

## Contributing

See the main [repository](https://github.com/agentclientprotocol/typescript-sdk) for contribution guidelines.

### License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
