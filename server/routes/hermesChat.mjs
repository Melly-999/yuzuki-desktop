import { spawn as nodeSpawn } from "node:child_process";
import { sendJson } from "../lib/json.mjs";
import { readJsonBody, MAX_BODY_BYTES } from "../lib/chatValidation.mjs";
import {
  HermesBridge,
  HERMES_STATE,
  BRIDGE_EVENT,
  HermesBridgeError,
  APPROVAL_CHOICE,
} from "../lib/hermesBridge.mjs";
import { resolveHermesRuntime } from "../lib/hermesRuntime.mjs";
import { PROFILE_FAILURE } from "../lib/hermesProfilePolicy.mjs";
import {
  publicFixtureEnabled,
  fixtureStatus,
  fixtureSessions,
  fixtureSearch,
  fixtureRoutingOptions,
} from "../lib/publicFixture.mjs";

/** Pre-start profile/setup failures, distinct from "runtime not installed". */
const PROFILE_SETUP_FAILURES = new Set(Object.values(PROFILE_FAILURE));

/**
 * Routes for the REAL local Hermes chat path.
 *
 * These are deliberately separate from POST /api/chat. That legacy route
 * is the provider-neutral USER_CHAT prototype and stays diagnostic /
 * development-only; this sprint's contract forbids ever silently retrying
 * a failed Hermes turn into it. Keeping the two on different paths makes
 * that impossible by construction rather than by convention — there is no
 * code path here that can reach the canned prototype reply.
 *
 *   GET  /api/hermes/status  -> secret-free runtime state
 *   POST /api/hermes/chat    -> Server-Sent Events stream of a real turn
 *   POST /api/hermes/cancel  -> cooperative interrupt of the running turn
 *   POST /api/hermes/search  -> deterministic local session FTS
 */

