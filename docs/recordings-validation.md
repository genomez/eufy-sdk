# Recording reads: offline validation receipt

## Persistent path fingerprint follow-up (2026-11-05)

Shared-path suppression now retains a private, account-and-station-bound
`coverPathKey` HMAC even when the selector is null. This lets a persistent store
reject reuse in later windows without retaining additional raw paths. The public
projection is unchanged. A new synthetic normalization test covers shared paths,
later-window stability, account isolation, invalid paths and projection privacy.

On Node `v24.15.0` / npm `11.12.1`, `npm run typecheck` and `npm run build` passed.
`npm test -- src/transport/rtc/__tests__/recordings.spec.ts src/transport/rtc/__tests__/recordings-arbitration.spec.ts src/client/__tests__/rtc-last-seen.spec.ts`
passed 113 tests, with zero failures or skips. `npm test` passed 6621 tests,
with zero failures and 8 existing skips across 303 files. All five existing
`scripts/ci/guard-*.sh` ownership/decorrelation/consumer/doc-reference/line guards
passed using Git Bash. Changed-file Prettier and `git diff --check` passed.
Fixtures remain synthetic; no live acceptance is claimed.

Date: 2026-11-05. Branch: `recordings-browse-20261105`, based on `2164d4e5b7adc55aa7029286f4c0e2fe5a2e01c8`. Run from the SDK root with Node `v24.15.0`, npm `11.12.1`, locally installed Vitest `5.0.1`, and synthetic v1 fixtures generated in `recordings-fixture.ts`. No dependencies were installed and no remote endpoint, device, session file, secret or real capture was used. Build output is the existing `dist/` directory.

The commit containing this receipt has the tested source state. Only this receipt was added after the final full-suite run.

| Command                                          | Passed | Failed | Skipped |
| ------------------------------------------------ | -----: | -----: | ------: |
| `npm run typecheck`                              | exit 0 |      0 |       0 |
| New specs below                                  |    112 |      0 |       0 |
| Existing regression specs below                  |    894 |      0 |       0 |
| `npm run build`                                  | exit 0 |      0 |       0 |
| `npx vitest run` (once, final integrated source) |   6620 |      0 |       8 |

New specs:

```powershell
npm test -- src/transport/rtc/__tests__/recordings.spec.ts src/transport/rtc/__tests__/recordings-arbitration.spec.ts src/client/__tests__/rtc-last-seen.spec.ts
```

Existing safety and state regressions, including the original unchanged playback-time tests:

```powershell
npm test -- src/transport/rtc/__tests__/event-table-candidate.spec.ts src/transport/rtc/__tests__/event-thumb-candidate.spec.ts src/transport/rtc/__tests__/event-playback-candidate.spec.ts src/transport/rtc/__tests__/event-playback-router.spec.ts src/transport/rtc/__tests__/playback-expiry.spec.ts src/transport/rtc/__tests__/playback-quarantine.spec.ts src/transport/rtc/__tests__/playback-qualification.spec.ts src/transport/rtc/__tests__/playback-replay.spec.ts src/transport/rtc/__tests__/playback-station-flags.spec.ts src/transport/rtc/__tests__/information-refresh.spec.ts src/transport/rtc/__tests__/session-refresh.spec.ts src/transport/rtc/__tests__/station-work-scheduler.spec.ts src/transport/rtc/__tests__/peer.spec.ts src/client/__tests__/rtc-state.spec.ts src/client/__tests__/rtc-wrapped-state.spec.ts src/client/__tests__/device-registry.spec.ts src/client/__tests__/light-effects.spec.ts src/client/__tests__/light-command-observation.spec.ts src/client/__tests__/rtc-late-effect.spec.ts src/client/__tests__/rtc-late-contrary.spec.ts src/client/__tests__/rtc-late-contrary-e2e.spec.ts src/client/__tests__/rtc-effect-confirmation.spec.ts src/client/__tests__/rtc-late-retry.spec.ts src/client/__tests__/poll.spec.ts src/client/__tests__/rtc-command-observation.spec.ts
```

The five `npm run guard:*` commands initially could not start: the default `bash` resolved to WSL without an installed distribution. All five scripts then passed with the existing Git Bash executable, without changing the environment or installing anything:

```powershell
foreach ($script in @('guard-decorrelation.sh','guard-capability-ownership.sh','guard-consumer-agnostic.sh','guard-doc-refs.sh','guard-lines.sh')) {
    & $gitBash ('scripts/ci/' + $script)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

The changed source and documentation were formatted with the installed Prettier executable. `git diff --check` passed. A changed-file scan found no attribution strings, machine paths or LAN addresses. No tests added by this package are skipped.

## Files

- `src/transport/rtc/recordings.ts`: normalization, identities, seals, types and safe projection.
- `src/transport/rtc/event-time.ts`: strict shared Chicago time helper.
- `src/transport/rtc/command-router.ts`: idle-only production reads, preemption and original information receipt time.
- `src/transport/rtc/event-playback-candidate.ts`: shared helper import/re-export only.
- `src/transport/rtc/peer.ts`: fixed send-failure logging without exception text.
- `src/client/eufy-mega.ts`: facade, scope/lifecycle guards and successful last-seen stamps.
- `src/client/device-registry.ts`: receipt overlay, account/removal pruning and roster-install join.
- `src/client/types.ts`, `src/client/index.ts`: option and exported API types.
- `src/transport/rtc/__tests__/recordings.spec.ts`, `recordings-arbitration.spec.ts`, `recordings-fixture.ts`: synthetic protocol, privacy, identity, parser, arbitration and cancellation coverage.
- `src/client/__tests__/rtc-last-seen.spec.ts`, `device-registry.spec.ts`: scoped freshness and roster race coverage.
- `src/client/__tests__/rtc-state.spec.ts`, `poll.spec.ts`: mocked successful reads supply the newly required current-owner metadata or guard result.
- `docs/recordings-sdk.md`, `docs/recordings-validation.md`: internal contract and validation receipt.

## Deliberate refinements and remaining qualification

The selector MAC additionally binds the opaque account namespace. `identityStartBasis` stores an HMAC rather than a source token, retaining stable identity without persisting unknown vendor strings. Neither changes a public contract. A cache-only namespace getter and safe row projection are exported for the internal caller.

Persistence, browse budgets, store-wide collision and cross-window path-ambiguity checks remain caller responsibilities. Within one observed table, conflicting identities are rejected and shared cover paths have no selector. A seal proves observed provenance, not firmware path uniqueness or continued retention. Historical-cover attribution, actual five-camera data and foreground hardware latency remain unqualified. No deployment, live test, PR, push or tag is part of this implementation.

Follow-up local validation (2026-11-05): `npm run typecheck` passed;
`npm test` passed 6,624 tests with 8 existing skips. The follow-up adds stable-ID
growth, sanitized rejection/time-shape diagnostics, and bounded cursor admission
regressions. `npm run build` creates the distribution used by the paired bridge.
All fixture rows and station sessions are synthetic; no live paging claim is made.
