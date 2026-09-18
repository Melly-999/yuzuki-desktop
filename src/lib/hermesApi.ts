/**
 * Client for the local HERMES API scaffold (`server/`). This module talks
 * only to that local, dependency-free Node scaffold — never to a model
 * provider. See server/README.md for the routes and response shapes this
 * file mirrors.
 *
 * No API key, no `.env` value, and no provider SDK is used here. Ordinary
 * local use calls the scaffold's documented loopback endpoint
 * (127.0.0.1:8787). An explicitly LAN-bound Vite development run uses a
 * same-origin `/api` proxy back to that loopback endpoint. Neither path is
 * a deployed/production endpoint, and this file must not be extended to
 * call one.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True only inside a Tauri-hosted webview (dev or the bundled release
 * build). Tauri always injects this global into the page regardless of
 * hostname or scheme, so it is a reliable signal there — unlike matching
 * Tauri's production asset-origin hostname (an internal detail that can
 * differ across Tauri/WebView2 versions and is not worth hardcoding).
 */
const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Keep the documented loopback API for ordinary local use, and for the
 * native Tauri desktop shell (whose bundled production build is served from
 * an internal asset origin, not `localhost`/`127.0.0.1`, but still talks to
 * the same loopback-only local API). During an explicitly LAN-bound Vite QA
 * run, use the page origin so Vite can proxy `/api` back to the
 * loopback-only scaffold without exposing port 8787.
 */
const API_BASE_URL =
  LOOPBACK_HOSTNAMES.has(window.location.hostname) || isTauriRuntime
    ? "http://127.0.0.1:8787"
    : "";

export type ChatMode = "PROTOTYPE" | "LOCAL_DEV" | "HOSTED";

export type RouteMode = "AUTO" | "BALANCED" | "DEEP" | "LOCAL";

export type RoutingMode = "PRIVATE" | "SAVER" | "FAST" | "SMART" | "DEEP" | "CREATIVE" | "ADVANCED";

export type HermesRoutingProvenance = {
  requested_mode: RoutingMode | null;
  requested_model_id: string | null;
  served_provider: string | null;
  served_model: string | null;
  locality: "local" | "cloud" | null;
  fallback_occurred: boolean;
  fallback_reason: string | null;
  routing_status: string | null;
};

export type HermesRoutingOption = {
  id: string;
  displayName: string;
  provider: string;
  locality: "local" | "cloud";
  selectable: boolean;
  status: string;
  lifecycle: string;
  capabilities: string[];
  budgetClass: string;
};

export type HermesRoutingOptionsOutcome =
  | { kind: "success"; status: string; models: HermesRoutingOption[] }
  | { kind: "unavailable"; status: string; message: string };

export type ModelRouteStatus =
  | "NOT_CONFIGURED"
  | "IMPLEMENTED_NOT_LIVE_VERIFIED"
  | "LOCAL_DEV"
  | "HOSTED_NATIVE_OPENROUTER"
  | "HOSTED_NATIVE_CUSTOM_ENDPOINT"
  | "HOSTED_DIRECT_PLUGIN"
  | "EXPERIMENTAL_FCC_PROXY"
  | "ERROR_PROVIDER_UNAVAILABLE";

export type ChatSuccessResponse = {
  ok: true;
  reply: string;
  turn_id: string;
  session_id: string | null;
  mode: ChatMode;
  model_route_status: ModelRouteStatus;
  provider_configured: boolean;
  memory_writes: boolean;
  external_actions: boolean;
  requires_approval: boolean;
  product_truth_labels: string[];
  next_required_configuration: string | null;
};

export type ChatErrorBody = {
  error: string;
  message: string;
  retryable: boolean;
  requires_next_run: string | null;
  /**
   * Present only on `CREDENTIAL_SHAPED_INPUT_REJECTED`. This is the
   * caller's own rejected text (trimmed), echoed back by the server so a
   * caller *could* show the user exactly what was flagged — see
   * server/lib/chatValidation.mjs. Deliberately typed but never rendered
   * by this UI (see `ChatErrorBanner` in App.tsx): it is, by definition,
   * text that looked like a credential or secret, and redisplaying it in
   * the app would put credential-shaped content back on screen for no
   * safety benefit — the composer already preserves the user's own draft
   * verbatim on error, so they can already see and edit what they typed.
   * Keep this field typed for API-contract completeness only; do not
   * wire it into any UI without a deliberate security review.
   */
  echoed_message?: string;
  /** Present only on CREDENTIAL_SHAPED_INPUT_REJECTED for attached file context — same non-rendering guarantee as echoed_message above. */
  echoed_context_text?: string;
};

