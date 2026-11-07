# Bounded recording reads

These methods use the already connected, healthy RTC owner. They do not discover devices, open an owner, reconnect, renew, play media, prepare video, or fall back to a live image. The SDK default is disabled.

The installed `rtc.recordings` policy has this exported shape:

```ts
interface RecordingPolicy {
  enabled: boolean;
  stationBinding: string;
  allowedCameras: ReadonlySet<string> | readonly string[];
}
```

The scope must match all five installed FLC identities and the current unambiguous station topology. The excluded camera label is checked only as an additional denial. Names do not enroll a device. Persist a random 32-byte installation key durably before using it. The SDK never creates or reads a key file. Obtain the opaque account namespace through the cache-only method below; `null` means there is no usable key or authenticated account.

```ts
import type {
  InternalCoverSelector,
  InternalRecordingRow,
  RecordingDiagnostics,
  RecordingReadReason,
} from "@mega-yfue/eufy-sdk";

interface RecordingReader {
  getRecordingAccountNamespace(identityKey: Uint8Array): string | null;
  readRecordingCatalog(scope: RecordingReadScope, opts?: RecordingReadOptions): Promise<CatalogReadResult>;
  readRecordingCover(
    scope: RecordingReadScope,
    selector: InternalCoverSelector,
    opts?: RecordingReadOptions,
  ): Promise<CoverReadResult>;
  setRecordingPacing(pacing?: Partial<RecordingPacing> | null): RecordingPacing;
}

interface RecordingPacing {
  coverGapMs: number;
  coverRatePerMinute: number | null;
  coverQuietMs: number;
}

interface RecordingReadScope {
  stationSn: string;
  cameraSns: ReadonlySet<string>;
  accountNamespace: string;
  identityKey: Uint8Array;
}
interface RecordingReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
type CatalogReadResult =
  { status: "ok"; rows: InternalRecordingRow[]; diagnostics: RecordingDiagnostics } | RecordingReadFailure;
type CoverReadResult = { status: "ok"; jpeg: Buffer } | RecordingReadFailure;
type RecordingReadFailure = {
  status: "deferred" | "unavailable";
  reason: RecordingReadReason;
};
```

`timeoutMs` defaults to 8000 and accepts only integer values from 1 through 8000. Both failure variants contain only a fixed exported `RecordingReadReason`, never an exception string. An empty successful query returns `rows: []`. A refusal or failure is not an empty catalog.

`InternalRecordingRow` and `InternalCoverSelector` are exported TypeScript types for restricted internal storage. They are **not public DTOs**. Their complete declarations and finite refusal codes are in `src/transport/rtc/recordings.ts`. Rows include opaque `scopeId`, `cameraId`, `eventId`, full `sourceKey`, validated time fields, numeric type labels and an optional sealed selector. No raw record ID, video path, arbitrary vendor string or raw row survives normalization. `identityStartBasis` is itself an HMAC, so unsupported timestamp strings need not be retained. Selectors contain the necessary private camera/station identities and observed storage path. Match `selector.sourceKey` to the selected stored row before fetching. Never accept selectors from a remote client. Persist neither a raw account identity nor the identity key in a public DTO.

The selector seal also binds the opaque account namespace, preventing reuse in a different account scope with the same installation key. Every uncached read verifies the full seal in constant time. Conflicting duplicate events are discarded. Distinct events sharing a path in the observed table have no usable selector. Their private `coverPathKey` remains available: an account-and-station-bound HMAC of a valid observed path, or null for an invalid path. Retain this fingerprint across windows and selector changes, and deny uncached reads when distinct events share it. It is excluded from `projectRecordingRow`. Persistent cross-window path reuse still requires qualification and a store-level ambiguity check; a persisted seal establishes observed provenance, not continued station retention or firmware path uniqueness.

`projectRecordingRow(row)` is an exported allowlist projection that excludes all private row fields and reconstructs fixed type labels. It returns `RecordingRowView`; the service still owns its versioned public contract, retention, accumulated deduplication and full-hash collision checks against its existing catalog. Keep the earliest persisted `firstObservedAtMs` when merging a re-observed event.

Admission is idle-only, routine priority, and requires 60 seconds of connected-owner observation plus qualified ordinary information health. Active playback and the unresolved playback latch both deny. Ordinary refresh, correction, queued work, probes, live demand and renewal outrank recordings. A canceled optional collector detaches locally and retains the existing 60-second late-reply reservations. Catalog attempts are spaced by two minutes, including failure; cover completions impose a five-second gap, with six cover attempts per sliding minute. The entire eight-second read plus five-second reserve must fit before the existing renewal deadline. No separate renewal schedule is introduced.

