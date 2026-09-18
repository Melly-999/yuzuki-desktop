import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { HermesBridge } from "../lib/hermesBridge.mjs";
import { createHermesChatRoutes } from "../routes/hermesChat.mjs";

const READY_LINE = "HERMES_BACKEND_READY port=45455\n";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

class SearchSocket {
  static last = null;

  constructor() {
    this.sent = [];
    SearchSocket.last = this;
    queueMicrotask(() => this.deliver({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
  }

  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.method === "session.create") {
      queueMicrotask(() => this.deliver({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          session_id: "runtime-bootstrap",
          stored_session_id: "20260907_000000_bootstrap",
          info: { model: "qwen3.5:4b" },
        },
      }));
    }
    if (frame.method === "session.search") {
      queueMicrotask(() => this.deliver({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          query: frame.params.query,
          results: [{
            session_id: "20260906_225220_f0ec17",
            title: "Polish notes",
            timestamp: 42,
            snippet: "zażółć gęślą",
          }],
        },
      }));
    }
    if (frame.method === "session.resume") {
      queueMicrotask(() => this.deliver({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          session_id: "3b378faf",
          resumed: frame.params.session_id,
          session_key: frame.params.session_id,
          messages: [
            { role: "user", text: "historical question" },
            { role: "assistant", text: "historical answer" },
          ],
          info: { model: "qwen3.5:4b", provider: "custom" },
        },
      }));
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
    webSocketImpl: SearchSocket,
    env: {},
    readyTimeoutMs: 1000,
    tokenFactory: () => "TEST-TOKEN",
  });
  const started = bridge.start();
  queueMicrotask(() => child.stdout.emit("data", READY_LINE));
  await started;
  return bridge;
}

function fakeReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  return req;
}

function fakeRes() {
  const chunks = [];
  return {
    statusCode: null,
    writeHead(code) { this.statusCode = code; },
    write(chunk) { chunks.push(chunk); },
    end(chunk = "") { if (chunk) chunks.push(chunk); },
    setHeader() {},
    body() { return chunks.join(""); },
  };
}

test("bridge translates profile-bound session.search results without adding client authority", async () => {
  const bridge = await startedBridge();
  const result = await bridge.searchSessions({ query: "zażółć", limit: 20 });
  const request = SearchSocket.last.sent.find((frame) => frame.method === "session.search");

  assert.deepEqual(request.params, { query: "zażółć", limit: 20 });
  assert.deepEqual(result, {
    query: "zażółć",
    results: [{
      sessionId: "20260906_225220_f0ec17",
      title: "Polish notes",
      timestamp: 42,
      snippet: "zażółć gęślą",
    }],
  });
  assert.equal(JSON.stringify(result).includes("state.db"), false);
  await bridge.stop();
});

test("search -> resume preserves the canonical API id and keeps the runtime handle internal", async () => {
  const canonical = "20260906_225220_f0ec17";
  const bridge = await startedBridge();
  const search = await bridge.searchSessions({ query: "zażółć", limit: 20 });
  assert.equal(search.results[0].sessionId, canonical);

  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local", command: "python", args: [], cwd: "." }),
    bridgeFactory: () => bridge,
  });
  const response = fakeRes();
  await routes.handleResume(fakeReq({ session_id: search.results[0].sessionId }), response);
  const body = JSON.parse(response.body());

  assert.equal(response.statusCode, 200);
  assert.equal(body.session_id, canonical);
  assert.equal(body.hermes.session_id, canonical);
  assert.deepEqual(body.messages, [
    { role: "user", text: "historical question" },
    { role: "assistant", text: "historical answer" },
  ]);
  assert.equal(JSON.stringify(body).includes("3b378faf"), false, "the runtime handle must not cross the API boundary");

  const turn = bridge.submitPrompt("continue the same conversation");
  const submit = SearchSocket.last.sent.find((frame) => frame.method === "prompt.submit");
  assert.equal(submit.params.session_id, "3b378faf", "gateway RPCs must use Hermes's runtime handle");
  SearchSocket.last.deliver({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.complete", session_id: "3b378faf", payload: { text: "continued" } },
  });
  assert.equal(await turn, "continued");
  assert.equal(bridge.describe().session_id, canonical, "the public identity must remain canonical after chat");
  await bridge.stop();
});

test("search route validates input, clamps limits, and never forwards profile or path selection", async () => {
  const calls = [];
  const bridge = {
    start: async () => {},
    describe: () => ({ connected: true }),
    searchSessions: async (input) => {
      calls.push(input);
      return { query: input.query, results: [] };
    },
  };
  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local", command: "python", args: [], cwd: "." }),
    bridgeFactory: () => bridge,
  });

  const valid = fakeRes();
  await routes.handleSearch(fakeReq({ query: "needle", limit: 999 }), valid);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(calls, [{ query: "needle", limit: 20 }]);

  for (const body of [
    { query: "needle", profile: "main" },
    { query: "needle", profile: "arbitrary" },
    { query: "needle", db_path: "../../main/state.db" },
    { query: "x" },
    { query: "bad\u0000query" },
  ]) {
    const rejected = fakeRes();
    await routes.handleSearch(fakeReq(body), rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body()).error, "INVALID_QUERY");
  }
  assert.equal(calls.length, 1);
});

test("search route reports an unavailable Hermes runtime without fabricating results", async () => {
  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => ({ ok: false, reason: "runtime missing" }),
  });
  const res = fakeRes();
  await routes.handleSearch(fakeReq({ query: "needle" }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body()).results, []);
});