export type ChatOutcome =
  | { kind: "success"; data: ChatSuccessResponse }
  | { kind: "api_error"; status: number; error: ChatErrorBody }
  | { kind: "network_error"; message: string };

/**
 * Session identity metadata only (HERMES-CHAT-SESSION-IDENTITY-API-001).
 * No message or reply content is ever part of this shape — see
 * server/lib/sessionStore.mjs. Persistence is EPHEMERAL (in-process
 * memory only, lost on server restart); do not assume a session survives
 * across the local API scaffold being restarted.
 */
export type SessionMetadata = {
  session_id: string;
  title: string;
  created_at: string;
  last_activity_at: string;
  /** Set when the session is archived (reversible); null when active. */
  archived_at: string | null;
};

/**
 * Live health of the durable local store — never a hardcoded "available"
 * claim. See server/lib/sessionStore.mjs's own failure posture.
 */
export type PersistenceStatus = {
  status:
    | "PERSISTENCE_AVAILABLE"
    | "PERSISTENCE_UNAVAILABLE"
    | "DATABASE_CORRUPT"
    | "MIGRATION_FAILED"
    | "MIGRATION_REQUIRED";
  detail: string;
};

export type MessageRole = "user" | "assistant";

export type MessageRecord = {
  message_id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  status: "complete" | "failed" | "cancelled";
};

export type SessionErrorBody = {
  error: string;
  message: string;
  retryable: boolean;
  requires_next_run: string | null;
  /** Present only on CREDENTIAL_SHAPED_INPUT_REJECTED for a session title — same non-persistence guarantee as ChatErrorBody's echoed_message. */
  echoed_title?: string;
};

export type SessionOutcome =
  | { kind: "success"; data: SessionMetadata }
  | { kind: "not_found" }
  | { kind: "api_error"; status: number; error: SessionErrorBody }
  | { kind: "network_error"; message: string };

export type SessionListOutcome =
  | { kind: "success"; data: SessionMetadata[]; persistence: PersistenceStatus }
  | { kind: "api_error"; status: number; error: SessionErrorBody }
  | { kind: "network_error"; message: string };

export type DeleteSessionOutcome =
  | { kind: "success" }
  | { kind: "not_found" }
  | { kind: "api_error"; status: number; error: SessionErrorBody }
  | { kind: "network_error"; message: string };

export type MessageListOutcome =
  | { kind: "success"; data: MessageRecord[] }
  | { kind: "not_found" }
  | { kind: "api_error"; status: number; error: SessionErrorBody }
  | { kind: "network_error"; message: string };

export type HealthResponse = {
  ok: true;
  service: string;
  mode: string;
  status: string;
  live_model_calls: boolean;
  memory_writes: boolean;
  external_integrations: boolean;
};

export type HealthOutcome =
  | { kind: "reachable"; data: HealthResponse }
  | { kind: "unreachable"; message: string };

export type CapabilityStatus =
  | "NOT_IMPLEMENTED_IN_THIS_PROTOTYPE"
  | "IMPLEMENTED_NOT_LIVE_VERIFIED"
  | "PLANNED"
  | "COMING_LATER"
  | "DESIGNED_APPROVAL_BASED"
  | "FOUNDATION"
  | "EXPLORATORY_SPEC_ONLY";

export type CapabilityEntry = {
  status: CapabilityStatus;
  note: string;
};

export type CapabilitiesResponse = {
  ok: true;
  capabilities: Record<string, CapabilityEntry>;
};

export type ProductTruthResponse = {
  ok: true;
  project_status: string;
  prototype_warning: string;
  what_exists: string[];
  what_does_not_exist: string[];
  future_capability_labeling_rule: string;
  no_live_integration_disclaimer: string;
};

