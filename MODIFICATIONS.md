# Source modification index

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
