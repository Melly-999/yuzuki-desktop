# HERMES API scaffold

```text
STATUS: IMPLEMENTED_NOT_LIVE_VERIFIED
IMPLEMENTATION: EXPLICITLY GATED, TEXT-ONLY CHAT WITH LOCAL SQLITE SESSIONS
LIVE MODEL CALLS MADE BY THIS IMPLEMENTATION TASK: NONE
MEMORY WRITES: NONE
EXTERNAL INTEGRATIONS: NONE
```

This local backend exposes the product-truth, health, chat, routing, and
session boundaries used by the Yuzuki frontend. `POST /api/chat` retains a
safe deterministic prototype response while provider chat is disabled. The
bounded model-backed path is explicitly gated, disabled by default, and has
not been live-verified in this public source snapshot.

**No live provider request was made by this task.** With model chat disabled,
`POST /api/chat` retains the fixed canned reply and reports `PROTOTYPE` /
`NOT_CONFIGURED`. With the explicit server gate enabled, the route uses the
server-owned catalog and OpenAI Responses adapter; configuration and provider
failures are explicit and never fall back to canned content.

`HERMES-MODEL-ROUTING-001` adds an isolated, dependency-free routing
**evaluation boundary** under `server/lib/`. It supports Path A
(OpenRouter) and Path B (a custom OpenAI-compatible endpoint), but is
fail-closed unless the caller supplies the internal
`SYNTHETIC_BENCHMARK` execution purpose. That legacy evaluation path remains
separate from the new `USER_CHAT` purpose and keeps its prior configuration
and behavior.

## What this is

- A plain Node.js HTTP server (`node:http`, no new dependencies) under
  `server/`.
- Binds to `127.0.0.1` only, on port `8787` by default (override with
  `PORT`).
- Returns structured JSON from every route.
- Never reads `.env`; stores session metadata and chat history in a local
  SQLite file with no cloud sync or encryption at rest.
- Keeps provider credentials server-side and calls no provider unless both
  the explicit activation gate and runtime credential are present.

## Model-backed user chat — implemented, not live-verified

The user-chat path is disabled unless `HERMES_MODEL_CHAT_ENABLED` is exactly
`true`. When enabled it reads `OPENAI_API_KEY` at request time through the
normal process environment boundary. This repository does not create, read,
or modify `.env` or any credential store.

| Route mode | Server-owned role | Current model | Reasoning |
|---|---|---|---|
| `AUTO` | `BALANCED_CLOUD` | `gpt-5.6-terra` | `medium` |
| `BALANCED` | `BALANCED_CLOUD` | `gpt-5.6-terra` | `medium` |
| `DEEP` | `DEEP_CLOUD` | `gpt-5.6-sol` | `high` |
| `LOCAL` | `LOCAL_GENERAL` | unavailable | unavailable |

`LOCAL` returns `LOCAL_MODEL_NOT_AVAILABLE` and never falls back to cloud.
P0 implements no retry or cross-model fallback. Luna and local generation are
deferred. Requests use `POST https://api.openai.com/v1/responses`, `store:false`,
plain text only, no tools, and a 512-token output cap. The raw parser walks only
documented `output[]` message items and nested `content[]` `output_text` parts;
it does not depend on an SDK `output_text` convenience property.

`HERMES_MODEL_TIMEOUT_MS` applies to this path as well as the preserved
benchmark boundary: default `30000`, maximum `120000`.

When `HERMES_USER_CHAT_BASE_URL`, `HERMES_USER_CHAT_MODEL`, and
`HERMES_USER_CHAT_API_KEY` are all present, USER_CHAT is instead served by
the same provider-neutral OpenAI-compatible chat-completions transport used
by the benchmark boundary's `custom` route (`server/lib/openAiCompatibleAdapter.mjs`'s
`generateOpenAiCompatibleReply`), reporting `HOSTED_NATIVE_CUSTOM_ENDPOINT`.
This overrides the OpenAI Responses catalog above; no vendor name is ever
referenced in routing logic. Missing any of the three falls back to the
`OPENAI_API_KEY` Responses path, and missing that too resolves to
`NOT_CONFIGURED`.

