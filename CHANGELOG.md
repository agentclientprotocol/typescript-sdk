# Changelog

## [0.5.2](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.5.1...v0.5.2) (2025-12-01)


### Bug Fixes

* Cleanup some strange code in the generated schema ([#20](https://github.com/agentclientprotocol/typescript-sdk/issues/20)) ([74017f1](https://github.com/agentclientprotocol/typescript-sdk/commit/74017f167c07b19049aa9bc8a942e3af9049fd66))

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
