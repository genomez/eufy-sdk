# Experimental.8 local preparation

Version `0.2.1-s1.experimental.8` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

RTC late-viewer keyframe gating; bounded refresh backoff and recovery; isolated slow replies; camera connectivity and hub reply evidence; T8171 detection; opt-in floodlight safety with bounded confirmation and problem notices; observation-only media stall evidence.

Live view remains off by default; only boolean `webrtc_relay: true` enables it. Command keepalive remains 29000 ms. Integration floodlight safety uses `light_correction_enabled` and remains off by default. The opt-in safety binds HA intent, uses 15-minute motion and ON waits with a 30-minute watchdog, retries OFF until camera confirmation within its limits, and reports problems with bounded phone retries. It may retry an authorized ON intent; the historical .7 OFF-only corrector description below is superseded. Passive connectivity diagnostics do not establish physical state.

Media gap evidence is observation only; no automatic stream restart is added. T8113-Z firmware 3.3.8 picture-then-black remains unresolved. A second live-view open may still be needed. Brightness/spotlight formatting and unexplained floodlight ON events remain under investigation. The refresh retry/backoff addresses the prior .7 refresh issue.

This is an offline local candidate, with no release, registry, installation, account, device, media or new soak acceptance. Update and installation instructions in the historical text apply only after a separately approved publication.

## Historical published experimental.7 documentation

# Source modification index

Modified for genomez S1 experimental source preview, 2026-10-17.

## Validated live-view inventory scope, 2026-10-17

- `src/client/eufy-mega.ts`: expose an opaque cache-only inventory scope and detached conflicting serials for validated media admission; reuse the already fetched device record when binding command context.
- `src/client/device-registry.ts`: retain differing duplicate parent, channel, model or type bindings across the house roster merge; partial refreshes cannot clear an unresolved conflict.
- `src/client/__tests__/inventory-scope.spec.ts`: exercise stable no-I/O scopes, topology/account/lifecycle invalidation, conflict retention and single-record model binding.

This is a modified experimental source distribution maintained by genomez.
Public comparison anchor: `7040a5b08f076fe784e37ce5b669f9bb6e546fdd`. This anchor is a comparison
reference, not a claim that the composite preview was produced by one upstream commit.
Original copyright, license and contributor attribution are retained.

The list covers modified upstream files; source headers and fixture companion notices
identify changes locally. New files and omitted historical files are listed separately.
Line-ending-only differences are normalized without claiming behavioral changes.

## Modified files

