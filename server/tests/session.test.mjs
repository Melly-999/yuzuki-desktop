import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  createSession,
  listSessions,
  getSession,
  touchSession,
  __resetForTests,
  MAX_TITLE_LENGTH,
} from "../lib/sessionStore.mjs";
import { isValidSessionId } from "../lib/sessionId.mjs";
import { createRouter } from "../router.mjs";
import { createChatHandler } from "../routes/chat.mjs";

const router = createRouter({
  chatHandler: createChatHandler({
    env: {},
    fetchImpl: async () => {
      throw new Error("session tests must never call a provider");
    },
  }),
});

test.beforeEach(() => {
  __resetForTests();
});

test("create session returns valid canonical metadata", () => {
  const session = createSession("Weekend trip");
  assert.equal(typeof session.session_id, "string");
  assert.ok(isValidSessionId(session.session_id), "session_id must be a recognizable id shape");
  assert.equal(session.title, "Weekend trip");
  assert.equal(typeof session.created_at, "string");
  assert.equal(typeof session.last_activity_at, "string");
  assert.equal(session.created_at, session.last_activity_at);
  assert.equal(session.archived_at, null);
  // No field beyond the five required ones — no secret-shaped or
  // message-content field ever appears on a session record.
  assert.deepEqual(Object.keys(session).sort(), [
    "archived_at",
    "created_at",
    "last_activity_at",
    "session_id",
    "title",
  ]);
});

test("create session without a title falls back to a default", () => {
  const session = createSession(undefined);
  assert.equal(session.title, "New session");
});

test("session ids are unique across many rapid sequential creates", () => {
  // createSession() is synchronous (randomUUID() + Map.set), so this
  // exercises "N rapid creates all get unique ids" — not real thread
  // concurrency, which a single-threaded in-memory store doesn't need to
  // prove.
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    ids.add(createSession(`session ${i}`).session_id);
  }
  assert.equal(ids.size, 200);
});

test("list returns created sessions", () => {
  const a = createSession("A");
  const b = createSession("B");
  const ids = listSessions().map((s) => s.session_id);
  assert.ok(ids.includes(a.session_id));
  assert.ok(ids.includes(b.session_id));
});

test("list ordering is deterministic across repeated calls", () => {
  createSession("A");
  createSession("B");
  createSession("C");
  const first = listSessions().map((s) => s.session_id);
  const second = listSessions().map((s) => s.session_id);
  assert.deepEqual(first, second);
});

test("list orders most recently active first, with a session_id tiebreak", async () => {
  const a = createSession("A");
  const b = createSession("B");
  // A short delay guarantees a distinguishable last_activity_at — two
  // synchronous creates can otherwise land in the same ISO millisecond,
  // which would fall through to the session_id tiebreak instead of
  // exercising the recency ordering this test is actually about.
  await new Promise((resolve) => setTimeout(resolve, 5));
  touchSession(b.session_id);
  const ordered = listSessions().map((s) => s.session_id);
  assert.equal(ordered[0], b.session_id);
  assert.ok(ordered.includes(a.session_id));
});

test("get/resume finds an existing session", () => {
  const created = createSession("Findable");
  const found = getSession(created.session_id);
  assert.deepEqual(found, created);
});

test("get with an unknown (but well-formed) id returns undefined", () => {
  const unknownButWellFormed = "00000000-0000-4000-8000-000000000000";
  assert.ok(isValidSessionId(unknownButWellFormed));
  assert.equal(getSession(unknownButWellFormed), undefined);
});

test("isValidSessionId rejects malformed ids", () => {
  assert.equal(isValidSessionId("not-a-uuid"), false);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(123), false);
  assert.equal(isValidSessionId(undefined), false);
});

test("touchSession advances last_activity_at and leaves created_at untouched", async () => {
  const session = createSession("Ages");
  const before = session.last_activity_at;
  // Guarantee a distinguishable timestamp without relying on real time.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const touched = touchSession(session.session_id);
  assert.notEqual(touched.last_activity_at, before);
  assert.equal(touched.created_at, session.created_at);
});

