# Changelog

## [0.14.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.13.1...v0.14.0) (2026-02-04)


### Features

* Stabilize Session Config Options ([#64](https://github.com/agentclientprotocol/typescript-sdk/issues/64)) ([15806a2](https://github.com/agentclientprotocol/typescript-sdk/commit/15806a212c7de266a87db8d265d53f2ecc4b8963))

## [0.13.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.13.0...v0.13.1) (2026-01-22)


### Bug Fixes

* **schema:** Update to schema v0.10.7 ([#58](https://github.com/agentclientprotocol/typescript-sdk/issues/58)) ([ade1b68](https://github.com/agentclientprotocol/typescript-sdk/commit/ade1b6842b12ac9acece6d4540e00bca8ce8cdb3))

## [0.13.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.12.0...v0.13.0) (2026-01-13)


### Features

* (breaking) no more auto underscoring of extension methods ([#55](https://github.com/agentclientprotocol/typescript-sdk/issues/55)) ([ec4b095](https://github.com/agentclientprotocol/typescript-sdk/commit/ec4b0950ff5bcdfa60826e720c25575929d1f034))
* add unstable session config option handling ([#56](https://github.com/agentclientprotocol/typescript-sdk/issues/56)) ([ec7bb47](https://github.com/agentclientprotocol/typescript-sdk/commit/ec7bb47628f2be505e8fe0f784674dc6573d2f15))
* Update to 0.10.6 of the schema ([#53](https://github.com/agentclientprotocol/typescript-sdk/issues/53)) ([766964e](https://github.com/agentclientprotocol/typescript-sdk/commit/766964e29df567a4725911002c3184b0c19ec99a))

## [0.12.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.11.0...v0.12.0) (2025-12-16)


### Features

* **unstable:** add list sessions method ([#47](https://github.com/agentclientprotocol/typescript-sdk/issues/47)) ([2efd404](https://github.com/agentclientprotocol/typescript-sdk/commit/2efd40492a5569cbe0f570731279dc8e9ebeb9d0))
* Update to 0.10.4 of the schema ([#49](https://github.com/agentclientprotocol/typescript-sdk/issues/49)) ([6c44fb2](https://github.com/agentclientprotocol/typescript-sdk/commit/6c44fb239c8420d0f797aa111d7d1ec6ec2d77da))

## [0.11.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.10.0...v0.11.0) (2025-12-12)


### Features

* **unstable:** add resumeSession support ([#41](https://github.com/agentclientprotocol/typescript-sdk/issues/41)) ([721c450](https://github.com/agentclientprotocol/typescript-sdk/commit/721c450c1eea1ec4ed2bcaf370a02b2ebfd2aa1c))

## [0.10.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.9.0...v0.10.0) (2025-12-11)


### Features

* Update to 0.10.2 of the schema ([#39](https://github.com/agentclientprotocol/typescript-sdk/issues/39)) ([0773dde](https://github.com/agentclientprotocol/typescript-sdk/commit/0773ddecc9881cbf18265c26ef422a51aeb7617b))

## [0.9.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.8.0...v0.9.0) (2025-12-11)


### Features

* Update to 0.10.1 of the schema ([#36](https://github.com/agentclientprotocol/typescript-sdk/issues/36)) ([210392b](https://github.com/agentclientprotocol/typescript-sdk/commit/210392bfdcb95d2f515784af914323d2606194f6))
* Unstable: add unstable forkSession support [#37](https://github.com/agentclientprotocol/typescript-sdk/pull/37)

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
