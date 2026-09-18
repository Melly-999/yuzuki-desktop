import { randomBytes } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";

/**
 * Native-side bridge from Yuzuki's local API to the real local Hermes
 * runtime, per docs/backend/YUZUKI_LOCAL_HERMES_RUNTIME_CONTRACT.md §4:
 *
 *   Yuzuki UI -> local API (this process) -> authenticated loopback
 *   /api/ws -> TUI-Gateway JSON-RPC -> Hermes AIAgent -> local model
 *
 * This module is deliberately NOT an agent loop. It owns exactly four
 * things: process lifecycle, the credential boundary, JSON-RPC request
 * correlation, and translation of Hermes gateway events into typed Yuzuki
 * events. Every decision about what to run, which tool to call, and what
 * to persist stays inside Hermes, which remains the canonical runtime and
 * session owner.
 *
 * CREDENTIAL BOUNDARY (load-bearing): the gateway session token is minted
 * here, passed to the Hermes child through its environment, and used to
 * build the WebSocket URL. It is held in a `#private` field that no
 * serialization path can reach — `describe()` is the ONLY state accessor
 * exposed to routes, and it returns a fixed, allow-listed shape. There is
 * deliberately no getter for the token or the credentialed URL, so a
 * future route cannot spread this object into a response by accident.
 * See server/tests/hermesBridge.test.mjs's secret-boundary tests.
 *
 * NO CLOUD FALLBACK: this bridge never selects a provider. It connects to
 * the Hermes profile it is told to use and reports whatever provider and
 * model that profile resolves. If the local runtime is unavailable the
 * turn FAILS visibly — it is never retried into the legacy USER_CHAT
 * prototype path (docs/backend/... §12), which remains diagnostic only.
 */

/**
 * User-facing runtime states. These are the names the task contract
 * requires; the repo had no prior connection-state vocabulary to reuse
 * (the existing MODEL_ROUTE_STATUS describes the legacy USER_CHAT
 * provider route, not a live runtime connection), so they are introduced
 * here as the single source of truth and re-exported through
 * productTruth.mjs for the capability surface.
 */
export const HERMES_STATE = Object.freeze({
  STARTING: "HERMES_STARTING",
  READY: "HERMES_READY",
  UNAVAILABLE: "HERMES_UNAVAILABLE",
  MODEL_NOT_READY: "MODEL_NOT_READY",
  REQUEST_RUNNING: "REQUEST_RUNNING",
  REQUEST_FAILED: "REQUEST_FAILED",
});

export const ROUTING_MODE = Object.freeze({
  PRIVATE: "PRIVATE",
  SAVER: "SAVER",
  FAST: "FAST",
  SMART: "SMART",
  DEEP: "DEEP",
  CREATIVE: "CREATIVE",
  ADVANCED: "ADVANCED",
});
const ROUTING_MODES = new Set(Object.values(ROUTING_MODE));

function normalizedRoutingIntent(routingMode, requestedModelId) {
  if (routingMode === undefined || routingMode === null || routingMode === "") return null;
  const mode = String(routingMode).trim().toUpperCase();
  const modelId = requestedModelId === undefined || requestedModelId === null
    ? null : String(requestedModelId).trim() || null;
  if (!ROUTING_MODES.has(mode)) {
    throw new HermesBridgeError("INVALID_ROUTING_MODE", `Unsupported routing mode: ${mode}`, { retryable: false });
  }
  if (mode === ROUTING_MODE.ADVANCED && !modelId) {
    throw new HermesBridgeError("MODEL_NOT_SELECTED", "ADVANCED requires an explicit model selection.", {
      retryable: false,
    });
  }
  return { mode, modelId: mode === ROUTING_MODE.ADVANCED ? modelId : null };
}

function safeRoutingProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    requested_mode: value.requested_mode ?? null,
    requested_model_id: value.requested_model_id ?? null,
    served_provider: value.served_provider ?? null,
    served_model: value.served_model ?? null,
    locality: value.locality ?? null,
    fallback_occurred: value.fallback_occurred === true,
    fallback_reason: value.fallback_reason ?? null,
    routing_status: value.routing_status ?? null,
  };
}

function safeRoutingOptions(value) {
  const status = typeof value?.status === "string" ? value.status : "REGISTRY_UNAVAILABLE";
  const models = Array.isArray(value?.models) ? value.models.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const id = typeof model.id === "string" ? model.id.trim() : "";
    const locality = model.locality === "local" || model.locality === "cloud" ? model.locality : null;
    if (!id || !locality) return [];
    return [{
      id,
      displayName: typeof model.displayName === "string" ? model.displayName : id,
      provider: typeof model.provider === "string" ? model.provider : "",
      locality,
      selectable: model.selectable === true,
      status: typeof model.status === "string" ? model.status : "REGISTRY_UNAVAILABLE",
      lifecycle: typeof model.lifecycle === "string" ? model.lifecycle : "",
      capabilities: Array.isArray(model.capabilities)
        ? model.capabilities.filter((item) => typeof item === "string") : [],
      budgetClass: typeof model.budgetClass === "string" ? model.budgetClass : "",
    }];
  }) : [];
  return { status, models };
}

function sameRoutingIntent(left, right) {
  return Boolean(left && right && left.mode === right.mode && left.modelId === right.modelId);
}

/** Typed Yuzuki events emitted to callers of `submitPrompt`. */
export const BRIDGE_EVENT = Object.freeze({
  STATE: "state",
  DELTA: "delta",
  COMPLETE: "complete",
  ERROR: "error",
  APPROVAL: "approval",
  ACTIVITY: "activity",
  CUA_PROPOSAL: "cua_proposal",
  CUA_START: "cua_start",
  CUA_COMPLETE: "cua_complete",
});

/**
 * Lifecycle a controlled action moves through, as surfaced to the Activity
 * Dock. These are Yuzuki's labels for states Hermes actually reports; none
 * of them is synthesized when Hermes is silent. In particular EXECUTING is
 * emitted only on a real `tool.start`, never optimistically after an
 * approval.
 */
