# Changelog

## [0.18.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.18.0...v0.18.1) (2026-04-06)


### Bug Fixes

* Handle ACP connection transport failures cleanly ([#103](https://github.com/agentclientprotocol/typescript-sdk/issues/103)) ([028ee3f](https://github.com/agentclientprotocol/typescript-sdk/commit/028ee3f6c89a51b6e0cc41aea7db97b3f9639812))

## [0.18.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.17.1...v0.18.0) (2026-04-01)


### Features

* **unstable:** Add initial additionalDirectories and NES support ([#104](https://github.com/agentclientprotocol/typescript-sdk/issues/104)) ([43cde3b](https://github.com/agentclientprotocol/typescript-sdk/commit/43cde3ba20ee39040f5c28d4aa3e56adde3bbdae))

## [0.17.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.17.0...v0.17.1) (2026-03-27)


### Bug Fixes

* Make sure we use zod/v4 path for imports ([#99](https://github.com/agentclientprotocol/typescript-sdk/issues/99)) ([e632d3b](https://github.com/agentclientprotocol/typescript-sdk/commit/e632d3be54cc55421b9a1d22c07a5df0b1c89a9b))

## [0.17.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.16.1...v0.17.0) (2026-03-25)


### Features

* **schema:** Update schema to 0.11.3 ([#88](https://github.com/agentclientprotocol/typescript-sdk/issues/88)) ([0fe246e](https://github.com/agentclientprotocol/typescript-sdk/commit/0fe246e8e4979ac637fe7a0d14648ba03baecebf))

## [0.16.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.16.0...v0.16.1) (2026-03-11)


### Bug Fixes

* **unstable:** Fixes for session/close capabilities ([#85](https://github.com/agentclientprotocol/typescript-sdk/issues/85)) ([e8721b7](https://github.com/agentclientprotocol/typescript-sdk/commit/e8721b79505a0a8eae03380bb3029c6419f8f1e6))

## [0.16.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.15.0...v0.16.0) (2026-03-10)


### Features

* add unstable session/close ([#81](https://github.com/agentclientprotocol/typescript-sdk/issues/81)) ([2c9bc77](https://github.com/agentclientprotocol/typescript-sdk/commit/2c9bc77af971f22dc2c30f473f9f3e4b57c47621))
* Stabilize unstable_listSessions to listSessions ([#84](https://github.com/agentclientprotocol/typescript-sdk/issues/84)) ([9e89bbc](https://github.com/agentclientprotocol/typescript-sdk/commit/9e89bbc6907d5ae343448b4d98c492fb296d74cf))

## [0.15.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.14.1...v0.15.0) (2026-03-05)


### Features

* Update to 0.11.0 of the schema ([#79](https://github.com/agentclientprotocol/typescript-sdk/issues/79)) ([2763d63](https://github.com/agentclientprotocol/typescript-sdk/commit/2763d63fe53f25d9af66ff7265915a50e8449e7b))


### Bug Fixes

* use npx.cmd on Windows in client example ([#68](https://github.com/agentclientprotocol/typescript-sdk/issues/68)) ([fdc7815](https://github.com/agentclientprotocol/typescript-sdk/commit/fdc78155f8e917c6e3b854df26a69ec4e8024e74))

## [0.14.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.14.0...v0.14.1) (2026-02-05)


### Bug Fixes

* inconsistent bigint vs number in zod and schema ([#66](https://github.com/agentclientprotocol/typescript-sdk/issues/66)) ([5e3c342](https://github.com/agentclientprotocol/typescript-sdk/commit/5e3c34229279989b385bd26baddc1536202635c8))

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