async function parseJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** GET /api/health — used only to detect whether the local scaffold is reachable. */
export async function checkApiHealth(signal?: AbortSignal): Promise<HealthOutcome> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`, { method: "GET", signal });
    if (!response.ok) {
      return { kind: "unreachable", message: `API scaffold responded with status ${response.status}.` };
    }
    const data = await parseJsonSafely(response);
    if (!data || typeof data !== "object") {
      return { kind: "unreachable", message: "API scaffold returned an unexpected response." };
    }
    return { kind: "reachable", data: data as HealthResponse };
  } catch {
    return { kind: "unreachable", message: "Could not reach the local HERMES API scaffold." };
  }
}

/** GET /api/capabilities — used to source the real chat-capability note instead of hardcoding it. */
export async function fetchCapabilities(signal?: AbortSignal): Promise<CapabilitiesResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/capabilities`, { method: "GET", signal });
    if (!response.ok) return null;
    const data = await parseJsonSafely(response);
    if (!data || typeof data !== "object") return null;
    return data as CapabilitiesResponse;
  } catch {
    return null;
  }
}

/** GET /api/product-truth — used to source the prototype disclaimer text instead of hardcoding it. */
export async function fetchProductTruth(signal?: AbortSignal): Promise<ProductTruthResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/product-truth`, { method: "GET", signal });
    if (!response.ok) return null;
    const data = await parseJsonSafely(response);
    if (!data || typeof data !== "object") return null;
    return data as ProductTruthResponse;
  } catch {
    return null;
  }
}

/** POST /api/sessions — creates a new session. `title` defaults server-side if omitted. */
export async function createSession(title?: string, signal?: AbortSignal): Promise<SessionOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title === undefined ? {} : { title }),
      signal,
    });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  return parseSessionOutcome(response);
}

/**
 * GET /api/sessions — lists known sessions in the scaffold's deterministic
 * order (most recently active first). Excludes archived sessions unless
 * `includeArchived` is set. The returned `persistence` field always
 * reflects the durable store's real, live health — never assume
 * `PERSISTENCE_AVAILABLE`.
 */
export async function listSessions(
  { includeArchived = false, signal }: { includeArchived?: boolean; signal?: AbortSignal } = {},
): Promise<SessionListOutcome> {
  let response: Response;
  try {
    const query = includeArchived ? "?include_archived=true" : "";
    response = await fetch(`${API_BASE_URL}/api/sessions${query}`, { method: "GET", signal });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  const data = await parseJsonSafely(response);
  if (response.ok && data && typeof data === "object" && Array.isArray((data as { sessions?: unknown }).sessions)) {
    const { sessions, persistence } = data as { sessions: SessionMetadata[]; persistence?: PersistenceStatus };
    return {
      kind: "success",
      data: sessions,
      persistence: persistence ?? { status: "PERSISTENCE_AVAILABLE", detail: "" },
    };
  }
  return { kind: "api_error", status: response.status, error: normalizeSessionError(data) };
}

/** PATCH /api/sessions/:id — rename and/or archive/unarchive (one endpoint for both). */
async function patchSession(
  sessionId: string,
  body: { title?: string; archived?: boolean },
  signal?: AbortSignal,
): Promise<SessionOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  return parseSessionOutcome(response);
}

/** Renames a session's title. Does not advance last_activity_at. */
export function renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<SessionOutcome> {
  return patchSession(sessionId, { title }, signal);
}

/** Archives (`true`) or unarchives (`false`) a session. Reversible; does not advance last_activity_at. */
export function archiveSession(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<SessionOutcome> {
  return patchSession(sessionId, { archived }, signal);
}

/**
 * DELETE /api/sessions/:id — permanent, irreversible deletion. Always
 * sends the required explicit confirmation body; callers (Desktop UI) are
 * responsible for obtaining that confirmation from the user before ever
 * calling this function — see src/desktop/NavRail.tsx's inline confirm
 * step.
 */
export async function deleteSession(sessionId: string, signal?: AbortSignal): Promise<DeleteSessionOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
      signal,
    });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  if (response.status === 404) {
    return { kind: "not_found" };
  }
  const data = await parseJsonSafely(response);
  if (response.ok && data && typeof data === "object" && (data as { ok?: unknown }).ok === true) {
    return { kind: "success" };
  }
  return { kind: "api_error", status: response.status, error: normalizeSessionError(data) };
}

/** GET /api/sessions/:id/messages — that session's durable message history, in order. */
export async function getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<MessageListOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "GET",
      signal,
    });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  if (response.status === 404) {
    return { kind: "not_found" };
  }
  const data = await parseJsonSafely(response);
  if (response.ok && data && typeof data === "object" && Array.isArray((data as { messages?: unknown }).messages)) {
    return { kind: "success", data: (data as { messages: MessageRecord[] }).messages };
  }
  return { kind: "api_error", status: response.status, error: normalizeSessionError(data) };
}

/** GET /api/sessions/:id — resumes a session, or reports it as not found. */
export async function getSession(sessionId: string, signal?: AbortSignal): Promise<SessionOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      signal,
    });
  } catch {
    return { kind: "network_error", message: "Could not reach the local HERMES API scaffold." };
  }
  if (response.status === 404) {
    return { kind: "not_found" };
  }
  return parseSessionOutcome(response);
}

async function parseSessionOutcome(response: Response): Promise<SessionOutcome> {
  const data = await parseJsonSafely(response);
  if (response.ok && data && typeof data === "object" && (data as { ok?: unknown }).ok === true) {
    return { kind: "success", data: (data as { session: SessionMetadata }).session };
  }
  if (response.status === 404) {
    return { kind: "not_found" };
  }
  return { kind: "api_error", status: response.status, error: normalizeSessionError(data) };
}

function normalizeSessionError(data: unknown): SessionErrorBody {
  if (data && typeof data === "object" && "error" in data) {
    return data as SessionErrorBody;
  }
  return {
    error: "UNEXPECTED_RESPONSE",
    message: "The API scaffold returned an unexpected response.",
    retryable: false,
    requires_next_run: null,
  };
}

/**
 * One explicitly user-selected local file's bounded, validated text
 * (YUZUKI-DESKTOP-CONTEXT-FILES-P0-IMPLEMENTATION-001) — never a path,
 * never parsed structurally. Optional and additive: omitting it from a
 * `sendChatMessage` call behaves identically to every call made before
 * this field existed.
 */
export type ChatContext = {
  filename: string;
  text: string;
};

/**
 * POST /api/chat — sends one message and returns a discriminated outcome.
 * Never infer liveness from `reply` text; callers must render `mode` and
 * `model_route_status` from the response (or the normalized error) as-is.
 * `sessionId` is optional — omit it to preserve today's single-turn
 * behavior; pass a known session id to associate the turn with it (the
 * server responds with SESSION_NOT_FOUND if the id is unknown).
 * `context` is optional — selecting/reading a file never itself calls
 * this function; only an explicit send may include it.
 */
export async function sendChatMessage(
  message: string,
  {
    sessionId,
    routeMode = "AUTO",
    context,
    signal,
  }: { sessionId?: string; routeMode?: RouteMode; context?: ChatContext; signal?: AbortSignal } = {},
): Promise<ChatOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        route_mode: routeMode,
        ...(context === undefined ? {} : { context }),
      }),
      signal,
    });
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the local HERMES API scaffold. It may not be running.",
    };
  }

  const data = await parseJsonSafely(response);

  if (response.ok && data && typeof data === "object" && (data as { ok?: unknown }).ok === true) {
    return { kind: "success", data: data as ChatSuccessResponse };
  }

  if (data && typeof data === "object" && "error" in data) {
    return { kind: "api_error", status: response.status, error: data as ChatErrorBody };
  }

  return {
    kind: "api_error",
    status: response.status,
    error: {
      error: "UNEXPECTED_RESPONSE",
      message: "The API scaffold returned an unexpected response.",
      retryable: false,
      requires_next_run: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Real local Hermes runtime (YUZUKI-LOCAL-HERMES-CHAT-SPRINT-001)
// ---------------------------------------------------------------------------

/**
 * Runtime states surfaced by the native bridge. These describe a live
 * connection to the local Hermes runtime and are deliberately distinct
 * from `ModelRouteStatus`, which describes the legacy USER_CHAT provider
 * route. `HERMES_READY` appears only after Hermes, the profile, and a
 * model are all actually resolved.
 */
export type HermesState =
  | "HERMES_STARTING"
  | "HERMES_READY"
  | "HERMES_UNAVAILABLE"
  | "MODEL_NOT_READY"
  | "REQUEST_RUNNING"
  | "REQUEST_FAILED";

export type HermesRuntimeInfo = {
  state: HermesState;
  detail: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  connected: boolean;
  routing?: HermesRoutingProvenance | null;
};

export type HermesStreamEvent =
  | { kind: "state"; hermes: HermesRuntimeInfo }
  | { kind: "delta"; text: string }
  | { kind: "complete"; text: string; hermes: HermesRuntimeInfo | null }
  | { kind: "approval"; approval: HermesApproval }
  | { kind: "activity"; activity: HermesActivity }
  | { kind: "error"; code: string; message: string; hermes: HermesRuntimeInfo | null };

/** Current runtime state. Never carries a credential. */
export async function fetchHermesStatus(signal?: AbortSignal): Promise<HermesRuntimeInfo | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/status`, { method: "GET", signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { hermes?: HermesRuntimeInfo };
    return data.hermes ?? null;
  } catch {
    return null;
  }
}