export const ACTIVITY_STATE = Object.freeze({
  REQUESTED: "REQUESTED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXECUTING: "EXECUTING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
});

/**
 * The ONLY approval choices Yuzuki may send. Hermes also offers "session"
 * and "always"; this sprint forbids both, so they are not representable
 * here — `respondApproval` rejects anything outside this set rather than
 * relaying it.
 */
export const APPROVAL_CHOICE = Object.freeze({ ONCE: "once", DENY: "deny" });

/**
 * Hermes announces its chosen port on stdout as
 * `HERMES_BACKEND_READY port=<n>` (legacy backends say
 * `HERMES_DASHBOARD_READY`). Mirrors the accepted reference contract in
 * the Hermes source's apps/desktop/electron/backend-ready.ts so the two
 * cannot drift silently.
 */
/**
 * Kill a process and everything it spawned.
 *
 * Windows has no process groups, so `taskkill /T` is the supported way to
 * reap a tree; `/F` is required because Hermes's re-exec'd runtime does not
 * exit on a polite request. On POSIX this tries the process group first and
 * falls back to the pid alone — the spawn does not currently detach, so the
 * group kill is best-effort there; Windows is the platform this alpha ships
 * and the one the orphan was reproduced on. Failure is non-fatal by design:
 * a process that is already gone is the outcome we wanted.
 */
