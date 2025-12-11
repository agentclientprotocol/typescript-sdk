# Changelog

## [0.9.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.8.0...v0.9.0) (2025-12-11)


### Features

* Update to 0.10.1 of the schema ([#36](https://github.com/agentclientprotocol/typescript-sdk/issues/36)) ([210392b](https://github.com/agentclientprotocol/typescript-sdk/commit/210392bfdcb95d2f515784af914323d2606194f6))

## [0.8.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.7.0...v0.8.0) (2025-12-08)


### Features

* Update to 0.10 of the schema ([#31](https://github.com/agentclientprotocol/typescript-sdk/issues/31)) ([f026432](https://github.com/agentclientprotocol/typescript-sdk/commit/f02643202801a8947ce78710ded6f3f7f6fa7ee8))

## [0.7.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.6.0...v0.7.0) (2025-12-01)


### Features

* Update to v0.9.1 of the schema ([#28](https://github.com/agentclientprotocol/typescript-sdk/issues/28)) ([6166944](https://github.com/agentclientprotocol/typescript-sdk/commit/6166944f69a212a6db2d68f315d33ed3214668d4))

## [0.6.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.5.1...v0.6.0) (2025-12-01)

Updates to the latest version of the ACP JSON Schema, [v0.8.0](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/v0.8.0)

This update provides much improved schema interfaces. The migration should be minimal because in TypeScript the interfaces should be functionally equivalent. But there may be some areas where the types are now more informative to the compiler and will hopefully help you catch errors earlier.

## 0.5.1 (2025-10-24)

- Add ability for agents and clients to provide information about their implementation
- Fix incorrectly serialized `_meta` field on `SetSessionModeResponse

## 0.5.0 (2025-10-24)

- Provide access to an `AbortSignal` and `closed` promise on connections so you can wait for the connection to close and handle any other cleanup tasks you need for a graceful shutdown. https://github.com/agentclientprotocol/typescript-sdk/pull/11
- Allow for more customization of error messages: https://github.com/agentclientprotocol/typescript-sdk/pull/12
- Update to latest ACP JSON Schema: https://github.com/agentclientprotocol/typescript-sdk/pull/10

## 0.4.9 (20205-10-21)

- Fix: incorrect method for session/set_model client implementation.

## 0.4.8 (2025-10-15)

- Fix: return valid setSessionModel response object

## 0.4.7 (2025-10-11)

- New repo: https://github.com/agentclientprotocol/typescript-sdk

## 0.4.6 (2025-10-10)

- No changes

## 0.4.5 (2025-10-02)

- **Unstable** initial support for model selection.

## 0.4.4 (2025-09-30)

### Protocol

- Correctly mark capability-based `Agent` and `Client` methods as optional.

## 0.4.3 (2025-09-25)

- No changes

## 0.4.2 (2025-09-22)

- No changes

## 0.4.1 (2025-09-22)

- No changes

## 0.4.0 (2025-09-17)

- Use Stream abstraction instead of raw byte streams [#93](https://github.com/agentclientprotocol/agent-client-protocol/pull/93)
  - Makes it easier to use with websockets instead of stdio
- Improve type safety for method map helpers [#94](https://github.com/agentclientprotocol/agent-client-protocol/pull/94)
