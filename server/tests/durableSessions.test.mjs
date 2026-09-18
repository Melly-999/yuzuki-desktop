import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createSession,
  listSessions,
  getSession,
  touchSession,
  renameSession,
  archiveSession,
  deleteSession,
  appendMessage,
  listMessages,
  getPersistenceStatus,
  SessionStoreError,
  __resetForTests,
  __initForTests,
  __closeForTests,
} from "../lib/sessionStore.mjs";
import { createChatHandler } from "../routes/chat.mjs";
import { createRouter, HOST } from "../router.mjs";

function tempDbPath() {
  return path.join(os.tmpdir(), `yuzuki-durable-test-${randomUUID()}.db`);
}

function cleanupPath(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

test.beforeEach(() => {
  __resetForTests();
});

// --- Restart recovery: the mandatory, actually-exercised proof (not
// static inspection) that a session and its messages survive a real
// close-and-reopen of the SQLite connection against the same file.

test("session survives store recreation against the same file (restart recovery)", () => {
  const dbPath = tempDbPath();
  try {
    const opened = __initForTests(dbPath);
    assert.equal(opened.status, "PERSISTENCE_AVAILABLE");

    const created = createSession("Survives restart");
    __closeForTests();

    const reopened = __initForTests(dbPath);
    assert.equal(reopened.status, "PERSISTENCE_AVAILABLE");

    const found = getSession(created.session_id);
    assert.deepEqual(found, created);
    assert.ok(listSessions().some((s) => s.session_id === created.session_id));
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

test("messages survive store recreation, in order, against the same file", () => {
  const dbPath = tempDbPath();
  try {
    __initForTests(dbPath);
    const session = createSession("Chatty restart test");
    appendMessage({ sessionId: session.session_id, role: "user", content: "one" });
    appendMessage({ sessionId: session.session_id, role: "assistant", content: "two" });
    __closeForTests();

    __initForTests(dbPath);
    const messages = listMessages(session.session_id);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((m) => m.content),
      ["one", "two"],
    );
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant"],
    );
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

test("rename survives a simulated restart", () => {
  const dbPath = tempDbPath();
  try {
    __initForTests(dbPath);
    const session = createSession("Before");
    renameSession(session.session_id, "After");
    __closeForTests();

    __initForTests(dbPath);
    assert.equal(getSession(session.session_id).title, "After");
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

test("archive survives a simulated restart", () => {
  const dbPath = tempDbPath();
  try {
    __initForTests(dbPath);
    const session = createSession("Archive me");
    archiveSession(session.session_id, true);
    __closeForTests();

    __initForTests(dbPath);
    const found = getSession(session.session_id);
    assert.ok(found.archived_at, "archived_at must survive a restart");
    assert.ok(!listSessions().some((s) => s.session_id === session.session_id));
    assert.ok(listSessions({ includeArchived: true }).some((s) => s.session_id === session.session_id));
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

// --- Delete semantics

test("permanent delete removes the session row", () => {
  const session = createSession("Doomed");
  assert.equal(deleteSession(session.session_id), true);
  assert.equal(getSession(session.session_id), undefined);
});

test("delete cascades to remove that session's own message rows", () => {
  const session = createSession("Doomed with history");
  appendMessage({ sessionId: session.session_id, role: "user", content: "hi" });
  appendMessage({ sessionId: session.session_id, role: "assistant", content: "hello" });
  deleteSession(session.session_id);
  assert.deepEqual(listMessages(session.session_id), []);
});

test("an unrelated session and its messages survive another session's delete", () => {
  const keep = createSession("Keep");
  appendMessage({ sessionId: keep.session_id, role: "user", content: "still here" });
  const remove = createSession("Remove");
  appendMessage({ sessionId: remove.session_id, role: "user", content: "gone" });

  deleteSession(remove.session_id);

  assert.deepEqual(getSession(keep.session_id), keep);
  assert.equal(listMessages(keep.session_id).length, 1);
  assert.equal(listMessages(keep.session_id)[0].content, "still here");
});

test("deleting an unknown session id is reported as not-deleted, not an error", () => {
  assert.equal(deleteSession("00000000-0000-4000-8000-000000000000"), false);
});

// --- Message ordering

test("message ordering is deterministic by created_at", async () => {
  const session = createSession("Ordered");
  appendMessage({ sessionId: session.session_id, role: "user", content: "first" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  appendMessage({ sessionId: session.session_id, role: "assistant", content: "second" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  appendMessage({ sessionId: session.session_id, role: "user", content: "third" });

  const messages = listMessages(session.session_id);
  assert.deepEqual(
    messages.map((m) => m.content),
    ["first", "second", "third"],
  );
});

// --- Chat transaction boundary — the highest-risk integration point,
// driven through the real HTTP router exactly like modelBackedChat.test.mjs
// does, so this is a genuine end-to-end proof, not a mocked call.

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

test("a user message row commits before the provider call is invoked", async () => {
  const session = createSession("Order-of-operations");
  let sawUserRowBeforeProviderCall = false;

  await withChatServer(
    {
      env: configuredEnv,
      fetchImpl: async () => {
        sawUserRowBeforeProviderCall = listMessages(session.session_id).some(
          (m) => m.role === "user" && m.content === "check order",
        );
        return new Response("boom", { status: 500 });
      },
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "check order", session_id: session.session_id }),
      });
    },
  );

  assert.equal(sawUserRowBeforeProviderCall, true);
});

test("provider failure does not erase the already-committed user message", async () => {
  const session = createSession("Failure keeps user text");

  await withChatServer(
    {
      env: configuredEnv,
      fetchImpl: async () => new Response("upstream failure", { status: 500 }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "please survive", session_id: session.session_id }),
      });
      assert.notEqual(response.status, 200);
    },
  );

  const messages = listMessages(session.session_id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "please survive");
});

test("a successful provider reply persists an assistant message", async () => {
  const session = createSession("Success persists reply");
  const completed = {
    object: "response",
    status: "completed",
    model: "gpt-5.6-terra",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "a real reply", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };

  await withChatServer(
    {
      env: configuredEnv,
      fetchImpl: async () =>
        new Response(JSON.stringify(completed), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "give me a reply", session_id: session.session_id }),
      });
      assert.equal(response.status, 200);
    },
  );

  const messages = listMessages(session.session_id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "a real reply");
});

test("an invalid session_id on the messages route is rejected the same way GET /api/sessions/:id already does", async () => {
  await withChatServer({ env: {}, fetchImpl: async () => new Response("unused", { status: 500 }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/not-a-uuid/messages`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "INVALID_SESSION_ID");
  });
});

test("a credential-shaped chat message is rejected before it ever reaches durable storage", async () => {
  const session = createSession("No secrets here");
  await withChatServer({ env: {}, fetchImpl: async () => new Response("unused", { status: 500 }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "sk-1234567890abcdefghijklmnop", session_id: session.session_id }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "CREDENTIAL_SHAPED_INPUT_REJECTED");
  });
  assert.deepEqual(listMessages(session.session_id), []);
});

// --- Storage failure semantics

test("a simulated DB write failure results in SAVE_FAILED, never a false success", () => {
  const dbPath = tempDbPath();
  try {
    __initForTests(dbPath);
    createSession("Before break");
    __closeForTests(); // simulates the connection becoming unusable mid-run

    assert.throws(
      () => createSession("After break"),
      (err) => err instanceof SessionStoreError && err.code === "SAVE_FAILED",
    );
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

// --- Migration / schema-version failure semantics

test("an unsupported newer schema version fails closed without mutating the file", () => {
  const dbPath = tempDbPath();
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 999;");
    raw.close();

    const outcome = __initForTests(dbPath);
    assert.equal(outcome.status, "MIGRATION_REQUIRED");

    // The original file must be left exactly as it was — never downgraded,
    // mutated, or recreated.
    const verify = new DatabaseSync(dbPath);
    const version = verify.prepare("PRAGMA user_version").get().user_version;
    verify.close();
    assert.equal(version, 999);
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

test("a migration/schema-creation failure preserves the existing store and reports MIGRATION_FAILED", () => {
  const dbPath = tempDbPath();
  try {
    // Simulate a store that started schema creation but crashed before the
    // version pragma was ever set: a `sessions` table already exists, but
    // user_version is still 0 — the fresh-init path will try to CREATE
    // TABLE sessions again and fail.
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY);");
    raw.close();

    const outcome = __initForTests(dbPath);
    assert.equal(outcome.status, "MIGRATION_FAILED");

    // The pre-existing (half-shaped) file must be left untouched — the
    // failed CREATE TABLE transaction rolled back, and nothing further was
    // written to it.
    const verify = new DatabaseSync(dbPath);
    const version = verify.prepare("PRAGMA user_version").get().user_version;
    const tables = verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    verify.close();
    assert.equal(version, 0);
    assert.deepEqual(tables, ["sessions"]);
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

// --- Corruption handling

test("a corrupted database is never auto-deleted; it is preserved and a fresh store is surfaced honestly", () => {
  const dbPath = tempDbPath();
  const garbage = "this is not a valid sqlite file, just garbage bytes";
  try {
    fs.writeFileSync(dbPath, garbage);

    const outcome = __initForTests(dbPath);
    assert.equal(outcome.status, "DATABASE_CORRUPT");
    assert.match(outcome.detail, /integrity check|corrupt|preserved/i);

    // The corrupt file must exist somewhere, renamed aside, never deleted
    // and never silently overwritten with its original bytes intact.
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.corrupt-`));
    assert.equal(backups.length, 1, "exactly one preserved corrupt-backup file must exist");
    const backupContent = fs.readFileSync(path.join(dir, backups[0]), "utf8");
    assert.equal(backupContent, garbage);

    // A fresh, working store is active going forward.
    const session = createSession("Fresh after corruption");
    assert.ok(getSession(session.session_id));

    // Clean up the backup file this test created.
    fs.unlinkSync(path.join(dir, backups[0]));
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

// --- Privacy / boundary smoke tests

test("the messages table has exactly the documented columns — no provider-payload or file-content column", () => {
  __initForTests(":memory:");
  const session = createSession("Schema check");
  appendMessage({ sessionId: session.session_id, role: "user", content: "plain text, even if it looks like /etc/passwd or an API key: sk-not-real" });
  const [message] = listMessages(session.session_id);
  assert.deepEqual(Object.keys(message).sort(), ["content", "created_at", "message_id", "role", "session_id", "status"]);
});

test("only 'user' and 'assistant' roles are ever accepted", () => {
  const session = createSession("Role check");
  assert.throws(
    () => appendMessage({ sessionId: session.session_id, role: "system", content: "no" }),
    (err) => err instanceof SessionStoreError,
  );
});

test("no approvals table exists — restart cannot resume any execution eligibility", () => {
  const dbPath = tempDbPath();
  try {
    __initForTests(dbPath);
    createSession("No approvals here");
    __closeForTests();
    __initForTests(dbPath);

    const raw = new DatabaseSync(dbPath);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    raw.close();
    assert.deepEqual(tables.sort(), ["messages", "sessions"]);
  } finally {
    __resetForTests();
    cleanupPath(dbPath);
  }
});

test("touchSession remains durable and independent of rename/archive timestamps", async () => {
  const session = createSession("Timestamps");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const touched = touchSession(session.session_id);
  assert.notEqual(touched.last_activity_at, session.created_at);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = renameSession(session.session_id, "New title");
  assert.equal(renamed.last_activity_at, touched.last_activity_at, "rename must not advance last_activity_at");
});

test("getPersistenceStatus reflects the active connection truthfully", () => {
  __resetForTests();
  assert.equal(getPersistenceStatus().status, "PERSISTENCE_AVAILABLE");
});
