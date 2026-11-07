# ICE establishment diagnostics and recovery

`RtcCommandRouter.getConnectionDiagnostics()` exposes sanitized establishment evidence at
`active[].stages.establishment` and `terminal[].stages.establishment`. A standalone session exposes
the same evidence through `RtcSession.getConnectionDiagnostics().establishment`; a standalone peer
exposes its observed evidence through `RtcPeer.getIceDiagnostics()`.

Evidence includes the actual policy, first grant/offer order and elapsed times, TURN configuration
at each native initialization, local/remote candidate occurrence counts by type, selected pair types,
ICE/connection transitions, and fired authentication, local-answer, connection or replacement deadlines.
Times are monotonic milliseconds since session construction. Occurrence counts include rejected types
and duplicates across SDP and trickle; they are not unique candidates or proof of successful checks.
Arrays retain 32 entries each and count evictions. Snapshots are detached and retain no addresses,
ports, ICE credentials, fingerprints, device/account identities, SDP, candidate strings or errors.

The native binding exposes no separate DTLS callback. `dtls.source` is explicitly
`connection_state_proxy`, with `nativeStateAvailable: false`: its transition timing mirrors connection
state (mapping disconnected to closed, as the binding's DTLS polyfill does). ICE-connected and
connection-connected times bound the observed transport-establishment gap; they cannot isolate a
DTLS failure from SCTP or prove handshake packet flow.

For caller integration, project `stages.establishment` from existing connection diagnostics into the
diagnostic response, including terminal rows so the failed direct attempt remains visible after relay
recovery. No signaling payload or native selected-pair object should be forwarded. No caller changes
are included here.

## Safety behavior

- `all` and `relay` defer an offer until the TURN grant arrives. Pre-grant trickle candidates queue
  separately (maximum 256); host-only offer-first behavior remains available. Non-host peers reject
  initialization without a grant, preventing a TURN-less peer from surviving a later grant.
- A failed non-relay shared-session establishment gets one explicitly relay-policy retry, including
  when the dynamic selector still returns `all`. Concurrent initial callers share that retry.
  Cancellation, reset and ownership changes prevent stale fallback or adoption.
- Each connection keeps the existing default 12-second deadline. Two attempts therefore take at most
  24 seconds by default. A non-relay replacement has a 30-second total window for both attempts,
  information verification and adoption; relay-only renewal retains its 15-second window. Playback
  recovery also retains its 60-second outer cap. Configured connection timeouts still apply.
- A replacement is adopted only after connection, a successful information read, and idle ownership
  checks. Failure preserves the original owner instead of explicitly dropping it. Failed playback
  recovery guards that owner and blocks new playback/live starts until a verified replacement succeeds;
  ordinary health reads remain available. Network or station closure can still take an owner down,
  and relay unavailability cannot be repaired by local retry logic.

## Source conclusions

(c) is confirmed: offer-first initialization could create a peer without TURN, and grant processing
then returned from `init()` because the peer already existed. Deferred initialization fixes it.
(a) is a supported failure path, not an observed diagnosis: `all` can select non-relay candidates and
the prior router had no relay fallback. (b) is possible: the default 12-second total deadline can
preempt the peer's 15-second answer timeout or call backoff. The evidence does not justify extending
the direct connection deadline. (d) remains unconfirmed; offer/answer stages, remote-close origin and
deadline evidence help distinguish signaling termination from a transport stall, but no answer
acceptance inference is made from a successful local send.

## Proposed live acceptance sequence (requires separate authorization)

1. Preserve the installed build and relay configuration. Confirm relay connection, one health read,
   and no active media lease. Enable only the sanitized diagnostic projection described above.
2. Select `all` for one new replacement attempt, retaining the healthy owner; do not start a clip or
   live view while it negotiates. Observe grant/offer order, TURN initialization and candidate types.
3. Allow its existing 12-second deadline and single relay fallback. Require verified replacement
   adoption within 30 seconds, or preservation of the original owner with explicit failure. Stop the
   experiment if neither is true; do not repeat direct attempts automatically.
4. Restore relay selection for future sessions. Verify a fresh health read and relay-selected pair.
   If playback recovery failed, keep media blocked until a verified relay replacement clears the
   affected owner. Then, under separate acceptance scope, try one short live view and one known clip
   sequentially, verifying health after each. Retain sanitized diagnostics and rollback material.