/** Policy-approved ADVANCED choices from Hermes's profile-scoped routing registry. */
export async function fetchHermesRoutingOptions(signal?: AbortSignal): Promise<HermesRoutingOptionsOutcome> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/routing-options`, { method: "GET", signal });
    const data = (await response.json()) as {
      status?: string;
      models?: HermesRoutingOption[];
      message?: string;
    };
    if (!response.ok) {
      return {
        kind: "unavailable",
        status: data.status ?? "REGISTRY_UNAVAILABLE",
        message: data.message ?? "Model list unavailable.",
      };
    }
    return { kind: "success", status: data.status ?? "READY", models: data.models ?? [] };
  } catch {
    return { kind: "unavailable", status: "REGISTRY_UNAVAILABLE", message: "Model list unavailable." };
  }
}

/** Cooperatively interrupt the running turn. */
export async function cancelHermesTurn(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/cancel`, { method: "POST", signal });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stream one real turn from the local Hermes runtime.
 *
 * This is the ONLY send path the desktop composer uses. On failure it
 * surfaces an `error` event — it never retries into the legacy
 * `sendChatMessage` prototype route, which stays diagnostic-only.
 */
export async function streamHermesChat(
  message: string,
  {
    routingMode,
    requestedModelId,
    signal,
    onEvent,
  }: {
    routingMode: RoutingMode;
    requestedModelId?: string;
    signal?: AbortSignal;
    onEvent: (event: HermesStreamEvent) => void;
  },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/hermes/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, routingMode, ...(requestedModelId ? { requestedModelId } : {}) }),
      signal,
    });
  } catch {
    onEvent({
      kind: "error",
      code: "HERMES_UNAVAILABLE",
      message: "Yuzuki could not reach its local service.",
      hermes: null,
    });
    return;
  }

  if (!response.ok || !response.body) {
    let body: { error?: string; message?: string; hermes?: HermesRuntimeInfo } = {};
    try {
      body = await response.json();
    } catch {
      /* keep the generic message below */
    }
    onEvent({
      kind: "error",
      code: body.error ?? "HERMES_UNAVAILABLE",
      message: body.message ?? "The local Hermes runtime is unavailable.",
      hermes: body.hermes ?? null,
    });
    return;
  }

  // Minimal SSE reader: frames are `event: <name>` + `data: <json>`,
  // separated by a blank line.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (frame: string) => {
    let name = "";
    let raw = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7).trim();
      else if (line.startsWith("data: ")) raw += line.slice(6);
    }
    if (!name || !raw) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (name === "delta") onEvent({ kind: "delta", text: String(data.text ?? "") });
    else if (name === "approval") onEvent({ kind: "approval", approval: data as unknown as HermesApproval });
    else if (name === "activity") onEvent({ kind: "activity", activity: data as unknown as HermesActivity });
    else if (name === "state") onEvent({ kind: "state", hermes: data as unknown as HermesRuntimeInfo });
    else if (name === "complete")
      onEvent({
        kind: "complete",
        text: String(data.text ?? ""),
        hermes: (data.hermes as HermesRuntimeInfo) ?? null,
      });
    else if (name === "error")
      onEvent({
        kind: "error",
        code: String(data.code ?? "REQUEST_FAILED"),
        message: String(data.message ?? "The turn failed."),
        hermes: (data.hermes as HermesRuntimeInfo) ?? null,
      });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      dispatch(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

// ---------------------------------------------------------------------------
// Controlled actions (YUZUKI-CONTROLLED-ACTIONS-SPRINT-001)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a controlled action. These mirror ACTIVITY_STATE in
 * server/lib/hermesBridge.mjs. None is synthesized client-side: each one
 * arrives because Hermes reported the corresponding event.
 */
export type ActivityState =
  | "REQUESTED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "DENIED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED";

/**
 * A real Hermes permission request awaiting a human decision. Hermes has
 * already redacted `command`/`description`; the server forwards only an
 * allow-listed subset of fields.
 */
export type HermesApproval = {
  request_id: string;
  session_id: string | null;
  command: string;
  description: string;
  pattern_key: string;
  smart_denied: boolean;
  received_at: string;
  revision: string;
  state: ActivityState;
  approval_kind?: "cua_fixture";
  action_id?: string;
  operation?: CuaOperation;
  target?: CuaTarget;
  fixture_id?: string;
  fixed_title?: string;
  binding_digest?: string;
  start_state?: CuaFixtureState;
  expires_at?: number;
  choices?: ["once", "deny"];
  allow_session?: false;
  allow_permanent?: false;
};

export type HermesActivity = {
  state: ActivityState;
  title: string;
  detail?: string;
  tool?: string;
  request_id?: string;
};

/** The ONLY decisions Yuzuki can send. No session-wide or permanent grant exists. */
export type ApprovalChoice = "once" | "deny";

export type CuaOperation =
  | "OBSERVE"
  | "FOCUS_TARGET"
  | "CLICK_TARGET"
  | "TYPE_IN_APPROVED_FIXTURE"
  | "WAIT_FOR_STATE"
  | "VERIFY_STATE";

export type CuaTarget = "FIXTURE_WINDOW" | "INCREMENT_BUTTON" | "TEXT_INPUT" | "STATE_SUMMARY";

export type CuaFixtureState = {
  counter: number;
  revision: number;
  echo_length: number;
  echo_sha256: string;
};

export type CuaReceipt = {
  schema_version: 1;
  action_id: string;
  approval_request_id: string | null;
  session_id: string;
  requested_operation: CuaOperation;
  resolved_target: {
    semantic_target: CuaTarget;
    fixed_title: string;
    fixture_id: string;
    binding_digest: string;
  };
  timestamps: { started_monotonic: number; ended_monotonic: number; duration_ms: number };
  start_state: CuaFixtureState;
  /**
   * null when input reached the fixture but the resulting state could not be
   * confirmed. Hermes will not assert an unchanged state it did not observe, so
   * this is genuinely unknown — re-observe rather than trusting `start_state`.
   */
  end_state: CuaFixtureState | null;
  result: "OBSERVED" | "SUCCEEDED" | "DENIED" | "STOPPED" | "FAILED";
  verification: { outcome: "VERIFIED" | "NOT_APPLICABLE" | "FAILED" | "UNKNOWN"; predicate: string };
  side_effect_summary: string;
  driver: { version: string; permission_mode: "bounded"; manifest_sha256: string };
  reason: string | null;
};

export type CuaFixtureResponse = {
  fixture_id?: string;
  observation?: {
    title: string;
    marker: string;
    state: CuaFixtureState;
    semantic_targets: Record<string, boolean>;
    image_sha256: string | null;
  };
  receipt?: CuaReceipt;
} & Partial<CuaReceipt>;

export type CuaStreamEvent =
  | { kind: "proposal"; proposal: Record<string, unknown> }
  | { kind: "action_start"; action: Record<string, unknown> }
  | { kind: "approval"; approval: HermesApproval }
  | { kind: "activity"; activity: HermesActivity }
  | { kind: "receipt"; receipt: CuaReceipt }
  | { kind: "complete"; result: CuaFixtureResponse }
  | { kind: "error"; code: string; message: string };

export type CuaFixtureRequest = {
  operation: CuaOperation;
  target: CuaTarget;
  fixture_id?: string;
  input?: string;
  expected?: Partial<Pick<CuaFixtureState, "counter" | "revision" | "echo_sha256">>;
};

/** Stream one developer-fixture action. Evidence is returned to the caller only. */
export async function streamCuaFixtureAction(
  request: CuaFixtureRequest,
  { signal, onEvent }: { signal?: AbortSignal; onEvent: (event: CuaStreamEvent) => void },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/hermes/cua`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch {
    onEvent({ kind: "error", code: "HERMES_UNAVAILABLE", message: "Could not reach the local service." });
    return;
  }
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    onEvent({ kind: "error", code: data.error ?? "CUA_UNAVAILABLE", message: data.message ?? "CUA unavailable." });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (frame: string) => {
    let name = "";
    let raw = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7).trim();
      else if (line.startsWith("data: ")) raw += line.slice(6);
    }
    if (!name || !raw) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (name === "proposal") onEvent({ kind: "proposal", proposal: data });
    else if (name === "action_start") onEvent({ kind: "action_start", action: data });
    else if (name === "approval") onEvent({ kind: "approval", approval: data as unknown as HermesApproval });
    else if (name === "activity") onEvent({ kind: "activity", activity: data as unknown as HermesActivity });
    else if (name === "receipt") onEvent({ kind: "receipt", receipt: data as unknown as CuaReceipt });
    else if (name === "complete") onEvent({ kind: "complete", result: data as CuaFixtureResponse });
    else if (name === "error") onEvent({
      kind: "error", code: String(data.code ?? "CUA_FAILED"), message: String(data.message ?? "CUA failed."),
    });
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      dispatch(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

export type HermesSessionSummary = {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
  source: string;
};

export type HermesSearchResult = {
  sessionId: string;
  title: string;
  timestamp: number;
  snippet: string;
};

export type HermesSearchOutcome =
  | { kind: "success"; query: string; results: HermesSearchResult[] }
  | { kind: "invalid_query"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

/** Hermes-owned session list. Yuzuki stores none of this. */
export async function fetchHermesSessions(signal?: AbortSignal): Promise<HermesSessionSummary[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/sessions`, { method: "GET", signal });
    if (!response.ok) return [];
    const data = (await response.json()) as { sessions?: HermesSessionSummary[] };
    return data.sessions ?? [];
  } catch {
    return [];
  }
}

