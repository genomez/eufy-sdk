# Experimental.9 local preparation

Version `0.2.1-s1.experimental.9` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.9`, integration/bridge `0.3.1-s1.experimental.9` and SDK `0.2.1-s1.experimental.9`.

Failed SDK background read-through refreshes now report through the existing `state_refresh` origin and retain last-known values. Routine camera health attributes refresh less often to reduce recorder writes. Optional floodlight safety reports persisted unconfirmed OFF incidents through `off_stuck_incident`, `off_stuck_reason`, `off_stuck_opened_at` and `off_stuck_escalate_at`.

Defaults are unchanged from .8: relay off, enabled only by boolean `webrtc_relay: true`; command keepalive 29000 ms; `light_correction_enabled` off. With safety off, the new OFF-stuck reporting is inactive and its attributes are not exposed. No new option or default is added. SDK documentation formatting is a documentation-only change.

Known issues carried from .8: T8113-Z firmware 3.3.8 picture-then-black; live view sometimes needs another open or stalls awaiting the hub offer; unexplained floodlight ON events; deferred brightness/spotlight formatting. No fix for these is claimed. Keep battery-camera preload off.

Local offline validation does not establish new device, account, media, HACS or soak acceptance. Publication, installation and tester messaging need separate owner approval. Owner-local recovery automation is outside this release.

## Historical experimental.8 documentation

# Experimental.8 verified public delivery

Runtime/source release: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.8
Integration release: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.8
Verified registry manifest: sha256:4289f94e617c0e60207edb8ddaa75d88cfdf777ad081e9e43feb915a4b2ef119
Paired add-on 0.4.1-s1.experimental.8, integration/bridge 0.3.1-s1.experimental.8 and SDK 0.2.1-s1.experimental.8. These bindings come from independent anonymous release, asset, workflow and registry verification. Installation, HACS and physical-device acceptance remain separate.

The official integration ZIP remains frozen at 6bb1365de39615d9e094b44b7665118451326e8d; current branch documentation may differ from the release archive. Version-specific source, image-context and archive records below remain historical. The exact prepared implementation and workflow are unchanged.

## Historical local preparation and earlier release records

# Experimental.8 local preparation

Version `0.2.1-s1.experimental.8` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

RTC late-viewer keyframe gating; bounded refresh backoff and recovery; isolated slow replies; camera connectivity and hub reply evidence; T8171 detection; opt-in floodlight safety with bounded confirmation and problem notices; observation-only media stall evidence.

Live view remains off by default; only boolean `webrtc_relay: true` enables it. Command keepalive remains 29000 ms. Integration floodlight safety uses `light_correction_enabled` and remains off by default. The opt-in safety binds HA intent, uses 15-minute motion and ON waits with a 30-minute watchdog, retries OFF until camera confirmation within its limits, and reports problems with bounded phone retries. It may retry an authorized ON intent; the historical .7 OFF-only corrector description below is superseded. Passive connectivity diagnostics do not establish physical state.

Media gap evidence is observation only; no automatic stream restart is added. T8113-Z firmware 3.3.8 picture-then-black remains unresolved. A second live-view open may still be needed. Brightness/spotlight formatting and unexplained floodlight ON events remain under investigation. The refresh retry/backoff addresses the prior .7 refresh issue.

This is an offline local candidate, with no release, registry, installation, account, device, media or new soak acceptance. Update and installation instructions in the historical text apply only after a separately approved publication.

## Historical published experimental.7 documentation

Current experimental.7 runtime source delivery: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.7

# Experimental.7 local preparation

Version `0.2.1-s1.experimental.7` is delivered with the verified experimental.7 runtime. Pair add-on `0.4.1-s1.experimental.7` and integration `0.3.1-s1.experimental.7`. Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics.

The package remains private; no npm publication is planned. Live view remains opt-in through `webrtc_relay: true`; public add-on default is false. Earlier release records below are historical.

> Modified for genomez S1 experimental source preview, 2026-10-14.

# S1 experimental sdk source

Experimental S1/T9000 transport, state and media source.

**Version `0.2.1-s1.experimental.6` corresponding source is published.** Read [EXPERIMENTAL.md](EXPERIMENTAL.md) for qualification evidence, known limitations and privacy requirements before using this source.

This is an independently maintained experimental branch derived from the [upstream project](https://github.com/mega-yfue/eufy-sdk) and [danymexi's S1 work](https://github.com/danymexi/eufy-sdk). It is not an official upstream release. Upstream copyright and license notices are preserved.

## Experimental.6 source delivery, 2026-10-18

Version `0.2.1-s1.experimental.6` corresponding source is published. Runtime and corresponding-source release: `https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.6`. The companion integration is `0.3.1-s1.experimental.6`, paired with add-on `0.4.1-s1.experimental.6`. Update both components; relay defaults to false and command keepalive remains 29000 ms independently. Only JSON boolean true enables relay. No npm publication is planned.

The accepted Linux amd64 image passed isolated smoke checks; this exact release has no claimed physical-device, live HA/HACS installation or overnight soak acceptance. Earlier dated preparation, dev3 pairing, source-preview restrictions and implementation qualification records below are historical. Current source is the accepted review.9 RC9 package; original licenses, attribution and modification notices are preserved.

## Development

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for source practices. Packages are delivered as runtime prerelease assets; no npm package publication is planned. Retained upstream commands and version labels must not be taken as fork installation instructions.

Please report synthetic reproductions and source findings in this fork. Never include real device or account information. The source manifest binds the exact files in this preview.

## Experimental.6 release candidate refresh, 2026-10-16

The earlier packaging-only .6 preparation above is historical. This candidate includes two SDK fixes: a slower state refresh cannot overwrite a newer parameter update, and a freshness read can retry when an unchanged background poll supersedes it. The SDK bundle, source inventory and local package are rebuilt from implementation input `980f9a1`, including `a408a51`. Version remains `0.2.1-s1.experimental.6`. Original licenses and attribution are preserved; final runtime qualification and publication remain pending.

## Experimental.6 upstream-port package refresh, 2026-10-16

This local package is rebuilt from implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5`, including the upstream power-policy adaptations and retained `a408a51`/`980f9a1` freshness fixes. Earlier package statements above describe historical inputs. SDK version remains `0.2.1-s1.experimental.6`, private with npm publication disabled. The rebuilt bundle, complete source manifest and offline tarball identify the exact local input. Original licenses, attribution and notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

