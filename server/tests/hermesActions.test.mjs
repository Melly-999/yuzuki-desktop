import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  HermesBridge,
  HERMES_STATE,
  BRIDGE_EVENT,
  ACTIVITY_STATE,
  APPROVAL_CHOICE,
} from "../lib/hermesBridge.mjs";
import { createHermesChatRoutes } from "../routes/hermesChat.mjs";

/**
 * Focused tests for the controlled-action surface
 * (YUZUKI-CONTROLLED-ACTIONS-SPRINT-001): Hermes session ownership, the
 * permission-event bridge, approve-once / deny, and activity translation.
 *
 * Everything external is faked. Hermes remains the enforcement owner in
 * production; these tests assert that Yuzuki relays decisions faithfully
 * and never manufactures authority of its own.
 */

const READY_LINE = "HERMES_BACKEND_READY port=45455\n";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

class FakeSocket {
  static last = null;
  static cuaApprovalOverrides = null;

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.pendingCua = null;
    FakeSocket.last = this;
    queueMicrotask(() =>
      this.deliver({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }),
    );
  }

  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Push a gateway event for the active session. */
  event(type, payload, sessionId = "sess-1") {
    this.deliver({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
  }

  requests() {
    return this.sent.map((r) => JSON.parse(r));
  }

  find(method) {
    return this.requests().find((r) => r.method === method);
  }

  send(raw) {
    this.sent.push(raw);
    const frame = JSON.parse(raw);
    if (frame.method === "session.create") {
      queueMicrotask(() =>
        this.deliver({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            session_id: "sess-1",
            stored_session_id: "sess-1",
            info: { model: "qwen3.5:9b", provider: "custom", profile_name: "yuzuki-local" },
          },
        }),
      );
    }
    if (frame.method === "session.list") {
      queueMicrotask(() =>
        this.deliver({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            sessions: [
              { id: "s-a", title: "Groceries", preview: "milk", started_at: 10, message_count: 4, source: "cli" },
              { id: "s-b", title: "Trip", preview: "flights", started_at: 20, message_count: 2, source: "cli" },
            ],
          },
        }),
      );
    }
    if (frame.method === "session.resume") {
      queueMicrotask(() =>
        this.deliver({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            session_id: frame.params.session_id,
            resumed: frame.params.session_id,
            session_key: frame.params.session_id,
            info: { model: "qwen3.5:9b", provider: "custom" },
            messages: [
              { role: "user", text: "hello" },
              { role: "assistant", text: "hi" },
            ],
          },
        }),
      );
    }
    if (frame.method === "approval.respond") {
      queueMicrotask(() => this.deliver({ jsonrpc: "2.0", id: frame.id, result: { resolved: true } }));
      if (this.pendingCua) {
        const pending = this.pendingCua;
        this.pendingCua = null;
        const receipt = {
          schema_version: 1,
          action_id: "cua-action-1",
          approval_request_id: "cua-approval-1",
          session_id: "sess-1",
          requested_operation: pending.params.operation,
          resolved_target: {
            semantic_target: pending.params.target,
            fixed_title: "Yuzuki CUA Fixture",
            fixture_id: pending.params.fixture_id,
            binding_digest: "digest",
          },
          timestamps: { started_monotonic: 1, ended_monotonic: 2, duration_ms: 1000 },
          start_state: { counter: 0, revision: 0, echo_length: 0, echo_sha256: "0".repeat(64) },
          end_state: { counter: frame.params.choice === "once" ? 1 : 0, revision: frame.params.choice === "once" ? 1 : 0, echo_length: 0, echo_sha256: "0".repeat(64) },
          result: frame.params.choice === "once" ? "SUCCEEDED" : "DENIED",
          verification: { outcome: frame.params.choice === "once" ? "VERIFIED" : "NOT_APPLICABLE", predicate: "counter + 1" },
          side_effect_summary: frame.params.choice === "once" ? "Counter incremented exactly once." : "No fixture mutation.",
          driver: { version: "0.23.2", permission_mode: "bounded", manifest_sha256: "a".repeat(64) },
          reason: frame.params.choice === "once" ? null : "APPROVAL_DENIED",
        };
        queueMicrotask(() => {
          if (frame.params.choice === "once") this.event("cua.action.start", { action_id: "cua-action-1" });
          this.event("cua.action.complete", receipt);
          this.deliver({ jsonrpc: "2.0", id: pending.id, result: receipt });
        });
      }
    }
    if (frame.method === "cua.fixture.run") {
      this.pendingCua = frame;
      queueMicrotask(() => {
        const startState = { counter: 0, revision: 0, echo_length: 0, echo_sha256: "0".repeat(64) };
        const expiresAt = Date.now() / 1000 + 30;
        this.event("cua.proposal", {
          action_id: "cua-action-1", operation: frame.params.operation, target: frame.params.target,
          fixture_id: frame.params.fixture_id, fixed_title: "Yuzuki CUA Fixture", binding_digest: "digest",
          start_state: startState, expires_at: expiresAt,
        });
        this.event("approval.request", approvalPayload({
          request_id: "cua-approval-1", approval_kind: "cua_fixture", action_id: "cua-action-1",
          operation: frame.params.operation, target: frame.params.target, fixture_id: frame.params.fixture_id,
          fixed_title: "Yuzuki CUA Fixture", binding_digest: "digest", start_state: startState,
          expires_at: expiresAt, choices: ["once", "deny"], allow_session: false, allow_permanent: false,
          ...(FakeSocket.cuaApprovalOverrides ?? {}),
        }));
      });
    }
  }

  close() {}
}

