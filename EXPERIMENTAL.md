# Experimental.7 local preparation

Version `0.2.1-s1.experimental.7` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.7` and integration `0.3.1-s1.experimental.7`. Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics.

The package remains private; no npm publication is planned. Live view remains opt-in through `webrtc_relay: true`; public add-on default is false. Earlier release records below are historical.

## Experimental.6 source delivery, 2026-10-18

Version `0.2.1-s1.experimental.6` corresponding source is published. Runtime and corresponding-source release: `https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.6`. The companion integration is `0.3.1-s1.experimental.6`, paired with add-on `0.4.1-s1.experimental.6`. Update both components; relay defaults to false and command keepalive remains 29000 ms independently. Only JSON boolean true enables relay. No npm publication is planned.

The accepted Linux amd64 image passed isolated smoke checks; this exact release has no claimed physical-device, live HA/HACS installation or overnight soak acceptance. Earlier dated preparation, dev3 pairing, source-preview restrictions and implementation qualification records below are historical. Current source is the accepted review.9 RC9 package; original licenses, attribution and modification notices are preserved.

# Experimental SDK release candidate

Version `0.2.1-s1.experimental.6` corresponding source is published. This independently maintained S1/T9000 source is not an official upstream release. npm publication is disabled; the stated qualification limits still apply.

The implementation preserves the prior signaling safety fix and adds one bounded renewal retry when a verified replacement times out while an original-session lease is held. Eligibility requires the original session to remain connected and untainted, stable identity, a fresh complete information read after failure, lease release, and a thirty-second cooldown. The existing two-attempt budget and cancellation rules remain in force. ACK-only evidence cannot authorize retry.

Historical offline verification of the inherited experimental.3 implementation input passed 4,982 tests in 254 files. The experimental.4 error-origin changes are outside that historical evidence. Current local test results are recorded separately; BUILD_PROVENANCE.json preserves the historical input binding. Later release qualification must be recorded separately against the final candidate hashes.

The historical synthetic platform was Linux amd64. No new physical-device, live-media, non-S1, other-architecture or simultaneous-consumer acceptance is claimed. Native dependency qualification and redistribution require matching release evidence. Source review alone does not authorize binary publication.

Use the pinned dependency lock with lifecycle scripts disabled. The matching corresponding-source archive contains the full source, tests, build scripts, dependency lock, licenses and attribution; SOURCE_MANIFEST.json binds all source files except itself. Runtime package files and sources must be paired by exact checksums. No installed dependencies, native binaries, runtime sessions, captures, owner-trial receipts or private device images are included in these sources.

Preserve capability/transport boundaries, explicit cancellation, bounded cleanup and caller ownership. Do not introduce hidden starts or retries to conceal failures.

Report model numbers, component commits, relevant versions and a minimal synthetic reproduction. Never include serials, P2P identifiers, account data, credentials, personal names, network addresses, captures, raw logs or real images. Preserve supplied licenses and upstream attribution.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds an `origin` label to SDK error events. Existing runtime defaults and renewal guards are retained. Local packaging does not establish image or physical-device acceptance.

## Experimental.5 preparation, 2026-10-16

Version `0.2.1-s1.experimental.5` corresponding source is published. Floodlight write confirmation; complete realtime teardown and empty-refresh backoff; withhold battery charge source on known mains cameras; treat -100 Wi-Fi as no reading; opt-in command-session keepalive; redact echoed tokens from RTC sign refusals.

The keepalive is opt-in in source; the paired experimental.5 Linux amd64 runtime enables it every 29 seconds. An earlier implementation test on one S1 ran about 9.5 hours with 1,138/1,138 echoes and no keepalive drops. This is limited prior hardware evidence, not verification of the final experimental.5 image. One night does not establish that keepalive prevents outages. Live view is outside this release qualification.

## Experimental.6 preparation, 2026-10-16

Version `0.2.1-s1.experimental.6` corresponding source is published. Packaging-only version update; SDK implementation and tests are unchanged from experimental.5, including token redaction and opt-in command-session keepalive.

The live-view changes are confined to the paired bridge; no SDK implementation or test files changed for this candidate. Existing licenses and attribution are preserved.

## Experimental.6 release candidate refresh, 2026-10-16

The earlier packaging-only .6 preparation above is historical. This candidate includes two SDK fixes: a slower state refresh cannot overwrite a newer parameter update, and a freshness read can retry when an unchanged background poll supersedes it. The SDK bundle, source inventory and local package are rebuilt from implementation input `980f9a1`, including `a408a51`. Version remains `0.2.1-s1.experimental.6`. Original licenses and attribution are preserved; final runtime qualification and publication remain pending.

## Experimental.6 upstream ports, 2026-10-16

One authoritative mains-model list retains T8425/T8419/T8410/T8416/T8426 and adds T84A1/T8423/T8E00/T8P00. Case-insensitive prefix matching classifies these as wired even with battery capability; other cameras with that capability remain battery, regardless of level or solar charging. Cameras without battery capability are wired. The classifier drives every powered media egress and standalone session tier; HomeBase sessions remain wired. Cell-read suppression and charge-mode gating use the same list. State-freshness guards, command keepalive and RTC transport are retained.

Narrow adaptations from upstream commits:

- `45d2e5ac3cbc78efc20d1e1c5abc41f0aae3086d`: Public cameraPowerTier classifier and media/session routing.
- `7ab7fa555c740fd8763a6d136f10ca7ebbf7d39d`: T84A1 hardwired wall-light model.
- `ad98abfca39426c1a7f12d8d6bac02086bf7dc7c`: T8423 mains floodlight model.
- `57e28338944c005f387102d3b4bee431e0f682b9`: Merged T8E00/T8P00 PoE classification; includes 3e8274f262ef1a9e17844a769158b9146c36d80e and evidence clarification d3273ceb391207e66def90ac3bb077bb1d918537.

The prior packaging and implementation statements above are historical. Version remains unchanged. These local source ports do not establish final-image or hardware qualification. Apache-2.0 licenses, copyright, contributor attribution and existing notices are preserved; changed source/test files carry dated modification headers.

## Experimental.6 upstream-port package refresh, 2026-10-16

This local package is rebuilt from implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5`, including the upstream power-policy adaptations and retained `a408a51`/`980f9a1` freshness fixes. Earlier package statements above describe historical inputs. SDK version remains `0.2.1-s1.experimental.6`, private with npm publication disabled. The rebuilt bundle, complete source manifest and offline tarball identify the exact local input. Original licenses, attribution and notices remain intact; final-image and hardware qualification remain pending.

## S1 attached-camera siren source port, 2026-10-16

Adapted upstream mega-yfue/eufy-sdk #364 (danymexi, final feature `70e48103daefbe1acf0af67f4e12c42f0ef4c74a`,
merged as `2adf08595ff0bcb8f9c5c56588ce6ce812a1cfa3`) and #401 final head
`024d9d4eed3ad3ead5df2c2540f6cfb7981ded17`. The S1 portal alarm uses outer 1350 / inner 1202,
manual type 10, the selected camera channel and acting account name; zero duration stops it.

Only the exact T8134/T814X/T8214/T8790/T8122/T8113-Z/T8400 model set with reported EAS evidence
receives S1 attached-camera trigger and stop members. T8161 is excluded. Other attached S1 models
may retain the broad detected siren capability label but expose no alarm actions; callers must
inspect installed action members. The bridge already exposes that action manifest. No sounding
state is created from command ACKs. The station's own siren behavior and all existing RTC lifecycle,
keepalive, watchdog and freshness policies remain unchanged.

Version remains unchanged; no release manifests, package archives or runtime image were refreshed.
Offline validation is recorded separately. This port has no new physical-device acceptance.
Apache-2.0 licenses, copyright, attribution and existing notices are preserved.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.