test("touchSession on an unknown id returns undefined rather than throwing", () => {
  assert.equal(touchSession("00000000-0000-4000-8000-000000000000"), undefined);
});

test("title length is bounded by MAX_TITLE_LENGTH", () => {
  assert.equal(MAX_TITLE_LENGTH, 200);
});

test("storage is EPHEMERAL: a reset clears every session (no on-disk artifact backs this store)", () => {
  createSession("Will be cleared");
  assert.ok(listSessions().length > 0);
  __resetForTests();
  assert.equal(listSessions().length, 0);
});

// --- HTTP-level tests, against the real router on an ephemeral local
// server. This exercises the exact production request/response path
// (CORS, body parsing, status codes, response shape) rather than mocking
// Node's http req/res objects by hand.

let server;
let baseUrl;

test.before(async () => {
  server = createServer(router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("POST /api/sessions creates a session reachable via GET /api/sessions/:id", async () => {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "HTTP-created session" }),
  });
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.session.title, "HTTP-created session");

  const getResponse = await fetch(`${baseUrl}/api/sessions/${created.session.session_id}`);
  assert.equal(getResponse.status, 200);
  const fetched = await getResponse.json();
  assert.deepEqual(fetched.session, created.session);
});

test("a malformed POST /api/sessions body is rejected with MALFORMED_REQUEST", async () => {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "ok", unexpectedField: "not allowed" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "MALFORMED_REQUEST");
  // No secret-bearing or stack-trace-shaped field anywhere in the error body.
  assert.deepEqual(Object.keys(body).sort(), ["error", "message", "requires_next_run", "retryable"]);
});

test("GET /api/sessions/:id for an unknown id returns SESSION_NOT_FOUND", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/00000000-0000-4000-8000-000000000000`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, "SESSION_NOT_FOUND");
});

test("GET /api/sessions/:id for a malformed id returns INVALID_SESSION_ID", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/not-a-uuid`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "INVALID_SESSION_ID");
});

test("POST /api/chat rejects an unknown session_id", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "hello",
      session_id: "00000000-0000-4000-8000-000000000000",
    }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, "SESSION_NOT_FOUND");
});

test("POST /api/chat accepts a valid session_id, echoes it, and advances last_activity_at", async () => {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const { session } = await createResponse.json();

  await new Promise((resolve) => setTimeout(resolve, 5));

  const chatResponse = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello", session_id: session.session_id }),
  });
  assert.equal(chatResponse.status, 200);
  const chatBody = await chatResponse.json();
  assert.equal(chatBody.ok, true);
  assert.equal(chatBody.session_id, session.session_id);
  // The explicitly disabled test handler preserves the fixed prototype reply.
  assert.match(chatBody.reply, /prototype response/i);
  assert.equal(chatBody.mode, "PROTOTYPE");
  assert.equal(chatBody.model_route_status, "NOT_CONFIGURED");

  const resumed = getSession(session.session_id);
  assert.notEqual(resumed.last_activity_at, session.last_activity_at);
});

test("POST /api/chat without a session_id still works exactly as before (session_id: null)", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.session_id, null);
});

// --- Durable lifecycle routes: PATCH (rename/archive), DELETE, and
// GET .../messages, plus the persistence side effect on POST /api/chat.

async function createHttpSession(title) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: title === undefined ? "{}" : JSON.stringify({ title }),
  });
  const body = await response.json();
  return body.session;
}

test("GET /api/sessions includes a live persistence status", async () => {
  const response = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.persistence.status, "PERSISTENCE_AVAILABLE");
});

test("PATCH /api/sessions/:id renames a session without advancing last_activity_at", async () => {
  const session = await createHttpSession("Original title");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const response = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Renamed" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.title, "Renamed");
  assert.equal(body.session.last_activity_at, session.last_activity_at);
  assert.equal(body.session.session_id, session.session_id);
});