/** Local, deterministic full-text search. The request has no profile or DB-path field. */
export async function searchHermesSessions(
  query: string,
  { limit = 20, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<HermesSearchOutcome> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal,
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      query?: string;
      results?: HermesSearchResult[];
    };
    if (response.ok) {
      return { kind: "success", query: data.query ?? query, results: data.results ?? [] };
    }
    if (response.status === 400 || data.error === "INVALID_QUERY") {
      return { kind: "invalid_query", message: data.message ?? "Enter at least two characters." };
    }
    if (response.status === 503 || data.error === "HERMES_UNAVAILABLE") {
      return { kind: "unavailable", message: data.message ?? "The local Hermes runtime is unavailable." };
    }
    return { kind: "error", message: data.message ?? "Conversation search failed." };
  } catch (error) {
    if (signal?.aborted) return { kind: "error", message: "Search cancelled." };
    return { kind: "unavailable", message: error instanceof Error ? error.message : "The local service is unavailable." };
  }
}

/**
 * Open a NEW canonical Hermes conversation and adopt it as the active one.
 *
 * "New conversation" MUST go through here rather than only creating a local
 * row: Hermes owns the canonical session, so a fresh conversation on screen
 * is only truthful once Hermes has actually opened one. Returns `null` on
 * any failure so the caller can keep the previous conversation on screen
 * instead of showing a conversation Hermes never opened.
 *
 * Sends no body — Yuzuki must never propose a session id.
 */