## Model-routing evaluation boundary

The boundary uses Node's built-in `fetch` and `AbortController`; it adds
no package dependency and does not modify `package.json`.

Server-only environment variables, read exclusively inside
`server/lib/modelRouting.mjs`:

| Variable | Meaning |
|---|---|
| `HERMES_MODEL_ROUTE` | Exact value `openrouter` or `custom`. |
| `HERMES_MODEL_NAME` | Exact model identifier; no default is selected. |
| `HERMES_MODEL_API_KEY` | Required for OpenRouter; optional for an authenticated custom endpoint. |
| `HERMES_MODEL_BASE_URL` | Required only for `custom`; the boundary appends `/chat/completions`. |
| `HERMES_MODEL_TIMEOUT_MS` | Optional positive integer up to 120000; default 30000. |

Missing, unsupported, or unsafe configuration resolves to
`NOT_CONFIGURED` and makes no network call. A custom URL may use plaintext
HTTP only without a credential or on loopback; credentials for non-loopback
custom endpoints require HTTPS. URLs containing embedded credentials are
rejected.

The adapter:

- caps each generated response at 512 tokens;
- never logs a prompt, response, credential, or raw provider error;
- requires model provenance on every successful response;
- rejects model substitution;
- requires attributable per-request cost from OpenRouter;
- parses only the allowlisted OpenAI `error.code` needed to classify HTTP 429
  responses, without retaining, logging, or exposing the provider body;
- propagates cancellation and enforces a bounded timeout;
- implements no fallback between Path A and Path B.

Focused validation:

```bash
node --test server/tests/modelRouting.test.mjs
```

Live execution is intentionally not exposed as a general CLI or HTTP
route. A separately controlled benchmark harness may import the boundary
with fixed synthetic prompts after price, credential, request-count, and
spend-cap gates pass.

## Routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/health` | Scaffold liveness + explicit `false` flags for live model calls / memory writes / external integrations. |
| `GET` | `/api/capabilities` | Machine-readable capability registry (`chat`, `model_routing`, `memory`, `gmail`, `calendar`, `search`, `maps`, `reminders`, `voice`, `native_ios`, `pwa`, `external_actions`), each labelled `NOT_IMPLEMENTED_IN_THIS_PROTOTYPE` / `PLANNED` / `DESIGNED_APPROVAL_BASED` / `EXPLORATORY_SPEC_ONLY`. None are live. |
| `GET` | `/api/product-truth` | Machine-readable projection of the public claims in [`lib/productTruth.mjs`](lib/productTruth.mjs). |
| `POST` | `/api/chat` | Validates `{ message: string, session_id?: string, route_mode?: "AUTO" | "BALANCED" | "DEEP" | "LOCAL" }`. The default is `AUTO`. Disabled configuration returns the labelled prototype response; enabled configuration enters the bounded provider adapter. With a valid `session_id`, the user message and any successful assistant reply are persisted locally. |
| `POST` | `/api/sessions` | Creates a session. Body `{ title?: string }` (≤200 chars, credential-shaped input rejected the same way chat messages are). `200` with `{ok:true, session}`. |
| `GET` | `/api/sessions` | Lists known sessions, most recently active first (deterministic `session_id` tiebreak). `200` with `{ok:true, sessions:[...]}`. |
| `GET` | `/api/sessions/:id` | Resumes a session. `200` with `{ok:true, session}`; `400 INVALID_SESSION_ID` if `:id` isn't a recognizable id shape; `404 SESSION_NOT_FOUND` if well-formed but unknown. |
| any other route | — | `404` with `{"error": "NOT_FOUND", ...}`. |

### Session identity

The session routes are the smallest API boundary the Yuzuki client needs to
create, list, resume, and chat within a session. The implementation lives in
[`routes/sessions.mjs`](routes/sessions.mjs) and
[`lib/sessionStore.mjs`](lib/sessionStore.mjs).

