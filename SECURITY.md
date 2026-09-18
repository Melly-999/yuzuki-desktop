# Security policy

## Reporting a vulnerability

Please report security issues **privately** using GitHub's **Report a vulnerability** flow on this repository's **Security** tab.

Do not open a public issue for security concerns.

### What to include

- What you did
- What happened
- Which boundary you believe was crossed
- A reproduction against a clean profile (ideal)
- Do not include real conversation content, credentials, or personal data — a synthetic reproduction is safer and more useful

### Response expectations

This is a personal project without a funded security programme. Expect best-effort, unpaid, and sometimes slow responses.

---

## Supported versions

This repository publishes **source only**. No Windows binaries or installers are published from this snapshot. Security fixes apply to the `main` branch.

---

## Scope of the privacy guarantee

The `PRIVATE` routing mode is **fail-closed**:

- Before starting, Yuzuki validates that the target profile's provider `base_url` resolves to loopback (`127.0.0.1`, `localhost`, or `::1`)
- LAN addresses are **not** treated as local-safe
- If validation fails, the runtime does not start and no cloud fallback occurs

This guarantee covers **only** the `PRIVATE` mode. Other routing modes (`SAVER`, `FAST`, `SMART`, `DEEP`, `CREATIVE`, `ADVANCED`) may route through cloud providers configured in the Hermes runtime.

### What the guarantee does not cover

- Model behavior once the request reaches your local provider
- Encryption at rest (conversations are stored in a local SQLite file with ordinary filesystem permissions)
- Your operating system, backup software, or other applications with access to the same files

---

## Architecture reference

For the full privacy and security architecture, see:

- [docs/public/PRIVACY_AND_SECURITY.md](docs/public/PRIVACY_AND_SECURITY.md) — detailed threat model, data locations, network surface, and fixture/screenshot provenance
- [README.md](README.md#routing-modes) — routing mode definitions and the fail-closed guarantee

---

## Public provenance

This repository is a clean-root public snapshot. No private development history, internal task records, or AI operating instructions are included. See [PUBLIC_PROVENANCE.md](PUBLIC_PROVENANCE.md) for details.