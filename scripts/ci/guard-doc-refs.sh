#!/usr/bin/env bash
# Shipped-source reference hygiene (hard rule, no exceptions).
#
# Shipped src/ ships in dist/ (public) and cites its PEERS only — other source modules, exported
# symbols, {@link}s. A pointer to a companion prose file dangles for someone: a folder README is not
# part of the package, and docs/ is generated FROM this source's JSDoc, so a src -> guide reference
# inverts the direction the site is built on. Wire/protocol reasoning goes inline, or in the commit
# message.
# See CONTRIBUTING.md `## Hard rules`.
#
# Specs (__tests__/) are excluded — the build ships dist/ only, never the specs. Prints every offending
# reference and exits non-zero if any are found.
#
# Single source of truth: package.json `guard:docrefs` (folded into `npm run verify`) runs this; CI
# runs verify.
set -uo pipefail

fail=0

# Token-level (grep -o), not line-level, so an offending reference sharing a line with clean prose is
# still caught.
scan() {
  grep -rnoE "$1" src --include='*.ts' --exclude-dir='__tests__'
}

if scan "docs/[A-Za-z0-9._/-]+"; then
  echo "::error::shipped src/ references docs/ — the guide is generated FROM this source; cite the reasoning inline instead"
  fail=1
fi

# The leading class requires a non-dot character before `.md`, so a property access (`this.md`) is not
# a hit; \b stops `.mdx`/`.mdown` from matching.
if scan "[A-Za-z0-9_/-][A-Za-z0-9._/-]*\.md\b"; then
  echo "::error::shipped src/ references a .md file — src/ cites its peers (modules, symbols, {@link}) only; state the rule inline"
  fail=1
fi

exit "$fail"