A session record contains identity metadata only:
`{ session_id, title, created_at, last_activity_at }`. Message text is stored
separately in the same local SQLite database. `POST /api/chat` with a valid
`session_id` commits the user's message before provider execution and stores a
successful assistant reply afterward. Titles and messages are screened for
credential-shaped input before persistence and are never logged.

```text
SESSION_PERSISTENCE: DURABLE_LOCAL_SQLITE
MESSAGE_HISTORY_PERSISTENCE: DURABLE_LOCAL_SQLITE
```

The store in [`lib/sessionStore.mjs`](lib/sessionStore.mjs) persists sessions
and message history to a SQLite file in Yuzuki's local app-data directory, so
they survive an application or server restart. The data is not cloud-synced
and is not encrypted at rest. Store failures fail closed and are reported
through the persistence status surface rather than silently claiming success.

There is **no authentication or per-caller ownership concept** anywhere
in this scaffold. The API and the default Vite development/preview surfaces
bind to loopback only; any local process that can reach those ports can list
or read any session. Network exposure is unsupported as a standard workflow
and would require an explicit operator override with its own security review.

### `/api/chat` request/response shape

Request body: `{ "message": "<string, 1–4000 chars>", "session_id"?: "<uuid>", "route_mode"?: "AUTO" | "BALANCED" | "DEEP" | "LOCAL" }`. No other field is accepted. The client cannot supply a raw model, provider, reasoning level, endpoint, headers, or tools.

Success (`200`):

```json
{
  "ok": true,
  "reply": "This is a prototype response from the HERMES API scaffold. ...",
  "turn_id": "<uuid>",
  "mode": "PROTOTYPE",
  "model_route_status": "NOT_CONFIGURED",
  "provider_configured": false,
  "memory_writes": false,
  "external_actions": false,
  "requires_approval": false,
  "product_truth_labels": ["IMPLEMENTED_NOT_LIVE_VERIFIED", "EXAMPLE_DATA"],
  "next_required_configuration": "HERMES-OPENAI-PROVIDER-SMOKE-001"
}
```

Validation failure (`400` or `413`) follows the public contract implemented by
[`lib/chatValidation.mjs`](lib/chatValidation.mjs):

```json
{
  "error": "INVALID_INPUT",
  "message": "\"message\" is required and must be a string.",
  "retryable": false,
  "requires_next_run": null
}
```

Error codes: `INVALID_INPUT` (malformed JSON, wrong shape, empty/
whitespace message, unsupported field), `INVALID_SESSION_ID` (`session_id`
present but not a recognizable id shape), `SESSION_NOT_FOUND` (`404`,
`session_id` well-formed but unknown), `MESSAGE_TOO_LONG` (over 4000
characters), `REQUEST_TOO_LARGE` (`413`, body over 32 KiB),
`CREDENTIAL_SHAPED_INPUT_REJECTED` (message matches a credential-shaped
pattern; the message is echoed back in the response's `echoed_message`
field so the caller can see what was rejected, but it is never stored or
logged), `INVALID_ROUTE`, `PROVIDER_NOT_CONFIGURED`, `MODEL_NOT_AVAILABLE`,
`LOCAL_MODEL_NOT_AVAILABLE`, `AUTH_FAILURE`, `RATE_LIMITED`,
`QUOTA_EXHAUSTED`, `BILLING_NOT_AVAILABLE`, `PROVIDER_LIMIT_UNKNOWN`,
`REQUEST_TIMEOUT`, `CANCELLED`, `PROVIDER_ERROR`, and
`MALFORMED_PROVIDER_RESPONSE`. Provider error bodies, headers, and credentials
are never returned.

For OpenAI HTTP 429 responses, `RATE_LIMITED` is reserved for the documented
transient `slow_down` condition and is retryable metadata only; this scaffold
does not execute a retry. Documented depleted-credit or organization-usage
conditions become non-retryable `QUOTA_EXHAUSTED`, and documented organization
or project spend limits become non-retryable `BILLING_NOT_AVAILABLE`.
Malformed, missing-code, and unknown 429 payloads become non-retryable
`PROVIDER_LIMIT_UNKNOWN`. All public messages are fixed and sanitized.

