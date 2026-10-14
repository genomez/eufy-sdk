# client/ — the EufyMega facade

**Owns:** orchestration only — the login state machine, event fan-out (push/p2p/mqtt/poll → typed
semantic events), and wiring the layers together. `eufy-mega.ts` = the facade class; `types.ts` =
public options/event map. `device-registry.ts` = the `DeviceRegistry` collaborator that owns device
list/record resolution + the frame→caps cache (the house-scoped merge/dedupe, param overlay, and
standalone-vs-attached channel match) — the facade delegates its `getDevices`/`getDevice`/`inspect*`
to it. The P2P wire senders live in `transport/p2p/command-router.ts`; the facade delegates to it and
injects the model-coupled frame decode via the router's `onFrame` callback (so the router never
imports model).

**Invariant:** the facade NEVER names a capability — fluent accessors (`dev.camera()`) and typed
events (`eufy.on("motion")`) are derived from the capability barrel projections. Public method
signatures are the stable API; keep them thin over `core`/`transport`/`model`.

**Imports:** `../core`, `../transport`, `../model`. Everything below the facade.

**Surface:** `client/index.ts` (`export *` of the class + public types).
