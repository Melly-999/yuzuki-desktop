# Yuzuki V1.1 — public capture manifest

```
FIXTURE_CLASS: SYNTHETIC_PUBLIC_FIXTURE
REAL_USER_STATE_USED: NO
```

Every image in this directory was captured against a synthetic,
repository-owned fixture. None was captured against a real Hermes profile,
a real session database, a real conversation, or a real user's machine
state.

---

## Captures

| # | Surface | File | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| 01 | Desktop workspace, empty state | `01-home-desktop-1440.png` | 31254 | `a0889d7632fd6867708ecb32f652c82ce6ad7e0a591115577513bf10789bc048` |
| 02 | Knowledge Constellation | `02-knowledge-constellation-1440.png` | 66413 | `2aadf219fa4689588a372c960ef8f56cc0c5716bef5efb402b9bb684f3905ea4` |

Both at 1440×900, route `/desktop`, default (non-reduced) motion.

---

## How they were produced

The local API was started in public fixture mode:

```powershell
$env:YUZUKI_PUBLIC_FIXTURE = "1"; npm run api:dev
```

and captured with the repository's own tool:

```powershell
node scripts/capture-showcase-screenshot.mjs `
  --route /desktop --width 1440 --height 900 `
  --output docs/showcase/screenshots/yuzuki-v11-public/<name>.png
```

In fixture mode, `server/routes/hermesChat.mjs` returns in-memory constants
from `server/lib/publicFixture.mjs` for status, sessions, search, and
routing options, short-circuiting **before** any runtime seam. No runtime
is resolved, no process is spawned, and no session database is opened —
`server/tests/publicFixture.test.mjs` enforces this by injecting seams that
throw if touched.

Fixture timestamps are pinned to a fixed synthetic epoch
(`2026-01-15T09:00:00Z`) rather than `Date.now()`, so repeated captures are
byte-stable.

The Knowledge Constellation renders from its own repository-owned prototype
fixture. The application labels that surface `PROTOTYPE / FIXTURE DATA` on
screen, and the capture preserves that label rather than hiding it.

---

## Why the set is this small

Only views reachable **without real personal state** are included.

Starting a conversation is not one of them. Fixture mode covers the
read-only projections and deliberately does not fake a chat turn, so the
composer and the routing-mode selector — which render once a conversation
is open — cannot be captured this way. Faking them would have meant
fabricating assistant output and presenting it as a product screenshot.

The alternative of capturing against a real profile was rejected outright:
it would have put real session titles, timestamps, and a private profile
name into a public asset.

So the routing modes are documented in text — in the
[root README](../../../../README.md) and
[PRIVACY_AND_SECURITY.md](../../../public/PRIVACY_AND_SECURITY.md) — rather
than shown in a screenshot that would have had to be staged.

---

## Re-capturing

Re-running the commands above regenerates byte-identical images, provided
the UI itself has not changed. If a capture's hash changes, either the UI
changed or the fixture changed; both are legitimate reasons, but update the
table above so the manifest keeps matching the files.