### Foreground playback

Foreground clips require five seconds of connected-owner and ingress observation,
ordinary information frames, keepalive evidence and safe prestart ingress. Live view,
other work, replacement, pending renewal, taint, scope and enrollment conflicts still deny admission.
`rtc.sessionRefreshMs` is optional proactive replacement, disabled by default, with
no documented hard session expiry. An admitted clip holds a lease, so renewal is
deferred even when it falls within the expected media duration plus 20 seconds.
The capture keeps its independent hard deadline and byte limits; no renewal can
interrupt it merely because the proactive renewal timer becomes pending.

Full clips retain video until station EOF or the existing hard capture limit,
including frames arriving after the catalog duration. EOF completeness requires
random access, at least two retained frames and a positive arrival span. Other
capture outcomes retain the strict duration, gap and density checks.
Ordinary clip transfers default to speed 2, while probes and live view retain their
existing speed. `transferSpeed: 1` selects the comparison/fallback speed; an armed
experiment takes precedence. Coverage span, gap, density and cutoff use arrival
time scaled by transfer speed. Accelerated clips prefer a catalog-consistent native
header duration, falling back to catalog duration, so faster delivery preserves
normal playback timing. The receipt records `transferSpeed` and `durationBasis`.

`pullRecordingClip` optionally calls `mediaReady(receipt)` once for a complete EOF
capture, after the sink has received its last video bytes. This receipt is a
snapshot, before session retirement. A caller can publish converted media then,
but must keep the station job occupied until the returned promise settles.
EOF cleanup sends pause/stop and skips cessation observation in favor of bounded
session replacement. Live acquisition waits for that replacement and uses the
fresh owner. The final receipt reports reconnect outcome and duration separately;
cleanup failure does not invalidate the earlier media snapshot.

`rtc.recordingTimeZone` selects the IANA zone used for catalog selectors and probe
selection, defaulting to `America/Chicago`. Ambiguous or nonexistent local times
remain refused. Events become eligible ten seconds after their end.

The caller owns browse interests, cover budgets and queueing, persistent identity/store recovery, negative cache and disk quotas. Startup, detection, cache reads and public image transfer must not call these methods automatically. Stored covers and catalog pages can remain readable when new RTC reads are refused.

Runtime cover pacing defaults to `coverGapMs: 5000`, `coverRatePerMinute: 6`,
and `coverQuietMs: 2000`. Partial updates retain unspecified values; passing null
or omitting the argument resets defaults. Rate 0 or null disables the minute cap;
the returned rate is normalized to 0. Gaps are finite nonnegative milliseconds;
the cap is a nonnegative safe integer. Updates are atomic, process-local and do
not clear attempt history. No device request is sent by the setter.

Setting both gaps and the cap to 0 admits serialized back-to-back covers. Only
cover-to-cover quiet and completion spacing change. The fixed two-second quiet
after foreground demand and around catalog reads, catalog continuation spacing,
owner/health/observation, playback/live priority, renewal reserve, scope and
reply-capacity gates remain. Issued reply reservations still last 60 seconds:
uncapped pacing does not imply unlimited admitted throughput. Reduced pacing is
for measurement; synthetic validation does not establish firmware tolerance.

Only strict `YYYY-MM-DD HH:mm:ss` Chicago wall-clock syntax is supported. A repeated DST hour is ambiguous; a spring gap is invalid. UTC and offset-bearing local fields are null unless an instant is unique. Numeric duration is unqualified; only a bounded nonnegative end-minus-start duration is published. The shared helper preserves playback's original acceptance and seconds output.

Fixture version: synthetic v1, generated locally by `recordings-fixture.ts`. No live schema, five-camera coverage or historical-path qualification is established by these tests. Deployment and live acceptance remain separate gates.

Catalog continuations use the optional private `beforeRecordId` read option.
The station query retains its existing payload fields and count 20, setting
`start_id` to the exclusive bound minus one and retaining `end_id: 1`.
These paging semantics are unverified on hardware. Private `page` evidence
contains record bounds and normalized time bounds; it must never be serialized
as public metadata or diagnostics. A continuation must match the preceding
successful cursor, occur within 60 seconds of the first attempt, respect a
five-second completion gap, and consume one of four extra read slots. It repeats
all owner, renewal, preemption and scope checks and never acquires a camera owner.
The installed camera set can grow without changing scope or existing camera HMACs.
The client validates camera codec and station-channel ownership from cached inventory.
