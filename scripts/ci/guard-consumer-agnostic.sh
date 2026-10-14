#!/usr/bin/env bash
# Consumer-agnostic surface (hard rule, no exceptions).
#
# This is an SDK, not one host's plugin. Shipped src/ and the published docs/ must never name a
# specific consumer or its stack — the SDK carries Eufy truth and returns typed data or a typed reason;
# how a host renders that (a service type, a placeholder image, a poll cadence) is the caller's concern.
# Say "caller"/"host" generically. See CONTRIBUTING.md `## Hard rules`.
#
# Eufy's OWN wire vocabulary is exempt for free, with no allowlist: every term is word-bounded and the
# wire names are identifier-shaped, so `\bHomeKit\b` cannot match inside CMD_GET_START_HOMEKIT,
# devHomekitStatus or APP_CMD_GET_DEV_HOMEKIT_STATUS — the neighbouring character is always a word
# character. A consumer named in prose has whitespace or punctuation around it and is caught. An
# allowlist here would only carve a hole for a real leak to hide in.
#
# Scope is everything a consumer reads: src/, the published guide, and examples/ (typechecked in CI and
# embedded in the guide pages). Specs never ship, docs/api/ is generated typedoc output, and
# node_modules/dist are vendored or built.
#
# Single source of truth: package.json `guard:consumer-agnostic` (folded into `npm run verify`) runs
# this; CI runs verify.
set -uo pipefail

fail=0

# A missing scan path means the guard silently passes while checking nothing — fail loudly instead.
for dir in src docs examples; do
  if [ ! -d "$dir" ]; then
    echo "::error::$dir not found — run this from the package root"
    exit 1
  fi
done

# Consumer/stack names that must not appear on the consumer-facing surface. Word-bounded so an
# unrelated word that merely contains one (e.g. "Alexander") isn't flagged.
#
# The second group is host VOCABULARY rather than a host NAME — the leak a published capability
# manifest invites, where the SDK's own value words get "translated" in a comment or a field name and
# one host's schema quietly becomes the contract. The SDK says what a value MEANS; which entity class,
# topic or characteristic that maps to is the caller's table. None of these collide with eufy's wire
# vocabulary, so there are no false positives to allowlist around.
terms='\bHomeKit\b|\bhomebridge\b|\bHome[ -]Assistant\b|\bhomeassistant\b|\bhass\.io\b|\bHomey\b|\bSmartThings\b|\bAlexa\b|\bApple TVs?\b|\bApple Home\b|\bGoogle Home\b|\bSiri\b|\biobroker\b|\bplugins?\b'
terms="$terms"'|\bdevice_class\b|\bstate_class\b|\bunit_of_measurement\b|\bentity_category\b|\bstate_topic\b|\bdiscovery_topic\b|\bSensorDeviceClass\b|\bBinarySensorDeviceClass\b'

if grep -rniE "$terms" src docs examples --include='*.ts' --include='*.md' \
  --exclude-dir='__tests__' --exclude-dir='api' --exclude-dir='node_modules' --exclude-dir='dist'; then
  echo "::error::the consumer-facing surface names a specific consumer — the SDK is host-agnostic; say \"caller\"/\"host\" and leave presentation to the caller. See CONTRIBUTING.md ## Hard rules"
  fail=1
fi

exit "$fail"