- `.gitattributes` (comment header)
- `docs/live-media.md` (visible document notice)
- `examples/03-snapshot-and-control.ts` (source header)
- `package-lock.json` (manifest metadata)
- `package.json` (manifest metadata)
- `README.md` (visible document notice)
- `scripts/dev/gen_v2_fixture.py` (comment header)
- `src/client/__tests__/poll.spec.ts` (source header)
- `src/client/__tests__/realtime-property-changes.spec.ts` (source header)
- `src/client/__tests__/rebind-reads.spec.ts` (source header)
- `src/client/__tests__/stored-snapshot-lifecycle.spec.ts` (source header)
- `src/client/device-registry.ts` (source header)
- `src/client/eufy-mega.ts` (source header)
- `src/client/types.ts` (source header)
- `src/core/contracts.ts` (source header)
- `src/model/__tests__/device-cache.spec.ts` (source header)
- `src/model/__tests__/property-announcements.spec.ts` (source header)
- `src/model/__tests__/withheld-param-naming.spec.ts` (source header)
- `src/model/capabilities/__tests__/action-specs.spec.ts` (source header)
- `src/model/capabilities/__tests__/battery.spec.ts` (source header)
- `src/model/capabilities/__tests__/camera-disabled-media.spec.ts` (source header)
- `src/model/capabilities/__tests__/camera.spec.ts` (source header)
- `src/model/capabilities/__tests__/info.spec.ts` (source header)
- `src/model/capabilities/__tests__/light.spec.ts` (source header)
- `src/model/capabilities/__tests__/lock.spec.ts` (source header)
- `src/model/capabilities/__tests__/manifest.spec.ts` (source header)
- `src/model/capabilities/__tests__/motion.spec.ts` (source header)
- `src/model/capabilities/__tests__/person-detection.spec.ts` (source header)
- `src/model/capabilities/access.ts` (source header)
- `src/model/capabilities/battery.ts` (source header)
- `src/model/capabilities/camera.ts` (source header)
- `src/model/capabilities/index.ts` (source header)
- `src/model/capabilities/light.ts` (source header)
- `src/model/capabilities/lock.ts` (source header)
- `src/model/capabilities/manifest.ts` (source header)
- `src/model/capabilities/members.ts` (source header)
- `src/model/capabilities/motion.ts` (source header)
- `src/model/capabilities/person-detection.ts` (source header)
- `src/model/capabilities/ptz.ts` (source header)
- `src/model/device.ts` (source header)
- `src/model/types.ts` (source header)
- `src/transport/__tests__/stored-image-cache.spec.ts` (source header)
- `src/transport/http/__tests__/decode_v1.spec.ts` (source header)
- `src/transport/http/__tests__/decode_v2.spec.ts` (source header)
- `src/transport/http/__tests__/download-media.spec.ts` (source header)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_176x144.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_176x144_q30.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_264x200.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_320x240_420.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/gtoken-header.spec.ts` (source header)
- `src/transport/http/__tests__/solix-client.spec.ts` (source header)
- `src/transport/media-failure.ts` (source header)
- `src/transport/p2p/__tests__/p2p.spec.ts` (source header)
- `src/transport/push/__tests__/thumbnail-candidate.spec.ts` (source header)
- `src/transport/push/push-client.ts` (source header)
- `src/transport/push/types.ts` (source header)
- `src/transport/rtc/__tests__/command-router.spec.ts` (source header)
- `src/transport/rtc/__tests__/fixtures/ptcs-vectors.json` (fixture companion and directory notice)
- `src/transport/rtc/__tests__/live.spec.ts` (source header)
- `src/transport/rtc/__tests__/peer.spec.ts` (source header)
- `src/transport/rtc/__tests__/portal-packet.spec.ts` (source header)
- `src/transport/rtc/__tests__/ptcs-framer.spec.ts` (source header)
- `src/transport/rtc/__tests__/scall-sdp.spec.ts` (source header)
- `src/transport/rtc/__tests__/session.spec.ts` (source header)
- `src/transport/rtc/__tests__/signaling.spec.ts` (source header)
- `src/transport/rtc/command-router.ts` (source header)
- `src/transport/rtc/framer.ts` (source header)
- `src/transport/rtc/index.ts` (source header)
- `src/transport/rtc/live.ts` (source header)
- `src/transport/rtc/peer.ts` (source header)
- `src/transport/rtc/portal-packet.ts` (source header)
- `src/transport/rtc/ptcs-framer.ts` (source header)
- `src/transport/rtc/session.ts` (source header)
- `src/transport/rtc/signaling.ts` (source header)
- `src/transport/stored-image-cache.ts` (source header)
- `src/transport/tuya/__tests__/request.spec.ts` (source header)

## Additional files in the composite preview

- `EXPERIMENTAL.md`
- `SOURCE_MANIFEST.json`
- `src/client/__tests__/cached-device-context.spec.ts`
- `src/client/__tests__/cloud-envelope-pipeline.spec.ts`
- `src/client/__tests__/event-metadata-evidence.spec.ts`
- `src/client/__tests__/event-routing-diagnostics.spec.ts`
- `src/client/__tests__/event-state-overlay.spec.ts`
- `src/client/__tests__/light-command-observation.spec.ts`
- `src/client/__tests__/rtc-command-observation.spec.ts`
- `src/client/__tests__/rtc-command-routing.spec.ts`
- `src/client/__tests__/rtc-observation-diagnostics.spec.ts`
- `src/client/__tests__/rtc-push.spec.ts`
- `src/client/__tests__/rtc-state.spec.ts`
- `src/client/__tests__/rtc-wrapped-state.spec.ts`
- `src/client/__tests__/s1-passive-readback.spec.ts`
- `src/client/event-routing-diagnostics.ts`
- `src/client/rtc-observation-diagnostics.ts`
- `src/client/rtc-push.ts`
- `src/client/rtc-state.ts`
- `src/client/state-refresh-diagnostics.ts`
- `src/model/__tests__/cached-evidence.spec.ts`
- `src/model/__tests__/scalar-properties.spec.ts`
- `src/transport/__tests__/stored-image-retry.spec.ts`
- `src/transport/__tests__/thumbnail-diagnostics.spec.ts`
- `src/transport/__tests__/thumbnail-failure-evidence.spec.ts`
- `src/transport/push/__tests__/lifecycle-diagnostics.spec.ts`
- `src/transport/push/__tests__/mcs-envelope-preservation.spec.ts`
- `src/transport/push/__tests__/nested-thumbnail-time.spec.ts`
- `src/transport/push/lifecycle-diagnostics.ts`
- `src/transport/push/thumbnail-time.ts`
- `src/transport/rtc/__tests__/camera-info.spec.ts`
- `src/transport/rtc/__tests__/command-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/command-transport-evidence.spec.ts`
- `src/transport/rtc/__tests__/connection-deadline.spec.ts`
- `src/transport/rtc/__tests__/framing-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/information-refresh.spec.ts`
- `src/transport/rtc/__tests__/live-start-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/media-body.spec.ts`
- `src/transport/rtc/__tests__/media-ownership.spec.ts`
- `src/transport/rtc/__tests__/provider-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/ptcs-compression.spec.ts`
- `src/transport/rtc/__tests__/ptcs-reassembler.spec.ts`
- `src/transport/rtc/__tests__/push-notification.spec.ts`
- `src/transport/rtc/__tests__/readable-cancellation.spec.ts`
- `src/transport/rtc/__tests__/renewal-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/retained-session.spec.ts`
- `src/transport/rtc/__tests__/session-disposal.spec.ts`
- `src/transport/rtc/__tests__/session-refresh.spec.ts`
- `src/transport/rtc/__tests__/signaling-cancellation.spec.ts`
- `src/transport/rtc/__tests__/snapshot-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/transport-diagnostics.spec.ts`
- `src/transport/rtc/camera-info.ts`
- `src/transport/rtc/command-diagnostics.ts`
- `src/transport/rtc/command-transport-evidence.ts`
- `src/transport/rtc/connection-deadline.ts`
- `src/transport/rtc/push-notification.ts`
- `src/transport/rtc/read-diagnostics.ts`
- `src/transport/rtc/renewal-diagnostics.ts`
- `src/transport/rtc/retired-information-read.ts`
- `src/transport/rtc/snapshot.ts`
- `src/transport/rtc/storage-candidate.ts`
- `src/transport/rtc/transport-diagnostics.ts`
- `src/transport/thumbnail-diagnostics.ts`

## Historical files omitted from this preview

- `.github/CODEOWNERS`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/device_support.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/copilot-instructions.md`
- `.github/dependabot.yml`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `.github/workflows/docs.yml`
- `.github/workflows/merge-policy.yml`
- `.github/workflows/release.yml`
- `.gitmessage`
- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`
- `CODING_STANDARDS.md`
- `SECURITY.md`
- `docs/.vitepress/config.ts`
- `docs/.vitepress/theme/custom.css`
- `docs/.vitepress/theme/index.ts`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `docs/package-lock.json`
- `docs/package.json`
- `docs/public/devices/clean/clean-T1250.webp`
- `docs/public/devices/clean/clean-T2070.webp`
- `docs/public/devices/clean/clean-T2080.webp`
- `docs/public/devices/clean/clean-T2081.webp`
- `docs/public/devices/clean/clean-T2103.webp`
- `docs/public/devices/clean/clean-T2117.webp`
- `docs/public/devices/clean/clean-T2118.webp`
- `docs/public/devices/clean/clean-T2119.webp`
- `docs/public/devices/clean/clean-T211A.webp`
- `docs/public/devices/clean/clean-T2120.webp`
- `docs/public/devices/clean/clean-T2123.webp`
- `docs/public/devices/clean/clean-T2128.webp`
- `docs/public/devices/clean/clean-T2130.webp`
- `docs/public/devices/clean/clean-T2132.webp`
- `docs/public/devices/clean/clean-T2150.webp`
- `docs/public/devices/clean/clean-T2181.webp`
- `docs/public/devices/clean/clean-T2182.webp`
- `docs/public/devices/clean/clean-T2190.webp`
- `docs/public/devices/clean/clean-T2192.webp`
- `docs/public/devices/clean/clean-T2193.webp`
- `docs/public/devices/clean/clean-T2194.webp`
- `docs/public/devices/clean/clean-T2210.webp`
- `docs/public/devices/clean/clean-T2250.webp`
- `docs/public/devices/clean/clean-T2251.webp`
- `docs/public/devices/clean/clean-T2252.webp`
- `docs/public/devices/clean/clean-T2253.webp`
- `docs/public/devices/clean/clean-T2254.webp`
- `docs/public/devices/clean/clean-T2255.webp`
- `docs/public/devices/clean/clean-T2256.webp`
- `docs/public/devices/clean/clean-T2257.webp`
- `docs/public/devices/clean/clean-T2258.webp`
- `docs/public/devices/clean/clean-T2259.webp`
- `docs/public/devices/clean/clean-T2261.webp`
- `docs/public/devices/clean/clean-T2262.webp`
- `docs/public/devices/clean/clean-T2266.webp`
- `docs/public/devices/clean/clean-T2267.webp`
- `docs/public/devices/clean/clean-T2268.webp`
- `docs/public/devices/clean/clean-T2270.webp`
- `docs/public/devices/clean/clean-T2272.webp`
- `docs/public/devices/clean/clean-T2273.webp`
- `docs/public/devices/clean/clean-T2276.webp`
- `docs/public/devices/clean/clean-T2277.webp`
- `docs/public/devices/clean/clean-T2278.webp`
- `docs/public/devices/clean/clean-T2280.webp`
- `docs/public/devices/clean/clean-T2292.webp`
- `docs/public/devices/clean/clean-T2320.webp`
- `docs/public/devices/clean/clean-T2351.webp`
- `docs/public/devices/clean/clean-T2352.webp`
- `docs/public/devices/clean/clean-T2353.webp`
- `docs/public/devices/life/life-T8L00.webp`
- `docs/public/devices/life/life-T8L01.webp`
- `docs/public/devices/life/life-T8L02.webp`
- `docs/public/devices/life/life-T8L04.webp`
- `docs/public/devices/life/life-T8L10.webp`
- `docs/public/devices/life/life-T8L20.webp`
- `docs/public/devices/life/life-T8L30.webp`
- `docs/public/devices/life/life-T8L40.webp`
- `docs/public/devices/mower/mower-T2801.webp`
- `docs/public/devices/mower/mower-T280B.webp`
- `docs/public/devices/mower/mower-T2880.webp`
- `docs/public/devices/security/security-T7400.webp`
- `docs/public/devices/security/security-T7401.webp`
- `docs/public/devices/security/security-T8001.webp`
- `docs/public/devices/security/security-T8002.webp`
- `docs/public/devices/security/security-T8010.webp`
- `docs/public/devices/security/security-T8021.webp`
- `docs/public/devices/security/security-T8023.webp`
- `docs/public/devices/security/security-T8025.webp`
- `docs/public/devices/security/security-T8030.webp`
- `docs/public/devices/security/security-T8110.webp`
- `docs/public/devices/security/security-T8111.webp`
- `docs/public/devices/security/security-T8112.webp`
- `docs/public/devices/security/security-T8113.webp`
- `docs/public/devices/security/security-T8114.webp`
- `docs/public/devices/security/security-T8122.webp`
- `docs/public/devices/security/security-T8123.webp`
- `docs/public/devices/security/security-T8124.webp`
- `docs/public/devices/security/security-T8130.webp`
- `docs/public/devices/security/security-T8131.webp`
- `docs/public/devices/security/security-T8134.webp`
- `docs/public/devices/security/security-T8140.webp`
- `docs/public/devices/security/security-T8141.webp`
- `docs/public/devices/security/security-T8150.webp`
- `docs/public/devices/security/security-T8151.webp`
- `docs/public/devices/security/security-T8152.webp`
- `docs/public/devices/security/security-T8153.webp`
- `docs/public/devices/security/security-T8160.webp`
- `docs/public/devices/security/security-T8161.webp`
- `docs/public/devices/security/security-T8162.webp`
- `docs/public/devices/security/security-T8170.webp`
- `docs/public/devices/security/security-T8171.webp`
- `docs/public/devices/security/security-T8172.webp`
- `docs/public/devices/security/security-T8173.webp`
- `docs/public/devices/security/security-T8200.webp`
- `docs/public/devices/security/security-T8200X.webp`
- `docs/public/devices/security/security-T8201.webp`
- `docs/public/devices/security/security-T8203.webp`
- `docs/public/devices/security/security-T8210.webp`
- `docs/public/devices/security/security-T8213.webp`
- `docs/public/devices/security/security-T8214.webp`
- `docs/public/devices/security/security-T8222.webp`
- `docs/public/devices/security/security-T8400.webp`
- `docs/public/devices/security/security-T8401.webp`
- `docs/public/devices/security/security-T8410.webp`
- `docs/public/devices/security/security-T8411.webp`
- `docs/public/devices/security/security-T8414.webp`
- `docs/public/devices/security/security-T8416.webp`
- `docs/public/devices/security/security-T8417.webp`
- `docs/public/devices/security/security-T8419.webp`
- `docs/public/devices/security/security-T8419N.webp`
- `docs/public/devices/security/security-T8420.webp`
- `docs/public/devices/security/security-T8420X.webp`
- `docs/public/devices/security/security-T8422.webp`
- `docs/public/devices/security/security-T8423.webp`
- `docs/public/devices/security/security-T8424.webp`
- `docs/public/devices/security/security-T8425.webp`
- `docs/public/devices/security/security-T8441.webp`
- `docs/public/devices/security/security-T8442.webp`
- `docs/public/devices/security/security-T8452.webp`
- `docs/public/devices/security/security-T84A0.webp`
- `docs/public/devices/security/security-T84A1.webp`
- `docs/public/devices/security/security-T8500.webp`
- `docs/public/devices/security/security-T8502.webp`
- `docs/public/devices/security/security-T8503.webp`
- `docs/public/devices/security/security-T8504.webp`
- `docs/public/devices/security/security-T8506.webp`
- `docs/public/devices/security/security-T8510.webp`
- `docs/public/devices/security/security-T8510P.webp`
- `docs/public/devices/security/security-T8520.webp`
- `docs/public/devices/security/security-T8520P.webp`
- `docs/public/devices/security/security-T8530.webp`
- `docs/public/devices/security/security-T8531.webp`
- `docs/public/devices/security/security-T85D0.webp`
- `docs/public/devices/security/security-T85L0.webp`
- `docs/public/devices/security/security-T85P0.webp`
- `docs/public/devices/security/security-T85V0.webp`
- `docs/public/devices/security/security-T8600.webp`
- `docs/public/devices/security/security-T86P2.webp`
- `docs/public/devices/security/security-T8790.webp`
- `docs/public/devices/security/security-T87A0.webp`
- `docs/public/devices/security/security-T87B0.webp`
- `docs/public/devices/security/security-T87B2.webp`
- `docs/public/devices/security/security-T8900.webp`
- `docs/public/devices/security/security-T8910.webp`
- `docs/public/devices/security/security-T8920.webp`
- `docs/public/devices/security/security-T8960.webp`
- `docs/public/devices/security/security-T8B0.webp`
- `docs/public/devices/security/security-T8E00.webp`
- `docs/public/devices/security/security-T8N00.webp`
- `docs/public/devices/security/security-T8W11C.webp`
- `docs/public/devices/security/security-T90F0.webp`
- `docs/public/devices/security/security-T90M0.webp`
- `docs/public/devices/security/security-T90R0.webp`
- `docs/public/devices/security/security-T90S0.webp`
- `docs/public/favicon.svg`
- `docs/public/logo-dark.svg`
- `docs/public/logo.svg`
- `docs/scripts/guard-docs.sh`
- `scripts/device-artwork-to-webp.sh`
- `scripts/release.sh`

## Safety candidate, 2026-10-14

Local ICE callbacks require an open signaling socket. Base source commit: `5e81218e0a14109b1f002fe7a3ebd3e4accb7f31`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.

## Renewal retry candidate, 2026-10-14

Modified by genomez for version `0.2.1-s1.experimental.3`, based on public source commit `9716ee3ffb103482cbe2c6a21da4de6d467c7933`.

- `src/transport/rtc/command-router.ts`: permits the existing single proof-gated retry after a verified replacement is blocked by held leases; retains identity, connection, complete-read, cooldown, attempt-budget and cancellation guards.
- `src/transport/rtc/__tests__/session-refresh.spec.ts`: adds synthetic lease, proof, identity, candidate-failure, budget and cancellation coverage.
- `package.json` and `package-lock.json`: change only root version labels; dependencies, private status, authors and license remain unchanged.
- `README.md`, `EXPERIMENTAL.md`, `BUILD_PROVENANCE.json`, `PUBLICATION.json` and `SOURCE_MANIFEST.json`: identify local preparation status, matching sources and historical implementation evidence without claiming publication or a new test run.

Implementation bytes are identical to the historically verified input. Release qualification of this final metadata combination is pending. Original copyright, license, contributors and modification notices are preserved.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds SDK error-event `origin` labels, typed event metadata, documentation and synthetic regression coverage. Existing signaling safety and renewal behavior are retained. Packaging metadata and source hashes identify this unpublished local candidate. Original attribution and licenses are preserved.

## Experimental.5 candidate, 2026-10-16

Version `0.2.1-s1.experimental.5`: Floodlight write confirmation; complete realtime teardown and empty-refresh backoff; withhold battery charge source on known mains cameras; treat -100 Wi-Fi as no reading; opt-in command-session keepalive; redact echoed tokens from RTC sign refusals. Local packaging and prior hardware evidence do not establish final image acceptance. Original attribution and licenses are preserved.

## Experimental.6 preparation, 2026-10-16

Version `0.2.1-s1.experimental.6` is prepared locally and has not been published. Packaging-only version update; SDK implementation and tests are unchanged from experimental.5, including token redaction and opt-in command-session keepalive.

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

Files modified or added for this port:

- `src/client/__tests__/prewarm.spec.ts`
- `src/client/eufy-mega.ts`
- `src/model/__tests__/model.spec.ts`
- `src/model/capabilities/__tests__/battery.spec.ts`
- `src/model/capabilities/__tests__/camera.spec.ts`
- `src/model/capabilities/battery.ts`
- `src/model/capabilities/camera.ts`
- `src/model/capabilities/index.ts`

## Experimental.6 upstream-port package refresh, 2026-10-16

This local package is rebuilt from implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5`, including the upstream power-policy adaptations and retained `a408a51`/`980f9a1` freshness fixes. Earlier package statements above describe historical inputs. SDK version remains `0.2.1-s1.experimental.6`, private with npm publication disabled. The rebuilt bundle, complete source manifest and offline tarball identify the exact local input. Original licenses, attribution and notices remain intact; final-image and hardware qualification remain pending.