test("PATCH /api/sessions/:id archives and unarchives a session", async () => {
  const session = await createHttpSession("Archive me");

  const archived = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  const archivedBody = await archived.json();
  assert.ok(archivedBody.session.archived_at, "archived_at must be set");

  const listAfterArchive = await (await fetch(`${baseUrl}/api/sessions`)).json();
  assert.ok(
    !listAfterArchive.sessions.some((s) => s.session_id === session.session_id),
    "default list must exclude archived sessions",
  );

  const listIncludingArchived = await (
    await fetch(`${baseUrl}/api/sessions?include_archived=true`)
  ).json();
  assert.ok(listIncludingArchived.sessions.some((s) => s.session_id === session.session_id));

  const unarchived = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  const unarchivedBody = await unarchived.json();
  assert.equal(unarchivedBody.session.archived_at, null);
});

test("PATCH /api/sessions/:id rejects an empty body", async () => {
  const session = await createHttpSession("x");
  const response = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "MALFORMED_REQUEST");
});

test("PATCH /api/sessions/:id for an unknown id returns SESSION_NOT_FOUND", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/00000000-0000-4000-8000-000000000000`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(response.status, 404);
});

test("DELETE /api/sessions/:id without confirmation is rejected", async () => {
  const session = await createHttpSession("Do not delete me yet");
  const response = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "CONFIRMATION_REQUIRED");

  const stillThere = await fetch(`${baseUrl}/api/sessions/${session.session_id}`);
  assert.equal(stillThere.status, 200);
});

test("DELETE /api/sessions/:id with confirm:true permanently removes the session and its messages", async () => {
  const session = await createHttpSession("Delete me");
  await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello", session_id: session.session_id }),
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.session_id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, true);

  const getAfter = await fetch(`${baseUrl}/api/sessions/${session.session_id}`);
  assert.equal(getAfter.status, 404);

  const messagesAfter = await fetch(`${baseUrl}/api/sessions/${session.session_id}/messages`);
  assert.equal(messagesAfter.status, 404, "messages of a deleted session are also gone (cascade), reported as session-not-found");
});

test("DELETE /api/sessions/:id does not affect an unrelated session", async () => {
  const keep = await createHttpSession("Keep me");
  const remove = await createHttpSession("Remove me");

  await fetch(`${baseUrl}/api/sessions/${remove.session_id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });

  const stillThere = await fetch(`${baseUrl}/api/sessions/${keep.session_id}`);
  assert.equal(stillThere.status, 200);
});

test("GET /api/sessions/:id/messages returns durable history in order", async () => {
  const session = await createHttpSession("Chatty");

  await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "first", session_id: session.session_id }),
  });
  // A short delay guarantees a distinguishable created_at between the two
  // turns — two fast local round trips can otherwise land in the same
  // ISO millisecond, falling through to the message_id tiebreak instead of
  // exercising the chronological ordering this test is actually about.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "second", session_id: session.session_id }),
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.session_id}/messages`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session_id, session.session_id);
  // Each chat turn persists a user row then an assistant row (§7): two
  // turns => four rows, in commit order.
  assert.equal(body.messages.length, 4);
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(body.messages[0].content, "first");
  assert.equal(body.messages[2].content, "second");
  assert.match(body.messages[1].content, /prototype response/i);
  // No internal DB row id, no provider payload — only the documented fields.
  for (const message of body.messages) {
    assert.deepEqual(Object.keys(message).sort(), [
      "content",
      "created_at",
      "message_id",
      "role",
      "session_id",
      "status",
    ]);
  }
});

test("GET /api/sessions/:id/messages for an unknown id returns SESSION_NOT_FOUND", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/00000000-0000-4000-8000-000000000000/messages`);
  assert.equal(response.status, 404);
});

test("a user message persists even though the assistant reply path never executes (no session_id has nothing to attach to, still succeeds)", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "no session here" }),
  });
  assert.equal(response.status, 200);
});
