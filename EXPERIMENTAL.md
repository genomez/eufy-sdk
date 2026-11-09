# S1 experimental.14

## .14 changes

- Fixed: S350 (T8416) cameras no longer show a spotlight switch they don't have. A push connection that silently stops delivering events is now detected and reconnected. Camera settings are no longer overwritten by older values when a startup or refresh overlaps a change. Snapshot refreshes are no longer lost when they overlap; queued refreshes stop after a sign-in failure.
- Changed: Floodlight brightness/spotlight controls that HomeBase S1 can't drive are hidden. Number settings use per-model ranges. Media → Eufy shows "Playback not yet supported for this camera", "No playable recordings yet" or "No recordings yet" instead of an empty camera folder. More playback diagnostics.
- Upgrade: Update the add-on and integration together, then restart Home Assistant after the add-on is running, so removed controls are cleaned up.
- Known limits: Playback is silent; multi-lens cameras show one view; a late update from a camera can still briefly show an old state.

SDK 0.2.1-s1.experimental.14; bridge/integration 0.3.1-s1.experimental.14; add-on 0.4.1-s1.experimental.14. Linux amd64.

Recorded playback is progressive by default. Extra camera models are an eligibility opt-in, not proof of codec or lens compatibility. Keep the previous add-on/integration pair and backups for rollback; restore both together and restart Home Assistant. Live view and floodlight safety remain opt-in; keep battery preload off. Command keepalive is 29000 ms.

## Historical documentation through experimental.12

# S1 experimental.12

Update the add-on and integration together: add-on `0.4.1-s1.experimental.12`, integration and bridge `0.3.1-s1.experimental.12`, SDK `0.2.1-s1.experimental.12`.