### `/api/sessions` request/response shape

Create (`POST /api/sessions`) — request body `{ "title"?: "<string,
≤200 chars>" }`; success (`200`):

```json
{
  "ok": true,
  "session": {
    "session_id": "<uuid>",
    "title": "New session",
    "created_at": "<ISO 8601 timestamp>",
    "last_activity_at": "<ISO 8601 timestamp>"
  }
}
```

Error codes: `MALFORMED_REQUEST` (malformed JSON, wrong shape, unexpected
field, non-string/oversized title), `CREDENTIAL_SHAPED_INPUT_REJECTED`
(title matches a credential-shaped pattern, echoed back in
`echoed_title`, never stored), `SERVER_FAILURE` (`500`, defensive
fallback).

List (`GET /api/sessions`) — `200` with `{ "ok": true, "sessions": [...] }`,
each entry shaped like the `session` object above, ordered by
`last_activity_at` descending then `session_id` ascending.

Resume (`GET /api/sessions/:id`) — `200` with `{ "ok": true, "session": {...} }`;
`400 INVALID_SESSION_ID` if `:id` isn't a recognizable id shape;
`404 SESSION_NOT_FOUND` if well-formed but unknown.

## Run locally

```bash
npm run api:dev
```

Then, in another terminal:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/capabilities
curl http://127.0.0.1:8787/api/product-truth
curl -X POST http://127.0.0.1:8787/api/chat -H "Content-Type: application/json" -d '{"message":"hello"}'
curl -X POST http://127.0.0.1:8787/api/sessions -H "Content-Type: application/json" -d '{"title":"Weekend trip"}'
curl http://127.0.0.1:8787/api/sessions
curl http://127.0.0.1:8787/api/sessions/<session_id-from-above>
curl -X POST http://127.0.0.1:8787/api/chat -H "Content-Type: application/json" -d '{"message":"hello","session_id":"<session_id-from-above>"}'
curl http://127.0.0.1:8787/api/sessions/00000000-0000-4000-8000-000000000000
curl http://127.0.0.1:8787/api/unknown
```

`npm run api:check` constructs the router and exits immediately, without
binding a port — useful as a structural smoke check that requires no
running process and no environment configuration.

## Structure

```text
server/
  index.mjs              # entry point: startup / --check mode
  router.mjs               # request router (no side effects — importable by tests)
  routes/
    health.mjs            # GET /api/health
    capabilities.mjs      # GET /api/capabilities
    productTruth.mjs      # GET /api/product-truth
    chat.mjs               # POST /api/chat — gated prototype/provider orchestration
    sessions.mjs            # POST/GET /api/sessions, GET /api/sessions/:id
    notFound.mjs           # 404 fallback for unmatched routes
  lib/
    json.mjs              # sendJson() response helper
    cors.mjs              # localhost-only CORS + OPTIONS preflight
    productTruth.mjs      # single source of truth for capability/product-truth + routing enums
    chatValidation.mjs    # POST /api/chat request reading, validation, credential detection
    sessionId.mjs          # pure session-id shape validation
    sessionStore.mjs        # durable local SQLite session + message store
    modelRouting.mjs      # server-owned benchmark + user-chat routing catalog
    openAiCompatibleAdapter.mjs # Chat Completions + raw Responses adapters
  tests/
    modelRouting.test.mjs # dependency-free routing boundary tests
    modelBackedChat.test.mjs # gated chat, raw parser, and error tests
    session.test.mjs        # dependency-free session-identity tests
  README.md               # this file
```

## Scope boundary

Do not widen this bounded text-only path into memory storage,
Gmail/Calendar/Search/Maps/reminders, voice, tools, a manifest/service worker,
or any external write path. Live credential configuration and a one-shot
provider smoke belong to `HERMES-OPENAI-PROVIDER-SMOKE-001`.
