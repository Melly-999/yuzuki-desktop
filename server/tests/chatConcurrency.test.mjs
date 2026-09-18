import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSession, listMessages, __resetForTests } from "../lib/sessionStore.mjs";
import { createChatHandler } from "../routes/chat.mjs";
import { createRouter, HOST } from "../router.mjs";

/**
 * Deterministic, delayed-fake-transport proof of the exact race scenario
 * YUZUKI-DESKTOP-DAILY-USE-HARDENING-001 §1 requires: two concurrent
 * requests for two different sessions, using two different route_modes,
 * resolved OUT OF ORDER (the first-started request's provider response
 * arrives last) — proving neither the server nor the durable store ever
 * conflates which reply/route belongs to which session, regardless of
 * resolution order. This is the server-side half of the guarantee;
 * ChatPane.tsx's own client-side snapshot-at-submit-time behavior (which
 * this proves the server never has to compensate for) is exercised live
 * in this task's browser QA — see the task record.
 */

test.beforeEach(() => {
  __resetForTests();
});

async function withChatServer(options, run) {
  const server = createServer(createRouter({ chatHandler: createChatHandler(options) }));
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const { port } = server.address();
  try {
    await run(`http://${HOST}:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const configuredEnv = Object.freeze({
  HERMES_MODEL_CHAT_ENABLED: "true",
  OPENAI_API_KEY: "test-only-secret",
});

function completedPayload(model, text) {
  return {
    object: "response",
    status: "completed",
    model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

test("two concurrent requests for different sessions/routes, resolved out of order, never cross-contaminate session_id or route", async () => {
  const sessionA = createSession("Session A");
  const sessionB = createSession("Session B");

  // A is fired FIRST but its provider response is deliberately delayed
  // until AFTER B's has already resolved — the exact "late response"
  // shape a UI race would need to defend against, proven here at the
  // transport layer where it is deterministically controllable.
  let resolveA;
  const aGate = new Promise((resolve) => {
    resolveA = resolve;
  });
  let bStarted = false;

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const requestedModel = body.model;
    if (requestedModel === "gpt-5.6-terra") {
      // This is Session A's BALANCED request — block until B has started,
      // proving A's response can genuinely arrive after B's.
      await aGate;
      return new Response(JSON.stringify(completedPayload("gpt-5.6-terra", "Reply for A")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Session B's DEEP request — resolves immediately.
    bStarted = true;
    resolveA(); // release A's gate now that B has definitely started first
    return new Response(JSON.stringify(completedPayload("gpt-5.6-sol", "Reply for B")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await withChatServer({ env: configuredEnv, fetchImpl }, async (baseUrl) => {
    const requestA = fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Message for A", session_id: sessionA.session_id, route_mode: "BALANCED" }),
    });
    // Fire B slightly after A is dispatched, but well before A's gate opens.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const requestB = fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Message for B", session_id: sessionB.session_id, route_mode: "DEEP" }),
    });

    const [responseA, responseB] = await Promise.all([requestA, requestB]);
    const bodyA = await responseA.json();
    const bodyB = await responseB.json();

    assert.ok(bStarted, "B must have actually started before A's gate was released — proves genuine out-of-order resolution");

    // Each response belongs only to its own session and route — never
    // swapped, never merged, regardless of resolution order.
    assert.equal(bodyA.session_id, sessionA.session_id);
    assert.equal(bodyA.reply, "Reply for A");
    assert.equal(bodyA.mode, "HOSTED");

    assert.equal(bodyB.session_id, sessionB.session_id);
    assert.equal(bodyB.reply, "Reply for B");
    assert.equal(bodyB.mode, "HOSTED");
  });

  // The durable store shows each session with only its own turn — the
  // late-resolving A response did not leak into B's history or vice versa.
  const messagesA = listMessages(sessionA.session_id);
  const messagesB = listMessages(sessionB.session_id);

  assert.equal(messagesA.length, 2);
  assert.equal(messagesA[0].content, "Message for A");
  assert.equal(messagesA[1].content, "Reply for A");

  assert.equal(messagesB.length, 2);
  assert.equal(messagesB[0].content, "Message for B");
  assert.equal(messagesB[1].content, "Reply for B");
});

test("a request's own route_mode is immutable once sent, even while a second, later request for the same session uses a different route", async () => {
  const session = createSession("Route immutability test");

  let resolveFirst;
  const firstGate = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.model === "gpt-5.6-terra") {
      await firstGate;
      return new Response(JSON.stringify(completedPayload("gpt-5.6-terra", "First reply (BALANCED)")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    resolveFirst();
    return new Response(JSON.stringify(completedPayload("gpt-5.6-sol", "Second reply (DEEP)")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await withChatServer({ env: configuredEnv, fetchImpl }, async (baseUrl) => {
    // Submit with BALANCED — this is the in-flight request whose route
    // must remain BALANCED no matter what a UI selector shows afterward.
    const firstRequest = fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first", session_id: session.session_id, route_mode: "BALANCED" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A second, independent submission with DEEP — simulates the user
    // having switched the route selector and sent again; this must not
    // retroactively alter the first request's own route.
    const secondRequest = fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second", session_id: session.session_id, route_mode: "DEEP" }),
    });

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();

    assert.equal(firstBody.reply, "First reply (BALANCED)");
    assert.equal(secondBody.reply, "Second reply (DEEP)");
  });
});