/** One SSE frame. */
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createHermesChatRoutes({
  // Defaults are the real ones: Node's own spawn, and the global
  // WebSocket built into Node 22+ (so this adds no dependency).
  spawnImpl = nodeSpawn,
  webSocketImpl = globalThis.WebSocket,
  env = process.env,
  resolveRuntime = resolveHermesRuntime,
  bridgeFactory = (options) => new HermesBridge(options),
} = {}) {
  /** Lazily started singleton: one local runtime per Yuzuki process. */
  let bridge = null;
  let starting = null;

  /**
   * Opt-in, explicit-only synthetic mode for public screenshots/demos.
   * When on, the read surfaces below answer from repository-owned
   * constants and no runtime is ever resolved, spawned, or queried — so a
   * capture cannot reach the real SessionDB. Off unless the env var is
   * set to exactly "1".
   */
  const fixtureMode = publicFixtureEnabled(env);

  function unavailable(reason) {
    return {
      state: HERMES_STATE.UNAVAILABLE,
      detail: reason,
      profile: null,
      provider: null,
      model: null,
      session_id: null,
      connected: false,
    };
  }

  async function ensureBridge() {
    if (bridge && bridge.describe().connected) return bridge;
    if (starting) return starting;

    const runtime = resolveRuntime({ env });
    if (!runtime.ok) {
      // Pre-start profile/setup failures (missing profile, unreadable
      // config, no model configured, or an unconfirmed-local provider) get
      // their own distinct, non-retryable code rather than the generic
      // "unavailable" one, so a client can tell "needs setup" apart from
      // "runtime not installed" — without runtime.reason ever containing a
      // filesystem path or the profile's own name (see hermesRuntime.mjs).
      const code = PROFILE_SETUP_FAILURES.has(runtime.failure) ? "HERMES_SETUP_REQUIRED" : "HERMES_UNAVAILABLE";
      throw new HermesBridgeError(code, runtime.reason, {
        retryable: false,
        state: HERMES_STATE.UNAVAILABLE,
      });
    }

    const candidate = bridgeFactory({
      profile: runtime.profile,
      command: runtime.command,
      args: runtime.args,
      cwd: runtime.cwd,
      spawnImpl,
      webSocketImpl,
      env,
    });

    starting = candidate
      .start()
      .then(() => {
        bridge = candidate;
        starting = null;
        return candidate;
      })
      .catch((err) => {
        starting = null;
        throw err;
      });
    return starting;
  }

  async function handleStatus(req, res) {
    if (fixtureMode) {
      sendJson(res, 200, { ok: true, hermes: fixtureStatus() });
      return;
    }
    if (!bridge) {
      const runtime = resolveRuntime({ env });
      sendJson(res, 200, {
        ok: true,
        hermes: runtime.ok
          ? { ...unavailable("The local Hermes runtime has not been started yet."), profile: runtime.profile }
          : unavailable(runtime.reason),
      });
      return;
    }
    sendJson(res, 200, { ok: true, hermes: bridge.describe() });
  }

  async function handleCancel(req, res) {
    if (!bridge) {
      sendJson(res, 409, {
        error: "NO_RUNNING_TURN",
        message: "There is no running turn to cancel.",
        retryable: false,
      });
      return;
    }
    try {
      const cancelled = await bridge.cancel();
      sendJson(res, cancelled ? 200 : 409, {
        ok: cancelled,
        ...(cancelled ? {} : { error: "NO_RUNNING_TURN", message: "There is no running turn to cancel." }),
        hermes: bridge.describe(),
      });
    } catch (err) {
      sendJson(res, 502, {
        error: err.code || "HERMES_ERROR",
        message: err.message,
        retryable: Boolean(err.retryable),
      });
    }
  }

  async function handleChat(req, res) {
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "The request could not be processed.", retryable: false });
      return;
    }
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const allowed = new Set(["message", "routingMode", "requestedModelId"]);
    if (!message || Object.keys(body ?? {}).some((key) => !allowed.has(key))) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "A non-empty message is required.", retryable: false });
      return;
    }

    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      // The runtime is genuinely unavailable. Report it as such — there
      // is deliberately no fallback to the USER_CHAT prototype reply.
      sendJson(res, 503, {
        error: err.code || "HERMES_UNAVAILABLE",
        message: err.message,
        retryable: Boolean(err.retryable),
        hermes: unavailable(err.message),
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // The bridge emits a typed error event AND rejects for the same
    // failure. Track it so the stream carries exactly one error frame.
    let errorSent = false;
    const emit = (event) => {
      if (event.type === BRIDGE_EVENT.DELTA) sse(res, "delta", { text: event.text });
      else if (event.type === BRIDGE_EVENT.STATE) sse(res, "state", event.state);
      else if (event.type === BRIDGE_EVENT.COMPLETE) sse(res, "complete", { text: event.text, hermes: event.state });
      else if (event.type === BRIDGE_EVENT.APPROVAL) sse(res, "approval", event.approval);
      else if (event.type === BRIDGE_EVENT.ACTIVITY) sse(res, "activity", event.activity);
      else if (event.type === BRIDGE_EVENT.ERROR) {
        errorSent = true;
        sse(res, "error", { code: event.code, message: event.message, hermes: event.state });
      }
    };
    // Approval and tool events can arrive while the agent thread is blocked,
    // so the stream also observes out-of-turn events.
    active.setObserver(emit);
    try {
      await active.submitPrompt(message, {
        routingMode: body.routingMode,
        requestedModelId: body.requestedModelId,
        onEvent: emit,
      });
    } catch (err) {
      // The stream is already open, so the failure is delivered as a
      // terminal SSE error frame rather than an HTTP status. Either way
      // it stays a visible failure.
      if (!errorSent)
        sse(res, "error", {
          code: err.code || "REQUEST_FAILED",
          message: err.message,
          hermes: active.describe(),
        });
    } finally {
      active.setObserver(null);
      res.end();
    }
  }

  /** GET /api/hermes/routing-options — safe projection from Hermes routing.options. */
  async function handleRoutingOptions(req, res) {
    if (fixtureMode) {
      sendJson(res, 200, fixtureRoutingOptions());
      return;
    }
    let active;
    try {
      active = await ensureBridge();
      sendJson(res, 200, await active.routingOptions());
    } catch (err) {
      sendJson(res, 502, {
        status: "REGISTRY_UNAVAILABLE",
        models: [],
        message: "Model list unavailable.",
      });
    }
  }

  /** Feature-gated stream for one Hermes-owned bounded fixture action. */
  async function handleCua(req, res) {
    if (env.YUZUKI_CUA_FIXTURE_MODE !== "1") {
      sendJson(res, 404, { error: "NOT_FOUND", message: "Not found." });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "The request could not be processed." });
      return;
    }
    const allowed = new Set(["operation", "target", "fixture_id", "input", "expected"]);
    const unexpected = Object.keys(body ?? {}).filter((key) => !allowed.has(key));
    const operation = typeof body?.operation === "string" ? body.operation : "";
    const target = typeof body?.target === "string" ? body.target : "";
    const compatible = {
      OBSERVE: new Set(["FIXTURE_WINDOW", "STATE_SUMMARY"]),
      FOCUS_TARGET: new Set(["FIXTURE_WINDOW"]),
      CLICK_TARGET: new Set(["INCREMENT_BUTTON"]),
      TYPE_IN_APPROVED_FIXTURE: new Set(["TEXT_INPUT"]),
      WAIT_FOR_STATE: new Set(["STATE_SUMMARY"]),
      VERIFY_STATE: new Set(["STATE_SUMMARY"]),
    };
    const fixtureId = typeof body?.fixture_id === "string" ? body.fixture_id : "";
    if (unexpected.length || !compatible[operation]?.has(target)
        || (operation !== "OBSERVE" && !fixtureId)) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "Invalid bounded CUA fixture request." });
      return;
    }
    if (operation === "TYPE_IN_APPROVED_FIXTURE"
        && (typeof body.input !== "string" || body.input.length < 1 || body.input.length > 64
            || /[\u0000-\u001f\u007f]/.test(body.input))) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "Fixture text must be 1–64 printable characters." });
      return;
    }
    if (operation !== "TYPE_IN_APPROVED_FIXTURE" && body.input !== undefined) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "Input is valid only for fixture typing." });
      return;
    }

    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      sendJson(res, 503, { error: err.code || "HERMES_UNAVAILABLE", message: err.message });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    const emit = (event) => {
      if (event.type === BRIDGE_EVENT.CUA_PROPOSAL) sse(res, "proposal", event.payload);
      else if (event.type === BRIDGE_EVENT.CUA_START) sse(res, "action_start", event.payload);
      else if (event.type === BRIDGE_EVENT.CUA_COMPLETE) sse(res, "receipt", event.payload);
      else if (event.type === BRIDGE_EVENT.APPROVAL) sse(res, "approval", event.approval);
      else if (event.type === BRIDGE_EVENT.ACTIVITY) sse(res, "activity", event.activity);
    };
    try {
      const result = await active.runCuaFixture(body, { onEvent: emit });
      sse(res, "complete", result);
    } catch (err) {
      sse(res, "error", { code: err.code || "CUA_FAILED", message: err.message });
    } finally {
      res.end();
    }
  }

  /** GET /api/hermes/sessions — Hermes-owned session list. */
  async function handleSessions(req, res) {
    if (fixtureMode) {
      sendJson(res, 200, { ok: true, sessions: fixtureSessions(), hermes: fixtureStatus() });
      return;
    }
    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      sendJson(res, 503, { error: err.code || "HERMES_UNAVAILABLE", message: err.message, sessions: [] });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, sessions: await active.listSessions(), hermes: active.describe() });
    } catch (err) {
      sendJson(res, 502, { error: err.code || "HERMES_ERROR", message: err.message, sessions: [] });
    }
  }

  /** POST /api/hermes/search — profile-bound, deterministic conversation search. */
  async function handleSearch(req, res) {
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 400, { error: "INVALID_QUERY", message: "The search request could not be processed." });
      return;
    }
    const unexpected = Object.keys(body ?? {}).filter((key) => key !== "query" && key !== "limit");
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (unexpected.length > 0 || query.length < 2 || query.length > 200 || /[\u0000-\u001f]/.test(query)) {
      sendJson(res, 400, { error: "INVALID_QUERY", message: "Enter 2–200 printable characters." });
      return;
    }
    const rawLimit = body?.limit ?? 20;
    if (!Number.isInteger(rawLimit)) {
      sendJson(res, 400, { error: "INVALID_QUERY", message: "The result limit must be an integer." });
      return;
    }
    const limit = Math.max(1, Math.min(rawLimit, 20));
    // Validation above still applies in fixture mode: only the data source
    // is synthetic, never the input contract.
    if (fixtureMode) {
      sendJson(res, 200, { ok: true, ...fixtureSearch(query, limit) });
      return;
    }
    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      sendJson(res, 503, { error: err.code || "HERMES_UNAVAILABLE", message: err.message, results: [] });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await active.searchSessions({ query, limit })) });
    } catch (err) {
      sendJson(res, 502, { error: err.code || "HERMES_ERROR", message: err.message, results: [] });
    }
  }

  /** POST /api/hermes/resume — adopt a Hermes-owned session. */
  async function handleResume(req, res) {
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "The request could not be processed." });
      return;
    }
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    if (!sessionId) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "A session_id is required." });
      return;
    }
    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      sendJson(res, 503, { error: err.code || "HERMES_UNAVAILABLE", message: err.message });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await active.resumeSession(sessionId)) });
    } catch (err) {
      sendJson(res, 502, { error: err.code || "HERMES_ERROR", message: err.message });
    }
  }

  /**
   * POST /api/hermes/session — open a NEW canonical Hermes conversation.
   *
   * The narrowest seam that makes Hermes's own `session.create` reachable
   * after connect. It takes no body: Hermes mints and owns the id, and
   * Yuzuki must never propose one (contract §6 — one canonical owner).
   */
  async function handleNewSession(req, res) {
    let active;
    try {
      active = await ensureBridge();
    } catch (err) {
      sendJson(res, 503, { error: err.code || "HERMES_UNAVAILABLE", message: err.message });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await active.newSession()) });
    } catch (err) {
      // A busy turn is a distinct, retryable condition — not a runtime
      // failure — so it must not be reported as one.
      sendJson(res, err.code === "REQUEST_RUNNING" ? 409 : 502, {
        error: err.code || "HERMES_ERROR",
        message: err.message,
      });
    }
  }

  /** GET /api/hermes/approvals — what is awaiting a human decision. */
  async function handleApprovals(req, res) {
    sendJson(res, 200, { ok: true, approvals: bridge ? bridge.pendingApprovals() : [] });
  }

  /**
   * POST /api/hermes/approval — relay ONE human decision.
   *
   * Approval logic lives in Hermes; this only carries the answer. A request
   * arriving in chat text is not authorization and can never reach here:
   * the only way to produce a decision is an explicit call naming the exact
   * pending request_id.
   */
  async function handleApprovalRespond(req, res) {
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "The request could not be processed." });
      return;
    }
    const requestId = typeof body?.request_id === "string" ? body.request_id : "";
    const choice = typeof body?.choice === "string" ? body.choice : "";
    if (!requestId) {
      sendJson(res, 400, { error: "INVALID_INPUT", message: "A request_id is required." });
      return;
    }
    if (choice !== APPROVAL_CHOICE.ONCE && choice !== APPROVAL_CHOICE.DENY) {
      sendJson(res, 400, {
        error: "INVALID_CHOICE",
        message: `Only "${APPROVAL_CHOICE.ONCE}" or "${APPROVAL_CHOICE.DENY}" is accepted.`,
      });
      return;
    }
    if (!bridge) {
      sendJson(res, 409, { error: "STALE_APPROVAL", message: "That approval request is no longer pending." });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await bridge.respondApproval(requestId, choice)) });
    } catch (err) {
      sendJson(res, err.code === "STALE_APPROVAL" || err.code === "INVALID_CHOICE" ? 409 : 502, {
        error: err.code || "HERMES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Tear down the local Hermes runtime this process started.
   *
   * Without this, exiting the API server left the spawned Hermes runtime
   * (and the CUA driver it owns) running: `bridge.stop()` was only ever
   * reachable from an explicit request, so a normal shutdown orphaned the
   * whole tree. Idempotent, and safe to call when nothing was ever started.
   */
  async function shutdown() {
    const active = bridge;
    bridge = null;
    starting = null;
    if (!active) return false;
    try {
      await active.stop();
    } catch {
      /* shutting down anyway */
    }
    return true;
  }

  return {
    handleStatus,
    handleRoutingOptions,
    handleChat,
    handleCua,
    handleCancel,
    handleSessions,
    handleSearch,
    handleResume,
    handleNewSession,
    handleApprovals,
    handleApprovalRespond,
    shutdown,
    _internals: { ensureBridge },
  };
}

const routes = createHermesChatRoutes();
export const handleHermesStatus = routes.handleStatus;
export const handleHermesRoutingOptions = routes.handleRoutingOptions;
export const handleHermesChat = routes.handleChat;
export const handleHermesCua = routes.handleCua;
export const handleHermesCancel = routes.handleCancel;
export const handleHermesSessions = routes.handleSessions;
export const handleHermesSearch = routes.handleSearch;
export const handleHermesResume = routes.handleResume;
export const handleHermesNewSession = routes.handleNewSession;
export const handleHermesApprovals = routes.handleApprovals;
export const handleHermesApprovalRespond = routes.handleApprovalRespond;
/** Stop the local Hermes runtime on process shutdown (see server/index.mjs). */
export const shutdownHermesRuntime = routes.shutdown;
