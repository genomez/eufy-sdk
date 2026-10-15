# Experimental SDK release candidate

Version `0.2.1-s1.experimental.4` is an experimental prerelease, published 2026-10-15 with runtime [s1-runtime-0.4.1.experimental.4](https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.4). This independently maintained S1/T9000 source is not an official upstream release. npm publication is disabled. It has not been tested on physical hardware.

The implementation preserves the prior signaling safety fix and adds one bounded renewal retry when a verified replacement times out while an original-session lease is held. Eligibility requires the original session to remain connected and untainted, stable identity, a fresh complete information read after failure, lease release, and a thirty-second cooldown. The existing two-attempt budget and cancellation rules remain in force. ACK-only evidence cannot authorize retry.

Historical offline verification of the inherited experimental.3 implementation input passed 4,982 tests in 254 files. The experimental.4 error-origin changes are outside that historical evidence. Current local test results are recorded separately; BUILD_PROVENANCE.json preserves the historical input binding. Later release qualification must be recorded separately against the final candidate hashes.

The historical synthetic platform was Linux amd64. No new physical-device, live-media, non-S1, other-architecture or simultaneous-consumer acceptance is claimed. Native dependency qualification and redistribution require matching release evidence. Source review alone does not authorize binary publication.

Use the pinned dependency lock with lifecycle scripts disabled. The matching corresponding-source archive contains the full source, tests, build scripts, dependency lock, licenses and attribution; SOURCE_MANIFEST.json binds all source files except itself. Runtime package files and sources must be paired by exact checksums. No installed dependencies, native binaries, runtime sessions, captures, owner-trial receipts or private device images are included in these sources.

Preserve capability/transport boundaries, explicit cancellation, bounded cleanup and caller ownership. Do not introduce hidden starts or retries to conceal failures.

Report model numbers, component commits, relevant versions and a minimal synthetic reproduction. Never include serials, P2P identifiers, account data, credentials, personal names, network addresses, captures, raw logs or real images. Preserve supplied licenses and upstream attribution.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds an `origin` label to SDK error events. Existing runtime defaults and renewal guards are retained. Local packaging does not establish image or physical-device acceptance.