async function startedBridge() {
  const child = fakeChild();
  const bridge = new HermesBridge({
    profile: "yuzuki-local",
    command: "python",
    args: [],
    spawnImpl: () => child,
    webSocketImpl: FakeSocket,
    env: {},
    readyTimeoutMs: 1000,
    tokenFactory: () => "TEST-TOKEN",
  });
  const started = bridge.start();
  queueMicrotask(() => child.stdout.emit("data", READY_LINE));
  await started;
  return bridge;
}

/** A realistic Hermes approval payload (already redacted upstream). */
function approvalPayload(overrides = {}) {
  return {
    request_id: "req-abc",
    command: "<write to notes.txt>",
    description: "Write to protected agent-instruction file(s): notes.txt.",
    pattern_key: "protected_instruction_file",
    allow_permanent: false,
    allow_session: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A — Hermes session ownership
// ---------------------------------------------------------------------------

test("session.list is read from Hermes and mapped without inventing fields", async () => {
  const bridge = await startedBridge();
  const sessions = await bridge.listSessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(Object.keys(sessions[0]).sort(), [
    "id",
    "message_count",
    "preview",
    "source",
    "started_at",
    "title",
  ]);
  assert.equal(sessions[0].title, "Groceries");
  await bridge.stop();
});

test("resuming a Hermes session adopts its id and returns Hermes's own transcript", async () => {
  const bridge = await startedBridge();
  const resumed = await bridge.resumeSession("s-b");
  assert.equal(resumed.session_id, "s-b");
  assert.deepEqual(
    resumed.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  // Active session identity moved to the resumed session.
  assert.equal(bridge.describe().session_id, "s-b");
  await bridge.stop();
});

test("the bridge never writes Hermes conversations into Yuzuki's session store", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/hermesBridge.mjs", import.meta.url), "utf8");
  // Code references only — the module comment names sessions.db precisely
  // to document that it is NOT written, so a prose mention is expected.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["sessionStore", "appendMessage", "sessions.db"]) {
    assert.ok(!code.includes(forbidden), `hermesBridge must not reference ${forbidden} in code`);
  }
});

// ---------------------------------------------------------------------------
// B — Permission event bridge
// ---------------------------------------------------------------------------

test("a Hermes approval.request becomes a typed event with the required fields", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("approval.request", approvalPayload());

  const approval = seen.find((e) => e.type === BRIDGE_EVENT.APPROVAL)?.approval;
  assert.ok(approval, "an approval event was emitted");
  assert.equal(approval.request_id, "req-abc");
  assert.equal(approval.session_id, "sess-1");
  assert.equal(approval.pattern_key, "protected_instruction_file");
  assert.match(approval.command, /notes\.txt/);
  assert.ok(approval.received_at, "carries a timestamp");
  assert.ok(approval.revision, "carries a binding identity");
  assert.equal(approval.state, ACTIVITY_STATE.AWAITING_APPROVAL);
  await bridge.stop();
});

