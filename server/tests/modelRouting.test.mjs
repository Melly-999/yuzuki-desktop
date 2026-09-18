import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_EXECUTION_PURPOSE,
  ModelRouteError,
  inspectModelRouteConfiguration,
  routeModelReply,
} from "../lib/modelRouting.mjs";
import { CHAT_MODE, MODEL_ROUTE_STATUS } from "../lib/productTruth.mjs";

const purpose = MODEL_EXECUTION_PURPOSE.SYNTHETIC_BENCHMARK;
const jsonResponse = (payload, { status = 200 } = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("provider execution is fail-closed without the synthetic benchmark purpose", async () => {
  let calls = 0;
  const result = await routeModelReply("arbitrary text", {
    env: {
      HERMES_MODEL_ROUTE: "openrouter",
      HERMES_MODEL_NAME: "example/model",
      HERMES_MODEL_API_KEY: "test-only-secret",
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, { kind: "not_configured" });
  assert.equal(calls, 0);
});

test("missing or invalid configuration is NOT_CONFIGURED and makes no call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not run");
  };
  for (const env of [
    {},
    { HERMES_MODEL_ROUTE: "unknown", HERMES_MODEL_NAME: "model" },
    { HERMES_MODEL_ROUTE: "openrouter", HERMES_MODEL_NAME: "model" },
    { HERMES_MODEL_ROUTE: "custom", HERMES_MODEL_NAME: "model", HERMES_MODEL_BASE_URL: "bad" },
    {
      HERMES_MODEL_ROUTE: "custom",
      HERMES_MODEL_NAME: "model",
      HERMES_MODEL_BASE_URL: "http://private.example/v1",
      HERMES_MODEL_API_KEY: "private-key",
    },
    {
      HERMES_MODEL_ROUTE: "custom",
      HERMES_MODEL_NAME: "model",
      HERMES_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      HERMES_MODEL_TIMEOUT_MS: "0",
    },
  ]) {
    assert.deepEqual(await routeModelReply("synthetic", { purpose, env, fetchImpl }), {
      kind: "not_configured",
    });
  }
  assert.equal(calls, 0);
});

test("OpenRouter uses the hosted route and normalizes provenance and cost", async () => {
  let request;
  const result = await routeModelReply("synthetic prompt", {
    purpose,
    env: {
      HERMES_MODEL_ROUTE: "openrouter",
      HERMES_MODEL_NAME: "example/model",
      HERMES_MODEL_API_KEY: "test-only-secret",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        model: "example/model",
        choices: [{ message: { content: "synthetic reply" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.00001 },
      });
    },
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-only-secret");
  assert.equal(request.options.headers["X-OpenRouter-Metadata"], "enabled");
  assert.deepEqual(JSON.parse(request.options.body), {
    model: "example/model",
    messages: [{ role: "user", content: "synthetic prompt" }],
    max_tokens: 512,
    stream: false,
  });
  assert.equal(result.mode, CHAT_MODE.HOSTED);
  assert.equal(result.routeStatus, MODEL_ROUTE_STATUS.HOSTED_NATIVE_OPENROUTER);
  assert.equal(result.servedModel, "example/model");
  assert.equal(result.usage.cost_usd, 0.00001);
  assert.equal(JSON.stringify(result).includes("test-only-secret"), false);
});

test("custom route shares the adapter and supports unauthenticated loopback", async () => {
  let request;
  const result = await routeModelReply("synthetic prompt", {
    purpose,
    env: {
      HERMES_MODEL_ROUTE: "custom",
      HERMES_MODEL_NAME: "local-model",
      HERMES_MODEL_BASE_URL: "http://127.0.0.1:11434/v1/",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        model: "local-model",
        choices: [{ message: { content: "local reply" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  });

  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal("Authorization" in request.options.headers, false);
  assert.equal(result.mode, CHAT_MODE.LOCAL_DEV);
  assert.equal(result.routeStatus, MODEL_ROUTE_STATUS.HOSTED_NATIVE_CUSTOM_ENDPOINT);
  assert.equal(result.usage.cost_usd, null);
});

test("provider errors are normalized without parsing the upstream body", async () => {
  const vendorBody = "vendor=https://private.example org=secret key-fragment=abc123";
  await assert.rejects(
    routeModelReply("synthetic", {
      purpose,
      env: {
        HERMES_MODEL_ROUTE: "openrouter",
        HERMES_MODEL_NAME: "example/model",
        HERMES_MODEL_API_KEY: "test-only-secret",
      },
      fetchImpl: async () => new Response(vendorBody, { status: 503 }),
    }),
    (error) => {
      assert.ok(error instanceof ModelRouteError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(vendorBody), false);
      assert.equal(error.message.includes("test-only-secret"), false);
      return true;
    },
  );
});

test("missing provenance is a normalized provider failure", async () => {
  await assert.rejects(
    routeModelReply("synthetic", {
      purpose,
      env: {
        HERMES_MODEL_ROUTE: "openrouter",
        HERMES_MODEL_NAME: "example/model",
        HERMES_MODEL_API_KEY: "test-only-secret",
      },
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "reply" } }] }),
    }),
    (error) => error instanceof ModelRouteError && error.code === "PROVIDER_UNAVAILABLE",
  );
});

test("model substitution and missing OpenRouter cost fail closed", async () => {
  const env = {
    HERMES_MODEL_ROUTE: "openrouter",
    HERMES_MODEL_NAME: "requested/model",
    HERMES_MODEL_API_KEY: "test-only-secret",
  };
  for (const payload of [
    {
      model: "substituted/model",
      choices: [{ message: { content: "reply" } }],
      usage: { cost: 0.00001 },
    },
    {
      model: "requested/model",
      choices: [{ message: { content: "reply" } }],
      usage: { total_tokens: 4 },
    },
  ]) {
    await assert.rejects(
      routeModelReply("synthetic", {
        purpose,
        env,
        fetchImpl: async () => jsonResponse(payload),
      }),
      (error) => error instanceof ModelRouteError,
    );
  }
});

test("parent cancellation aborts the upstream request", async () => {
  const controller = new AbortController();
  const pending = routeModelReply("synthetic", {
    purpose,
    env: {
      HERMES_MODEL_ROUTE: "openrouter",
      HERMES_MODEL_NAME: "example/model",
      HERMES_MODEL_API_KEY: "test-only-secret",
    },
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  controller.abort(new Error("client disconnected"));
  await assert.rejects(pending, (error) => error instanceof ModelRouteError);
});

test("configuration inspection never returns the secret", () => {
  const state = inspectModelRouteConfiguration({
    env: {
      HERMES_MODEL_ROUTE: "openrouter",
      HERMES_MODEL_NAME: "example/model",
      HERMES_MODEL_API_KEY: "test-only-secret",
    },
  });
  assert.equal(state.configured, true);
  assert.equal(state.route, "openrouter");
  assert.equal(JSON.stringify(state).includes("test-only-secret"), false);
});
