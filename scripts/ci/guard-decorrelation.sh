#!/usr/bin/env bash
# Capability <-> transport decorrelation (hard rule, no exceptions).
#
# Nothing under model/ may import from transport/ (or a transport wire lib: axios/mqtt/protobufjs/
# werift); transport/ never imports model/. The two layers use DISJOINT wire-id subsets — the only
# genuinely cross-layer vocabulary is the command/media boundary in core/contracts. See
# CONTRIBUTING.md `## Hard rules`. Prints the offending import lines and exits non-zero if any are found.
#
# Single source of truth for this check: package.json `guard:decorrelation` and the CI workflow both
# run it (via `npm run verify`).
set -uo pipefail

fail=0

if grep -rnE "from ['\"].*(transport/|axios|mqtt|protobufjs|werift)" src/model --include='*.ts'; then
  echo "::error::model/ imports from transport/ (decorrelation violation — a single-sided const belongs in the owning layer; only the cross-layer contract goes in core/)"
  fail=1
fi

if grep -rnE "from ['\"].*/model" src/transport --include='*.ts'; then
  echo "::error::transport/ imports from model/ (decorrelation violation — a single-sided const belongs in the owning layer; only the cross-layer contract goes in core/)"
  fail=1
fi

exit "$fail"
