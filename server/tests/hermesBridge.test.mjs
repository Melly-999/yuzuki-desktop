import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { HermesBridge, HERMES_STATE, BRIDGE_EVENT, HermesBridgeError, ROUTING_MODE } from "../lib/hermesBridge.mjs";
import { resolveHermesRuntime, DEFAULT_PROFILE } from "../lib/hermesRuntime.mjs";
import { createHermesChatRoutes } from "../routes/hermesChat.mjs";

/**
 * Focused tests for the native Hermes bridge
 * (YUZUKI-LOCAL-HERMES-CHAT-SPRINT-001). Everything external is faked, so
 * these never start a real runtime, open a real socket, or call a model —
 * the genuine end-to-end proof is recorded separately in the task record.
 */

const READY_LINE = "HERMES_BACKEND_READY port=44444\n";

/** Minimal stand-in for a spawned Hermes child process. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

/**
 * Minimal stand-in for a WebSocket. Records the URL it was opened with
 * (so the credential-boundary tests can inspect it), captures sent
 * frames, and lets a test push frames back.
 */
class FakeWebSocket {
  static last = null;

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.last = this;
    // Never emit synchronously: the bridge assigns its handlers after the
    // constructor returns, exactly as a real WebSocket behaves.
    queueMicrotask(() => this.emitReady());
  }

  emitReady() {
    this.deliver({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
  }

  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Frames the bridge sent, parsed. */
  requests() {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  lastRequest() {
    const all = this.requests();
    return all[all.length - 1];
  }

  send(raw) {
    this.sent.push(raw);
    const frame = JSON.parse(raw);
    // Auto-answer session.create so tests can reach a READY bridge in one
    // step; every other method is left for the test to drive explicitly.
    if (frame.method === "session.create") {
      // `createError` lets a test drive a REFUSED session.create, which is
      // how the "failed New conversation" path is exercised.
      if (this.createError) {
        queueMicrotask(() => this.deliver({ jsonrpc: "2.0", id: frame.id, error: this.createError }));
        return;
      }
      queueMicrotask(() =>
        this.deliver({
          jsonrpc: "2.0",
          id: frame.id,
          // Mirrors the real session.create shape: provenance nested
          // under `info` (tui_gateway/methods_session.py).
          result: {
            session_id: this.sessionId ?? "hermes-session-1",
            stored_session_id: this.storedSessionId ?? this.sessionId ?? "hermes-session-1",
            info: {
              profile_name: "yuzuki-local",
              provider: this.provider ?? "custom",
              model: this.model === null ? undefined : (this.model ?? "qwen3.5:9b"),
              ...(this.routing ? { routing: this.routing } : {}),
            },
          },
        }),
      );
    }
    if (frame.method === "routing.options") {
      queueMicrotask(() =>
        this.deliver({
          jsonrpc: "2.0",
          id: frame.id,
          result: this.routingOptions ?? {
            status: "READY",
            models: [{
              id: "approved-model", displayName: "Approved model", provider: "openrouter",
              locality: "cloud", selectable: true, status: "READY", lifecycle: "active",
              capabilities: ["chat", "tools"], budgetClass: "low",
            }],
          },
        }),
      );
    }
  }

  close() {
    this.closed = true;
  }
}

/** Build a started bridge wired to fakes. */
async function startedBridge(overrides = {}) {
  const child = fakeChild();
  class Sock extends FakeWebSocket {
    constructor(url) {
      super(url);
      Object.assign(this, overrides.socketFields || {});
    }
  }
  const bridge = new HermesBridge({
    profile: "yuzuki-local",
    command: "python",
    args: ["-m", "hermes_cli.main"],
    cwd: ".",
    spawnImpl: () => child,
    webSocketImpl: Sock,
    env: {},
    readyTimeoutMs: 1000,
    tokenFactory: () => "TEST-SECRET-TOKEN",
    ...overrides.bridge,
  });
  const started = bridge.start();
  queueMicrotask(() => child.stdout.emit("data", READY_LINE));
  await started;
  return { bridge, child };
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

test("a started bridge reports HERMES_READY with the local profile, provider and model", async () => {
  const { bridge } = await startedBridge();
  const state = bridge.describe();
  assert.equal(state.state, HERMES_STATE.READY);
  assert.equal(state.profile, "yuzuki-local");
  assert.equal(state.provider, "custom");
  assert.equal(state.model, "qwen3.5:9b");
  assert.equal(state.connected, true);
  await bridge.stop();
});

test("HERMES_UNAVAILABLE when the runtime never announces a port", async () => {
  const child = fakeChild();
  const bridge = new HermesBridge({
    command: "python",
    args: [],
    spawnImpl: () => child,
    webSocketImpl: FakeWebSocket,
    readyTimeoutMs: 20,
    tokenFactory: () => "t",
  });
  await assert.rejects(() => bridge.start(), (err) => {
    assert.ok(err instanceof HermesBridgeError);
    assert.equal(err.code, "HERMES_UNAVAILABLE");
    return true;
  });
  assert.equal(bridge.describe().state, HERMES_STATE.UNAVAILABLE);
});

test("HERMES_UNAVAILABLE when the runtime exits during startup", async () => {
  const child = fakeChild();
  const bridge = new HermesBridge({
    command: "python",
    args: [],
    spawnImpl: () => child,
    webSocketImpl: FakeWebSocket,
    readyTimeoutMs: 500,
    tokenFactory: () => "t",
  });
  const started = bridge.start();
  queueMicrotask(() => child.emit("exit", 1));
  await assert.rejects(started, /exited during startup/);
  assert.equal(bridge.describe().state, HERMES_STATE.UNAVAILABLE);
});

test("MODEL_NOT_READY is distinct from a generic failure when the profile reports no model", async () => {
  const { bridge } = await startedBridge({ socketFields: { model: null } });
  assert.equal(bridge.describe().state, HERMES_STATE.MODEL_NOT_READY);
  // And a turn cannot be submitted in that state.
  await assert.rejects(() => bridge.submitPrompt("hi"), /not ready/);
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Request correlation
// ---------------------------------------------------------------------------

test("responses are correlated by JSON-RPC id, not by arrival order", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;

  // A cancel with no running turn issues no RPC at all.
  const first = bridge.cancel();
  assert.equal(await first, false, "no running turn -> no RPC issued");

  // Correlation is exercised directly: submit a turn, then answer the
  // prompt.submit id out of band and confirm the turn is unaffected.
  const events = [];
  const turn = bridge.submitPrompt("hello", { onEvent: (e) => events.push(e) });
  const submit = sock.requests().find((r) => r.method === "prompt.submit");
  assert.ok(submit, "prompt.submit was sent");

  // A response carrying an UNKNOWN id must be ignored, not mistaken for
  // this turn's answer.
  sock.deliver({ jsonrpc: "2.0", id: 99999, result: { ignored: true } });
  sock.deliver({ jsonrpc: "2.0", id: submit.id, result: { ok: true } });
  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.complete", session_id: "hermes-session-1", payload: { text: "done" } },
  });

  assert.equal(await turn, "done");
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Stream / event translation
// ---------------------------------------------------------------------------

test("message.delta frames are translated into ordered typed delta events", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  const events = [];
  const turn = bridge.submitPrompt("hi", { onEvent: (e) => events.push(e) });

  for (const text of ["YUZUKI_", "LOCAL_", "HERMES_OK"]) {
    sock.deliver({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "hermes-session-1", payload: { text } },
    });
  }
  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.complete", session_id: "hermes-session-1", payload: { text: "ignored-when-streamed" } },
  });

  assert.equal(await turn, "YUZUKI_LOCAL_HERMES_OK");
  const deltas = events.filter((e) => e.type === BRIDGE_EVENT.DELTA).map((e) => e.text);
  assert.deepEqual(deltas, ["YUZUKI_", "LOCAL_", "HERMES_OK"]);
  assert.equal(events.at(-1).type, BRIDGE_EVENT.COMPLETE);
  await bridge.stop();
});

