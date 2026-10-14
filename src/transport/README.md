# transport/ — wire layer

**Owns:** every cloud/realtime transport — HTTP (mega algo_ecdh), secure MQTT, P2P (PPCS),
FCM push, Tuya. All frame encoding/decoding, encryption levels, sockets, sessions. THE only
place that builds bytes on a wire.

**Invariant:** transports emit/accept transport-neutral data (a `Command`, a raw frame, a
`PushEvent`); they never name a capability and never decide capability semantics. P2P encryption
level (L1/L2) is resolved per-command from runtime topology, never a family trait. Unverified write
wires throw — never guess (fire-and-forget looks like success).

**Per-transport layout (session vs command router — keep the two transports symmetric).** Each
transport with an outbound command path splits into two modules, and new wire families follow the same
split:

- **session module** — the raw connection only: sockets, TLS/handshake, connect/subscribe/publish/
  disconnect, receive. `p2p/p2p-session.ts`, `mqtt/secure-mqtt.ts`. It builds NO command envelope and
  names no command family (`ff09`, …). Generic helpers (`secureTopic`) may live here.
- **command router** — maps a `Command` to its wire frame + envelope and owns the connection lifecycle
  per send. `p2p/command-router.ts` (`P2PCommandRouter`), `mqtt/command-router.ts` (`MqttCommandRouter`).
  ALL frame/envelope building for a command family lives here (P2P: the `1940` payload; MQTT: the
  `trans`/`{head,payload}` envelope + `buildFf09Trans`/`buildFf09MqttEnvelope`/`ff09MqttTopic`/
  `parseFf09SettingsResponseTrans`). A router's module doc describes it as _the transport's command
  router_, not one wire family — `ff09-*` is today's payload; a future family (`ff08`, `pp45`, tuya) is
  one more `dispatchCommand` branch, not a rename. Routers are internal (imported by the facade via
  direct path, NOT re-exported from the barrel), like both current routers.

Do NOT put command-envelope building in a session module (the reason `mqtt/secure-mqtt.ts` no longer
holds the ff09 `trans` builders — they belong in `mqtt/command-router.ts`, mirroring P2P). The shared
wire frame + its opcodes live once in `transport/ff09.ts`; both routers call it and carry the returned
`apiCommand` through — neither router names an opcode.

**Serving the capability layer without knowing it exists.** Some transport work is pulled by a
capability rather than pushed by a wire — decoding a structured payload, opening a stream. That is an
**injected provider**: the interface lives in `core/contracts`, the implementation here, and the facade
injects it at `bindActions`. Name it for the technical job, never the feature that motivated it
(`RawDpCodec`, not `VacuumStatusDecoder`) — if the interface can't be written without naming a
capability, the split is wrong. A pure, stateless provider with no socket or session sits at the
transport root beside `ff09.ts`/`raw-dp.ts` and is imported by direct path, not re-exported from the
barrel. Full pattern: root `CLAUDE.md`, "How the two layers DO talk".

**Imports:** `../core` only (the shared `contracts` boundary). NEVER `../model` or `../client` (would
invert the layering) — enforced in CI, no exceptions.

**Surface:** each subfolder's `index.ts` barrel; the `transport/index.ts` aggregate (tuya namespaced
for generic names). This layer owns the wire ids it actually issues: the P2P
router's envelope/routing ids (`P2P_ENVELOPE` in `p2p/envelope.ts`) and the MCS framing tags
(`MessageTag` in `push/message-tags.ts`). The capability layer's feature ids (per-capability
`CAMERA_CMD` / `LIGHT_CMD` / …), state param ids (`BATTERY_PARAM`), and push-event _semantics_ live in
`model/` — the router forwards `cmd.param` opaquely and the client injects the frame→event decode, so
transport never names a feature or event.