test("only allow-listed approval fields cross the boundary — extra payload keys are dropped", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event(
    "approval.request",
    approvalPayload({
      api_key: "sk-super-secret-value",
      env: { HERMES_DASHBOARD_SESSION_TOKEN: "TEST-TOKEN" },
      raw_command: "curl -H 'Authorization: Bearer abc123'",
    }),
  );

  const approval = seen.find((e) => e.type === BRIDGE_EVENT.APPROVAL).approval;
  const serialized = JSON.stringify(approval);
  assert.ok(!serialized.includes("sk-super-secret-value"), "an unknown secret-ish field must not be forwarded");
  assert.ok(!serialized.includes("TEST-TOKEN"), "the gateway token must never appear");
  assert.ok(!serialized.includes("Bearer abc123"), "unknown raw fields must not be forwarded");
  assert.equal(approval.api_key, undefined);
  assert.equal(approval.env, undefined);
  await bridge.stop();
});

test("an approval request with no request_id is unaddressable and is not shown", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("approval.request", approvalPayload({ request_id: undefined }));
  assert.equal(seen.filter((e) => e.type === BRIDGE_EVENT.APPROVAL).length, 0);
  assert.equal(bridge.pendingApprovals().length, 0);
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// C — Approve once / deny
// ---------------------------------------------------------------------------

test("approve once relays exactly choice=once for that request, and never resolve-all", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("approval.request", approvalPayload());
  const result = await bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE);

  const sent = FakeSocket.last.find("approval.respond");
  assert.ok(sent, "approval.respond was sent");
  assert.equal(sent.params.choice, "once");
  assert.equal(sent.params.request_id, "req-abc");
  assert.equal(sent.params.all, false, "must never resolve more than the answered request");
  assert.equal(result.state, ACTIVITY_STATE.APPROVED);
  assert.equal(bridge.pendingApprovals().length, 0);
  await bridge.stop();
});

test("deny relays choice=deny", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  const result = await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  assert.equal(FakeSocket.last.find("approval.respond").params.choice, "deny");
  assert.equal(result.state, ACTIVITY_STATE.DENIED);
  await bridge.stop();
});

test("session-wide and permanent grants are refused, not relayed", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("approval.request", approvalPayload());
  for (const forbidden of ["session", "always", "yolo", ""]) {
    await assert.rejects(
      () => bridge.respondApproval("req-abc", forbidden),
      (err) => {
        assert.equal(err.code, "INVALID_CHOICE");
        return true;
      },
      `choice "${forbidden}" must be refused`,
    );
  }
  // The request is still pending — a refused choice must not consume it.
  assert.equal(bridge.pendingApprovals().length, 1);
  assert.equal(FakeSocket.last.find("approval.respond"), undefined, "nothing was relayed to Hermes");
  await bridge.stop();
});

