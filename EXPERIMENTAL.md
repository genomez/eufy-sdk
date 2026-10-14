# Experimental SDK source preview

This branch exposes an experimental S1/T9000 composite source baseline for review and synthetic reproduction. It is not an official upstream version or a published package. Existing version fields identify preparation inputs, not a released fork artifact.

The private qualification suite passed 4,946 tests, type checking, ESM export checks and configured architecture guards. Those are retained pre-publication results, not a public CI claim for this branch. Publication changes concern metadata and documentation; no transport or model behavior was changed for this preview.

The tested platform was Linux amd64. Native dependency binary provenance and redistribution requirements remain open for a future package/image release. No native binaries, installed dependencies, runtime sessions, captures or device data are included. S1 behavior is experimental; non-S1, other architectures and simultaneous media consumers are not covered by the preview support promise.

This package is marked private and automatic release commands are disabled. Source review and synthetic tests can proceed without real accounts or devices. Use the pinned dependency lock with lifecycle scripts disabled; inspect native dependency requirements separately before executing them. The peer bridge must deliberately use the matching SDK source/artifact; its historical upstream registry dependency is not this customized build.

Preserve capability/transport boundaries, explicit cancellation, bounded cleanup and caller ownership. Do not introduce hidden starts or retries to conceal failures.

Report model numbers, component commits, relevant versions and a minimal synthetic reproduction. Never include serials, P2P identifiers, account data, credentials, personal names, network addresses, captures, raw logs or real images. Preserve supplied licenses and upstream attribution. Source review does not authorize binary publication.


## Safety candidate, 2026-10-14

Local ICE callbacks require an open signaling socket. Base source commit: `5e81218e0a14109b1f002fe7a3ebd3e4accb7f31`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.