- Push-store save failures are caught and reported through push-connection diagnostics (#539).
- Session and FCM files use an owner-only temporary file and atomic rename where the filesystem permits (#540). On restricted directories or single-file mounts, the existing in-place fallback is non-atomic and retains existing file permissions.
- Stored snapshots recover after a successful re-login, including when an older in-flight download fails afterwards (#545).
- Optional HomeBase S1 storage telemetry also supports firmware 4.4.1.4; it remains off by default.
- After an acknowledged light command, Home Assistant holds the requested display value for up to 45 seconds. A matching boolean report releases it early. The acknowledgement does not confirm the physical light state.
- A registry identity conflict invalidates the affected child-camera status to unknown.
- HomeBase firmware metadata updates from newly received inventory without a Home Assistant restart. A new Firmware version sensor exposes the received version.
- Dated experimental.11 and experimental.12 modification notices are retained, including the restored integration notice.

Defaults are unchanged. Live view and optional floodlight safety remain off by default. Keep battery-camera preload off. Verify the integration ZIP checksum and restart Home Assistant after replacing the integration. Changing live-view opt-in requires an add-on restart. Command keepalive remains 29000 ms.

Known live-view stalls, unexplained floodlight ON events and brightness/spotlight formatting issues remain unresolved. This is an experimental fork.

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.12

Integration ZIP and checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.12

Publication availability is pending. The accepted image is delivered without rebuilding. Earlier release records below are historical.

Modified for genomez experimental.11, 2026-10-31

Modified for genomez experimental.12, 2026-11-02

## Historical documentation before experimental.12 publication

Current local candidate: experimental.12 (2026-11-02). Unpublished; no installation or device acceptance. Earlier release references below are historical.

# S1 experimental.12 — Experimental support and limitations

TypeScript SDK source for the S1 experimental stack. The SDK package remains private on npm; use the paired release archives.

Pair add-on `0.4.1-s1.experimental.12`, integration/bridge `0.3.1-s1.experimental.12` and SDK `0.2.1-s1.experimental.12`.

Use matching release versions and retain your existing configuration unless deliberately changing an option.

## Changes

- Diagnostics keep bounded failure-only command and property-write history, so failures remain visible when later commands succeed. The SDK error history is limited to 32 entries.
- Event thumbnail decoding supports the V2 encrypted-chroma variant. Alarm pushes that explicitly report an app stop are labelled stopped rather than triggered.
- Unsupported RTSP stream publish controls are hidden for cameras behind HomeBase S1. RTSP URLs and the existing recording/authentication settings retain their existing support rules.
- Streaming-quality sensors behind HomeBase S1 appear only when the camera has reported the corresponding quality parameter. The separate video-quality select is unchanged.
- After updating both components and restarting Home Assistant, 15 existing RTSP stream switches and 15 existing streaming-quality sensors on the affected installation are expected to become unavailable. Their retained entity entries can be removed in Home Assistant. Streaming-quality sensors with reported support remain available.
- Camera-health diagnostics show the last suppressed signal-strength reading, its reason and source. This diagnostic does not change the published signal strength or prove the current radio state.
- More cameras now show Online/Offline status from HomeBase S1 (T9000). Offline/recovery testing covers T8425, T8426, T8416, T8214, T8134 and T8170; T8171 has not yet been offline-tested.
- Camera status holds until the HomeBase reports a change.
- After a HomeBase reconnect, cameras show unknown until the next routine status update, about 10 minutes by default plus polling and sweep time. Failed or disabled polling or missing reports can leave status unknown longer.
- A camera marked offline never holds back light OFF commands or retries. Existing transport and safety checks still apply. Upgrade the add-on and integration together.

## Defaults and use

Defaults are unchanged. Live view is off by default; only boolean `webrtc_relay: true` enables it. Changing that option requires an add-on restart. Command keepalive remains 29000 ms. Integration `light_correction_enabled` remains off. With safety off, OFF-stuck incident reporting is inactive and its four attributes are absent. No new option or default was added. Keep battery-camera preload off.

## Known issues

- T8113-Z firmware 3.3.8 can show a picture then black.
- Some live-view sessions need another open or wait for the hub offer.
- Unexplained floodlight ON events and brightness/spotlight command formatting remain unresolved. This update does not claim to fix these issues. Passive diagnostics do not establish physical state.

## Releases, source and notices

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.11

Integration release and ZIP checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.11

Image manifest: `sha256:28cc3774423aae12a7a328c0d39c66c317f8c5232466073c356076d1bbd50471`.

See LICENSE and source headers for applicable license and author notices. Runtime/source archives retain their original notices and corresponding-source links.

Full SDK corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/download/s1-runtime-0.4.1.experimental.11/eufy-sdk-0.2.1-s1.experimental.11-source.tar.gz; SHA-256 `d49311318a9522d7cdc6ebb0bddaeaa12bd7d8df383688b414ed294c2b03d465`, 1619648 bytes. The npm package is separate. In-image source records retain their historical build-time values.

## Historical experimental.9 / experimental.10 documentation

# S1 experimental.9 — Experimental support and limitations

TypeScript SDK source for the S1 experimental stack. See docs/ and examples/ for API usage. The SDK package remains private on npm; use the corresponding release source and package archives.

Pair add-on `0.4.1-s1.experimental.9`, integration/bridge `0.3.1-s1.experimental.9` and SDK `0.2.1-s1.experimental.9`.

Use the matching release versions and retain your existing configuration unless deliberately changing an option.

## Changes

- Failed SDK background read-through refreshes report through the existing `state_refresh` origin and retain last-known values until an update succeeds.
- Routine camera health attributes refresh less often. On one installation, 15 connectivity sensors went from about 317,000 recorder rows a day to about 1,600.
- With the existing optional floodlight safety enabled, unconfirmed OFF incidents expose `off_stuck_incident`, `off_stuck_reason`, `off_stuck_opened_at` and `off_stuck_escalate_at`.
- SDK Markdown formatting was corrected. A test-only change uses 5.0015 seconds to avoid clock rounding; production timing is unchanged.

## Defaults and use

Live view is off by default; only boolean `webrtc_relay: true` enables it. Live-view opt-in requires an add-on restart. Command keepalive remains 29000 ms. Integration `light_correction_enabled` remains off. With safety off, OFF-stuck incident reporting is inactive and its four attributes are absent. No new option or default was added. Keep battery-camera preload off.

## Known issues

T8113-Z firmware 3.3.8 can show a picture then black. Some live-view sessions need another open or wait for the hub offer. Unexplained floodlight ON events and brightness/spotlight command formatting remain unresolved. This release does not claim to fix these issues. Passive diagnostics do not establish physical state.

## Releases, source and notices

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.9

Integration release and ZIP checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.9

Image manifest: `sha256:fe2fca682ecf41655402abc7ba2da970995eeed4a6010f51865409b60141bd0e`. The integration release archive corresponds to source commit `bf6d218faa3df8734c8bfee594ed6ae6e807e1f3`; current branch documentation can differ from that tagged archive.

See LICENSE and source headers for applicable license and author notices. Runtime/source archives retain their original notices and immutable base corresponding-source links.

## Historical experimental.8 documentation

# Experimental.8 verified public delivery

Runtime/source release: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.8
Integration release: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.8
Verified registry manifest: sha256:4289f94e617c0e60207edb8ddaa75d88cfdf777ad081e9e43feb915a4b2ef119
Paired add-on 0.4.1-s1.experimental.8, integration/bridge 0.3.1-s1.experimental.8 and SDK 0.2.1-s1.experimental.8. These bindings come from independent anonymous release, asset, workflow and registry verification. Installation, HACS and physical-device acceptance remain separate.

The official integration ZIP remains frozen at 6bb1365de39615d9e094b44b7665118451326e8d; current branch documentation may differ from the release archive. Version-specific source, image-context and archive records below remain historical. The exact prepared implementation and workflow are unchanged.

## Historical local preparation and earlier release records

# Experimental.8 local preparation

Version `0.2.1-s1.experimental.8` is described in this historical notice. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

RTC late-viewer keyframe gating; bounded refresh backoff and recovery; isolated slow replies; camera connectivity and hub reply evidence; T8171 detection; opt-in floodlight safety with bounded confirmation and problem notices; observation-only media stall evidence.

Live view remains off by default; only boolean `webrtc_relay: true` enables it. Command keepalive remains 29000 ms. Integration floodlight safety uses `light_correction_enabled` and remains off by default. The opt-in safety binds HA intent, uses 15-minute motion and ON waits with a 30-minute watchdog, retries OFF until camera confirmation within its limits, and reports problems with bounded phone retries. It may retry an authorized ON intent; the historical .7 OFF-only corrector description below is superseded. Passive connectivity diagnostics do not establish physical state.

Media gap evidence is observation only; no automatic stream restart is added. T8113-Z firmware 3.3.8 picture-then-black remains unresolved. A second live-view open may still be needed. Brightness/spotlight formatting and unexplained floodlight ON events remain under investigation. The refresh retry/backoff addresses the prior .7 refresh issue.

This is an offline local candidate, with no release, registry, installation, account, device, media or new soak acceptance. Update and installation instructions in the historical text apply only after a separately approved publication.

## Historical published experimental.7 documentation

Current experimental.7 runtime source delivery: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.7

# Experimental.7 local preparation

Version `0.2.1-s1.experimental.7` is delivered with the verified experimental.7 runtime. Pair add-on `0.4.1-s1.experimental.7` and integration `0.3.1-s1.experimental.7`. Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics.

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


## Historical input documentation and modification notices

# Experimental SDK release candidate

Version `0.2.1-s1.experimental.6` is described in this historical notice. This independently maintained S1/T9000 source is not an official upstream release. The package remains private, npm publication is disabled, and release qualification is pending.

The implementation preserves the prior signaling safety fix and adds one bounded renewal retry when a verified replacement times out while an original-session lease is held. Eligibility requires the original session to remain connected and untainted, stable identity, a fresh complete information read after failure, lease release, and a thirty-second cooldown. The existing two-attempt budget and cancellation rules remain in force. ACK-only evidence cannot authorize retry.

Historical offline verification of the inherited experimental.3 implementation input passed 4,982 tests in 254 files. The experimental.4 error-origin changes are outside that historical evidence. Current local test results are recorded separately; BUILD_PROVENANCE.json preserves the historical input binding. Later release qualification must be recorded separately against the final candidate hashes.

The historical synthetic platform was Linux amd64. No new physical-device, live-media, non-S1, other-architecture or simultaneous-consumer acceptance is claimed. Native dependency qualification and redistribution require matching release evidence. Source review alone does not authorize binary publication.

Use the pinned dependency lock with lifecycle scripts disabled. The matching corresponding-source archive contains the full source, tests, build scripts, dependency lock, licenses and attribution; SOURCE_MANIFEST.json binds all source files except itself. Runtime package files and sources must be paired by exact checksums. No installed dependencies, native binaries, runtime sessions, captures, owner-trial receipts or private device images are included in these sources.

Preserve capability/transport boundaries, explicit cancellation, bounded cleanup and caller ownership. Do not introduce hidden starts or retries to conceal failures.

Report model numbers, component commits, relevant versions and a minimal synthetic reproduction. Never include serials, P2P identifiers, account data, credentials, personal names, network addresses, captures, raw logs or real images. Preserve supplied licenses and upstream attribution.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds an `origin` label to SDK error events. Existing runtime defaults and renewal guards are retained. Local packaging does not establish image or physical-device acceptance.

## Experimental.5 preparation, 2026-10-16

Version `0.2.1-s1.experimental.5` is described in this historical notice. Floodlight write confirmation; complete realtime teardown and empty-refresh backoff; withhold battery charge source on known mains cameras; treat -100 Wi-Fi as no reading; opt-in command-session keepalive; redact echoed tokens from RTC sign refusals.

The keepalive is opt-in in source; the paired experimental.5 Linux amd64 runtime enables it every 29 seconds. An earlier implementation test on one S1 ran about 9.5 hours with 1,138/1,138 echoes and no keepalive drops. This is limited prior hardware evidence, not verification of the final experimental.5 image. One night does not establish that keepalive prevents outages. Live view is outside this release qualification.

## Experimental.6 preparation, 2026-10-16

Version `0.2.1-s1.experimental.6` is described in this historical notice. Packaging-only version update; SDK implementation and tests are unchanged from experimental.5, including token redaction and opt-in command-session keepalive.

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
