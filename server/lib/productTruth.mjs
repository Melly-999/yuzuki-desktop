/**
 * Single source of truth for product-truth metadata served by this API
 * scaffold. Keeping this in one module means /api/health,
 * /api/capabilities, and /api/product-truth cannot silently drift apart.
 *
 * This file does not implement any of the capabilities it describes. See
 * docs/backend/HERMES_BACKEND_READINESS_PLAN.md and
 * docs/context-pack/04_PRODUCT_TRUTH_AND_SAFETY.md for the source rules.
 */

export const SERVICE_NAME = "yuzuki-local-api";

export const PROJECT_STATUS = "VISUAL_PROTOTYPE_READY";

/**
 * Chat response `mode` values, per
 * docs/backend/HERMES_MODEL_ROUTING_READINESS_ADDENDUM.md §10.1. Defined
 * here, alongside the other product-truth constants, so no route defines
 * its own copy that could drift (addendum §10.5).
 */
export const CHAT_MODE = Object.freeze({
  PROTOTYPE: "PROTOTYPE",
  LOCAL_DEV: "LOCAL_DEV",
  HOSTED: "HOSTED",
});

/**
 * `model_route_status` values, per addendum §10.2. The OpenAI user-chat
 * path is implemented behind an explicit server-side activation gate but
 * has not been live-verified in this repository state.
 */
export const MODEL_ROUTE_STATUS = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  IMPLEMENTED_NOT_LIVE_VERIFIED: "IMPLEMENTED_NOT_LIVE_VERIFIED",
  LOCAL_DEV: "LOCAL_DEV",
  HOSTED_NATIVE_OPENROUTER: "HOSTED_NATIVE_OPENROUTER",
  HOSTED_NATIVE_CUSTOM_ENDPOINT: "HOSTED_NATIVE_CUSTOM_ENDPOINT",
  HOSTED_DIRECT_PLUGIN: "HOSTED_DIRECT_PLUGIN",
  EXPERIMENTAL_FCC_PROXY: "EXPERIMENTAL_FCC_PROXY",
  ERROR_PROVIDER_UNAVAILABLE: "ERROR_PROVIDER_UNAVAILABLE",
});

/**
 * Required capability names per HERMES-API-SCAFFOLD-001. The additive
 * IMPLEMENTED_NOT_LIVE_VERIFIED state means code and deterministic tests
 * exist, not that credentials are configured or a live request passed.
 */
/**
 * Evidence actually achieved by YUZUKI-LOCAL-HERMES-CHAT-SPRINT-001 and
 * proven end-to-end through the same local API path the packaged desktop
 * app uses. These are claims about the LOCAL runtime only. They say
 * nothing about tools, approvals, memory, or skills, all of which remain
 * unavailable to this profile.
 */
export const LOCAL_RUNTIME_TRUTH = Object.freeze({
  LOCAL_HERMES_CONNECTED: true,
  LOCAL_MODEL_VERIFIED: true,
  LOCAL_CHAT_ACTIVE: true,
  // Deliberately not the literal profile name: this is a public-safe
  // product-truth surface and must never echo a private deployment
  // identifier. Which profile is active, if any, is reported live by
  // GET /api/hermes/status instead.
  profile_configured: true,
  provider: "custom (local Ollama, 127.0.0.1)",
  // Deliberately NOT a model name. The model this profile resolves is
  // owned by the Hermes profile config and reported by the live runtime
  // (`info.model` -> hermesBridge's state -> `hermesInfo.model` in the
  // UI). A second, hand-maintained copy here drifted out of date once
  // already — it still claimed `qwen3.5:9b` after the profile moved to a
  // different local model — so this file no longer restates it.
  model_source: "reported by the live Hermes runtime (GET /api/hermes -> info.model)",
  transport: "TUI-Gateway JSON-RPC over an authenticated loopback WebSocket (/api/ws)",
  cloud_fallback: false,
  tools_active: false,
  approval_bridge_active: false,
  memory_active: false,
  skill_learning_active: false,
});

/**
 * Live connection states the local API reports for the Hermes runtime.
 * Mirrors HERMES_STATE in server/lib/hermesBridge.mjs, which is the
 * single source of truth.
 */
export const HERMES_RUNTIME_STATE = Object.freeze({
  STARTING: "HERMES_STARTING",
  READY: "HERMES_READY",
  UNAVAILABLE: "HERMES_UNAVAILABLE",
  MODEL_NOT_READY: "MODEL_NOT_READY",
  REQUEST_RUNNING: "REQUEST_RUNNING",
  REQUEST_FAILED: "REQUEST_FAILED",
});