test("CUA proposal, once-only approval, start, and receipt remain correlated to one action", async () => {
  const bridge = await startedBridge();
  const seen = [];
  const running = bridge.runCuaFixture(
    { fixture_id: "fixture-1", operation: "CLICK_TARGET", target: "INCREMENT_BUTTON" },
    { onEvent: (event) => seen.push(event) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const approval = seen.find((event) => event.type === BRIDGE_EVENT.APPROVAL)?.approval;
  assert.equal(approval.approval_kind, "cua_fixture");
  assert.equal(approval.action_id, "cua-action-1");
  assert.deepEqual(approval.choices, ["once", "deny"]);
  assert.equal(approval.allow_session, false);
  assert.equal(approval.allow_permanent, false);

  await bridge.respondApproval(approval.request_id, APPROVAL_CHOICE.ONCE);
  const receipt = await running;
  assert.equal(receipt.result, "SUCCEEDED");
  assert.deepEqual(
    seen.filter((event) => [BRIDGE_EVENT.CUA_PROPOSAL, BRIDGE_EVENT.APPROVAL, BRIDGE_EVENT.CUA_START, BRIDGE_EVENT.CUA_COMPLETE].includes(event.type)).map((event) => event.type),
    [BRIDGE_EVENT.CUA_PROPOSAL, BRIDGE_EVENT.APPROVAL, BRIDGE_EVENT.CUA_START, BRIDGE_EVENT.CUA_COMPLETE],
  );
  assert.equal(FakeSocket.last.find("cua.fixture.run").params.session_id, "sess-1");
  await bridge.stop();
});

test("CUA events for another Hermes session and a concurrent action fail closed", async () => {
  const bridge = await startedBridge();
  const seen = [];
  const running = bridge.runCuaFixture(
    { fixture_id: "fixture-1", operation: "CLICK_TARGET", target: "INCREMENT_BUTTON" },
    { onEvent: (event) => seen.push(event) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  FakeSocket.last.event("cua.action.start", { action_id: "cua-action-1" }, "other-session");
  await assert.rejects(
    () => bridge.runCuaFixture({ fixture_id: "fixture-1", operation: "VERIFY_STATE", target: "STATE_SUMMARY" }),
    (err) => err.code === "REQUEST_RUNNING",
  );
  assert.equal(seen.filter((event) => event.type === BRIDGE_EVENT.CUA_START).length, 0);
  await bridge.respondApproval("cua-approval-1", APPROVAL_CHOICE.DENY);
  await running;
  await bridge.stop();
});

test("a CUA approval whose target binding drifts from the proposal is never actionable", async () => {
  FakeSocket.cuaApprovalOverrides = { target: "TEXT_INPUT" };
  const bridge = await startedBridge();
  try {
    await assert.rejects(
      bridge.runCuaFixture(
        { fixture_id: "fixture-1", operation: "CLICK_TARGET", target: "INCREMENT_BUTTON" },
      ),
      (err) => err.code === "INVALID_CUA_BINDING",
    );
    assert.equal(bridge.pendingApprovals().length, 0);
    assert.equal(FakeSocket.last.find("approval.respond"), undefined);
  } finally {
    FakeSocket.cuaApprovalOverrides = null;
    await bridge.stop();
  }
});

test("a receipt whose terminal state is unknown is relayed without inventing one", async () => {
  const bridge = await startedBridge();
  const seen = [];
  const running = bridge.runCuaFixture(
    { fixture_id: "fixture-1", operation: "CLICK_TARGET", target: "INCREMENT_BUTTON" },
    { onEvent: (event) => seen.push(event) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const call = FakeSocket.last.find("cua.fixture.run");
  // Hermes delivered the click, then could not confirm the result: end_state is
  // null and the outcome is UNKNOWN. Neither may be smoothed into a concrete state.
  const unknown = {
    schema_version: 1,
    action_id: "cua-action-1",
    approval_request_id: "cua-approval-1",
    session_id: "sess-1",
    requested_operation: "CLICK_TARGET",
    resolved_target: {
      semantic_target: "INCREMENT_BUTTON", fixed_title: "Yuzuki CUA Fixture",
      fixture_id: "fixture-1", binding_digest: "digest",
    },
    timestamps: { started_monotonic: 1, ended_monotonic: 2, duration_ms: 1000 },
    start_state: { counter: 0, revision: 0, echo_length: 0, echo_sha256: "0".repeat(64) },
    end_state: null,
    result: "FAILED",
    verification: { outcome: "UNKNOWN", predicate: "The bounded action must complete without internal error." },
    side_effect_summary: "Input was delivered to the bounded fixture; the resulting state could not be confirmed.",
    driver: { version: "0.23.2", permission_mode: "bounded", manifest_sha256: "a".repeat(64) },
    reason: "INTERNAL_FAILURE",
  };
  FakeSocket.last.event("cua.action.complete", unknown);
  FakeSocket.last.deliver({ jsonrpc: "2.0", id: call.id, result: unknown });

  const result = await running;
  assert.equal(result.end_state, null);
  assert.equal(result.verification.outcome, "UNKNOWN");
  const relayed = seen.find((event) => event.type === BRIDGE_EVENT.CUA_COMPLETE)?.payload;
  assert.equal(relayed.end_state, null, "the bridge must not substitute start_state");
  assert.notDeepEqual(relayed.end_state, relayed.start_state);
  await bridge.stop();
});

test("a decision for an unknown or already-answered request is rejected as stale", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE);

  // Replaying the same decision must not reach Hermes a second time.
  await assert.rejects(
    () => bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE),
    (err) => {
      assert.equal(err.code, "STALE_APPROVAL");
      return true;
    },
  );
  await assert.rejects(
    () => bridge.respondApproval("never-existed", APPROVAL_CHOICE.ONCE),
    (err) => {
      assert.equal(err.code, "STALE_APPROVAL");
      return true;
    },
  );
  assert.equal(FakeSocket.last.requests().filter((r) => r.method === "approval.respond").length, 1);
  await bridge.stop();
});

test("a disconnect invalidates pending approvals instead of leaving them decidable", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("approval.request", approvalPayload());
  assert.equal(bridge.pendingApprovals().length, 1);

  FakeSocket.last.onclose?.();

  assert.equal(bridge.pendingApprovals().length, 0, "nothing may remain answerable after a disconnect");
  const lost = seen.find(
    (e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.state === ACTIVITY_STATE.FAILED,
  );
  assert.ok(lost, "the lost request is reported, not silently dropped");
});

// ---------------------------------------------------------------------------
// D — Activity translation
// ---------------------------------------------------------------------------

test("tool lifecycle is translated, and EXECUTING is never synthesized from an approval", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE);

  const statesAfterApproval = seen
    .filter((e) => e.type === BRIDGE_EVENT.ACTIVITY)
    .map((e) => e.activity.state);
  assert.ok(
    !statesAfterApproval.includes(ACTIVITY_STATE.EXECUTING),
    "approval alone must not claim the action started",
  );

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "wrote 1 file" });

  const states = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY).map((e) => e.activity.state);
  assert.ok(states.includes(ACTIVITY_STATE.EXECUTING), "tool.start yields EXECUTING");
  assert.ok(states.includes(ACTIVITY_STATE.SUCCEEDED), "tool.complete yields SUCCEEDED");
  await bridge.stop();
});