export function killProcessTree(pid, { platform = process.platform, spawnSyncImpl = nodeSpawnSync } = {}) {
  if (!pid) return false;
  if (platform === "win32") {
    const result = spawnSyncImpl("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return !result.error;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

const READY_RE = /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m;

/** Hermes gateway event names this bridge understands. */
const EV = Object.freeze({
  READY: "gateway.ready",
  START: "message.start",
  DELTA: "message.delta",
  INTERIM: "message.interim",
  COMPLETE: "message.complete",
  APPROVAL_REQUEST: "approval.request",
  TOOL_START: "tool.start",
  TOOL_PROGRESS: "tool.progress",
  TOOL_COMPLETE: "tool.complete",
  CUA_PROPOSAL: "cua.proposal",
  CUA_START: "cua.action.start",
  CUA_COMPLETE: "cua.action.complete",
});

/**
 * Allow-list for the approval fields Yuzuki forwards to the UI. Hermes
 * already redacts `command` and `description` before emitting
 * (`_approval_request_payload` / `redact_sensitive_text`), but forwarding
 * the whole payload would mean any field Hermes adds later reaches the
 * renderer unreviewed. An allow-list fails closed instead.
 */
const APPROVAL_FIELDS = [
  "request_id", "command", "description", "pattern_key", "smart_denied",
  "approval_kind", "action_id", "operation", "target", "fixture_id", "fixed_title",
  "binding_digest", "start_state", "expires_at", "choices", "allow_session", "allow_permanent",
];

const CUA_ACTION_TARGETS = Object.freeze({
  FOCUS_TARGET: "FIXTURE_WINDOW",
  CLICK_TARGET: "INCREMENT_BUTTON",
  TYPE_IN_APPROVED_FIXTURE: "TEXT_INPUT",
});

function isCuaFixtureState(value) {
  return value && typeof value === "object" &&
    Number.isFinite(value.counter) && Number.isFinite(value.revision) &&
    Number.isFinite(value.echo_length) && typeof value.echo_sha256 === "string";
}

/** Validate the exact material fields that bind proposal -> decision. */
function cuaBindingFrom(data) {
  if (!data || typeof data !== "object") return null;
  const requiredStrings = ["action_id", "operation", "target", "fixture_id", "fixed_title", "binding_digest"];
  if (!requiredStrings.every((field) => typeof data[field] === "string" && data[field].length > 0)) return null;
  if (CUA_ACTION_TARGETS[data.operation] !== data.target) return null;
  if (!isCuaFixtureState(data.start_state)) return null;
  if (!Number.isFinite(data.expires_at) || data.expires_at <= Date.now() / 1000) return null;
  return {
    action_id: data.action_id,
    operation: data.operation,
    target: data.target,
    fixture_id: data.fixture_id,
    fixed_title: data.fixed_title,
    binding_digest: data.binding_digest,
    start_state: data.start_state,
    expires_at: data.expires_at,
  };
}

function sameCuaBinding(left, right) {
  if (!left || !right) return false;
  return ["action_id", "operation", "target", "fixture_id", "fixed_title", "binding_digest", "expires_at"]
    .every((field) => left[field] === right[field]) &&
    JSON.stringify(left.start_state) === JSON.stringify(right.start_state);
}

export class HermesBridgeError extends Error {
  constructor(code, message, { retryable = false, state = null } = {}) {
    super(message);
    this.name = "HermesBridgeError";
    this.code = code;
    this.retryable = retryable;
    this.state = state;
  }
}

/**
 * Reads a `text` field defensively. Hermes payloads are trusted transport
 * frames, not user instructions, but they are still parsed data: a
 * non-string `text` must not become the literal string "undefined" in the
 * transcript.
 */
function payloadText(payload) {
  const text = payload && payload.text;
  return typeof text === "string" ? text : "";
}

export class HermesBridge {
  #token = null;
  #port = null;
  #ws = null;
  #child = null;
  #pending = new Map();
  #nextId = 1;
  /** Hermes SessionDB identity exposed through the Yuzuki API. */
  #sessionId = null;
  /** Ephemeral Hermes gateway handle used only for session-scoped RPC transport. */
  #runtimeSessionId = null;
  #state = HERMES_STATE.UNAVAILABLE;
  #detail = "Not started.";
  #provider = null;
  #model = null;
  #routing = null;
  #turn = null;
  #closed = false;
  /** request_id -> sanitized pending approval awaiting a human decision. */
  #pendingApprovals = new Map();
  /** Stable Hermes tool ids -> running tool metadata. */
  #activeTools = new Map();
  /** request_id -> tool_id, captured when Hermes asks during that tool run. */
  #approvalToolIds = new Map();
  /** Tool ids whose relayed human decision was DENY. */
  #deniedToolIds = new Set();
  /** Out-of-turn observer (the open SSE stream), for approval/tool events. */
  #observer = null;
  /** Dedicated CUA RPC/event correlation; never shared with a chat turn. */
  #cuaRun = null;
  /** CUA approval request id -> immutable Hermes action id. */
  #cuaApprovalActionIds = new Map();

  /**
   * @param {object} deps Everything external is injected so the bridge is
   *   testable without spawning a real Hermes or opening a real socket.
   */
  constructor({
    profile,
    routingMode = null,
    requestedModelId = null,
    command,
    args,
    cwd,
    spawnImpl,
    webSocketImpl,
    env = process.env,
    readyTimeoutMs = 90_000,
    tokenFactory = () => randomBytes(32).toString("base64url"),
    logger = null,
    killTreeImpl = killProcessTree,
  } = {}) {
    this.profile = profile;
    this.routingIntent = normalizedRoutingIntent(routingMode, requestedModelId);
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.webSocketImpl = webSocketImpl;
    this.env = env;
    this.readyTimeoutMs = readyTimeoutMs;
    this.tokenFactory = tokenFactory;
    this.logger = logger;
    this.killTreeImpl = killTreeImpl;
  }

  /**
   * Allow-listed, secret-free state for `/api/hermes/status` and for the
   * `state` events streamed to the UI. This is the ONLY accessor routes
   * may use. It must never grow a token, a credentialed URL, or the raw
   * child environment.
   */
  describe() {
    return {
      state: this.#state,
      detail: this.#detail,
      profile: this.profile ?? null,
      provider: this.#provider,
      model: this.#model,
      routing: this.#routing,
      session_id: this.#sessionId,
      connected: this.#ws !== null && this.#state !== HERMES_STATE.UNAVAILABLE,
      pending_approvals: this.#pendingApprovals.size,
    };
  }

  /** Node's inspect/JSON paths must not be able to surface the token. */
  toJSON() {
    return this.describe();
  }

  #setState(state, detail) {
    this.#state = state;
    if (detail !== undefined) this.#detail = detail;
  }

  /**
   * Bind Hermes's distinct durable and runtime identities without making
   * Yuzuki a second session authority. Hermes alone mints both values:
   * `stored_session_id` on create, and `resumed` / `session_key` on resume,
   * are the canonical SessionDB identity; `session_id` is the gateway's
   * ephemeral lookup handle. The latter must never cross Yuzuki's public
   * session boundary as though it were canonical.
   */
  #adoptSessionIdentity(result, { expectedCanonical = null } = {}) {
    const runtimeSessionId = typeof result?.session_id === "string" ? result.session_id.trim() : "";
    const canonicalFields = ["resumed", "session_key", "stored_session_id"]
      .map((field) => [field, typeof result?.[field] === "string" ? result[field].trim() : ""])
      .filter(([, value]) => value);
    const canonicalSessionId = canonicalFields[0]?.[1] || "";
    const canonicalValues = new Set(canonicalFields.map(([, value]) => value));

    if (!runtimeSessionId || !canonicalSessionId || canonicalValues.size !== 1) {
      throw new HermesBridgeError(
        "HERMES_SESSION_IDENTITY_INVALID",
        "Hermes did not return one unambiguous canonical session identity and runtime handle.",
        { retryable: false },
      );
    }
    if (expectedCanonical && canonicalSessionId !== expectedCanonical) {
      throw new HermesBridgeError(
        "HERMES_SESSION_IDENTITY_MISMATCH",
        "Hermes resumed a different canonical session than Yuzuki requested.",
        { retryable: false },
      );
    }

    this.#sessionId = canonicalSessionId;
    this.#runtimeSessionId = runtimeSessionId;
  }

  #log(message) {
    if (this.logger) this.logger(message);
  }

  /**
   * Start (or restart) the runtime and connect. Resolves once the gateway
   * has answered `gateway.ready` AND a Hermes session exists, so a
   * `HERMES_READY` state always means "a turn can actually be submitted".
   */
  async start() {
    if (this.#state === HERMES_STATE.READY) return this.describe();
    this.#closed = false;
    this.#setState(HERMES_STATE.STARTING, "Starting the local Hermes runtime.");

    this.#token = this.tokenFactory();
    try {
      this.#port = await this.#spawnAndAwaitPort();
      await this.#connect();
      await this.#createSession();
    } catch (err) {
      await this.stop({ keepState: true });
      const detail = err instanceof Error ? err.message : String(err);
      this.#setState(HERMES_STATE.UNAVAILABLE, detail);
      throw err instanceof HermesBridgeError
        ? err
        : new HermesBridgeError("HERMES_UNAVAILABLE", detail, {
            retryable: true,
            state: HERMES_STATE.UNAVAILABLE,
          });
    }
    return this.describe();
  }

  /**
   * Spawn `hermes --profile <p> serve --host 127.0.0.1 --port 0` and wait
   * for its port announcement. The session token travels ONLY through the
   * child's environment — never argv, which is world-readable in process
   * listings on every platform this ships to.
   */
  #spawnAndAwaitPort() {
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: { ...this.env, HERMES_DASHBOARD_SESSION_TOKEN: this.#token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;

    return new Promise((resolve, reject) => {
      let buffered = "";
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        done(
          reject,
          new HermesBridgeError(
            "HERMES_UNAVAILABLE",
            `The local Hermes runtime did not announce a port within ${this.readyTimeoutMs}ms.`,
            { retryable: true, state: HERMES_STATE.UNAVAILABLE },
          ),
        );
      }, this.readyTimeoutMs);

      const onChunk = (chunk) => {
        buffered += String(chunk);
        const match = buffered.match(READY_RE);
        if (match) done(resolve, Number(match[1]));
      };

      child.stdout?.on("data", onChunk);
      // The announcement is a stdout contract, but a runtime that dies
      // during startup explains itself on stderr; capture it so the
      // failure the user sees names the real cause.
      child.stderr?.on("data", (chunk) => {
        buffered += String(chunk);
      });
      child.on("error", (err) =>
        done(
          reject,
          new HermesBridgeError("HERMES_UNAVAILABLE", `Could not start the local Hermes runtime: ${err.message}`, {
            retryable: false,
            state: HERMES_STATE.UNAVAILABLE,
          }),
        ),
      );
      child.on("exit", (code) =>
        done(
          reject,
          new HermesBridgeError(
            "HERMES_UNAVAILABLE",
            `The local Hermes runtime exited during startup (code ${code}).`,
            { retryable: true, state: HERMES_STATE.UNAVAILABLE },
          ),
        ),
      );
    });
  }

  #connect() {
    // The credentialed URL is built and consumed entirely inside this
    // method. It is never stored on the instance, so there is no field
    // for a serializer to find.
    const url = `ws://127.0.0.1:${this.#port}/api/ws?token=${encodeURIComponent(this.#token)}`;
    const ws = new this.webSocketImpl(url);
    this.#ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new HermesBridgeError("HERMES_UNAVAILABLE", "Timed out waiting for gateway.ready.", {
            retryable: true,
            state: HERMES_STATE.UNAVAILABLE,
          }),
        );
      }, this.readyTimeoutMs);

      ws.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return; // A frame we cannot parse is dropped, never guessed at.
        }
        if (!settled && frame?.params?.type === EV.READY) {
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        this.#onFrame(frame);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new HermesBridgeError("HERMES_UNAVAILABLE", "The local Hermes gateway refused the connection.", {
            retryable: true,
            state: HERMES_STATE.UNAVAILABLE,
          }),
        );
      };
      ws.onclose = () => {
        this.#onDisconnect();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new HermesBridgeError("HERMES_UNAVAILABLE", "The local Hermes gateway closed the connection.", {
            retryable: true,
            state: HERMES_STATE.UNAVAILABLE,
          }),
        );
      };
    });
  }

  /**
   * A disconnect must never look like a completed turn. Fail every
   * in-flight request and the running turn explicitly.
   */
  #onDisconnect() {
    this.#ws = null;
    // Nothing from the old socket may affect a later session.
    this.#activeTools.clear();
    this.#approvalToolIds.clear();
    this.#deniedToolIds.clear();
    this.#cuaApprovalActionIds.clear();
    const err = new HermesBridgeError("HERMES_UNAVAILABLE", "The connection to the local Hermes runtime was lost.", {
      retryable: true,
      state: HERMES_STATE.UNAVAILABLE,
    });
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
    // A dropped connection makes every queued approval unanswerable: drop
    // them so nothing in the UI looks decidable when it no longer is.
    if (this.#pendingApprovals.size > 0) {
      for (const req of this.#pendingApprovals.values()) {
        this.#broadcast({
          type: BRIDGE_EVENT.ACTIVITY,
          activity: {
            state: ACTIVITY_STATE.FAILED,
            request_id: req.request_id,
            title: "Permission request lost",
            detail: "The connection to the local Hermes runtime dropped before a decision was recorded.",
          },
        });
      }
      this.#pendingApprovals.clear();
    }
    if (this.#turn) {
      const turn = this.#turn;
      this.#turn = null;
      turn.fail(err);
    }
    if (this.#cuaRun) {
      const run = this.#cuaRun;
      this.#cuaRun = null;
      run.fail(err);
    }
    if (!this.#closed) this.#setState(HERMES_STATE.UNAVAILABLE, err.message);
  }

  /** Routes one inbound JSON-RPC frame: response, or gateway event. */
  #onFrame(frame) {
    if (frame && frame.id !== undefined && frame.id !== null && this.#pending.has(frame.id)) {
      const pending = this.#pending.get(frame.id);
      this.#pending.delete(frame.id);
      if (frame.error) {
        pending.reject(
          new HermesBridgeError("HERMES_RPC_ERROR", frame.error.message || "The Hermes gateway rejected the request.", {
            retryable: false,
          }),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame?.method === "event") this.#onEvent(frame.params || {});
  }

  /**
   * Translate a Hermes gateway event into a typed Yuzuki event. Only the
   * turn-relevant subset is handled. Approval and tool-lifecycle events are
   * routed too, but they are NOT gated on a running turn: an approval can
   * still need resolving while the agent thread is blocked, and dropping it
   * would strand the runtime until its timeout.
   */
  #onEvent(params) {
    const { type, payload } = params;
    // Events for another session must never leak into this one.
    if (params.session_id && this.#runtimeSessionId && params.session_id !== this.#runtimeSessionId) return;

    if (type === EV.APPROVAL_REQUEST) return this.#onApprovalRequest(payload);
    if (type === EV.CUA_PROPOSAL || type === EV.CUA_START || type === EV.CUA_COMPLETE) {
      const run = this.#cuaRun;
      const actionId = typeof payload?.action_id === "string" ? payload.action_id : null;
      if (!run || !actionId) return;
      if (type === EV.CUA_PROPOSAL) {
        if (run.actionId && run.actionId !== actionId) return;
        const binding = cuaBindingFrom(payload);
        if (!binding) {
          this.#cuaRun = null;
          run.fail(new HermesBridgeError(
            "INVALID_CUA_BINDING",
            "Hermes returned an incomplete or expired CUA proposal; leaving it blocked.",
            { retryable: false },
          ));
          return;
        }
        run.actionId = actionId;
        run.binding = binding;
      } else if (run.actionId !== actionId) {
        return;
      }
      const eventType = type === EV.CUA_PROPOSAL
        ? BRIDGE_EVENT.CUA_PROPOSAL
        : type === EV.CUA_START
          ? BRIDGE_EVENT.CUA_START
          : BRIDGE_EVENT.CUA_COMPLETE;
      if (type === EV.CUA_COMPLETE) {
        for (const [requestId, correlatedActionId] of this.#cuaApprovalActionIds) {
          if (correlatedActionId === actionId) {
            this.#cuaApprovalActionIds.delete(requestId);
            this.#pendingApprovals.delete(requestId);
          }
        }
      }
      run.emit({ type: eventType, payload });
      return;
    }
    if (type === EV.TOOL_START || type === EV.TOOL_PROGRESS || type === EV.TOOL_COMPLETE)
      return this.#onToolEvent(type, payload);

    const turn = this.#turn;
    if (!turn) return;

    switch (type) {
      case EV.START:
        return;
      case EV.DELTA: {
        const text = payloadText(payload);
        if (!text) return;
        turn.push(text);
        turn.emit({ type: BRIDGE_EVENT.DELTA, text });
        return;
      }
      case EV.INTERIM: {
        // Interim text that was already streamed would double up.
        if (payload?.already_streamed) return;
        const text = payloadText(payload);
        if (!text) return;
        turn.push(text);
        turn.emit({ type: BRIDGE_EVENT.DELTA, text });
        return;
      }
      case EV.COMPLETE: {
        const status = payload?.status;
        const finalText = payloadText(payload);
        this.#turn = null;
        if (status && status !== "complete" && status !== "ok") {
          // A failed turn is reported as a failure. It is never replaced
          // with a plausible-looking substitute reply.
          turn.fail(
            new HermesBridgeError("REQUEST_FAILED", finalText || `The turn ended with status "${status}".`, {
              retryable: true,
              state: HERMES_STATE.REQUEST_FAILED,
            }),
          );
          return;
        }
        turn.finish(finalText);
        return;
      }
      default:
        return;
    }
  }

  /** Emit to the running turn if there is one, else to the open stream observer. */
  #broadcast(event) {
    if (this.#turn) this.#turn.emit(event);
    else if (this.#observer) this.#observer(event);
  }

  /**
   * A real Hermes permission request. Hermes stays the enforcement owner —
   * nothing here decides anything. Yuzuki only sanitizes, records, and
   * shows it, then relays exactly one human decision back.
   */
  #correlateApprovalTool(data) {
    const claimed = new Set(this.#approvalToolIds.values());
    const candidates = [...this.#activeTools].filter(([toolId]) => !claimed.has(toolId));
    if (candidates.length === 1) return candidates[0][0];

    // Concurrent file/terminal tools can all be active before the first gate
    // paints its approval. Match the redacted target text to stable, harmless
    // target arguments (path/command); a non-unique match stays
    // uncorrelated and a later deny fails closed.
    const haystack = `${typeof data.command === "string" ? data.command : ""}\n${
      typeof data.description === "string" ? data.description : ""
    }`
      .replaceAll("\\", "/")
      .toLowerCase();
    const matches = candidates.filter(([, tool]) => {
      const strings = ["path", "file_path", "target", "target_path", "command"]
        .map((key) => tool.args?.[key])
        .filter((value) => typeof value === "string");
      return strings.some((value) => {
        const normalized = value.replaceAll("\\", "/").toLowerCase();
        const basename = normalized.split("/").pop();
        return (normalized.length >= 3 && haystack.includes(normalized)) ||
          (basename && basename.length >= 3 && haystack.includes(basename));
      });
    });
    return matches.length === 1 ? matches[0][0] : null;
  }

  #onApprovalRequest(payload) {
    const data = payload || {};
    const requestId = typeof data.request_id === "string" ? data.request_id : null;
    if (!requestId) return; // Unaddressable: cannot be answered, so never shown.
    const isCua = data.approval_kind === "cua_fixture";
    const actionId = typeof data.action_id === "string" ? data.action_id : null;
    if (isCua && (!actionId || !this.#cuaRun || this.#cuaRun.actionId !== actionId)) return;
    if (isCua) {
      const approvalBinding = cuaBindingFrom(data);
      const choicesAreExact = Array.isArray(data.choices) && data.choices.length === 2 &&
        data.choices[0] === APPROVAL_CHOICE.ONCE && data.choices[1] === APPROVAL_CHOICE.DENY;
      const approvalIsOnceOnly = data.allow_session === false && data.allow_permanent === false;
      if (!sameCuaBinding(this.#cuaRun.binding, approvalBinding) || !choicesAreExact || !approvalIsOnceOnly) {
        const run = this.#cuaRun;
        this.#cuaRun = null;
        run.fail(new HermesBridgeError(
          "INVALID_CUA_BINDING",
          "Hermes approval did not match the exact CUA proposal; leaving it blocked.",
          { retryable: false },
        ));
        return;
      }
    }

    const pending = {
      request_id: requestId,
      session_id: this.#sessionId,
      // Hermes redacts these before emitting; the allow-list keeps any
      // future field it adds from reaching the renderer unreviewed.
      command: typeof data.command === "string" ? data.command : "",
      description: typeof data.description === "string" ? data.description : "",
      pattern_key: typeof data.pattern_key === "string" ? data.pattern_key : "",
      smart_denied: Boolean(data.smart_denied),
      received_at: new Date().toISOString(),
      // Recorded so a decision can be rejected if the runtime moved on.
      // Hermes has no per-request revision id, so the session identity plus
      // the request id IS the binding identity available here.
      revision: `${this.#sessionId || ""}:${requestId}`,
      state: ACTIVITY_STATE.AWAITING_APPROVAL,
    };
    if (isCua) {
      for (const field of APPROVAL_FIELDS.slice(5)) {
        if (data[field] !== undefined) pending[field] = data[field];
      }
    }
    this.#pendingApprovals.set(requestId, pending);
    // Hermes emits tool.start before the running tool reaches its internal
    // permission gate. Keep this correlation private so no new payload field
    // crosses the renderer boundary.
    const toolId = isCua ? null : this.#correlateApprovalTool(data);
    if (toolId) this.#approvalToolIds.set(requestId, toolId);
    if (isCua) this.#cuaApprovalActionIds.set(requestId, actionId);
    const emit = isCua ? this.#cuaRun.emit : (event) => this.#broadcast(event);
    emit({ type: BRIDGE_EVENT.APPROVAL, approval: pending });
    emit({
      type: BRIDGE_EVENT.ACTIVITY,
      activity: {
        state: ACTIVITY_STATE.AWAITING_APPROVAL,
        request_id: requestId,
        title: "Permission requested",
        detail: pending.command || pending.description,
      },
    });
  }

  /**
   * Real tool lifecycle. Nothing is synthesized: EXECUTING is emitted only
   * on an actual tool.start, and the terminal state comes from Hermes's own
   * completion payload.
   *
   * One correction is applied, and it is a truthfulness fix rather than a
   * synthesized state. When a human DENIES the permission a tool was
   * blocked on, Hermes still completes that tool normally: the refusal is
   * returned as the tool's ordinary result string, so `tool.complete`
   * carries no `error` and `success` is not false. Reporting that as
   * SUCCEEDED would tell the user a write happened that provably did not
   * (verified end-to-end: the target file stays absent). A denial observed
   * during this tool's run therefore reports DENIED, matching what actually
   * occurred. The denial is keyed to Hermes's stable `tool_id` and consumed
   * only by that tool's completion, so interleaved unrelated tools keep their
   * own real outcome.
   */
  #onToolEvent(type, payload) {
    const data = payload || {};
    const name = typeof data.tool === "string" ? data.tool : typeof data.name === "string" ? data.name : "tool";
    // Production Hermes lifecycle payloads carry tool_id. The name fallback
    // preserves deterministic handling of older injected/test events.
    const toolId =
      typeof data.tool_id === "string" && data.tool_id ? data.tool_id : `legacy:${name}`;
    let state = ACTIVITY_STATE.EXECUTING;
    if (type === EV.TOOL_START) {
      this.#activeTools.delete(toolId);
      this.#activeTools.set(toolId, { name, args: data.args && typeof data.args === "object" ? data.args : {} });
    }
    if (type === EV.TOOL_COMPLETE) {
      const failed = data.error !== undefined && data.error !== null && data.error !== "";
      if (failed || data.success === false) state = ACTIVITY_STATE.FAILED;
      else if (this.#deniedToolIds.has(toolId)) state = ACTIVITY_STATE.DENIED;
      else state = ACTIVITY_STATE.SUCCEEDED;
      this.#activeTools.delete(toolId);
      this.#deniedToolIds.delete(toolId);
      for (const [requestId, correlatedToolId] of this.#approvalToolIds) {
        if (correlatedToolId === toolId) this.#approvalToolIds.delete(requestId);
      }
    }
    const finished = type === EV.TOOL_COMPLETE;
    this.#broadcast({
      type: BRIDGE_EVENT.ACTIVITY,
      activity: {
        state,
        tool: name,
        title: finished
          ? state === ACTIVITY_STATE.DENIED
            ? `Tool ${name} denied`
            : `Tool ${name} finished`
          : `Tool ${name} running`,
        detail: typeof data.summary === "string" ? data.summary : "",
      },
    });
  }

  /** Sanitized snapshot of everything awaiting a human decision. */
  pendingApprovals() {
    return [...this.#pendingApprovals.values()];
  }

  /**
   * Relay exactly ONE human decision for ONE pending request.
   *
   * - Only "once" and "deny" are representable; "session"/"always" are
   *   rejected outright rather than forwarded, so no permanent or
   *   session-wide grant can leave Yuzuki.
   * - The decision must name a request that is still pending. A stale or
   *   unknown request_id is refused, so an approval cannot be replayed onto
   *   a different operation.
   */
  async respondApproval(requestId, choice) {
    if (choice !== APPROVAL_CHOICE.ONCE && choice !== APPROVAL_CHOICE.DENY) {
      throw new HermesBridgeError(
        "INVALID_CHOICE",
        `Only "${APPROVAL_CHOICE.ONCE}" or "${APPROVAL_CHOICE.DENY}" may be sent; refusing to relay "${choice}".`,
        { retryable: false },
      );
    }
    const pending = this.#pendingApprovals.get(requestId);
    if (!pending) {
      throw new HermesBridgeError("STALE_APPROVAL", "That approval request is no longer pending.", {
        retryable: false,
      });
    }
    const toolId = this.#approvalToolIds.get(requestId);
    const cuaActionId = this.#cuaApprovalActionIds.get(requestId);
    const isCua = pending.approval_kind === "cua_fixture";
    if (isCua && (!cuaActionId || !this.#cuaRun || this.#cuaRun.actionId !== cuaActionId)) {
      throw new HermesBridgeError(
        "ACTIVITY_EVENT_CORRELATION",
        "Cannot correlate this decision to the exact active CUA action; leaving it blocked.",
        { retryable: false },
      );
    }
    if (!isCua && choice === APPROVAL_CHOICE.DENY && !toolId) {
      throw new HermesBridgeError(
        "ACTIVITY_EVENT_CORRELATION",
        "Cannot correlate this denial to one running Hermes tool; leaving the action blocked.",
        { retryable: false },
      );
    }
    this.#pendingApprovals.delete(requestId);
    const state = choice === APPROVAL_CHOICE.ONCE ? ACTIVITY_STATE.APPROVED : ACTIVITY_STATE.DENIED;
    this.#approvalToolIds.delete(requestId);
    this.#cuaApprovalActionIds.delete(requestId);
    // Arm before awaiting the RPC acknowledgement: Hermes may release the
    // blocked worker and emit tool.complete before the acknowledgement frame
    // reaches this client. Roll back if the decision itself is rejected.
    if (state === ACTIVITY_STATE.DENIED && toolId) this.#deniedToolIds.add(toolId);
    try {
      await this.#rpc("approval.respond", {
        session_id: this.#runtimeSessionId,
        request_id: requestId,
        choice,
        // Never resolve more than the one request the human answered.
        all: false,
      });
    } catch (err) {
      if (toolId) this.#deniedToolIds.delete(toolId);
      throw err;
    }
    const emit = isCua ? this.#cuaRun.emit : (event) => this.#broadcast(event);
    emit({
      type: BRIDGE_EVENT.ACTIVITY,
      activity: { state, request_id: requestId, title: `Permission ${state.toLowerCase()}`, detail: pending.command },
    });
    return { request_id: requestId, choice, state };
  }

  /** Hermes-owned session listing for the sidebar. */
  async listSessions({ limit = 50 } = {}) {
    const result = await this.#rpc("session.list", { limit });
    const rows = Array.isArray(result?.sessions) ? result.sessions : [];
    return rows.map((row) => ({
      id: row.id,
      title: row.title || "",
      preview: row.preview || "",
      started_at: row.started_at || 0,
      message_count: row.message_count || 0,
      source: row.source || "",
    }));
  }

  /** Deterministic full-text search in Hermes's launch-profile SessionDB. */
  async searchSessions({ query, limit = 20 }) {
    const result = await this.#rpc("session.search", { query, limit });
    const rows = Array.isArray(result?.results) ? result.results : [];
    return {
      query: typeof result?.query === "string" ? result.query : query,
      results: rows.map((row) => ({
        sessionId: row.session_id,
        title: row.title || "Untitled conversation",
        timestamp: Number(row.timestamp) || 0,
        snippet: typeof row.snippet === "string" ? row.snippet : "",
      })),
    };
  }

  /**
   * Resume a Hermes-owned session and adopt it as the active one. Hermes
   * returns the transcript; Yuzuki renders it and stores none of it.
   */
  async resumeSession(sessionId) {
    const result = await this.#rpc("session.resume", { session_id: sessionId });
    const info = (result && result.info) || {};
    this.#adoptSessionIdentity(result, { expectedCanonical: sessionId });
    this.#provider = info.provider ?? this.#provider;
    this.#model = info.model ?? this.#model;
    this.#routing = info.routing ? safeRoutingProvenance(info.routing) : this.#routing;
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return {
      session_id: this.#sessionId,
      messages: messages.map((m) => ({ role: m.role, text: typeof m.text === "string" ? m.text : m.content || "" })),
      hermes: this.describe(),
    };
  }

  /**
   * Open a NEW canonical Hermes conversation and adopt it as the active
   * one. Yuzuki's "New conversation" must reach this: Hermes mints and
   * owns the id here exactly as it does at connect, so a fresh
   * conversation on screen always corresponds to a fresh canonical
   * session.
   *
   * Without it, "New conversation" was a client-only reset — the bridge
   * kept the previous `#sessionId`, so the next turn was appended to the
   * PREVIOUS canonical SessionDB row.
   *
   * On failure the previous session id is restored: a new conversation
   * Hermes did not open must leave the existing conversation intact
   * rather than strand the shell with no canonical session.
   */
  async newSession({ routingMode, requestedModelId } = {}) {
    // Busy is checked FIRST: an in-flight turn also moves the state out of
    // READY, and "a turn is running" is a precise, retryable answer the
    // caller can act on, where "the runtime is not ready" would be
    // misleading about a runtime that is in fact healthy.
    if (this.#turn || this.#cuaRun) {
      throw new HermesBridgeError(
        "REQUEST_RUNNING",
        "A chat turn or CUA action is already active in this session.",
        { retryable: true },
      );
    }
    if (this.#state !== HERMES_STATE.READY && this.#state !== HERMES_STATE.REQUEST_FAILED) {
      throw new HermesBridgeError(
        "HERMES_UNAVAILABLE",
        `The local Hermes runtime is not ready (${this.#state}).`,
        { retryable: true, state: this.#state },
      );
    }
    const previousSessionId = this.#sessionId;
    const previousRuntimeSessionId = this.#runtimeSessionId;
    const previousRouting = this.#routing;
    try {
      const intent = routingMode === undefined && requestedModelId === undefined
        ? this.routingIntent : normalizedRoutingIntent(routingMode, requestedModelId);
      await this.#createSession(intent);
    } catch (err) {
      this.#sessionId = previousSessionId;
      this.#runtimeSessionId = previousRuntimeSessionId;
      this.#routing = previousRouting;
      throw err;
    }
    return {
      session_id: this.#sessionId,
      previous_session_id: previousSessionId,
      hermes: this.describe(),
    };
  }

  /** Read-only, profile-scoped projection of Hermes-approved ADVANCED choices. */
  async routingOptions() {
    const params = this.profile ? { profile: this.profile } : {};
    return safeRoutingOptions(await this.#rpc("routing.options", params));
  }

  /** Set the stream observer used for out-of-turn approval/tool events. */
  setObserver(fn) {
    this.#observer = fn;
  }

  /** Run one Hermes-owned fixture request with a dedicated event channel. */
  runCuaFixture(request, { onEvent = () => {} } = {}) {
    if (this.#state !== HERMES_STATE.READY && this.#state !== HERMES_STATE.REQUEST_FAILED) {
      return Promise.reject(new HermesBridgeError(
        "HERMES_UNAVAILABLE",
        `The local Hermes runtime is not ready (${this.#state}).`,
        { retryable: true, state: this.#state },
      ));
    }
    if (this.#turn || this.#cuaRun) {
      return Promise.reject(new HermesBridgeError(
        "REQUEST_RUNNING",
        "A chat turn or CUA action is already active in this session.",
        { retryable: true },
      ));
    }
    const operation = request?.operation;
    const method = operation === "OBSERVE" ? "cua.fixture.observe" : "cua.fixture.run";
    const params = { session_id: this.#runtimeSessionId };
    if (method === "cua.fixture.run") {
      for (const field of ["fixture_id", "operation", "target", "input", "expected"]) {
        if (request[field] !== undefined) params[field] = request[field];
      }
    }
    return new Promise((resolve, reject) => {
      const run = { actionId: null, binding: null, emit: onEvent, fail: reject };
      this.#cuaRun = run;
      this.#rpc(method, params).then((result) => {
        if (this.#cuaRun === run) this.#cuaRun = null;
        resolve(result);
      }).catch((err) => {
        if (this.#cuaRun === run) this.#cuaRun = null;
        reject(err);
      });
    });
  }

  #rpc(method, params = {}) {
    if (!this.#ws) {
      return Promise.reject(
        new HermesBridgeError("HERMES_UNAVAILABLE", "Not connected to the local Hermes runtime.", {
          retryable: true,
          state: HERMES_STATE.UNAVAILABLE,
        }),
      );
    }
    const id = this.#nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(JSON.stringify(frame));
      } catch (err) {
        this.#pending.delete(id);
        reject(
          new HermesBridgeError("HERMES_UNAVAILABLE", `Could not send to the Hermes gateway: ${err.message}`, {
            retryable: true,
            state: HERMES_STATE.UNAVAILABLE,
          }),
        );
      }
    });
  }

  /**
   * Create the Hermes-owned session. Hermes mints and owns the id; Yuzuki
   * only remembers it. Nothing about this conversation is written to
   * Yuzuki's legacy sessions.db (contract §6 — one canonical owner).
   */
  async #createSession(intent = this.routingIntent) {
    const params = {};
    if (this.profile) params.profile = this.profile;
    if (intent) {
      params.routing_mode = intent.mode;
      if (intent.modelId) params.requested_model_id = intent.modelId;
    }
    const result = await this.#rpc("session.create", params);
    // session.create returns runtime provenance nested under `info` (verified
    // against tui_gateway/methods_session.py). `provider` is only present when
    // the session carries an explicit model override, so it is read
    // best-effort and never fabricated when absent — readiness gates on the
    // model, which is always reported.
    const info = (result && result.info) || {};
    this.#adoptSessionIdentity(result);
    this.#provider = info.provider ?? result?.provider ?? this.#provider;
    this.#model = info.model ?? result?.model ?? this.#model;
    this.#routing = safeRoutingProvenance(info.routing);
    this.routingIntent = intent;
    if (info.profile_name) this.profile = info.profile_name;
    if (!this.#model) {
      // Connected, but the profile has no usable model: an honest
      // distinct state, not a generic failure and not a silent cloud swap.
      this.#setState(HERMES_STATE.MODEL_NOT_READY, "The Hermes profile did not report a model.");
      return;
    }
    this.#setState(HERMES_STATE.READY, "Connected to the local Hermes runtime.");
  }

  /**
   * Submit one user turn. `onEvent` receives typed Yuzuki events; the
   * promise resolves with the full reply text, or rejects with a
   * HermesBridgeError. There is no fallback path on failure.
   */
  async submitPrompt(text, { routingMode, requestedModelId, onEvent = () => {} } = {}) {
    if (this.#state !== HERMES_STATE.READY && this.#state !== HERMES_STATE.REQUEST_FAILED) {
      return Promise.reject(
        new HermesBridgeError("HERMES_UNAVAILABLE", `The local Hermes runtime is not ready (${this.#state}).`, {
          retryable: true,
          state: this.#state,
        }),
      );
    }
    if (this.#turn || this.#cuaRun) {
      return Promise.reject(
        new HermesBridgeError("REQUEST_RUNNING", "A chat turn or CUA action is already active in this session.", {
          retryable: true,
        }),
      );
    }

    if (routingMode !== undefined || requestedModelId !== undefined) {
      const intent = normalizedRoutingIntent(routingMode, requestedModelId);
      if (!sameRoutingIntent(intent, this.routingIntent)) {
        await this.newSession({ routingMode: intent.mode, requestedModelId: intent.modelId });
      }
    }

    this.#setState(HERMES_STATE.REQUEST_RUNNING, "Waiting for the local model.");
    onEvent({ type: BRIDGE_EVENT.STATE, state: this.describe() });

    return new Promise((resolve, reject) => {
      const chunks = [];
      const turn = {
        emit: onEvent,
        push: (chunk) => chunks.push(chunk),
        finish: (finalText) => {
          // Prefer streamed deltas; fall back to the terminal frame's own
          // text for a non-streaming backend.
          const reply = chunks.length > 0 ? chunks.join("") : finalText;
          this.#setState(HERMES_STATE.READY, "Connected to the local Hermes runtime.");
          onEvent({ type: BRIDGE_EVENT.COMPLETE, text: reply, state: this.describe() });
          resolve(reply);
        },
        fail: (err) => {
          this.#setState(
            err.state === HERMES_STATE.UNAVAILABLE ? HERMES_STATE.UNAVAILABLE : HERMES_STATE.REQUEST_FAILED,
            err.message,
          );
          onEvent({ type: BRIDGE_EVENT.ERROR, code: err.code, message: err.message, state: this.describe() });
          reject(err);
        },
      };
      this.#turn = turn;

      this.#rpc("prompt.submit", { session_id: this.#runtimeSessionId, text }).catch((err) => {
        if (this.#turn === turn) {
          this.#turn = null;
          turn.fail(err);
        }
      });
    });
  }

  /**
   * Cooperative cancellation via Hermes's own `session.interrupt`. Per
   * contract §4.3 this stops the turn; it never claims to have killed
   * background processes.
   */
  async cancel() {
    if (!this.#runtimeSessionId || !this.#turn) return false;
    await this.#rpc("session.interrupt", { session_id: this.#runtimeSessionId });
    return true;
  }

  /** Stop the runtime and drop the credential. */
  async stop({ keepState = false } = {}) {
    this.#closed = true;
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* already closing */
      }
      this.#ws = null;
    }
    if (this.#child) {
      // The spawned process is only Hermes's launcher: it re-execs into a
      // pinned interpreter, so the runtime that actually holds the port and
      // the CUA driver is a GRANDCHILD. Killing `#child` alone leaves that
      // grandchild running — observed directly on Windows, where a parent's
      // death never cascades. Tear down the whole tree instead.
      try {
        this.killTreeImpl(this.#child.pid);
      } catch {
        /* best effort */
      }
      try {
        this.#child.kill();
      } catch {
        /* already gone */
      }
      this.#child = null;
    }
    this.#pending.clear();
    this.#pendingApprovals.clear();
    this.#activeTools.clear();
    this.#approvalToolIds.clear();
    this.#deniedToolIds.clear();
    this.#cuaApprovalActionIds.clear();
    this.#observer = null;
    this.#turn = null;
    this.#cuaRun = null;
    this.#sessionId = null;
    this.#runtimeSessionId = null;
    this.#token = null;
    this.#port = null;
    if (!keepState) this.#setState(HERMES_STATE.UNAVAILABLE, "Stopped.");
  }
}