export const CAPABILITIES = {
  local_hermes_chat: {
    status: "FOUNDATION",
    note:
      "Chat is connected to the REAL local Hermes runtime: Yuzuki's local API starts a dedicated, " +
      "profile-scoped, loopback Hermes backend and talks TUI-Gateway JSON-RPC over an authenticated " +
      "WebSocket. A turn was verified end-to-end through this exact path against the local model " +
      "the active local profile resolves, with streamed tokens and no cloud provider. The model " +
      "identity is reported by the live runtime rather than restated here, so it cannot drift. " +
      "Hermes owns the session; nothing is mirrored into Yuzuki's legacy session store. This grants " +
      "NO tools, NO approval bridge, NO memory writes, and NO skill changes — all remain unavailable " +
      "to this profile. The legacy USER_CHAT route is unchanged and is never used as a fallback.",
  },
  chat: {
    status: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    note: "POST /api/chat has a stateless, text-only OpenAI Responses path behind an explicit server activation gate. When disabled or not configured it remains an honestly labelled prototype; no live provider validation has occurred.",
  },
  model_routing: {
    status: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    note: "Server-owned AUTO/BALANCED/DEEP/LOCAL routing and a dependency-free OpenAI Responses adapter are implemented with fake-transport tests. They are disabled by default and have not made a live provider request.",
  },
  session_persistence: {
    status: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    note: "Sessions and their message history are durably stored in a local SQLite file (node:sqlite, no new dependency) that survives an application/server restart. This status field is overridden per-request in GET /api/capabilities with the store's live health (PERSISTENCE_AVAILABLE, PERSISTENCE_UNAVAILABLE, DATABASE_CORRUPT, MIGRATION_FAILED, or MIGRATION_REQUIRED) — see server/lib/sessionStore.mjs's getPersistenceStatus(). No cloud sync, no encryption-at-rest (POST_P0), no memory writes.",
  },
  context_files: {
    status: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    note: "One local file (.txt/.md fully supported; .json/.csv read as bounded plain text) may be explicitly selected and its bounded text (<=8,000 characters) included in a chat request. Selection, validation, and decoding are fully deterministic and testable client-side; whether an attached file's content is actually respected by a real model is gated on the same not-yet-live-verified provider path as chat itself. No server-side file storage, no persistence of file content or path, no RAG, no embeddings.",
  },
  memory: {
    status: "DESIGNED_APPROVAL_BASED",
    note: "Contract and approval-based UX are designed, not implemented. No storage and no writes exist. See docs/context-pack/11_MEMORY_CONTRACT_EXPLORATION.md and 13_MEMORY_CONTRACT_UX.md.",
  },
  gmail: {
    status: "PLANNED",
    note: "No Gmail integration exists. No account is connected.",
  },
  calendar: {
    status: "PLANNED",
    note: "No Calendar integration exists. No account is connected.",
  },
  search: {
    status: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    note: "Yuzuki Desktop implements bounded local full-text search over the active Hermes profile's canonical SessionDB and can resume a selected canonical session. Search is deterministic and does not call a model or admit results into prompt context. No web, Gmail, Maps, semantic, memory, or cross-profile search is implemented.",
  },
  maps: {
    status: "PLANNED",
    note: "No Maps integration exists.",
  },
  reminders: {
    status: "PLANNED",
    note: "No reminders backend exists.",
  },
  voice: {
    status: "PLANNED",
    note: "No voice assistant exists.",
  },
  native_ios: {
    status: "PLANNED",
    note: "No native iOS app exists. A PWA, if built later, does not change this status.",
  },
  pwa: {
    status: "EXPLORATORY_SPEC_ONLY",
    note: "No manifest.json or service worker exists. See docs/context-pack/12_PWA_MANIFEST_STRATEGY.md.",
  },
  external_actions: {
    status: "DESIGNED_APPROVAL_BASED",
    note: "An approval-tier model (read-only / draft / write-send / destructive) is designed, not implemented. No autonomous actions and no external writes exist.",
  },
  review_approvals: {
    status: "DESIGNED_APPROVAL_BASED",
    note: "The Review and Approvals UI implements a real, ephemeral, session-scoped decision state machine (REVIEW_REQUIRED -> APPROVAL_REQUIRED -> APPROVED/REJECTED/CANCELLED/STALE) with no execution engine behind it. An approved WRITE_LOCAL or EXTERNAL_ACTION proposal always renders EXECUTION_UNAVAILABLE: no Runtime decision engine is wired to this UI and no executor exists anywhere in this repository. Approval eligibility is never persisted and is invalidated by a restart, a session archive, or a session delete.",
  },
};

export const WHAT_EXISTS = [
  "frontend visual prototype (React + TypeScript + Vite)",
  "final avatar / portrait / favicon assets",
  "this local API scaffold: health, capabilities, product-truth, and session-aware chat",
  "an explicitly gated, stateless, text-only OpenAI Responses path that is implemented but not live-verified",
  "a live-verified chat path to the REAL local Hermes runtime (loopback WebSocket + JSON-RPC) answering from the local model the profile resolves (identity reported by the runtime, not restated here), with streaming, cancellation, and honest failure states",
  "a dependency-free OpenAI-compatible routing evaluation boundary restricted to explicitly authorized synthetic benchmark prompts",
];

export const WHAT_DOES_NOT_EXIST = [
  "production backend/API",
  "a live-verified CLOUD or production model chat endpoint (the verified chat path is local-only)",
  "a configured or live-verified OpenAI provider connection in this repository state",
  "persistent memory",
  "memory writes",
  "Gmail integration",
  "Calendar integration",
  "web, Gmail, Maps, semantic, memory, or cross-profile search integration",
  "Maps integration",
  "reminders implementation",
  "voice assistant",
  "native iOS app",
  "manifest.json",
  "service worker",
  "production notifications",
  "autonomous actions",
  "message sending",
  "an E2EE production guarantee",
];

export const FUTURE_CAPABILITY_LABELING_RULE =
  "Every future-capability mention must be anchored with one of: NOT_IMPLEMENTED_IN_THIS_PROTOTYPE, PLANNED, COMING_LATER, DESIGNED_APPROVAL_BASED, EXPLORATORY_SPEC_ONLY.";

export const NO_LIVE_INTEGRATION_DISCLAIMER =
  "This API scaffold contains an explicitly gated OpenAI user-chat path, but it is disabled by default and has not been live-verified. It does not connect to any external account or store personal data or memory. Model routing grants no tools or external-action authority.";