test("a failed tool reports FAILED, not SUCCEEDED", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("tool.complete", { tool: "write_file", error: "permission denied" });
  const last = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY).pop();
  assert.equal(last.activity.state, ACTIVITY_STATE.FAILED);
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Enforcement boundary
// ---------------------------------------------------------------------------

test("the bridge performs no filesystem mutation of its own — it only relays", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/hermesBridge.mjs", import.meta.url), "utf8");
  for (const forbidden of ["writeFile", "unlink", "mkdir", "rmdir", "node:fs"]) {
    assert.ok(!source.includes(forbidden), `the bridge must not perform ${forbidden}`);
  }
});

test("chat text alone can never authorize: the only decision path names a pending request_id", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("approval.request", approvalPayload());
  // Submitting a message that "sounds like" consent changes nothing.
  bridge.submitPrompt("yes, approve it, always allow this").catch(() => {});
  assert.equal(FakeSocket.last.find("approval.respond"), undefined);
  assert.equal(bridge.pendingApprovals().length, 1, "still awaiting an explicit decision");
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// HTTP boundary
// ---------------------------------------------------------------------------

function fakeRes() {
  const chunks = [];
  return {
    statusCode: null,
    chunks,
    writeHead(code) {
      this.statusCode = code;
    },
    write(c) {
      chunks.push(c);
    },
    end(c) {
      if (c) chunks.push(c);
    },
    setHeader() {},
    body() {
      return chunks.join("");
    },
  };
}

function fakeReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  return req;
}