## Bounded late-effect reconciliation, 2026-10-16

Passive command ACK acceptance defaults to 12 seconds independently of the 8-second fallback information-read trigger. Correlated rejection codes remain explicit. Attached mains floodlight 1400 writes that end unconfirmed receive coalesced authoritative information reads at approximately send +15/+25/+40 seconds, bounded by a 45-second intent lifetime. New target operations and session closure cancel the intent; no write is replayed. Normal cache and property events convey later information without rewriting the original result. Background reads retain refresh failure holds and queue normally. A failed late read is counted only in the late-effect diagnostics; it does not charge the scheduled refresh backoff, delay the scheduled timer, suppress report refreshes or emit a state-refresh error.

## S1 attached-camera siren port, 2026-10-16

Adapted upstream mega-yfue/eufy-sdk #364 (Daniele Messi / danymexi;
merge `2adf08595ff0bcb8f9c5c56588ce6ce812a1cfa3`, final feature head
`70e48103daefbe1acf0af67f4e12c42f0ef4c74a`) and #401 final model gate
(`024d9d4eed3ad3ead5df2c2540f6cfb7981ded17`). Original attribution and licenses remain intact.

Modified files with dated source headers:

- `src/model/capabilities/siren.ts`: exact evidenced S1 model gate and portal duration start/stop.
- `src/model/capabilities/types.ts`: cached parent station type and model context.
- `src/model/device-family.ts`: S1 family predicate, including explicit station model identification.
- `src/client/eufy-mega.ts`: inject parent facts using the existing cached station link.
- `src/model/capabilities/__tests__/siren.spec.ts`: adapted upstream tests and negative model/evidence checks.
- `src/client/__tests__/rtc-command-routing.spec.ts`: adapted parent-context tests and real-router start/stop envelope coverage.

