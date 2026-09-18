# Developing Yuzuki

Everything here is derived from the repository as it actually is —
`package.json`, `src-tauri/tauri.conf.json`, and the module layout under
`server/` and `src/`. If a command below stops matching the manifest,
the manifest is right and this file is wrong.

---

## Layout

```
src/                     React + TypeScript frontend
  desktop/               the desktop shell UI (ChatPane, routing, search)
  lib/hermesApi.ts       the only client → API boundary (127.0.0.1:8787)
server/                  local HTTP API (Node, ESM, no framework)
  index.mjs              entry point; --check runs a startup self-test
  router.mjs             routes; DEFAULT_PORT = 8787, HOST = 127.0.0.1
  routes/                health, capabilities, product-truth, chat,
                         sessions, hermesChat
  lib/                   hermesBridge, hermesRuntime, hermesProfilePolicy,
                         sessionStore, modelRouting, productTruth, …
  tests/                 node:test suites (14 files)
src-tauri/               Tauri v2 Rust shell
  src/main.rs            window lifecycle, API child process, Job Object
scripts/                 verification and screenshot-capture tooling
docs/                    design and review record; docs/public/ is the
                         public-facing subset
```

Two boundaries are worth internalising before changing anything:

- **The frontend never talks to a model.** `src/lib/hermesApi.ts` is the
  single client-side egress point, and it targets loopback only.
- **The API owns no model either.** It brokers to the Hermes runtime,
  which owns sessions, memory, and routing authority. Yuzuki's job is to
  ask correctly and to refuse safely.

---

## Prerequisites

- Node.js 22+ (the session store uses `node:sqlite`).
- Rust toolchain and the Tauri v2 prerequisites, for the desktop shell.
- For anything that exercises a real chat turn: a working Hermes install
  and profile, per [INSTALL.md](INSTALL.md). Everything else — typecheck,
  build, tests, fixture-mode screenshots — runs without one.

```powershell
npm install
```

---

## Scripts

Every script in `package.json`, and what it is actually for:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on 5173. Proxies `/api` → `127.0.0.1:8787`. |
| `npm run build` | `tsc -b` then `vite build`. Emits both `index.html` and `desktop.html` entries. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run preview` | Serve the production build. |
| `npm run api:dev` | Run the local API in the foreground. |
| `npm run api:check` | Start-up self-test for the API. Exits non-zero on failure — use it in CI. |
| `npm run verify:adapter` | Verify the capability adapter contract. |
| `npm run tauri:dev` | Desktop shell against the Vite dev server. |
| `npm run tauri:build` | Package the desktop application. |

---

## The dev loop

For frontend and API work, two terminals:

```powershell
npm run api:dev
```

```powershell
npm run dev
```

Then open `http://127.0.0.1:5173/desktop` — the `/desktop` path is what
selects the desktop shell (`src/App.tsx` resolves it client-side), and it
is the same surface the packaged app renders.

For shell work, `npm run tauri:dev` starts the Vite server for you via
`beforeDevCommand`.

### Working without a Hermes runtime

The UI's read-only surfaces can be driven from a synthetic fixture instead
of a real runtime:

```powershell
$env:YUZUKI_PUBLIC_FIXTURE = "1"; npm run api:dev
```

This serves deterministic, repository-owned data for status, sessions,
search, and routing options from `server/lib/publicFixture.mjs`. It is off
unless the variable is exactly `"1"` — never inferred.

The isolation is structural rather than conventional: in fixture mode the
route handlers short-circuit before any runtime seam, so nothing resolves a
runtime, spawns a process, or opens a session database.
`server/tests/publicFixture.test.mjs` proves this by injecting seams that
throw if touched at all.

Note what fixture mode does *not* cover: starting a conversation. That path
requires a real runtime and is left to fail honestly rather than
fabricating an assistant turn.

---

## Tests

```powershell
node --test server/tests/*.test.mjs
```

Rust tests, including the real-OS Windows process-lifecycle suite:

```powershell
cd src-tauri
cargo test
```

> On some Windows setups a parallel release build can abort with
> `STATUS_STACK_BUFFER_OVERRUN`. If you hit it, build with `-j 1`. It is a
> toolchain/linker issue, not a code defect — it reproduces on an
> unmodified tree.

---

## Before you open a pull request

```powershell
npm run typecheck
npm run build
npm run api:check
npm run verify:adapter
node --test server/tests/*.test.mjs
```

### Things that will get a change rejected

These are contract, not style:

- Making `PRIVATE` reachable by any path that can end at a non-loopback
  provider.
- Adding profile auto-discovery, auto-creation, "first available profile"
  selection, or filesystem-order selection.
- Adding a fallback that substitutes a different profile, provider, or
  model when the configured one fails.
- Moving routing or session/memory ownership out of Hermes and into Yuzuki.
- Putting a private profile name, real filesystem path, username, or any
  real conversation content into source, tests, fixtures, or screenshots.
- Letting `server/lib/productTruth.mjs` claim more than the code delivers.

When local safety cannot be positively established, the correct behaviour
is to fail closed and say so.