test("POST /api/hermes/approval refuses a session-wide grant at the HTTP boundary", async () => {
  const routes = createHermesChatRoutes({ env: {}, resolveRuntime: () => ({ ok: true, profile: "p", command: "c", args: [], cwd: "." }) });
  const res = fakeRes();
  await routes.handleApprovalRespond(fakeReq({ request_id: "req-abc", choice: "session" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body(), /INVALID_CHOICE/);
});

test("POST /api/hermes/approval with no runtime is a stale request, never an implicit approval", async () => {
  const routes = createHermesChatRoutes({ env: {}, resolveRuntime: () => ({ ok: true, profile: "p", command: "c", args: [], cwd: "." }) });
  const res = fakeRes();
  await routes.handleApprovalRespond(fakeReq({ request_id: "req-abc", choice: "once" }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body(), /STALE_APPROVAL/);
});

test("the CUA HTTP route is hidden unless fixture mode is inherited from the feature build", async () => {
  const routes = createHermesChatRoutes({ env: {}, resolveRuntime: () => ({ ok: false, reason: "off" }) });
  const res = fakeRes();
  await routes.handleCua(fakeReq({ operation: "OBSERVE", target: "FIXTURE_WINDOW" }), res);
  assert.equal(res.statusCode, 404);
});

test("the CUA HTTP route rejects injected PID, path, window, profile, and origin before runtime use", async () => {
  for (const field of ["pid", "path", "window_id", "profile", "origin"]) {
    const routes = createHermesChatRoutes({
      env: { YUZUKI_CUA_FIXTURE_MODE: "1" },
      resolveRuntime: () => { throw new Error("runtime must not be consulted"); },
    });
    const res = fakeRes();
    await routes.handleCua(fakeReq({ operation: "OBSERVE", target: "FIXTURE_WINDOW", [field]: "injected" }), res);
    assert.equal(res.statusCode, 400, `${field} is denied before bridge startup`);
  }
});

test("GET /api/hermes/sessions reports the gateway being unavailable rather than inventing a list", async () => {
  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => ({ ok: false, reason: "No local Hermes runtime installed.", profile: "p" }),
  });
  const res = fakeRes();
  await routes.handleSessions({}, res);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body());
  assert.deepEqual(body.sessions, []);
  assert.equal(body.error, "HERMES_UNAVAILABLE");
});

test("the status surface exposes a pending-approval COUNT and still no credential", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("approval.request", approvalPayload());
  const described = bridge.describe();
  assert.equal(described.pending_approvals, 1);
  const blob = JSON.stringify(described);
  assert.ok(!blob.includes("TEST-TOKEN"));
  assert.ok(!blob.includes("token="));
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// Denied-write product truth (YUZUKI-CONTROLLED-ACTIONS-SPRINT-001-R2)
//
// Observed against a real local Hermes during the R2 end-to-end run: when a
// human DENIES the permission a write was blocked on, Hermes completes the
// tool normally — the refusal comes back as the tool's ordinary result, so
// `tool.complete` carries no `error` and `success` is not false. The bridge
// used to map that to SUCCEEDED, which told the user a write had happened
// while the target file provably stayed absent.
// ---------------------------------------------------------------------------

test("a denied permission reports the blocked tool as DENIED, never SUCCEEDED", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  // Hermes starts the tool, then blocks it on the gate and asks.
  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  // Hermes completes the tool with NO error — the refusal is the result.
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "" });

  const states = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY).map((e) => e.activity.state);
  assert.ok(states.includes(ACTIVITY_STATE.DENIED), "the denial itself is reported");
  assert.ok(
    !states.includes(ACTIVITY_STATE.SUCCEEDED),
    "a denied write must never be reported as SUCCEEDED",
  );
  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.DENIED);
  assert.equal(terminal.activity.title, "Tool write_file denied");
  await bridge.stop();
});

test("a denial does not leak into a later unrelated tool run", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "" });

  // A brand-new tool run must start from a clean slate.
  FakeSocket.last.event("tool.start", { tool_id: "tool-read", tool: "read_file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-read", tool: "read_file", summary: "read 1 file" });

  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.tool, "read_file");
  assert.equal(terminal.activity.state, ACTIVITY_STATE.SUCCEEDED, "the next tool is judged on its own outcome");
  await bridge.stop();
});

test("approve-once still yields SUCCEEDED on a clean completion", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "wrote 1 file" });

  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.SUCCEEDED);
  assert.equal(terminal.activity.title, "Tool write_file finished");
  await bridge.stop();
});

test("a real tool error still reports FAILED even after an approval was granted", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.ONCE);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", error: "disk full" });

  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.FAILED);
  await bridge.stop();
});