test("events for a different session never leak into the running turn", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  const turn = bridge.submitPrompt("hi");

  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.delta", session_id: "SOME-OTHER-SESSION", payload: { text: "leaked" } },
  });
  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.complete", session_id: "hermes-session-1", payload: { text: "mine" } },
  });

  assert.equal(await turn, "mine");
  await bridge.stop();
});

test("a turn that completes with a non-complete status fails instead of returning substitute text", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  const turn = bridge.submitPrompt("hi");
  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "message.complete",
      session_id: "hermes-session-1",
      payload: { text: "Error: the model failed", status: "error" },
    },
  });
  await assert.rejects(turn, (err) => {
    assert.equal(err.code, "REQUEST_FAILED");
    return true;
  });
  assert.equal(bridge.describe().state, HERMES_STATE.REQUEST_FAILED);
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("cancel issues session.interrupt for the running turn", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  bridge.submitPrompt("hi").catch(() => {});
  const cancelling = bridge.cancel();
  const interrupt = sock.requests().find((r) => r.method === "session.interrupt");
  assert.ok(interrupt, "session.interrupt was sent");
  assert.equal(interrupt.params.session_id, "hermes-session-1");
  sock.deliver({ jsonrpc: "2.0", id: interrupt.id, result: { ok: true } });
  assert.equal(await cancelling, true);
  await bridge.stop();
});

