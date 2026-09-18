import test from "node:test";
import assert from "node:assert/strict";

import { createHermesChatRoutes } from "../routes/hermesChat.mjs";

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test("the local read-only route relays Hermes routing.options without consulting model.options", async () => {
  const calls = [];
  const bridge = {
    start: async () => {},
    describe: () => ({ connected: true }),
    routingOptions: async () => {
      calls.push("routing.options");
      return { status: "READY", models: [{ id: "approved", selectable: true }] };
    },
  };
  const routes = createHermesChatRoutes({
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local" }),
    bridgeFactory: () => bridge,
  });
  const res = responseCapture();
  await routes.handleRoutingOptions({}, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "READY", models: [{ id: "approved", selectable: true }] });
  assert.deepEqual(calls, ["routing.options"]);
});

test("an unavailable registry fails closed with no fallback model list", async () => {
  const routes = createHermesChatRoutes({
    resolveRuntime: () => ({ ok: true, profile: "yuzuki-local" }),
    bridgeFactory: () => ({
      start: async () => {},
      describe: () => ({ connected: true }),
      routingOptions: async () => { throw new Error("unavailable"); },
    }),
  });
  const res = responseCapture();
  await routes.handleRoutingOptions({}, res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, {
    status: "REGISTRY_UNAVAILABLE", models: [], message: "Model list unavailable.",
  });
});