The local RTC command router, keepalive, watchdog and state-freshness code is retained. A successful
command acknowledgement never supplies sounding state. This is a local source change only; release
packaging manifests and provenance have not been refreshed.

## 2026-10-17 — Pending acceptance for bounded late-effect writes

A strictly correlated station wait-timeout reply (-108) on a transmitted, current
late-effect-eligible attached mains switch now resolves the facade command as
accepted pending authoritative confirmation. Other negative codes and commands
without the bounded job retain rejection behavior. No send-only acceptance or
write replay is added. The existing +15/+25/+40-second information reads and
45-second expiry remain unchanged. Unchanged real observations still emit
propertiesObserved independently of propertyChanged. Count-only pendingAccepted
and a finite pending_accepted event distinguish this facade acceptance from the
retained signed station rejection evidence. Local synthetic verification only.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

## Experimental.7, 2026-10-22

Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics. Source input: `6deea127459f368edb24d7d3df59dcaf60d5b508`.


## Historical input documentation and modification notices

# Source modification index

Modified for genomez S1 experimental source preview, 2026-10-17.

## Validated live-view inventory scope, 2026-10-17

- `src/client/eufy-mega.ts`: expose an opaque cache-only inventory scope and detached conflicting serials for validated media admission; reuse the already fetched device record when binding command context.
- `src/client/device-registry.ts`: retain differing duplicate parent, channel, model or type bindings across the house roster merge; partial refreshes cannot clear an unresolved conflict.
- `src/client/__tests__/inventory-scope.spec.ts`: exercise stable no-I/O scopes, topology/account/lifecycle invalidation, conflict retention and single-record model binding.