test("an interleaved tool completion cannot consume another tool's denial", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  FakeSocket.last.event("tool.start", { tool_id: "tool-read", tool: "read_file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-read", tool: "read_file", summary: "read 1 file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "" });

  const terminals = seen.filter(
    (e) =>
      e.type === BRIDGE_EVENT.ACTIVITY &&
      e.activity.tool &&
      [ACTIVITY_STATE.SUCCEEDED, ACTIVITY_STATE.DENIED, ACTIVITY_STATE.FAILED].includes(e.activity.state),
  );
  assert.deepEqual(
    terminals.map((e) => [e.activity.tool, e.activity.state]),
    [
      ["read_file", ACTIVITY_STATE.SUCCEEDED],
      ["write_file", ACTIVITY_STATE.DENIED],
    ],
  );
  await bridge.stop();
});

test("concurrent active tools correlate a denial to the approval target", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", {
    tool_id: "tool-a",
    tool: "write_file",
    args: { path: "C:\\fixtures\\a.txt", content: "A" },
  });
  FakeSocket.last.event("tool.start", {
    tool_id: "tool-b",
    tool: "write_file",
    args: { path: "C:\\fixtures\\b.txt", content: "B" },
  });
  FakeSocket.last.event(
    "approval.request",
    approvalPayload({ command: "<write to C:\\fixtures\\a.txt>", description: "Write a.txt" }),
  );
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-b", tool: "write_file", summary: "wrote b.txt" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-a", tool: "write_file", summary: "" });

  const terminals = seen.filter(
    (e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool && e.activity.state !== ACTIVITY_STATE.EXECUTING,
  );
  assert.deepEqual(
    terminals.map((e) => e.activity.state),
    [ACTIVITY_STATE.SUCCEEDED, ACTIVITY_STATE.DENIED],
  );
  await bridge.stop();
});

test("an ambiguous denial fails closed without relaying a decision", async () => {
  const bridge = await startedBridge();
  FakeSocket.last.event("tool.start", { tool_id: "tool-a", tool: "write_file", args: { path: "a.txt" } });
  FakeSocket.last.event("tool.start", { tool_id: "tool-b", tool: "write_file", args: { path: "b.txt" } });
  FakeSocket.last.event("approval.request", approvalPayload({ command: "<write to a protected file>" }));

  await assert.rejects(
    () => bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY),
    (err) => err.code === "ACTIVITY_EVENT_CORRELATION",
  );
  assert.equal(FakeSocket.last.find("approval.respond"), undefined);
  assert.equal(bridge.pendingApprovals().length, 1);
  await bridge.stop();
});

test("denial is armed before approval acknowledgement and survives completion-before-ack", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());

  FakeSocket.last.send = function sendWithCompletionBeforeAck(raw) {
    this.sent.push(raw);
    const frame = JSON.parse(raw);
    assert.equal(frame.method, "approval.respond");
    this.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "" });
    queueMicrotask(() => this.deliver({ jsonrpc: "2.0", id: frame.id, result: { resolved: true } }));
  };
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);

  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.DENIED);
  await bridge.stop();
});

test("correlated denial state is removed after the tool completes", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("tool.start", { tool_id: "tool-reused", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-reused", tool: "write_file", summary: "" });

  FakeSocket.last.event("tool.start", { tool_id: "tool-reused", tool: "write_file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-reused", tool: "write_file", summary: "wrote later" });
  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.SUCCEEDED);
  await bridge.stop();
});

test("disconnect cleanup removes correlated denial state", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));
  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);

  FakeSocket.last.onclose?.();
  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", summary: "new session" });
  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.SUCCEEDED);
  await bridge.stop();
});

test("a genuine failure wins over denial for the same correlated tool", async () => {
  const bridge = await startedBridge();
  const seen = [];
  bridge.setObserver((e) => seen.push(e));

  FakeSocket.last.event("tool.start", { tool_id: "tool-write", tool: "write_file" });
  FakeSocket.last.event("approval.request", approvalPayload());
  await bridge.respondApproval("req-abc", APPROVAL_CHOICE.DENY);
  FakeSocket.last.event("tool.complete", { tool_id: "tool-write", tool: "write_file", error: "runtime failure" });

  const terminal = seen.filter((e) => e.type === BRIDGE_EVENT.ACTIVITY && e.activity.tool).pop();
  assert.equal(terminal.activity.state, ACTIVITY_STATE.FAILED);
  await bridge.stop();
});