## Historical input documentation and modification notices

> Modified for genomez S1 experimental source preview, 2026-10-14.

# S1 experimental sdk source

Experimental S1/T9000 transport, state and media source.

**Version `0.2.1-s1.experimental.6` is prepared locally and has not been published.** Read [EXPERIMENTAL.md](EXPERIMENTAL.md) for qualification evidence, known limitations and privacy requirements before using this source.

This is an independently maintained experimental branch derived from the [upstream project](https://github.com/mega-yfue/eufy-sdk) and [danymexi's S1 work](https://github.com/danymexi/eufy-sdk). It is not an official upstream release. Upstream copyright and license notices are preserved.

## Development

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for source practices. This candidate has no published package and remains private. Retained upstream commands and version labels must not be taken as fork installation instructions.

Please report synthetic reproductions and source findings in this fork. Never include real device or account information. The source manifest binds the exact files in this preview.

## Experimental.6 release candidate refresh, 2026-10-16

The earlier packaging-only .6 preparation above is historical. This candidate includes two SDK fixes: a slower state refresh cannot overwrite a newer parameter update, and a freshness read can retry when an unchanged background poll supersedes it. The SDK bundle, source inventory and local package are rebuilt from implementation input `980f9a1`, including `a408a51`. Version remains `0.2.1-s1.experimental.6`. Original licenses and attribution are preserved; final runtime qualification and publication remain pending.

## Experimental.6 upstream-port package refresh, 2026-10-16

This local package is rebuilt from implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5`, including the upstream power-policy adaptations and retained `a408a51`/`980f9a1` freshness fixes. Earlier package statements above describe historical inputs. SDK version remains `0.2.1-s1.experimental.6`, private with npm publication disabled. The rebuilt bundle, complete source manifest and offline tarball identify the exact local input. Original licenses, attribution and notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.
