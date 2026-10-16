# Experimental SDK release candidate

Version `0.2.1-s1.experimental.5` is an experimental prerelease, published 2026-10-16 with runtime [s1-runtime-0.4.1.experimental.5](https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.5). This independently maintained S1/T9000 source is not an official upstream release. The package remains private and npm publication is disabled.

The implementation preserves the prior signaling safety fix and adds one bounded renewal retry when a verified replacement times out while an original-session lease is held. Eligibility requires the original session to remain connected and untainted, stable identity, a fresh complete information read after failure, lease release, and a thirty-second cooldown. The existing two-attempt budget and cancellation rules remain in force. ACK-only evidence cannot authorize retry.

Historical offline verification of the inherited experimental.3 implementation input passed 4,982 tests in 254 files. The experimental.4 error-origin changes are outside that historical evidence. Current local test results are recorded separately; BUILD_PROVENANCE.json preserves the historical input binding. Later release qualification must be recorded separately against the final candidate hashes.

The historical synthetic platform was Linux amd64. No new physical-device, live-media, non-S1, other-architecture or simultaneous-consumer acceptance is claimed. Native dependency qualification and redistribution require matching release evidence. Source review alone does not authorize binary publication.

Use the pinned dependency lock with lifecycle scripts disabled. The matching corresponding-source archive contains the full source, tests, build scripts, dependency lock, licenses and attribution; SOURCE_MANIFEST.json binds all source files except itself. Runtime package files and sources must be paired by exact checksums. No installed dependencies, native binaries, runtime sessions, captures, owner-trial receipts or private device images are included in these sources.

Preserve capability/transport boundaries, explicit cancellation, bounded cleanup and caller ownership. Do not introduce hidden starts or retries to conceal failures.

Report model numbers, component commits, relevant versions and a minimal synthetic reproduction. Never include serials, P2P identifiers, account data, credentials, personal names, network addresses, captures, raw logs or real images. Preserve supplied licenses and upstream attribution.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds an `origin` label to SDK error events. Existing runtime defaults and renewal guards are retained. Local packaging does not establish image or physical-device acceptance.

## Experimental.5, 2026-10-16

Version `0.2.1-s1.experimental.5` changes: floodlight write confirmation; complete realtime teardown and empty-refresh backoff; withhold battery charge source on known mains cameras; treat -100 Wi-Fi as no reading; opt-in command-session keepalive; redact echoed tokens from RTC sign refusals.

The keepalive is opt-in in source; the paired experimental.5 Linux amd64 runtime enables it every 29 seconds. An earlier implementation test on one S1 ran about 9.5 hours with 1,138/1,138 echoes and no keepalive drops. This is limited prior hardware evidence; the final experimental.5 image passed an in-image smoke test but has not itself been run on hardware. One night does not establish that keepalive prevents outages. Live view is outside this release qualification.

## Runtime release

This source accompanies runtime `0.4.1-s1.experimental.5` and unchanged integration `0.3.1.dev2`, Linux amd64. Release: [s1-runtime-0.4.1.experimental.5](https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.5). No live-view acceptance is included.
