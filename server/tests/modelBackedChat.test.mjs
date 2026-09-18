import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import {
  MODEL_EXECUTION_PURPOSE,
  ModelRouteError,
  ROUTE_MODE,
  ROUTE_ROLE,
  inspectUserChatConfiguration,
  routeModelReply,
} from "../lib/modelRouting.mjs";
import {
  OPENAI_RESPONSES_ENDPOINT,
  ProviderAdapterError,
  parseOpenAiResponsesPayload,
} from "../lib/openAiCompatibleAdapter.mjs";
import { MODEL_ROUTE_STATUS } from "../lib/productTruth.mjs";
import { createChatHandler } from "../routes/chat.mjs";
import { createRouter, HOST } from "../router.mjs";

const purpose = MODEL_EXECUTION_PURPOSE.USER_CHAT;
const configuredEnv = Object.freeze({
  HERMES_MODEL_CHAT_ENABLED: "true",
  OPENAI_API_KEY: "test-only-secret",
});

const jsonResponse = (payload, { status = 200 } = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function completedPayload(model, output, usage) {
  return {
    object: "response",
    status: "completed",
    model,
    output,
    ...(usage === undefined ? {} : { usage }),
  };
}

function messageOutput(text) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

async function withChatServer(options, run) {
  const server = createServer(
    createRouter({
      chatHandler: createChatHandler(options),
    }),
  );
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const { port } = server.address();
  try {
    await run(`http://${HOST}:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("AUTO/BALANCED use Terra medium and DEEP uses Sol high without tools", async () => {
  const cases = [
    [ROUTE_MODE.AUTO, ROUTE_ROLE.BALANCED_CLOUD, "gpt-5.6-terra", "medium"],
    [ROUTE_MODE.BALANCED, ROUTE_ROLE.BALANCED_CLOUD, "gpt-5.6-terra", "medium"],
    [ROUTE_MODE.DEEP, ROUTE_ROLE.DEEP_CLOUD, "gpt-5.6-sol", "high"],
  ];

  for (const [routeMode, role, model, effort] of cases) {
    let request;
    const result = await routeModelReply("hello", {
      purpose,
      routeMode,
      env: configuredEnv,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse(
          completedPayload(model, [messageOutput("bounded reply")], {
            input_tokens: 2,
            output_tokens: 3,
            total_tokens: 5,
          }),
        );
      },
    });

    assert.equal(request.url, OPENAI_RESPONSES_ENDPOINT);
    assert.equal(request.options.headers.Authorization, "Bearer test-only-secret");
    assert.deepEqual(JSON.parse(request.options.body), {
      model,
      input: "hello",
      reasoning: { effort },
      max_output_tokens: 512,
      text: { format: { type: "text" } },
      store: false,
    });
    assert.equal(result.resolvedRole, role);
    assert.equal(result.reasoningEffort, effort);
    assert.equal(result.routeStatus, MODEL_ROUTE_STATUS.IMPLEMENTED_NOT_LIVE_VERIFIED);
    assert.deepEqual(result.fallback, { occurred: false, from: null, to: null, reason: null });
    assert.equal("tools" in JSON.parse(request.options.body), false);
    assert.equal(JSON.stringify(result).includes("test-only-secret"), false);
  }
});

test("the cloud activation gate is exact and disabled state makes no call", async () => {
  let calls = 0;
  for (const env of [
    {},
    { HERMES_MODEL_CHAT_ENABLED: "false", OPENAI_API_KEY: "test-only-secret" },
    { HERMES_MODEL_CHAT_ENABLED: "TRUE", OPENAI_API_KEY: "test-only-secret" },
  ]) {
    const result = await routeModelReply("hello", {
      purpose,
      routeMode: ROUTE_MODE.AUTO,
      env,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });
    assert.deepEqual(result, { kind: "not_configured" });
  }
  assert.equal(calls, 0);
});

test("enabled cloud chat without a credential fails closed and leaks nothing", async () => {
  let calls = 0;
  await assert.rejects(
    routeModelReply("hello", {
      purpose,
      env: { HERMES_MODEL_CHAT_ENABLED: "true" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    }),
    (error) => {
      assert.ok(error instanceof ModelRouteError);
      assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
      assert.equal(error.status, 503);
      assert.equal(JSON.stringify(error).includes("OPENAI_API_KEY"), false);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("LOCAL is explicitly unavailable and never falls back to cloud", async () => {
  let calls = 0;
  await assert.rejects(
    routeModelReply("hello", {
      purpose,
      routeMode: ROUTE_MODE.LOCAL,
      env: configuredEnv,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    }),
    (error) =>
      error instanceof ModelRouteError &&
      error.code === "LOCAL_MODEL_NOT_AVAILABLE" &&
      error.requiresNextRun === "HERMES-GPT-OSS-20B-LOCAL-FIT-BAKEOFF-001",
  );
  assert.equal(calls, 0);
});

test("an unknown internal route fails closed", async () => {
  await assert.rejects(
    routeModelReply("hello", { purpose, routeMode: "ARBITRARY", env: configuredEnv }),
    (error) => error instanceof ModelRouteError && error.code === "INVALID_ROUTE" && error.status === 400,
  );
});

test("raw parser walks documented nested text only and ignores SDK convenience output_text", () => {
  const parsed = parseOpenAiResponsesPayload(
    {
      ...completedPayload("gpt-5.6-terra", [
        { type: "reasoning", summary: [{ type: "summary_text", text: "private" }] },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "refusal", refusal: "ignored" },
            { type: "output_text", text: "hello", annotations: [] },
          ],
        },
        { type: "tool_call", name: "ignored" },
        messageOutput(" world"),
      ]),
      output_text: "SDK convenience must be ignored",
    },
    "gpt-5.6-terra",
  );

  assert.equal(parsed.reply, "hello world");
  assert.deepEqual(parsed.usage, {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_usd: null,
  });
});

test("raw parser normalizes documented usage and rejects malformed/non-completed payloads", () => {
  const parsed = parseOpenAiResponsesPayload(
    completedPayload("gpt-5.6-sol", [messageOutput("reply")], {
      input_tokens: 7,
      output_tokens: 11,
      total_tokens: 18,
      output_tokens_details: { reasoning_tokens: 4 },
    }),
    "gpt-5.6-sol",
  );
  assert.deepEqual(parsed.usage, {
    input_tokens: 7,
    output_tokens: 11,
    total_tokens: 18,
    cost_usd: null,
  });

  const malformed = [
    null,
    {},
    { object: "response", status: "completed", model: "gpt-5.6-sol" },
    completedPayload("gpt-5.6-sol", []),
    completedPayload("gpt-5.6-sol", [{ type: "reasoning" }]),
    completedPayload("gpt-5.6-sol", [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: " " }] },
    ]),
  ];
  for (const payload of malformed) {
    assert.throws(
      () => parseOpenAiResponsesPayload(payload, "gpt-5.6-sol"),
      (error) => error instanceof ProviderAdapterError && error.code === "MALFORMED_PROVIDER_RESPONSE",
    );
  }

  for (const status of ["failed", "incomplete", "in_progress", "queued"]) {
    assert.throws(
      () =>
        parseOpenAiResponsesPayload(
          { object: "response", status, model: "gpt-5.6-sol", output: [messageOutput("partial")] },
          "gpt-5.6-sol",
        ),
      (error) => error instanceof ProviderAdapterError && error.code === "PROVIDER_ERROR",
    );
  }
  assert.throws(
    () =>
      parseOpenAiResponsesPayload(
        { object: "response", status: "cancelled", model: "gpt-5.6-sol", output: [] },
        "gpt-5.6-sol",
      ),
    (error) => error instanceof ProviderAdapterError && error.code === "CANCELLED",
  );
});

test("unexpected served model is MODEL_NOT_AVAILABLE", () => {
  assert.throws(
    () =>
      parseOpenAiResponsesPayload(
        completedPayload("substituted-model", [messageOutput("reply")]),
        "gpt-5.6-terra",
      ),
    (error) => error instanceof ProviderAdapterError && error.code === "MODEL_NOT_AVAILABLE",
  );
});

test("provider auth errors remain safely normalized without body parsing", async () => {
  const sensitiveBody = "private-provider-body test-only-secret";
  await assert.rejects(
    routeModelReply("hello", {
      purpose,
      env: configuredEnv,
      fetchImpl: async () => new Response(sensitiveBody, { status: 401 }),
    }),
    (error) => {
      assert.ok(error instanceof ModelRouteError);
      assert.equal(error.code, "AUTH_FAILURE");
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes(sensitiveBody), false);
      assert.equal(error.message.includes("test-only-secret"), false);
      return true;
    },
  );
});

test("documented OpenAI 429 codes map to bounded retry metadata", async () => {
  const cases = [
    ["slow_down", "RATE_LIMITED", true],
    ["credit_balance_exhausted", "QUOTA_EXHAUSTED", false],
    ["organization_usage_limit_exceeded", "QUOTA_EXHAUSTED", false],
    ["organization_spend_limit_exceeded", "BILLING_NOT_AVAILABLE", false],
    ["project_spend_limit_exceeded", "BILLING_NOT_AVAILABLE", false],
  ];

  for (const [providerCode, publicCode, retryable] of cases) {
    await assert.rejects(
      routeModelReply("hello", {
        purpose,
        env: configuredEnv,
        fetchImpl: async () =>
          jsonResponse(
            {
              error: {
                type: providerCode === "slow_down" ? "rate_limit_error" : "insufficient_quota",
                code: providerCode,
                message: "private-provider-message test-only-secret",
              },
            },
            { status: 429 },
          ),
      }),
      (error) => {
        assert.ok(error instanceof ModelRouteError);
        assert.equal(error.code, publicCode);
        assert.equal(error.status, 503);
        assert.equal(error.retryable, retryable);
        assert.equal(error.message.includes("private-provider-message"), false);
        assert.equal(error.message.includes("test-only-secret"), false);
        return true;
      },
    );
  }
});

test("unknown, missing-code, and malformed OpenAI 429 responses fail closed", async () => {
  const responses = [
    () => jsonResponse({ error: { code: "future_limit_code", message: "private" } }, { status: 429 }),
    () => jsonResponse({ error: { type: "insufficient_quota", message: "private" } }, { status: 429 }),
    () => new Response("not-json private-provider-body", { status: 429 }),
  ];

  for (const makeResponse of responses) {
    await assert.rejects(
      routeModelReply("hello", {
        purpose,
        env: configuredEnv,
        fetchImpl: async () => makeResponse(),
      }),
      (error) => {
        assert.ok(error instanceof ModelRouteError);
        assert.equal(error.code, "PROVIDER_LIMIT_UNKNOWN");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("OpenAI limit parsing never logs or exposes provider and authorization content", async () => {
  const calls = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => calls.push(["log", ...args]);
  console.warn = (...args) => calls.push(["warn", ...args]);
  console.error = (...args) => calls.push(["error", ...args]);
  try {
    await withChatServer(
      {
        env: configuredEnv,
        fetchImpl: async (_url, options) =>
          jsonResponse(
            {
              error: {
                type: "insufficient_quota",
                code: "credit_balance_exhausted",
                message: `private provider detail ${options.headers.Authorization}`,
              },
              authorization: options.headers.Authorization,
            },
            { status: 429 },
          ),
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        });
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), [
          "error",
          "message",
          "requires_next_run",
          "retryable",
        ]);
        assert.equal(body.error, "QUOTA_EXHAUSTED");
        assert.equal(body.retryable, false);
        assert.equal(JSON.stringify(body).includes("private provider detail"), false);
        assert.equal(JSON.stringify(body).includes("test-only-secret"), false);
        assert.equal(JSON.stringify(body).includes("Authorization"), false);
      },
    );
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  assert.deepEqual(calls, []);
});

test("upstream OpenAI 5xx behavior remains retryable PROVIDER_ERROR", async () => {
  await assert.rejects(
    routeModelReply("hello", {
      purpose,
      env: configuredEnv,
      fetchImpl: async () => new Response("private-provider-body", { status: 500 }),
    }),
    (error) =>
      error instanceof ModelRouteError &&
      error.code === "PROVIDER_ERROR" &&
      error.status === 502 &&
      error.retryable === true &&
      !error.message.includes("private-provider-body"),
  );
});

test("bounded timeout and caller cancellation produce distinct errors", async () => {
  const pendingFetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  await assert.rejects(
    routeModelReply("hello", {
      purpose,
      env: { ...configuredEnv, HERMES_MODEL_TIMEOUT_MS: "5" },
      fetchImpl: pendingFetch,
    }),
    (error) => error instanceof ModelRouteError && error.code === "REQUEST_TIMEOUT" && error.status === 504,
  );

  const controller = new AbortController();
  const pending = routeModelReply("hello", {
    purpose,
    env: { ...configuredEnv, HERMES_MODEL_TIMEOUT_MS: "1000" },
    fetchImpl: pendingFetch,
    signal: controller.signal,
  });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(
    pending,
    (error) => error instanceof ModelRouteError && error.code === "CANCELLED" && error.status === 408,
  );
});

test("safe user-chat configuration inspection never returns the credential", () => {
  assert.deepEqual(inspectUserChatConfiguration({ env: {} }), {
    enabled: false,
    configured: false,
  });
  const configured = inspectUserChatConfiguration({ env: configuredEnv });
  assert.deepEqual(configured, { enabled: true, configured: true, timeoutMs: 30_000 });
  assert.equal(JSON.stringify(configured).includes("test-only-secret"), false);
});

test("HTTP chat defaults to AUTO, preserves public shape, and exposes no provider internals", async () => {
  await withChatServer(
    {
      env: configuredEnv,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.model, "gpt-5.6-terra");
        return jsonResponse(completedPayload(request.model, [messageOutput("provider reply")]));
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), [
        "external_actions",
        "memory_writes",
        "mode",
        "model_route_status",
        "next_required_configuration",
        "ok",
        "product_truth_labels",
        "provider_configured",
        "reply",
        "requires_approval",
        "session_id",
        "turn_id",
      ]);
      assert.equal(body.reply, "provider reply");
      assert.equal(body.mode, "HOSTED");
      assert.equal(body.model_route_status, "IMPLEMENTED_NOT_LIVE_VERIFIED");
      assert.equal(body.provider_configured, true);
      assert.equal("model" in body, false);
      assert.equal("usage" in body, false);
    },
  );
});

test("HTTP disabled state stays labelled and activated failures never return canned success", async () => {
  let calls = 0;
  await withChatServer(
    {
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", route_mode: "BALANCED" }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.mode, "PROTOTYPE");
      assert.equal(body.model_route_status, "NOT_CONFIGURED");
      assert.equal(body.provider_configured, false);
      assert.match(body.reply, /prototype response/i);
    },
  );
  assert.equal(calls, 0);

  await withChatServer(
    { env: { HERMES_MODEL_CHAT_ENABLED: "true" }, fetchImpl: async () => new Response(null) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, "PROVIDER_NOT_CONFIGURED");
      assert.equal("reply" in body, false);
    },
  );
});

test("HTTP validation rejects arbitrary routing/provider controls", async () => {
  await withChatServer({ env: {} }, async (baseUrl) => {
    for (const requestBody of [
      { message: "hello", route_mode: "FAST" },
      { message: "hello", model: "anything" },
      { message: "hello", reasoning_effort: "max" },
      { message: "hello", tools: [] },
    ]) {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.ok(["INVALID_ROUTE", "INVALID_INPUT"].includes(body.error));
    }
  });
});

test("client contract contains exactly the two authorized additive status literals", () => {
  const client = readFileSync(new URL("../../src/lib/hermesApi.ts", import.meta.url), "utf8");
  assert.equal((client.match(/\| "IMPLEMENTED_NOT_LIVE_VERIFIED"/g) ?? []).length, 2);
});
