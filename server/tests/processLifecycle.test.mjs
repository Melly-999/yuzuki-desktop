import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { HermesBridge, killProcessTree } from "../lib/hermesBridge.mjs";
import { createHermesChatRoutes } from "../routes/hermesChat.mjs";

/**
 * Process-lifecycle regressions for YUZUKI-V1-INTEGRATION-HARDENING-001.
 *
 * The defect these pin down was reproduced live, not theorised: an API
 * server and the Hermes runtime it started were still running ~10 hours
 * after their parent had exited, with the API server still holding port
 * 8787 — which then fails the desktop shell's own pre-flight port check on
 * the next launch. Two independent causes, both covered here:
 *
 *   1. Nothing stopped the bridge on process shutdown at all.
 *   2. Even an explicit stop killed only the direct child, while Hermes
 *      re-execs into a pinned interpreter — so the real runtime is a
 *      grandchild and survived.
 */

const READY_LINE = "HERMES_BACKEND_READY port=44444\n";

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }),
      }),
    );
  }
  send(raw) {
    this.sent.push(raw);
    const frame = JSON.parse(raw);
    if (frame.method === "session.create") {
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              session_id: "hermes-session-1",
              stored_session_id: "hermes-session-1",
              info: { profile_name: "yuzuki-local", provider: "custom", model: "qwen3.5:9b" },
            },
          }),
        }),
      );
    }
  }
  close() {
    this.closed = true;
  }
}

async function startedBridge(extra = {}) {
  const child = fakeChild();
  const bridge = new HermesBridge({
    profile: "yuzuki-local",
    command: "python",
    args: ["-m", "hermes_cli.main"],
    cwd: ".",
    spawnImpl: () => child,
    webSocketImpl: FakeWebSocket,
    env: {},
    readyTimeoutMs: 1000,
    tokenFactory: () => "TEST-SECRET-TOKEN",
    ...extra,
  });
  const started = bridge.start();
  queueMicrotask(() => child.stdout.emit("data", READY_LINE));
  await started;
  return { bridge, child };
}

test("killProcessTree reaps the whole tree on Windows, not just the named pid", () => {
  const calls = [];
  const ok = killProcessTree(4242, {
    platform: "win32",
    spawnSyncImpl: (cmd, args) => {
      calls.push({ cmd, args });
      return {};
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ cmd: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
  // `/T` is the whole point: without it the re-exec'd Hermes runtime lives on.
  assert.ok(calls[0].args.includes("/T"));
});

test("killProcessTree treats an already-dead process as success, never a throw", () => {
  assert.equal(killProcessTree(0, { platform: "win32", spawnSyncImpl: () => ({}) }), false);
  assert.equal(
    killProcessTree(999999, { platform: "win32", spawnSyncImpl: () => ({ error: new Error("not found") }) }),
    false,
  );
});

test("stopping the bridge tears down the runtime tree, not only the spawned child", async () => {
  const killed = [];
  const { bridge, child } = await startedBridge({ killTreeImpl: (pid) => killed.push(pid) });

  await bridge.stop();

  assert.deepEqual(killed, [child.pid], "the tree kill must target the spawned child's pid");
  assert.equal(child.killed, true, "the direct child is still reaped as well");
  assert.equal(bridge.describe().connected, false);
});

test("routes expose a shutdown that stops a started runtime and is idempotent", async () => {
  const stops = [];
  const fakeBridge = {
    start: async () => {},
    describe: () => ({
      state: "HERMES_READY",
      detail: "",
      profile: "yuzuki-local",
      provider: null,
      model: null,
      session_id: null,
      connected: true,
    }),
    stop: async () => {
      stops.push(Date.now());
    },
  };

  const routes = createHermesChatRoutes({
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local", command: "python", args: [], cwd: "." }),
    bridgeFactory: () => fakeBridge,
  });

  // Nothing started yet: shutdown is a safe no-op, not a crash.
  assert.equal(await routes.shutdown(), false);
  assert.deepEqual(stops, []);

  await routes._internals.ensureBridge();
  assert.equal(await routes.shutdown(), true);
  assert.equal(stops.length, 1);

  // Idempotent — a second signal must not double-stop or throw.
  assert.equal(await routes.shutdown(), false);
  assert.equal(stops.length, 1);
});

test("a bridge that fails to stop cleanly still releases the runtime slot", async () => {
  const routes = createHermesChatRoutes({
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local", command: "python", args: [], cwd: "." }),
    bridgeFactory: () => ({
      start: async () => {},
      describe: () => ({
        state: "HERMES_READY",
        detail: "",
        profile: "yuzuki-local",
        provider: null,
        model: null,
        session_id: null,
        connected: true,
      }),
      stop: async () => {
        throw new Error("gateway already gone");
      },
    }),
  });

  await routes._internals.ensureBridge();
  // Shutdown must not reject: a failure here would abort the exit path and
  // leave exactly the orphan this change exists to prevent.
  await assert.doesNotReject(() => routes.shutdown());
  assert.equal(await routes.shutdown(), false);
});