This is a modified experimental source distribution maintained by genomez.
Public comparison anchor: `7040a5b08f076fe784e37ce5b669f9bb6e546fdd`. This anchor is a comparison
reference, not a claim that the composite preview was produced by one upstream commit.
Original copyright, license and contributor attribution are retained.

The list covers modified upstream files; source headers and fixture companion notices
identify changes locally. New files and omitted historical files are listed separately.
Line-ending-only differences are normalized without claiming behavioral changes.

## Modified files

- `.gitattributes` (comment header)
- `docs/live-media.md` (visible document notice)
- `examples/03-snapshot-and-control.ts` (source header)
- `package-lock.json` (manifest metadata)
- `package.json` (manifest metadata)
- `README.md` (visible document notice)
- `scripts/dev/gen_v2_fixture.py` (comment header)
- `src/client/__tests__/poll.spec.ts` (source header)
- `src/client/__tests__/realtime-property-changes.spec.ts` (source header)
- `src/client/__tests__/rebind-reads.spec.ts` (source header)
- `src/client/__tests__/stored-snapshot-lifecycle.spec.ts` (source header)
- `src/client/device-registry.ts` (source header)
- `src/client/eufy-mega.ts` (source header)
- `src/client/types.ts` (source header)
- `src/core/contracts.ts` (source header)
- `src/model/__tests__/device-cache.spec.ts` (source header)
- `src/model/__tests__/property-announcements.spec.ts` (source header)
- `src/model/__tests__/withheld-param-naming.spec.ts` (source header)
- `src/model/capabilities/__tests__/action-specs.spec.ts` (source header)
- `src/model/capabilities/__tests__/battery.spec.ts` (source header)
- `src/model/capabilities/__tests__/camera-disabled-media.spec.ts` (source header)
- `src/model/capabilities/__tests__/camera.spec.ts` (source header)
- `src/model/capabilities/__tests__/info.spec.ts` (source header)
- `src/model/capabilities/__tests__/light.spec.ts` (source header)
- `src/model/capabilities/__tests__/lock.spec.ts` (source header)
- `src/model/capabilities/__tests__/manifest.spec.ts` (source header)
- `src/model/capabilities/__tests__/motion.spec.ts` (source header)
- `src/model/capabilities/__tests__/person-detection.spec.ts` (source header)
- `src/model/capabilities/access.ts` (source header)
- `src/model/capabilities/battery.ts` (source header)
- `src/model/capabilities/camera.ts` (source header)
- `src/model/capabilities/index.ts` (source header)
- `src/model/capabilities/light.ts` (source header)
- `src/model/capabilities/lock.ts` (source header)
- `src/model/capabilities/manifest.ts` (source header)
- `src/model/capabilities/members.ts` (source header)
- `src/model/capabilities/motion.ts` (source header)
- `src/model/capabilities/person-detection.ts` (source header)
- `src/model/capabilities/ptz.ts` (source header)
- `src/model/device.ts` (source header)
- `src/model/types.ts` (source header)
- `src/transport/__tests__/stored-image-cache.spec.ts` (source header)
- `src/transport/http/__tests__/decode_v1.spec.ts` (source header)
- `src/transport/http/__tests__/decode_v2.spec.ts` (source header)
- `src/transport/http/__tests__/download-media.spec.ts` (source header)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_176x144.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_176x144_q30.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_264x200.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/fixtures/v2_thumbnail_320x240_420.b64` (fixture companion and directory notice)
- `src/transport/http/__tests__/gtoken-header.spec.ts` (source header)
- `src/transport/http/__tests__/solix-client.spec.ts` (source header)
- `src/transport/media-failure.ts` (source header)
- `src/transport/p2p/__tests__/p2p.spec.ts` (source header)
- `src/transport/push/__tests__/thumbnail-candidate.spec.ts` (source header)
- `src/transport/push/push-client.ts` (source header)
- `src/transport/push/types.ts` (source header)
- `src/transport/rtc/__tests__/command-router.spec.ts` (source header)
- `src/transport/rtc/__tests__/fixtures/ptcs-vectors.json` (fixture companion and directory notice)
- `src/transport/rtc/__tests__/live.spec.ts` (source header)
- `src/transport/rtc/__tests__/peer.spec.ts` (source header)
- `src/transport/rtc/__tests__/portal-packet.spec.ts` (source header)
- `src/transport/rtc/__tests__/ptcs-framer.spec.ts` (source header)
- `src/transport/rtc/__tests__/scall-sdp.spec.ts` (source header)
- `src/transport/rtc/__tests__/session.spec.ts` (source header)
- `src/transport/rtc/__tests__/signaling.spec.ts` (source header)
- `src/transport/rtc/command-router.ts` (source header)
- `src/transport/rtc/framer.ts` (source header)
- `src/transport/rtc/index.ts` (source header)
- `src/transport/rtc/live.ts` (source header)
- `src/transport/rtc/peer.ts` (source header)
- `src/transport/rtc/portal-packet.ts` (source header)
- `src/transport/rtc/ptcs-framer.ts` (source header)
- `src/transport/rtc/session.ts` (source header)
- `src/transport/rtc/signaling.ts` (source header)
- `src/transport/stored-image-cache.ts` (source header)
- `src/transport/tuya/__tests__/request.spec.ts` (source header)

## Additional files in the composite preview

- `EXPERIMENTAL.md`
- `SOURCE_MANIFEST.json`
- `src/client/__tests__/cached-device-context.spec.ts`
- `src/client/__tests__/cloud-envelope-pipeline.spec.ts`
- `src/client/__tests__/event-metadata-evidence.spec.ts`
- `src/client/__tests__/event-routing-diagnostics.spec.ts`
- `src/client/__tests__/event-state-overlay.spec.ts`
- `src/client/__tests__/light-command-observation.spec.ts`
- `src/client/__tests__/rtc-command-observation.spec.ts`
- `src/client/__tests__/rtc-command-routing.spec.ts`
- `src/client/__tests__/rtc-observation-diagnostics.spec.ts`
- `src/client/__tests__/rtc-push.spec.ts`
- `src/client/__tests__/rtc-state.spec.ts`
- `src/client/__tests__/rtc-wrapped-state.spec.ts`
- `src/client/__tests__/s1-passive-readback.spec.ts`
- `src/client/event-routing-diagnostics.ts`
- `src/client/rtc-observation-diagnostics.ts`
- `src/client/rtc-push.ts`
- `src/client/rtc-state.ts`
- `src/client/state-refresh-diagnostics.ts`
- `src/model/__tests__/cached-evidence.spec.ts`
- `src/model/__tests__/scalar-properties.spec.ts`
- `src/transport/__tests__/stored-image-retry.spec.ts`
- `src/transport/__tests__/thumbnail-diagnostics.spec.ts`
- `src/transport/__tests__/thumbnail-failure-evidence.spec.ts`
- `src/transport/push/__tests__/lifecycle-diagnostics.spec.ts`
- `src/transport/push/__tests__/mcs-envelope-preservation.spec.ts`
- `src/transport/push/__tests__/nested-thumbnail-time.spec.ts`
- `src/transport/push/lifecycle-diagnostics.ts`
- `src/transport/push/thumbnail-time.ts`
- `src/transport/rtc/__tests__/camera-info.spec.ts`
- `src/transport/rtc/__tests__/command-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/command-transport-evidence.spec.ts`
- `src/transport/rtc/__tests__/connection-deadline.spec.ts`
- `src/transport/rtc/__tests__/framing-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/information-refresh.spec.ts`
- `src/transport/rtc/__tests__/live-start-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/media-body.spec.ts`
- `src/transport/rtc/__tests__/media-ownership.spec.ts`
- `src/transport/rtc/__tests__/provider-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/ptcs-compression.spec.ts`
- `src/transport/rtc/__tests__/ptcs-reassembler.spec.ts`
- `src/transport/rtc/__tests__/push-notification.spec.ts`
- `src/transport/rtc/__tests__/readable-cancellation.spec.ts`
- `src/transport/rtc/__tests__/renewal-diagnostics.spec.ts`
- `src/transport/rtc/__tests__/retained-session.spec.ts`
- `src/transport/rtc/__tests__/session-disposal.spec.ts`
- `src/transport/rtc/__tests__/session-refresh.spec.ts`
- `src/transport/rtc/__tests__/signaling-cancellation.spec.ts`
- `src/transport/rtc/__tests__/snapshot-lifecycle.spec.ts`
- `src/transport/rtc/__tests__/transport-diagnostics.spec.ts`
- `src/transport/rtc/camera-info.ts`
- `src/transport/rtc/command-diagnostics.ts`
- `src/transport/rtc/command-transport-evidence.ts`
- `src/transport/rtc/connection-deadline.ts`
- `src/transport/rtc/push-notification.ts`
- `src/transport/rtc/read-diagnostics.ts`
- `src/transport/rtc/renewal-diagnostics.ts`
- `src/transport/rtc/retired-information-read.ts`
- `src/transport/rtc/snapshot.ts`
- `src/transport/rtc/storage-candidate.ts`
- `src/transport/rtc/transport-diagnostics.ts`
- `src/transport/thumbnail-diagnostics.ts`

## Historical files omitted from this preview

- `.github/CODEOWNERS`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/device_support.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/copilot-instructions.md`
- `.github/dependabot.yml`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `.github/workflows/docs.yml`
- `.github/workflows/merge-policy.yml`
- `.github/workflows/release.yml`
- `.gitmessage`
- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`
- `CODING_STANDARDS.md`
- `SECURITY.md`
- `docs/.vitepress/config.ts`
- `docs/.vitepress/theme/custom.css`
- `docs/.vitepress/theme/index.ts`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `docs/package-lock.json`
- `docs/package.json`
- `docs/public/devices/clean/clean-T1250.webp`
- `docs/public/devices/clean/clean-T2070.webp`
- `docs/public/devices/clean/clean-T2080.webp`
- `docs/public/devices/clean/clean-T2081.webp`
- `docs/public/devices/clean/clean-T2103.webp`
- `docs/public/devices/clean/clean-T2117.webp`
- `docs/public/devices/clean/clean-T2118.webp`
- `docs/public/devices/clean/clean-T2119.webp`
- `docs/public/devices/clean/clean-T211A.webp`
- `docs/public/devices/clean/clean-T2120.webp`
- `docs/public/devices/clean/clean-T2123.webp`
- `docs/public/devices/clean/clean-T2128.webp`
- `docs/public/devices/clean/clean-T2130.webp`
- `docs/public/devices/clean/clean-T2132.webp`
- `docs/public/devices/clean/clean-T2150.webp`
- `docs/public/devices/clean/clean-T2181.webp`
- `docs/public/devices/clean/clean-T2182.webp`
- `docs/public/devices/clean/clean-T2190.webp`
- `docs/public/devices/clean/clean-T2192.webp`
- `docs/public/devices/clean/clean-T2193.webp`
- `docs/public/devices/clean/clean-T2194.webp`
- `docs/public/devices/clean/clean-T2210.webp`
- `docs/public/devices/clean/clean-T2250.webp`
- `docs/public/devices/clean/clean-T2251.webp`
- `docs/public/devices/clean/clean-T2252.webp`
- `docs/public/devices/clean/clean-T2253.webp`
- `docs/public/devices/clean/clean-T2254.webp`
- `docs/public/devices/clean/clean-T2255.webp`
- `docs/public/devices/clean/clean-T2256.webp`
- `docs/public/devices/clean/clean-T2257.webp`
- `docs/public/devices/clean/clean-T2258.webp`
- `docs/public/devices/clean/clean-T2259.webp`
- `docs/public/devices/clean/clean-T2261.webp`
- `docs/public/devices/clean/clean-T2262.webp`
- `docs/public/devices/clean/clean-T2266.webp`
- `docs/public/devices/clean/clean-T2267.webp`
- `docs/public/devices/clean/clean-T2268.webp`
- `docs/public/devices/clean/clean-T2270.webp`
- `docs/public/devices/clean/clean-T2272.webp`
- `docs/public/devices/clean/clean-T2273.webp`
- `docs/public/devices/clean/clean-T2276.webp`
- `docs/public/devices/clean/clean-T2277.webp`
- `docs/public/devices/clean/clean-T2278.webp`
- `docs/public/devices/clean/clean-T2280.webp`
- `docs/public/devices/clean/clean-T2292.webp`
- `docs/public/devices/clean/clean-T2320.webp`
- `docs/public/devices/clean/clean-T2351.webp`
- `docs/public/devices/clean/clean-T2352.webp`
- `docs/public/devices/clean/clean-T2353.webp`
- `docs/public/devices/life/life-T8L00.webp`
- `docs/public/devices/life/life-T8L01.webp`
- `docs/public/devices/life/life-T8L02.webp`
- `docs/public/devices/life/life-T8L04.webp`
- `docs/public/devices/life/life-T8L10.webp`
- `docs/public/devices/life/life-T8L20.webp`
- `docs/public/devices/life/life-T8L30.webp`
- `docs/public/devices/life/life-T8L40.webp`
- `docs/public/devices/mower/mower-T2801.webp`
- `docs/public/devices/mower/mower-T280B.webp`
- `docs/public/devices/mower/mower-T2880.webp`
- `docs/public/devices/security/security-T7400.webp`
- `docs/public/devices/security/security-T7401.webp`
- `docs/public/devices/security/security-T8001.webp`
- `docs/public/devices/security/security-T8002.webp`
- `docs/public/devices/security/security-T8010.webp`
- `docs/public/devices/security/security-T8021.webp`
- `docs/public/devices/security/security-T8023.webp`
- `docs/public/devices/security/security-T8025.webp`
- `docs/public/devices/security/security-T8030.webp`
- `docs/public/devices/security/security-T8110.webp`
- `docs/public/devices/security/security-T8111.webp`
- `docs/public/devices/security/security-T8112.webp`
- `docs/public/devices/security/security-T8113.webp`
- `docs/public/devices/security/security-T8114.webp`
- `docs/public/devices/security/security-T8122.webp`
- `docs/public/devices/security/security-T8123.webp`
- `docs/public/devices/security/security-T8124.webp`
- `docs/public/devices/security/security-T8130.webp`
- `docs/public/devices/security/security-T8131.webp`
- `docs/public/devices/security/security-T8134.webp`
- `docs/public/devices/security/security-T8140.webp`
- `docs/public/devices/security/security-T8141.webp`
- `docs/public/devices/security/security-T8150.webp`
- `docs/public/devices/security/security-T8151.webp`
- `docs/public/devices/security/security-T8152.webp`
- `docs/public/devices/security/security-T8153.webp`
- `docs/public/devices/security/security-T8160.webp`
- `docs/public/devices/security/security-T8161.webp`
- `docs/public/devices/security/security-T8162.webp`
- `docs/public/devices/security/security-T8170.webp`
- `docs/public/devices/security/security-T8171.webp`
- `docs/public/devices/security/security-T8172.webp`
- `docs/public/devices/security/security-T8173.webp`
- `docs/public/devices/security/security-T8200.webp`
- `docs/public/devices/security/security-T8200X.webp`
- `docs/public/devices/security/security-T8201.webp`
- `docs/public/devices/security/security-T8203.webp`
- `docs/public/devices/security/security-T8210.webp`
- `docs/public/devices/security/security-T8213.webp`
- `docs/public/devices/security/security-T8214.webp`
- `docs/public/devices/security/security-T8222.webp`
- `docs/public/devices/security/security-T8400.webp`
- `docs/public/devices/security/security-T8401.webp`
- `docs/public/devices/security/security-T8410.webp`
- `docs/public/devices/security/security-T8411.webp`
- `docs/public/devices/security/security-T8414.webp`
- `docs/public/devices/security/security-T8416.webp`
- `docs/public/devices/security/security-T8417.webp`
- `docs/public/devices/security/security-T8419.webp`
- `docs/public/devices/security/security-T8419N.webp`
- `docs/public/devices/security/security-T8420.webp`
- `docs/public/devices/security/security-T8420X.webp`
- `docs/public/devices/security/security-T8422.webp`
- `docs/public/devices/security/security-T8423.webp`
- `docs/public/devices/security/security-T8424.webp`
- `docs/public/devices/security/security-T8425.webp`
- `docs/public/devices/security/security-T8441.webp`
- `docs/public/devices/security/security-T8442.webp`
- `docs/public/devices/security/security-T8452.webp`
- `docs/public/devices/security/security-T84A0.webp`
- `docs/public/devices/security/security-T84A1.webp`
- `docs/public/devices/security/security-T8500.webp`
- `docs/public/devices/security/security-T8502.webp`
- `docs/public/devices/security/security-T8503.webp`
- `docs/public/devices/security/security-T8504.webp`
- `docs/public/devices/security/security-T8506.webp`
- `docs/public/devices/security/security-T8510.webp`
- `docs/public/devices/security/security-T8510P.webp`
- `docs/public/devices/security/security-T8520.webp`
- `docs/public/devices/security/security-T8520P.webp`
- `docs/public/devices/security/security-T8530.webp`
- `docs/public/devices/security/security-T8531.webp`
- `docs/public/devices/security/security-T85D0.webp`
- `docs/public/devices/security/security-T85L0.webp`
- `docs/public/devices/security/security-T85P0.webp`
- `docs/public/devices/security/security-T85V0.webp`
- `docs/public/devices/security/security-T8600.webp`
- `docs/public/devices/security/security-T86P2.webp`
- `docs/public/devices/security/security-T8790.webp`
- `docs/public/devices/security/security-T87A0.webp`
- `docs/public/devices/security/security-T87B0.webp`
- `docs/public/devices/security/security-T87B2.webp`
- `docs/public/devices/security/security-T8900.webp`
- `docs/public/devices/security/security-T8910.webp`
- `docs/public/devices/security/security-T8920.webp`
- `docs/public/devices/security/security-T8960.webp`
- `docs/public/devices/security/security-T8B0.webp`
- `docs/public/devices/security/security-T8E00.webp`
- `docs/public/devices/security/security-T8N00.webp`
- `docs/public/devices/security/security-T8W11C.webp`
- `docs/public/devices/security/security-T90F0.webp`
- `docs/public/devices/security/security-T90M0.webp`
- `docs/public/devices/security/security-T90R0.webp`
- `docs/public/devices/security/security-T90S0.webp`
- `docs/public/favicon.svg`
- `docs/public/logo-dark.svg`
- `docs/public/logo.svg`
- `docs/scripts/guard-docs.sh`
- `scripts/device-artwork-to-webp.sh`
- `scripts/release.sh`

## Safety candidate, 2026-10-14

Local ICE callbacks require an open signaling socket. Base source commit: `5e81218e0a14109b1f002fe7a3ebd3e4accb7f31`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.

## Renewal retry candidate, 2026-10-14

Modified by genomez for version `0.2.1-s1.experimental.3`, based on public source commit `9716ee3ffb103482cbe2c6a21da4de6d467c7933`.

- `src/transport/rtc/command-router.ts`: permits the existing single proof-gated retry after a verified replacement is blocked by held leases; retains identity, connection, complete-read, cooldown, attempt-budget and cancellation guards.
- `src/transport/rtc/__tests__/session-refresh.spec.ts`: adds synthetic lease, proof, identity, candidate-failure, budget and cancellation coverage.
- `package.json` and `package-lock.json`: change only root version labels; dependencies, private status, authors and license remain unchanged.
- `README.md`, `EXPERIMENTAL.md`, `BUILD_PROVENANCE.json`, `PUBLICATION.json` and `SOURCE_MANIFEST.json`: identify local preparation status, matching sources and historical implementation evidence without claiming publication or a new test run.

Implementation bytes are identical to the historically verified input. Release qualification of this final metadata combination is pending. Original copyright, license, contributors and modification notices are preserved.

## Error-origin candidate, 2026-10-15

Version `0.2.1-s1.experimental.4` adds SDK error-event `origin` labels, typed event metadata, documentation and synthetic regression coverage. Existing signaling safety and renewal behavior are retained. Packaging metadata and source hashes identify this unpublished local candidate. Original attribution and licenses are preserved.

## Experimental.5 candidate, 2026-10-16

Version `0.2.1-s1.experimental.5`: Floodlight write confirmation; complete realtime teardown and empty-refresh backoff; withhold battery charge source on known mains cameras; treat -100 Wi-Fi as no reading; opt-in command-session keepalive; redact echoed tokens from RTC sign refusals. Local packaging and prior hardware evidence do not establish final image acceptance. Original attribution and licenses are preserved.

## Experimental.6 preparation, 2026-10-16

Version `0.2.1-s1.experimental.6` is prepared locally and has not been published. Packaging-only version update; SDK implementation and tests are unchanged from experimental.5, including token redaction and opt-in command-session keepalive.

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

Files modified or added for this port:

- `src/client/__tests__/prewarm.spec.ts`
- `src/client/eufy-mega.ts`
- `src/model/__tests__/model.spec.ts`
- `src/model/capabilities/__tests__/battery.spec.ts`
- `src/model/capabilities/__tests__/camera.spec.ts`
- `src/model/capabilities/battery.ts`
- `src/model/capabilities/camera.ts`
- `src/model/capabilities/index.ts`

## Experimental.6 upstream-port package refresh, 2026-10-16

This local package is rebuilt from implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5`, including the upstream power-policy adaptations and retained `a408a51`/`980f9a1` freshness fixes. Earlier package statements above describe historical inputs. SDK version remains `0.2.1-s1.experimental.6`, private with npm publication disabled. The rebuilt bundle, complete source manifest and offline tarball identify the exact local input. Original licenses, attribution and notices remain intact; final-image and hardware qualification remain pending.

