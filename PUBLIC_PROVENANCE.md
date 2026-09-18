# Public snapshot provenance

This repository is a clean-root public-source snapshot of Yuzuki. It does
not contain the private development history it was exported from — that
history remains private by design.

```
PUBLIC_SNAPSHOT_PRIVATE_SOURCE_HEAD: b5fcd22ea67f684c674fb37e08b0248462602b93
ACCEPTED_V11_BINARY_BUILD_SOURCE: c8ae742604d30260bcce11e255d7fc8923ff7219
PUBLIC_PROFILE_CONTRACT: fe02194734ac9d48d794a21060f622dcb557b73a
PUBLIC_PRIVACY_HARDENING: 657b6a6d3a85f78f31574fe7dd13b7c0acbc9f89
V1_1_STATUS: CLOSED
```

## What these mean

- **`PUBLIC_SNAPSHOT_PRIVATE_SOURCE_HEAD`** — the exact commit in the
  private development repository this snapshot's file contents were
  exported from. The snapshot's own Git history starts fresh from this
  commit's tree state, not from that repository's commit graph.
- **`ACCEPTED_V11_BINARY_BUILD_SOURCE`** — the commit the currently
  accepted, closed V1.1 Windows binaries were built from.
- **`PUBLIC_PROFILE_CONTRACT`** — the commit that introduced the
  public-safe Hermes profile validation contract (fail-closed,
  loopback-only, no private profile identifier in code or tests).
- **`PUBLIC_PRIVACY_HARDENING`** — the commit that brought the public
  documentation, synthetic fixture layer, and public screenshot pack to
  their current state.
- **`V1_1_STATUS: CLOSED`** — V1.1 is a finished, accepted milestone. It is
  not reinterpreted or reopened by this snapshot.

## Binary provenance

**Existing validated Windows binaries were built from `c8ae742`, not from
this clean public snapshot.** No binary has been built from this
snapshot's source. If a public binary release is produced later, it will
be built from this snapshot (or a descendant of it) and that build's exact
commit will be recorded at that time — it is not implied by anything
above.

## What is not in this repository

This snapshot exports the product source, its test suites, its public
documentation, and its synthetic screenshot fixtures. It deliberately does
not include the private repository's internal task-acceptance history,
architecture-review archive, AI-agent operating instructions, or QA
evidence — none of that is required to build, run, or contribute to
Yuzuki, and keeping it out of the public tree is a privacy choice, not an
oversight.

## Recut history

This repository's Git history begins at a single root commit. It is not
the first attempt at a clean public snapshot, and that history is worth
recording honestly.

An earlier public-snapshot repository was cut from the private source
above, then carried two further remediation commits: one hardening the
default development-server binding to loopback-only and replacing a
private profile identifier that had leaked into two test assertions'
literal text, and one correcting inaccurate public documentation
(installation steps, broken references, and a stale claim that session
data was never persisted, when it is — durably, in a local SQLite file).
Its resulting tree passed every privacy, secret, and validation check.

That tree state is exactly what this repository's own root commit
contains. The recut exists because, on closer audit, that earlier
repository's *own root commit* — the very first one, made before any of
the above fixes — was found to still carry the original private profile
identifier inside its own committed Git objects, even though the fix had
long since removed it from the working tree. A later commit cannot erase
that from history without rewriting it, which was out of scope for that
repository. So rather than rewrite it, this repository exports that
fully-remediated tree into a brand-new, single-commit history with no
ancestry at all — nothing to search, because there is only the one commit,
and its own contents have been independently re-audited and contain no
private profile identifier anywhere, working tree or object database.

The earlier repository is not deleted. It remains local engineering
record of how the fixes were made and verified. This repository is the
one intended for eventual public use.