export async function createHermesSession(
  signal?: AbortSignal,
): Promise<{ session_id: string } | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { session_id?: string };
    return typeof data.session_id === "string" && data.session_id ? { session_id: data.session_id } : null;
  } catch {
    return null;
  }
}

/** Resume a Hermes-owned session; Hermes returns the transcript. */
export async function resumeHermesSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ session_id: string; messages: { role: string; text: string }[] } | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
      signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as { session_id: string; messages: { role: string; text: string }[] };
  } catch {
    return null;
  }
}

/** Whatever is currently awaiting a human decision (survives a page refresh). */
export async function fetchPendingApprovals(signal?: AbortSignal): Promise<HermesApproval[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/approvals`, { method: "GET", signal });
    if (!response.ok) return [];
    const data = (await response.json()) as { approvals?: HermesApproval[] };
    return data.approvals ?? [];
  } catch {
    return [];
  }
}

/**
 * Relay exactly ONE decision for ONE request. There is no "allow always"
 * and no "allow for this session" — the type does not permit expressing
 * one, and the server rejects anything else.
 */
export async function respondToApproval(
  requestId: string,
  choice: ApprovalChoice,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/hermes/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, choice }),
      signal,
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    return { ok: response.ok, ...data };
  } catch {
    return { ok: false, error: "HERMES_UNAVAILABLE", message: "Could not reach the local service." };
  }
}