test("cancel with no running turn issues no RPC", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  const before = sock.requests().length;
  assert.equal(await bridge.cancel(), false);
  assert.equal(sock.requests().length, before);
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

test("a disconnect fails the running turn rather than silently completing it", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;
  const turn = bridge.submitPrompt("hi");
  sock.onclose?.();
  await assert.rejects(turn, (err) => {
    assert.equal(err.code, "HERMES_UNAVAILABLE");
    return true;
  });
  assert.equal(bridge.describe().state, HERMES_STATE.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// Secret boundary
// ---------------------------------------------------------------------------

test("the session token reaches the child through env only, never argv", async () => {
  let seen = null;
  const child = fakeChild();
  const bridge = new HermesBridge({
    command: "python",
    args: ["-m", "hermes_cli.main", "--profile", "yuzuki-local", "serve"],
    spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return child;
    },
    webSocketImpl: FakeWebSocket,
    readyTimeoutMs: 1000,
    tokenFactory: () => "TEST-SECRET-TOKEN",
  });
  const started = bridge.start();
  queueMicrotask(() => child.stdout.emit("data", READY_LINE));
  await started;

  assert.equal(seen.opts.env.HERMES_DASHBOARD_SESSION_TOKEN, "TEST-SECRET-TOKEN");
  assert.ok(
    !seen.args.some((a) => String(a).includes("TEST-SECRET-TOKEN")),
    "the token must never appear in argv (process listings are world-readable)",
  );
  await bridge.stop();
});

test("describe() and JSON serialization expose no token and no credentialed URL", async () => {
  const { bridge } = await startedBridge();
  const sock = FakeWebSocket.last;

  // The socket really was opened with the credential...
  assert.match(sock.url, /token=TEST-SECRET-TOKEN/);

  // ...but nothing the routes can reach exposes it.
  const serialized = JSON.stringify(bridge);
  const described = JSON.stringify(bridge.describe());
  for (const blob of [serialized, described]) {
    assert.ok(!blob.includes("TEST-SECRET-TOKEN"), "token must not be serializable");
    assert.ok(!blob.includes("token="), "credentialed URL must not be serializable");
    assert.ok(!blob.includes("ws://"), "socket URL must not be serializable");
  }

  assert.deepEqual(
    Object.keys(bridge.describe()).sort(),
    // pending_approvals is a COUNT, deliberately never the payloads.
    ["connected", "detail", "model", "pending_approvals", "profile", "provider", "routing", "session_id", "state"],
    "describe() must stay an allow-list",
  );
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Session ownership
// ---------------------------------------------------------------------------

test("Hermes mints the session id; Yuzuki never invents one", async () => {
  const { bridge } = await startedBridge({ socketFields: { sessionId: "hermes-owned-42" } });
  assert.equal(bridge.describe().session_id, "hermes-owned-42");
  const sock = FakeWebSocket.last;
  const create = sock.requests().find((r) => r.method === "session.create");
  assert.ok(create, "session.create was issued");
  assert.equal(create.params.profile, "yuzuki-local");
  assert.equal(create.params.session_id, undefined, "Yuzuki must not supply a session id");
  await bridge.stop();
});

test("routing intent crosses only the session-create contract and provenance remains secret-free", async () => {
  const routing = {
    requested_mode: "SMART", requested_model_id: null,
    served_provider: "openrouter", served_model: "vendor/smart", locality: "cloud",
    fallback_occurred: false, fallback_reason: null, routing_status: "READY",
  };
  const { bridge } = await startedBridge({
    bridge: { routingMode: ROUTING_MODE.SMART },
    socketFields: { provider: "openrouter", model: "vendor/smart", routing: {
      ...routing, api_key: "MUST-NOT-CROSS", credential_path: "MUST-NOT-CROSS",
    } },
  });
  const create = FakeWebSocket.last.requests().find((r) => r.method === "session.create");
  assert.equal(create.params.routing_mode, "SMART");
  assert.equal(create.params.requested_model_id, undefined);
  assert.deepEqual(bridge.describe().routing, routing);
  assert.ok(!JSON.stringify(bridge.describe()).toLowerCase().includes("api_key"));
  assert.ok(!JSON.stringify(bridge.describe()).includes("MUST-NOT-CROSS"));
  await bridge.stop();
});

test("ADVANCED requires and forwards one explicit model without provider credentials", async () => {
  const { bridge } = await startedBridge();
  await bridge.newSession({ routingMode: "ADVANCED", requestedModelId: "approved-model" });
  const creates = FakeWebSocket.last.requests().filter((r) => r.method === "session.create");
  assert.deepEqual(creates.at(-1).params, {
    profile: "yuzuki-local", routing_mode: "ADVANCED", requested_model_id: "approved-model",
  });
  await assert.rejects(
    () => bridge.newSession({ routingMode: "ADVANCED" }),
    (err) => err.code === "MODEL_NOT_SELECTED",
  );
  await bridge.stop();
});

test("routing options come only from the profile-scoped routing.options RPC and stay secret-free", async () => {
  const { bridge } = await startedBridge({
    socketFields: {
      routingOptions: {
        status: "READY",
        models: [{
          id: "approved-model", displayName: "Approved model", provider: "openrouter", locality: "cloud",
          selectable: true, status: "READY", lifecycle: "active", capabilities: ["chat"], budgetClass: "low",
          api_key: "MUST-NOT-CROSS", credential_path: "MUST-NOT-CROSS", env_var: "MUST-NOT-CROSS",
        }],
      },
    },
  });
  const result = await bridge.routingOptions();
  const request = FakeWebSocket.last.requests().find((item) => item.method === "routing.options");
  assert.deepEqual(request.params, { profile: "yuzuki-local" });
  assert.equal(FakeWebSocket.last.requests().some((item) => item.method === "model.options"), false);
  assert.deepEqual(Object.keys(result.models[0]).sort(), [
    "budgetClass", "capabilities", "displayName", "id", "lifecycle", "locality",
    "provider", "selectable", "status",
  ]);
  assert.ok(!JSON.stringify(result).includes("MUST-NOT-CROSS"));
  await bridge.stop();
});

test("chat route intent creates one validated routed session only when the intent changes", async () => {
  const { bridge } = await startedBridge({ bridge: { routingMode: ROUTING_MODE.PRIVATE } });
  const sock = FakeWebSocket.last;

  const first = bridge.submitPrompt("private", { routingMode: "PRIVATE" });
  assert.equal(sock.requests().filter((item) => item.method === "session.create").length, 1);
  sock.deliver({
    jsonrpc: "2.0", method: "event",
    params: { type: "message.complete", session_id: "hermes-session-1", payload: { text: "done" } },
  });
  await first;

  const second = bridge.submitPrompt("smart", { routingMode: "SMART", requestedModelId: "must-not-cross" });
  await new Promise((resolve) => setImmediate(resolve));
  const creates = sock.requests().filter((item) => item.method === "session.create");
  assert.equal(creates.length, 2);
  assert.equal(creates.at(-1).params.routing_mode, "SMART");
  assert.equal(creates.at(-1).params.requested_model_id, undefined);
  sock.deliver({
    jsonrpc: "2.0", method: "event",
    params: { type: "message.complete", session_id: "hermes-session-1", payload: { text: "done" } },
  });
  await second;
  await bridge.stop();
});

test("new sessions expose Hermes's canonical stored id while transport uses its runtime handle", async () => {
  const { bridge } = await startedBridge({
    socketFields: { sessionId: "runtime-create-42", storedSessionId: "20260907_120000_create42" },
  });
  const sock = FakeWebSocket.last;

  assert.equal(bridge.describe().session_id, "20260907_120000_create42");
  const turn = bridge.submitPrompt("hello");
  const submit = sock.requests().find((r) => r.method === "prompt.submit");
  assert.equal(submit.params.session_id, "runtime-create-42");
  sock.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.complete", session_id: "runtime-create-42", payload: { text: "done" } },
  });
  assert.equal(await turn, "done");
  assert.equal(bridge.describe().session_id, "20260907_120000_create42");
  await bridge.stop();
});

test("New conversation opens a NEW canonical Hermes session and adopts it", async () => {
  // The V1 blocker: "New conversation" was a client-only reset, so the
  // bridge kept the previous session id and the next turn was appended to
  // the PREVIOUS canonical conversation.
  const { bridge } = await startedBridge({ socketFields: { sessionId: "hermes-old-1" } });
  assert.equal(bridge.describe().session_id, "hermes-old-1");

  const sock = FakeWebSocket.last;
  sock.sessionId = "hermes-new-2";
  const result = await bridge.newSession();

  assert.equal(result.previous_session_id, "hermes-old-1");
  assert.equal(result.session_id, "hermes-new-2");
  assert.notEqual(result.session_id, result.previous_session_id, "a new conversation must not reuse the old id");
  assert.equal(bridge.describe().session_id, "hermes-new-2", "the bridge must adopt the new session");

  const creates = sock.requests().filter((r) => r.method === "session.create");
  assert.equal(creates.length, 2, "a second session.create was issued");
  assert.equal(creates[1].params.session_id, undefined, "Yuzuki must not supply a session id");
  await bridge.stop();
});

test("a failed New conversation keeps the previous canonical session intact", async () => {
  // Product truth: a fresh conversation may only appear once Hermes has
  // actually opened one. A failure must not strand the shell with no
  // session, and must not silently discard the current conversation.
  const { bridge } = await startedBridge({ socketFields: { sessionId: "hermes-old-1" } });
  const sock = FakeWebSocket.last;
  sock.createError = { code: -32000, message: "session.create refused" };

  await assert.rejects(() => bridge.newSession(), /session\.create refused/);
  assert.equal(bridge.describe().session_id, "hermes-old-1", "the previous session id must survive the failure");
  await bridge.stop();
});

test("New conversation is refused while a turn is still running", async () => {
  const { bridge } = await startedBridge({ socketFields: { sessionId: "hermes-old-1" } });
  const turn = bridge.submitPrompt("hello", { onEvent: () => {} });
  await assert.rejects(() => bridge.newSession(), (err) => err.code === "REQUEST_RUNNING");
  assert.equal(bridge.describe().session_id, "hermes-old-1");
  turn.catch(() => {});
  await bridge.stop();
});

test("the bridge writes nothing to Yuzuki's legacy session store", async () => {
  // Structural guarantee: the bridge module must not import the legacy
  // sessionStore at all, so it cannot mirror a Hermes conversation into
  // %LOCALAPPDATA%\Yuzuki\sessions.db.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/hermesBridge.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("sessionStore"), "hermesBridge must not import the legacy session store");
  assert.ok(!source.includes("appendMessage"), "hermesBridge must not persist messages itself");
});

// ---------------------------------------------------------------------------
// No USER_CHAT fallback
// ---------------------------------------------------------------------------

test("an unavailable runtime returns 503 and never the USER_CHAT prototype reply", async () => {
  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => ({ ok: false, reason: "No local Hermes runtime installed.", profile: "yuzuki-local" }),
  });

  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
    },
    setHeader() {},
  };
  // A real Readable, so readJsonBody's own stream handling is exercised
  // rather than a hand-rolled event order that could differ from Node's.
  const { Readable } = await import("node:stream");
  const req = Readable.from([Buffer.from(JSON.stringify({ message: "hi" }))]);
  req.headers = {};

  await routes.handleChat(req, res);
  const body = chunks.join("");
  assert.equal(res.statusCode, 503);
  assert.match(body, /HERMES_UNAVAILABLE/);
  assert.ok(!/prototype response/i.test(body), "must never fall back to the USER_CHAT canned reply");
  assert.ok(!/PROTOTYPE/.test(body), "must not report the prototype chat mode");
});

test("the Hermes route module never imports the legacy chat route or its canned reply", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../routes/hermesChat.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("routes/chat.mjs"), "no import of the USER_CHAT route");
  assert.ok(!source.includes("CANNED_REPLY"), "no access to the prototype reply");
  assert.ok(!source.includes("routeModelReply"), "no access to the legacy provider router");
});

// ---------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------

test("the runtime is resolved as an isolated, loopback, profile-scoped backend", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/agent" },
    platform: "linux",
    exists: () => true,
    validateProfile: () => ({ ok: true, model: "example-model", provider: "example-local-provider" }),
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.profile, DEFAULT_PROFILE);
  assert.equal(DEFAULT_PROFILE, "yuzuki-local", "the compiled fallback must be a generic, non-personal name");
  const args = resolved.args.join(" ");
  assert.match(args, /--profile yuzuki-local/);
  assert.match(args, /--host 127\.0\.0\.1/);
  assert.match(args, /--isolated/);
  assert.match(args, /--port 0/);
});

test("a missing runtime resolves to an honest failure, not a guess", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/nope" },
    platform: "linux",
    exists: () => false,
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /not found/);
});
