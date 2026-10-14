# model/ — device domain

**Owns:** the capability-driven `Device` (no subclasses), family classification
(`device-family.ts`), the registry/resolution (`registry.ts`, `classify.ts`, `infer.ts`), and one
self-contained module per capability under `capabilities/`. See `capabilities/README.md`.

**Invariant (decorrelation — enforced in CI, NO exceptions):** nothing under `model/` may import
from `transport/`. A capability owns its semantics and emits transport-neutral intent (a `Command`);
the only cross-layer contract it needs — the command/media boundary (`core/contracts`) — lives in
`core/`. The wire vocabulary a capability targets is the model's OWN, declared INLINE in the
capability module: feature-command ids (`camera.ts` `CAMERA_CMD`, `light.ts` `LIGHT_CMD`, `audio.ts`
`AUDIO_CMD`, `motion.ts` `MOTION_CMD`, `doorbell.ts` `DOORBELL_CMD`, `pan-tilt.ts` `PTZ_CMD`) and
state param ids (`battery.ts` `BATTERY_PARAM`) — each id is used by exactly one capability, so it sits
next to the behaviour it drives, not in a shared file. `push-events.ts` (event semantics + the id→name
mapper `detectionName`) is the ONE shared model wire file, because several capabilities match the same
event codes. Transport speaks a disjoint command subset (`P2P_ENVELOPE`), so the two never import each
other. Adding a capability = one new file + a couple of `capabilities/index.ts` lines; `device.ts` and
the facade never name a capability.

**Needing something only a transport can do** (decode a payload, open a stream, read a settings blob)
is NOT a reason to import one. Take an injected provider off `core/contracts` instead — the facade
supplies it at `bindActions`, the capability keeps the semantics, and neither side names the other.
`RawDpCodec` is the worked example: the codec turns a structured DP payload into a field tree,
`vacuum-clean.ts` says which field number means what. Full pattern + when it applies: root `CLAUDE.md`,
"How the two layers DO talk". A provider is optional by construction — an unbound device reads
`undefined`, never a guess.

**Value semantics (`kind`) — what a value MEANS, not how it is stored.** Every `PropertySpec` carries a
`kind` (`ValueKind` in `types.ts`) beside its `type`: `boolean`, `percent`, `celsius`, `dbm`, `seconds`,
`megabytes`, `degrees`, `scalar`, `bitfield`, `enum`, `identifier`, `timestamp`, `text`. `type` says a
value is a number; `kind` says whether that number is a battery percentage, a temperature, a duration or
an instant — a distinction nothing else in the schema makes, and one a caller cannot re-derive. The union
is deliberately **open** (`KnownValueKind | (string & {})`), so modelling a new kind never breaks a
caller's exhaustive switch. The pairings are spec'd, not conventional — `value-kinds.spec.ts` fails the
build when `kind` and `unit` disagree in either direction, when `boolean` and `type: "bool"` come apart,
when an `enum` ships without its `enumValues`, or when a numeric kind sits on a value stored as something
else. That last rule is what caught `snoozeTime` declaring a duration for a config blob the device
reports whole, and the unit rule is what caught `lastSeen` declaring `unit: "s"` for a timestamp.

A property whose stored value is a structured payload declares NO `kind` — the semantic value is a field
inside it, so the kind goes on the member that decodes it (`decodedKind`, plus `decodedValues` for an enum), which
is also the only place either is legal without a `decode`. Same evidence bar as everything else: annotate
what the wire is known to mean, never a plausible-looking unit. `megabytes`/`degrees` stay as the device
reports them — converting is inventing.

**Imports:** `../core` only (types + the `contracts` boundary). NEVER `../transport`, NEVER
`../client` — and that holds for specs too: `guard-decorrelation.sh` has no `__tests__` exemption, so a
capability spec proves the split by driving a hand-written fake provider. A cross-layer spec that needs
the real transport goes in the top-level `src/__tests__/`.

**Surface:** `model/index.ts` + `model/capabilities/index.ts` (barrels + projections). Only the shared
push enums + `detectionName` are re-exported from `model/index.ts`; the per-capability feature-command
/ param consts are internal wire vocabulary (imported by their own spec via direct file path, not the
barrel).
