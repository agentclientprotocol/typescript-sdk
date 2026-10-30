# Changelog

Migration guide: [Stable and unstable protocol entrypoints](MIGRATION_STABLE_UNSTABLE.md).

## [2.2.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.1.0...v2.2.0) (2026-10-30)


### Features

* update to schema v1.28.0 and v2.0.0-alpha.11 ([#326](https://github.com/agentclientprotocol/typescript-sdk/issues/326)) ([c19627e](https://github.com/agentclientprotocol/typescript-sdk/commit/c19627e10f439705f42161228459379ea65a0147))
* **v2:** add a helper that rejects unadvertised MCP transports ([#324](https://github.com/agentclientprotocol/typescript-sdk/issues/324)) ([08a0d30](https://github.com/agentclientprotocol/typescript-sdk/commit/08a0d30f023bf86574d49d59c4154e44d4386f55))
* **v2:** keep ActiveSession.configOptions in sync with config updates ([#323](https://github.com/agentclientprotocol/typescript-sdk/issues/323)) ([446874d](https://github.com/agentclientprotocol/typescript-sdk/commit/446874d7337c9a3c28bad882a4b832d4cb5efe83))

## [2.1.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.0.2...v2.1.0) (2026-10-28)


### Features

* add RequestError.sessionNotFound and align examples and docs with the latest protocol ([#317](https://github.com/agentclientprotocol/typescript-sdk/issues/317)) ([cbb81e9](https://github.com/agentclientprotocol/typescript-sdk/commit/cbb81e92d30b60367f0892726e0674e6db2b5433))
* **unstable:** add MCP-over-ACP caller and provider ([#311](https://github.com/agentclientprotocol/typescript-sdk/issues/311)) ([1fe5041](https://github.com/agentclientprotocol/typescript-sdk/commit/1fe5041ba058499d15b54bcdcb0d96785b8e8ea2))
* **unstable:** add MCP-over-ACP HTTP bridge ([#313](https://github.com/agentclientprotocol/typescript-sdk/issues/313)) ([b979377](https://github.com/agentclientprotocol/typescript-sdk/commit/b979377f0c873674cc0187bd15117b7078a008db))
* **unstable:** serve MCP SDK servers over MCP-over-ACP ([#314](https://github.com/agentclientprotocol/typescript-sdk/issues/314)) ([bca8e49](https://github.com/agentclientprotocol/typescript-sdk/commit/bca8e49199927e167fab74db4dd76dec4743bb49))
* update to schema v1.27.0 and v2.0.0-alpha.10 ([#315](https://github.com/agentclientprotocol/typescript-sdk/issues/315)) ([6c3e6d3](https://github.com/agentclientprotocol/typescript-sdk/commit/6c3e6d3780b74fa530abd69b64f3fe7655ad82e5))


### Bug Fixes

* don't print raw invalid messages or failed notification params ([#318](https://github.com/agentclientprotocol/typescript-sdk/issues/318)) ([c5db504](https://github.com/agentclientprotocol/typescript-sdk/commit/c5db50486663c2f2152634108ea2614fe4cf04f4))
* match Rust parsing for null lists, elicitation scope and 64-bit integers ([#316](https://github.com/agentclientprotocol/typescript-sdk/issues/316)) ([a68441d](https://github.com/agentclientprotocol/typescript-sdk/commit/a68441d4a85dd08439ae330ea80d075246cff5dc))
* **v2:** follow v2 initialize negotiation rules and reject null request IDs ([#319](https://github.com/agentclientprotocol/typescript-sdk/issues/319)) ([4805748](https://github.com/agentclientprotocol/typescript-sdk/commit/4805748fa365e44d0ce7487355b2e5dfbf0b899b))

## [2.0.2](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.0.1...v2.0.2) (2026-10-23)


### Bug Fixes

* **http:** handle CR line endings in SSE streams ([#306](https://github.com/agentclientprotocol/typescript-sdk/issues/306)) ([fd86335](https://github.com/agentclientprotocol/typescript-sdk/commit/fd86335aa340e4f1be4837d583e840b670d6a6cf))
* isolate request-scoped HTTP POST failures ([#307](https://github.com/agentclientprotocol/typescript-sdk/issues/307)) ([d9db04d](https://github.com/agentclientprotocol/typescript-sdk/commit/d9db04db30a9ec47cda64fa35bca6694338b29e9))

## [2.0.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v2.0.0...v2.0.1) (2026-10-22)


### Bug Fixes

* **http:** Isolate session stream conflicts from shared transport ([#303](https://github.com/agentclientprotocol/typescript-sdk/issues/303)) ([ad220c7](https://github.com/agentclientprotocol/typescript-sdk/commit/ad220c7b35f2df60c5902e9b8889664a2674f5ab))

## [2.0.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.9.0...v2.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* AgentSideConnection, ClientSideConnection, Agent, Client, LegacyAgentFactory, createLegacyAgent, and their extension aliases and connector helper have been removed. Use agent()/client() apps and peer-context request()/notify() calls. Compiled tests, fixtures, and examples are no longer published. See MIGRATION_STABLE_UNSTABLE.md for migration instructions.
* Default v1 and experimental v2 imports now expose only stable-feature schemas. Unstable v1 features require @agentclientprotocol/sdk/unstable; unstable v2 features require @agentclientprotocol/sdk/experimental/v2/unstable. Both v2 entrypoints remain experimental. SDK 2.0 does not switch the default protocol from ACP v1. The unversioned JSON schema export is removed; use the versioned schema/v1 or schema/v2 exports. All legacy v1 integrations must migrate to agent()/client() apps regardless of feature profile; opting into /unstable does not restore the removed connection classes or connector helper. See https://github.com/agentclientprotocol/typescript-sdk/blob/main/MIGRATION_STABLE_UNSTABLE.md for migration instructions.

### Features

* make stable protocol bindings the default ([6caf469](https://github.com/agentclientprotocol/typescript-sdk/commit/6caf46998ccdfc0ac27618881a446b2243055e95))
* retire legacy connection APIs and publish production-only builds ([#294](https://github.com/agentclientprotocol/typescript-sdk/issues/294)) ([52edc15](https://github.com/agentclientprotocol/typescript-sdk/commit/52edc1575d40c70ca6a6f640d827025794c1497f))


### Bug Fixes

* enforce supported Zod floor and patch generator YAML parser ([#296](https://github.com/agentclientprotocol/typescript-sdk/issues/296)) ([f0cab19](https://github.com/agentclientprotocol/typescript-sdk/commit/f0cab1937935e3ee75473b4ec66d4876f33807a6))
* import zod as a namespace so bundlers can tree-shake it ([#291](https://github.com/agentclientprotocol/typescript-sdk/issues/291)) ([60619a4](https://github.com/agentclientprotocol/typescript-sdk/commit/60619a459869d1d93dfc9cb8fd4764a8d80cdfe7))

## [1.9.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.8.0...v1.9.0) (2026-10-16)


### Features

* isolate NES behind an experimental entrypoint ([#284](https://github.com/agentclientprotocol/typescript-sdk/issues/284)) ([e3678c2](https://github.com/agentclientprotocol/typescript-sdk/commit/e3678c27d1826e126652286fd77434afe73bab4c))
* update schemas to v1.26.0 and v2.0.0-alpha.9 ([#285](https://github.com/agentclientprotocol/typescript-sdk/issues/285)) ([93599f3](https://github.com/agentclientprotocol/typescript-sdk/commit/93599f34d2d682bd690dedada9a032deec2b9a56))


### Bug Fixes

* accept omitted and null params for optional requests ([#282](https://github.com/agentclientprotocol/typescript-sdk/issues/282)) ([a2fbbb9](https://github.com/agentclientprotocol/typescript-sdk/commit/a2fbbb9db5b17d76f1852def45d804523a7f7c3b))
* **examples:** report v2 turn failures on idle ([#279](https://github.com/agentclientprotocol/typescript-sdk/issues/279)) ([28b1291](https://github.com/agentclientprotocol/typescript-sdk/commit/28b1291f7c320d7d9070dadcdc6dfa42298ac292))
* preserve outgoing v2 initialize payloads ([#283](https://github.com/agentclientprotocol/typescript-sdk/issues/283)) ([b98857b](https://github.com/agentclientprotocol/typescript-sdk/commit/b98857b3f0342915728d7e30d8a7258311054f8f))
* **v2:** align protocol version negotiation ([#286](https://github.com/agentclientprotocol/typescript-sdk/issues/286)) ([4197b89](https://github.com/agentclientprotocol/typescript-sdk/commit/4197b8925d52cefec9c065926a3f605a2cf2a2b7))
* **v2:** decouple session updates from prompt completion ([#280](https://github.com/agentclientprotocol/typescript-sdk/issues/280)) ([0154528](https://github.com/agentclientprotocol/typescript-sdk/commit/015452892b1aca42202b59ddc934c6a7481938e2))

## [1.8.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.7.0...v1.8.0) (2026-10-09)


### Features

* **schema:** update to v1.25.0 and v2.0.0-alpha.8 ([#273](https://github.com/agentclientprotocol/typescript-sdk/issues/273)) ([c979649](https://github.com/agentclientprotocol/typescript-sdk/commit/c979649b1b69d6576e3b6a29e152235b4c324984))

## [1.7.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.6.1...v1.7.0) (2026-10-02)


### Features

* **v2:** check the extensible-union values you build ([#268](https://github.com/agentclientprotocol/typescript-sdk/issues/268)) ([8a60383](https://github.com/agentclientprotocol/typescript-sdk/commit/8a60383d6c411c87b766d6cca387c54c9d017d09))

## [1.6.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.6.0...v1.6.1) (2026-10-02)


### Bug Fixes

* type the routed connection's closed promise as always present ([#265](https://github.com/agentclientprotocol/typescript-sdk/issues/265)) ([9d9fa3d](https://github.com/agentclientprotocol/typescript-sdk/commit/9d9fa3dba2ed77fc4053e738e25c7003b7f88384))

## [1.6.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.5.1...v1.6.0) (2026-10-01)


### Features

* update schemas to v1.24.1 and v2.0.0-alpha.7 ([#263](https://github.com/agentclientprotocol/typescript-sdk/issues/263)) ([a1a80ff](https://github.com/agentclientprotocol/typescript-sdk/commit/a1a80ff5ad3b8587ee0156df84a06236c1095df9))

## [1.5.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.5.0...v1.5.1) (2026-09-28)


### Bug Fixes

* bound incoming transport message sizes ([#259](https://github.com/agentclientprotocol/typescript-sdk/issues/259)) ([69fda37](https://github.com/agentclientprotocol/typescript-sdk/commit/69fda3703bfb3a33d2f0e9fa6b90081270297d4c))
* bound per-connection memory in AcpServer ([#261](https://github.com/agentclientprotocol/typescript-sdk/issues/261)) ([4356253](https://github.com/agentclientprotocol/typescript-sdk/commit/4356253eb95ad02d9278af93e9ae6a28cf1d7a67))

## [1.5.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.4.0...v1.5.0) (2026-09-21)


### Features

* update schemas to v1.22.0 and v2.0.0-alpha.4 ([#253](https://github.com/agentclientprotocol/typescript-sdk/issues/253)) ([a9f08bd](https://github.com/agentclientprotocol/typescript-sdk/commit/a9f08bd03cb643d4d20a7da12daa1abe7d0bd3ba))
* update schemas to v1.23.0 and v2.0.0-alpha.5 ([#255](https://github.com/agentclientprotocol/typescript-sdk/issues/255)) ([f7941e7](https://github.com/agentclientprotocol/typescript-sdk/commit/f7941e753be6c809230307c7cf8b4f9ee220018c))

## [1.4.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.3.0...v1.4.0) (2026-08-20)


### Features

* Stabilize elicitation APIs ([#242](https://github.com/agentclientprotocol/typescript-sdk/issues/242)) ([dc3b0e4](https://github.com/agentclientprotocol/typescript-sdk/commit/dc3b0e420f5a6334ced6404832d8113f5ec93916))


### Bug Fixes

* **jsonrpc:** report malformed input ([#230](https://github.com/agentclientprotocol/typescript-sdk/issues/230)) ([0819dbe](https://github.com/agentclientprotocol/typescript-sdk/commit/0819dbebfbed9e8262f6c6617ac57d3408120b1b))
* **server:** preserve routed outbound messages ([#231](https://github.com/agentclientprotocol/typescript-sdk/issues/231)) ([5f58a95](https://github.com/agentclientprotocol/typescript-sdk/commit/5f58a95a10bfb67cc21c9c48c8436cf021c67fd8))
* **v2:** enforce initialization lifecycle ([#235](https://github.com/agentclientprotocol/typescript-sdk/issues/235)) ([b7d6e81](https://github.com/agentclientprotocol/typescript-sdk/commit/b7d6e81feae289e171ebaf78b4b3db8386c1fff0))
* **v2:** enforce method contracts ([#229](https://github.com/agentclientprotocol/typescript-sdk/issues/229)) ([0101014](https://github.com/agentclientprotocol/typescript-sdk/commit/01010146a731212fbbb677d6055e0b7bf183b288))

## [1.3.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.2.1...v1.3.0) (2026-07-21)


### Features

* **experimental:** Add experimental ACP v2 API ([#223](https://github.com/agentclientprotocol/typescript-sdk/issues/223)) ([26cdeb4](https://github.com/agentclientprotocol/typescript-sdk/commit/26cdeb48dc389335830fdb51d61dbfa88d644e96))
* Update to schema v1.20.0 and v2.0.0-alpha.2 ([#225](https://github.com/agentclientprotocol/typescript-sdk/issues/225)) ([cb61107](https://github.com/agentclientprotocol/typescript-sdk/commit/cb61107a3a9c9881bcf1a7988596bdd17aaf93c5))

## [1.2.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.2.0...v1.2.1) (2026-07-07)


### Bug Fixes

* **http:** make SSE close and response delivery deterministic ([#209](https://github.com/agentclientprotocol/typescript-sdk/issues/209)) ([2adee0f](https://github.com/agentclientprotocol/typescript-sdk/commit/2adee0f5071bd1201c84b7d8a2836cfe011d4c9a))
* Preserve extensible union semantics in TS schemas ([#215](https://github.com/agentclientprotocol/typescript-sdk/issues/215)) ([e323221](https://github.com/agentclientprotocol/typescript-sdk/commit/e3232216ac172283e4f77f9d75c12f820952b5e9))

## [1.2.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.1.0...v1.2.0) (2026-07-06)


### Features

* Update schema to 1.17.0 ([#204](https://github.com/agentclientprotocol/typescript-sdk/issues/204)) ([fa8b5bd](https://github.com/agentclientprotocol/typescript-sdk/commit/fa8b5bd426fec07a85203d6a6e4b83d173243cf1))
* Update schema to 1.19.0 ([#213](https://github.com/agentclientprotocol/typescript-sdk/issues/213)) ([6599433](https://github.com/agentclientprotocol/typescript-sdk/commit/6599433640feb8e36372a767554869fd5097fdd3))


### Bug Fixes

* make ndJsonStream receive path linear in message size ([#210](https://github.com/agentclientprotocol/typescript-sdk/issues/210)) ([2fc41d2](https://github.com/agentclientprotocol/typescript-sdk/commit/2fc41d2822579f754042db4d4f8c53b7c9b9ad2f))
* unify JSON-RPC message validation policy across transports ([#212](https://github.com/agentclientprotocol/typescript-sdk/issues/212)) ([5e01eb2](https://github.com/agentclientprotocol/typescript-sdk/commit/5e01eb2ac2cd72c8c6ebff1015874366c781eaa5)), closes [#211](https://github.com/agentclientprotocol/typescript-sdk/issues/211)

## [1.1.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.0.0...v1.1.0) (2026-06-29)


### Features

* Expose request ids in handler contexts ([#202](https://github.com/agentclientprotocol/typescript-sdk/issues/202)) ([eda849c](https://github.com/agentclientprotocol/typescript-sdk/commit/eda849ca7894f32e4ed11df81eb5b024e5512e5b))

## [1.0.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.29.0...v1.0.0) (2026-06-24)


### Features

* **schema:** Update to v1.16.0 of the schema ([#199](https://github.com/agentclientprotocol/typescript-sdk/issues/199)) ([de58791](https://github.com/agentclientprotocol/typescript-sdk/commit/de5879100c1bb5e2fdaebc957c1ca01364eb33cc))


### Miscellaneous Chores

* release 1.0.0 ([#201](https://github.com/agentclientprotocol/typescript-sdk/issues/201)) ([008fc28](https://github.com/agentclientprotocol/typescript-sdk/commit/008fc2861adc3f87edc4daa12eb78b81a6fd7161))

## [0.29.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.28.1...v0.29.0) (2026-06-22)


### Features

* **unstable:** Add support for request cancellation ([#195](https://github.com/agentclientprotocol/typescript-sdk/issues/195)) ([d5197f9](https://github.com/agentclientprotocol/typescript-sdk/commit/d5197f9f6346a4b57084552e0bdf3c71ccf64412))

## [0.28.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.28.0...v0.28.1) (2026-06-19)


### Bug Fixes

* Expose peer contexts from app connections ([#190](https://github.com/agentclientprotocol/typescript-sdk/issues/190)) ([d657310](https://github.com/agentclientprotocol/typescript-sdk/commit/d6573109fd7c27170cd970aa9b28e7e6054e993e))

## [0.28.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.27.1...v0.28.0) (2026-06-18)


### Features

* **schema:** Update to schema v1.14.0 ([#185](https://github.com/agentclientprotocol/typescript-sdk/issues/185)) ([3c619a7](https://github.com/agentclientprotocol/typescript-sdk/commit/3c619a737120bbd4ccc6282b893e94152125562c))

## [0.27.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.27.0...v0.27.1) (2026-06-18)


### Bug Fixes

* **node-adapter:** Cap HTTP request body size ([#186](https://github.com/agentclientprotocol/typescript-sdk/issues/186)) ([3832d4c](https://github.com/agentclientprotocol/typescript-sdk/commit/3832d4ce69d9f44c5f886c9b3ff24169d6119236))
* **node-adapter:** harden Node adapter request parsing ([220eae6](https://github.com/agentclientprotocol/typescript-sdk/commit/220eae660e459ac648fe352b756b586f39f9aa1e))

## [0.27.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.26.0...v0.27.0) (2026-06-18)

This is a big release! We have rewritten the SDK to have a more ergonomic design for creating new agents and clients. You can read more in the [Migration Guide](https://github.com/agentclientprotocol/typescript-sdk/blob/main/MIGRATION_0.26_0.27.md) for how to migrate.

For now, you will still have the old interfaces available to ease the migration, but they are deprecated and will be removed in a future release.

### Features

* Experimental Streamable HTTP & WebSocket Transport ([#155](https://github.com/agentclientprotocol/typescript-sdk/issues/155)) ([d6a3d88](https://github.com/agentclientprotocol/typescript-sdk/commit/d6a3d88107d3a4440479a1aba3c664eccd384661))
* New SDK design (see MIGRATION_0.26_0.27.md) ([#181](https://github.com/agentclientprotocol/typescript-sdk/issues/181)) ([87e2df3](https://github.com/agentclientprotocol/typescript-sdk/commit/87e2df33b5c8a010bd9e4d750c5a6a32ecb82388))

## [0.26.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.25.1...v0.26.0) (2026-06-16)


### Features

* **schema:** Update to v1.13.7 of the schema ([#179](https://github.com/agentclientprotocol/typescript-sdk/issues/179)) ([34885b6](https://github.com/agentclientprotocol/typescript-sdk/commit/34885b639326bcfbda2053aab4679bd2f9773fec))

## [0.25.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.25.0...v0.25.1) (2026-06-13)


### Bug Fixes

* cleanup zod generation ([#170](https://github.com/agentclientprotocol/typescript-sdk/issues/170)) ([be44483](https://github.com/agentclientprotocol/typescript-sdk/commit/be44483cf0e49ffe8d078361f091e8783f69ed14))
* Zod type inference errors ([#177](https://github.com/agentclientprotocol/typescript-sdk/issues/177)) ([d9fafa2](https://github.com/agentclientprotocol/typescript-sdk/commit/d9fafa20533e907a02754251a741a58f0cc07e81))

## [0.25.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.24.0...v0.25.0) (2026-06-05)


### Features

* **schema:** stabilize deleteSession ([#168](https://github.com/agentclientprotocol/typescript-sdk/issues/168)) ([2cc77af](https://github.com/agentclientprotocol/typescript-sdk/commit/2cc77af0b4b9d8d4f64b41ed266e32ce00010bdc))

## [0.24.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.23.0...v0.24.0) (2026-06-02)


### Features

* Add resilient schema deserialization ([#167](https://github.com/agentclientprotocol/typescript-sdk/issues/167)) ([5864e73](https://github.com/agentclientprotocol/typescript-sdk/commit/5864e7306e0feb0852cef9aee2a5ba53a0a7f627))
* **schema:** Stabilize addl dirs and remove unstable model selectors ([#165](https://github.com/agentclientprotocol/typescript-sdk/issues/165)) ([fa6e302](https://github.com/agentclientprotocol/typescript-sdk/commit/fa6e30280874ccd702cc4ab7577d402d2864f619))

## [0.23.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.22.1...v0.23.0) (2026-06-01)


### Features

* **schema:** Stabilize logout and update schema to v0.13.4 ([#163](https://github.com/agentclientprotocol/typescript-sdk/issues/163)) ([cfd900a](https://github.com/agentclientprotocol/typescript-sdk/commit/cfd900a981eb00dbcdee52db2b2b38847a957328))

## [0.22.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.22.0...v0.22.1) (2026-05-18)


### Bug Fixes

* Event ordering ([#153](https://github.com/agentclientprotocol/typescript-sdk/issues/153)) ([7b63226](https://github.com/agentclientprotocol/typescript-sdk/commit/7b632266f009865d0e8e64def5cd55367363845b))

## [0.22.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.21.1...v0.22.0) (2026-05-18)


### Features

* **unstable:** Add session delete handling ([#152](https://github.com/agentclientprotocol/typescript-sdk/issues/152)) ([f9384f5](https://github.com/agentclientprotocol/typescript-sdk/commit/f9384f59008298b44fd1e22e5dde3f2e922fc7ec))
* Update schema to v0.13.2 ([#150](https://github.com/agentclientprotocol/typescript-sdk/issues/150)) ([b15960b](https://github.com/agentclientprotocol/typescript-sdk/commit/b15960b74667f9a582470d58c18ebb9054e5acfd))

## [0.21.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.21.0...v0.21.1) (2026-05-14)


### Bug Fixes

* emit .js extensions in generated schema barrel for nodenext consumers ([#146](https://github.com/agentclientprotocol/typescript-sdk/issues/146)) ([63b96db](https://github.com/agentclientprotocol/typescript-sdk/commit/63b96db49d4826c02fe4afc62a7754db1f9f9ef7))

## [0.21.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.20.0...v0.21.0) (2026-04-28)


### Features

* **unstable:** Add `providers/*` support ([#138](https://github.com/agentclientprotocol/typescript-sdk/issues/138)) ([e234c21](https://github.com/agentclientprotocol/typescript-sdk/commit/e234c213d362d2cd170f8215fa0758a62a59d54e))

## [0.20.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.19.2...v0.20.0) (2026-04-23)


### Features

* Stabilize `closeSession` and `resumeSession` ([#132](https://github.com/agentclientprotocol/typescript-sdk/issues/132)) ([806d307](https://github.com/agentclientprotocol/typescript-sdk/commit/806d307ba92e824e859075f3f72fe1e9b35b8f0b))

## [0.19.2](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.19.1...v0.19.2) (2026-04-23)


### Bug Fixes

* Avoid event loop timing causing out of order messages ([#130](https://github.com/agentclientprotocol/typescript-sdk/issues/130)) ([8f514f3](https://github.com/agentclientprotocol/typescript-sdk/commit/8f514f348decd2ed0f8a57b845c7e170aaa75376))

## [0.19.1](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.19.0...v0.19.1) (2026-04-21)


### Bug Fixes

* avoid spurious unhandledRejection when transport fails mid-sendRequest ([#122](https://github.com/agentclientprotocol/typescript-sdk/issues/122)) ([b6b2cb4](https://github.com/agentclientprotocol/typescript-sdk/commit/b6b2cb44650286b4dc9ea8097cef46d4c41b6f1f))
* Flush decoder state at end of NDJSON stream ([#119](https://github.com/agentclientprotocol/typescript-sdk/issues/119)) ([4e1b07a](https://github.com/agentclientprotocol/typescript-sdk/commit/4e1b07aab3fbbcc5b2c0bfbfa0adc63e1aa53f92))
* Use TypeScript private keyword instead of ES #private fields ([#127](https://github.com/agentclientprotocol/typescript-sdk/issues/127)) ([c6e6ee2](https://github.com/agentclientprotocol/typescript-sdk/commit/c6e6ee2f369fde017e0f4df48e509bf041ab8985))

## [0.19.0](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.18.2...v0.19.0) (2026-04-14)


### Features

* **unstable:** Initial unstable elicitation support ([#113](https://github.com/agentclientprotocol/typescript-sdk/issues/113)) ([bf259e9](https://github.com/agentclientprotocol/typescript-sdk/commit/bf259e9e36b38fc760397babe7f455cdf6665193))

## [0.18.2](https://github.com/agentclientprotocol/typescript-sdk/compare/v0.18.1...v0.18.2) (2026-04-08)


### Bug Fixes

* propagate input stream errors through ndJsonStream ([#111](https://github.com/agentclientprotocol/typescript-sdk/issues/111)) ([f57a8d1](https://github.com/agentclientprotocol/typescript-sdk/commit/f57a8d1d4606c6f12684e7790b0c9cfaba0e319c))

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
* Unstable: add unstable forkSession support ([#37](https://github.com/agentclientprotocol/typescript-sdk/pull/37)) ([16262ef
](https://github.com/agentclientprotocol/typescript-sdk/commit/16262ef7b52892f935aa7fb39d98657895345ff4))

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
- Fix incorrectly serialized `_meta` field on `SetSessionModeResponse`

## 0.5.0 (2025-10-24)

- Provide access to an `AbortSignal` and `closed` promise on connections so you can wait for the connection to close and handle any other cleanup tasks you need for a graceful shutdown. https://github.com/agentclientprotocol/typescript-sdk/pull/11
- Allow for more customization of error messages: https://github.com/agentclientprotocol/typescript-sdk/pull/12
- Update to latest ACP JSON Schema: https://github.com/agentclientprotocol/typescript-sdk/pull/10

## 0.4.9 (2025-10-21)

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
