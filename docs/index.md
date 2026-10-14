---
layout: home
hero:
  name: eufy-sdk
  text: One client for every Anker eufy device
  tagline: One typed client for the whole Anker eufy ecosystem — devices, realtime events, and live media.
  # The suffix names the MODE, not the ink: logo-dark.svg is the white glyph, for a dark
  # background. Same mapping as themeConfig.logo in .vitepress/config.ts — they must agree.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: eufy-sdk
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: sponsor
      text: 📸 Device compatibility
      link: /devices-gallery
    - theme: alt
      text: View on GitHub
      link: https://github.com/mega-yfue/eufy-sdk
features:
  - title: 🔀 One pull, many consumers
    details: Every live view, fresh snapshot, and recording on a camera shares one media session, fanned out — with instant keyframe-priming for late joiners.
  - title: 📦 Dependency-free egress
    details: Raw frames, a node Readable, or fragmented-MP4 (CMAF) for HLS/MSE — muxed with zero native deps.
  - title: 🔋 Power-aware
    details: Battery and solar cameras get a stream budget with extend/auto-stop; wired cameras stream unbounded.
---

These guides cover **how to use** the SDK.

## An SDK, not an app

eufy-sdk is a building block for developers. There is no UI, no dashboard, and nothing here to
install as an end user — it's the layer an integration is built _on_.

If you arrived here from something you installed in a smart-home platform, its maintainer is the
right first stop. They own what you actually see and click, they chose how to use this SDK, and
they're the ones who can tell whether a problem is theirs or ours. Coming here first usually costs
you a round trip.

Building that integration yourself? Then you're in the right place — start with
[Install & log in](/getting-started).

## Independent project

eufy-sdk is an independent, unofficial SDK. It is **not affiliated with, endorsed by, or sponsored
by Anker Innovations, Anker eufy, or eufy**, and it is not a product of either company — no support,
warranty, or service commitment here comes from them.

"Anker eufy", "eufy", "Anker", and the device names and model codes used across these guides are
trademarks of their respective owners. They appear here only to identify the hardware this SDK talks
to.

The vendor now brands the line **Anker eufy**; these guides introduce it that way and then use "eufy"
as the short form, which is also what the wire and the product names still say — `eufy_security`,
`eufy_life`, eufyCam, eufy Clean. Protocol vocabulary follows the device, not the marketing.

Use it with devices on your own account. Rapid or failed logins can trigger a captcha or a temporary
cooldown — see [Troubleshooting](/troubleshooting).
