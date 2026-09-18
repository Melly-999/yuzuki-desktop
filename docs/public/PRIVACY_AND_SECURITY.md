# Privacy and security

Yuzuki's privacy claim is narrow and mechanical, which is what makes it
worth anything. This document states exactly what it covers and, just as
importantly, what it does not.

---

## The claim

**In `PRIVATE` mode, a conversation does not leave your machine.**

That holds because of a check that runs *before* anything starts, not
because of a policy applied afterwards. Before Yuzuki will launch a Hermes
backend, it validates the target profile by reading files only — no
process is spawned and no socket is opened:

1. The profile's `config.yaml` must exist and be readable.
2. It must have a `model:` block.
3. That block must name a model.
4. It must name a provider, and that provider must have a resolvable
   `base_url`.
5. That `base_url`'s host must be **`127.0.0.1`, `localhost`, or `::1`**.

If any step fails, the runtime does not start. Yuzuki does not select a
different profile, enable a provider, or route to a cloud model. It reports
that the local runtime is unavailable and stops.

Two consequences are deliberate and often surprising:

- **A provider's name is never taken as evidence.** A provider called
  `ollama` whose `base_url` points at a remote host is rejected. Only the
  resolved host counts.
- **Your LAN is not "local".** A model server on another machine on your
  own network is rejected. The guarantee is about the machine, not the
  network, because "my network" is not a security boundary you can reason
  about simply.

Ambiguity always resolves toward refusing to run.

---

## What the claim does not cover

Be clear about the edges.

- **Other routing modes.** `SAVER`, `FAST`, `SMART`, `DEEP`, `CREATIVE`,
  and `ADVANCED` route through models the Hermes runtime has approved,
  which may include cloud providers you have configured. Only `PRIVATE`
  carries the no-egress guarantee.
- **What the model does with the prompt.** Yuzuki guarantees where the
  request goes. Once it reaches your local model, what happens is a
  property of the model and provider you installed.
- **Encryption at rest.** Conversations are stored in a local SQLite file
  with ordinary filesystem permissions. Anyone who can read your user
  profile directory can read them. There is no encryption at rest and no
  end-to-end-encryption guarantee.
- **Your operating system and other software.** Yuzuki cannot make claims
  about backup software, sync clients, or anything else with access to the
  same files.

---

## What is stored, and where

| Data | Location | Owner |
| --- | --- | --- |
| Conversations and message history | Hermes SessionDB, under the Hermes home directory (`%LOCALAPPDATA%\hermes` by default) | **Hermes** |
| Yuzuki's own session records | A local SQLite file in Yuzuki's app-data directory | Yuzuki |
| Profile configuration and model settings | `%LOCALAPPDATA%\hermes\profiles\<profile>\config.yaml` | **Hermes** |
| Model weights | Wherever your provider keeps them (e.g. Ollama's store) | Your provider |

Hermes owns the canonical conversation record. Yuzuki reads it and does not
mirror it into a second copy.

Nothing is synced to a server. There is no telemetry, no analytics, and no
crash reporting — Yuzuki has no network destination to send any of that to.

Uninstalling Yuzuki does not delete your Hermes data, and that is
intentional: the application should not be able to destroy a record it
does not own.

---

## Network surface

The local API binds to `127.0.0.1:8787` — loopback only, never `0.0.0.0`.
The Hermes backend Yuzuki starts is launched `--isolated --host 127.0.0.1`
on an OS-assigned port, so it is reachable only from the same machine and
is scoped to one profile rather than joining a shared dashboard.

`--isolated` is load-bearing, not cosmetic: without it, the runtime routes
to the shared machine-wide dashboard with the profile merely preselected.

---

## Approvals grant nothing

The Review and Approvals interface implements a real, ephemeral,
session-scoped decision state machine. It has no executor behind it.

Approving a local write or an external action always renders
`EXECUTION_UNAVAILABLE`. No execution engine exists anywhere in this
repository. Approval eligibility is never persisted and is invalidated by
a restart, a session archive, or a session delete.

In the same vein, the local chat path grants **no** tool use, **no**
approval bridge, **no** memory writes, and **no** skill changes.

---

## Screenshots and fixtures

Every public screenshot and demo fixture in this repository is synthetic
and repository-owned. None is derived from a real conversation, profile,
session database, filesystem path, or username.

Fixture mode is off unless `YUZUKI_PUBLIC_FIXTURE` is exactly `"1"`, and
when it is on, the route handlers return in-memory constants before
reaching any runtime seam — so a capture cannot observe real state even by
accident. See
[the capture manifest](../showcase/screenshots/yuzuki-v11-public/README.md).

---

## Reporting a vulnerability

Please report security issues privately rather than opening a public
issue: use GitHub's **Report a vulnerability** flow on this repository's
Security tab.

Useful things to include: what you did, what happened, and which boundary
you believe was crossed. A reproduction against a clean profile is ideal.
Please do not include real conversation content, credentials, or personal
data in a report — a synthetic reproduction is more useful and safer for
both of us.

This is a personal project without a funded security programme, so expect
best-effort, unpaid, and sometimes slow responses.