## Bounded late-effect reconciliation, 2026-10-16

Passive command ACK acceptance defaults to 12 seconds independently of the 8-second fallback information-read trigger. Correlated rejection codes remain explicit. Attached mains floodlight 1400 writes that end unconfirmed receive coalesced authoritative information reads at approximately send +15/+25/+40 seconds, bounded by a 45-second intent lifetime. New target operations and session closure cancel the intent; no write is replayed. Normal cache and property events convey later information without rewriting the original result. Background reads retain refresh failure holds and queue normally. A failed late read is counted only in the late-effect diagnostics; it does not charge the scheduled refresh backoff, delay the scheduled timer, suppress report refreshes or emit a state-refresh error.

## S1 attached-camera siren port, 2026-10-16

Adapted upstream mega-yfue/eufy-sdk #364 (Daniele Messi / danymexi;
merge `2adf08595ff0bcb8f9c5c56588ce6ce812a1cfa3`, final feature head
`70e48103daefbe1acf0af67f4e12c42f0ef4c74a`) and #401 final model gate
(`024d9d4eed3ad3ead5df2c2540f6cfb7981ded17`). Original attribution and licenses remain intact.

Modified files with dated source headers:

- `src/model/capabilities/siren.ts`: exact evidenced S1 model gate and portal duration start/stop.
- `src/model/capabilities/types.ts`: cached parent station type and model context.
- `src/model/device-family.ts`: S1 family predicate, including explicit station model identification.
- `src/client/eufy-mega.ts`: inject parent facts using the existing cached station link.
- `src/model/capabilities/__tests__/siren.spec.ts`: adapted upstream tests and negative model/evidence checks.
- `src/client/__tests__/rtc-command-routing.spec.ts`: adapted parent-context tests and real-router start/stop envelope coverage.

The local RTC command router, keepalive, watchdog and state-freshness code is retained. A successful
command acknowledgement never supplies sounding state. This is a local source change only; release
packaging manifests and provenance have not been refreshed.

## 2026-10-17 — Pending acceptance for bounded late-effect writes

A strictly correlated station wait-timeout reply (-108) on a transmitted, current
late-effect-eligible attached mains switch now resolves the facade command as
accepted pending authoritative confirmation. Other negative codes and commands
without the bounded job retain rejection behavior. No send-only acceptance or
write replay is added. The existing +15/+25/+40-second information reads and
45-second expiry remain unchanged. Unchanged real observations still emit
propertiesObserved independently of propertyChanged. Count-only pendingAccepted
and a finite pending_accepted event distinguish this facade acceptance from the
retained signed station rejection evidence. Local synthetic verification only.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.
