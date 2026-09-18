import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionsDbPath } from "./appDataPath.mjs";

/**
 * Durable, local, single-file SQLite-backed session + message store for the
 * HERMES API scaffold, per
 * docs/product/YUZUKI_DESKTOP_DURABLE_SESSIONS_P0_CONTRACT.md and its
 * implementation handoff.
 *
 * SESSION_PERSISTENCE: DURABLE (local SQLite file via node:sqlite,
 * %LOCALAPPDATA%\Yuzuki\sessions.db — see appDataPath.mjs). No cloud sync,
 * no second database, no ORM.
 *
 * MESSAGE_HISTORY_PERSISTENCE: DURABLE, text-only (`role`, `content`,
 * timestamps). Never stored, here or anywhere else in this module: raw
 * provider payloads, authorization headers, credentials, chain-of-thought,
 * absolute file paths, or file content.
 *
 * Failure posture (never faked): if the real store cannot be opened, is
 * corrupt, or has an unsupported/half-migrated schema, this module falls
 * back to a fresh in-memory (`:memory:`) SQLite connection so the process
 * keeps serving requests — but getPersistenceStatus() reports the real,
 * degraded state, and a corrupt file is preserved (renamed aside), never
 * deleted or silently overwritten. See openAndBootstrap() below.
 *
 * There is no authentication or per-caller ownership concept anywhere in
 * this scaffold — consistent with the rest of this local-only prototype.
 */

export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_TITLE = "New session";
export const MESSAGE_ROLES = Object.freeze(["user", "assistant"]);
const SCHEMA_VERSION = 1;

export class SessionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeTimestampSuffix() {
  // Windows filenames cannot contain ':' — an ISO timestamp needs sanitizing
  // before it can be used as part of a filename.
  return nowIso().replace(/[:.]/g, "-");
}

// --- Module state -----------------------------------------------------
// `db` is always a live DatabaseSync once `ensureDb()` has run at least
// once — either the real durable store, or an in-memory fallback if the
// real one could not be safely used. `initialized` guards against
// re-opening the production path once a test hook has already pointed
// this module at a test-only store.
let db = null;
let statements = null;
let persistence = { status: "PERSISTENCE_UNAVAILABLE", detail: "Not yet initialized." };
let initialized = false;

function prepareStatements(database) {
  return {
    insertSession: database.prepare(
      "INSERT INTO sessions (session_id, title, created_at, last_activity_at, archived_at) VALUES (?, ?, ?, ?, NULL)",
    ),
    listSessions: database.prepare(
      "SELECT session_id, title, created_at, last_activity_at, archived_at FROM sessions WHERE archived_at IS NULL ORDER BY last_activity_at DESC, session_id ASC",
    ),
    listSessionsIncludingArchived: database.prepare(
      "SELECT session_id, title, created_at, last_activity_at, archived_at FROM sessions ORDER BY last_activity_at DESC, session_id ASC",
    ),
    getSession: database.prepare(
      "SELECT session_id, title, created_at, last_activity_at, archived_at FROM sessions WHERE session_id = ?",
    ),
    touchSession: database.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_id = ?"),
    renameSession: database.prepare("UPDATE sessions SET title = ? WHERE session_id = ?"),
    archiveSession: database.prepare("UPDATE sessions SET archived_at = ? WHERE session_id = ?"),
    deleteSession: database.prepare("DELETE FROM sessions WHERE session_id = ?"),
    insertMessage: database.prepare(
      "INSERT INTO messages (message_id, session_id, role, content, created_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    // Tiebreak on `rowid` (SQLite's own implicit, monotonically increasing
    // insert-order column for an ordinary rowid table), not `message_id` —
    // two rows can share an identical ISO-millisecond `created_at` (e.g.
    // the user and assistant row of one fast, not-yet-configured chat
    // turn), and a random-UUID `message_id` tiebreak would not reliably
    // preserve insertion/causal order in that case, while `rowid` always
    // does.
    listMessages: database.prepare(
      "SELECT message_id, session_id, role, content, created_at, status FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
    ),
  };
}

function createSchema(database) {
  database.exec(`
    BEGIN;
    CREATE TABLE sessions (
      session_id       TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      archived_at      TEXT
    );
    CREATE TABLE messages (
      message_id  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'complete'
                    CHECK (status IN ('complete', 'failed', 'cancelled'))
    );
    CREATE INDEX idx_messages_session_created ON messages (session_id, created_at);
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

/**
 * Ordered, numbered migration steps, each applied inside its own
 * transaction. Only `0 -> 1` exists at P0 (schema creation itself); this
 * array exists so a future schema change has a bounded place to land
 * without inventing a migration framework.
 */
const MIGRATIONS = [
  // { from: 1, to: 2, up(database) { ... } },
];

/**
 * Applies any pending migrations in order, starting from `fromVersion`.
 * Each step is its own transaction: on failure that step rolls back fully
 * and this function rethrows, leaving the store at whatever version the
 * last *successful* step left it at (never half-applied).
 */
function applyMigrations(database, fromVersion) {
  let version = fromVersion;
  for (const migration of MIGRATIONS) {
    if (migration.from !== version) continue;
    database.exec("BEGIN;");
    try {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.to}; COMMIT;`);
      version = migration.to;
    } catch (err) {
      database.exec("ROLLBACK;");
      throw err;
    }
  }
  return version;
}

/**
 * Opens (creating if necessary) a SQLite file at `dbPath`, running the
 * mandatory `PRAGMA foreign_keys = ON` (required every connection — SQLite
 * does not enforce declared foreign keys unless a connection explicitly
 * turns this on), a startup `PRAGMA integrity_check`, and schema
 * creation/migration. Returns `{ db, persistence }` — this function itself
 * never throws for an *expected* failure mode (corruption, migration
 * failure, unsupported newer schema, open failure); those are all folded
 * into a returned `persistence.status` plus, where a real durable open is
 * impossible, a fresh in-memory fallback connection so the caller always
 * gets back a usable `db`.
 */
function openAndBootstrap(dbPath) {
  const isMemory = dbPath === ":memory:";

  if (!isMemory) {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch (err) {
      return openMemoryFallback("PERSISTENCE_UNAVAILABLE", `Could not create the app-data directory: ${err.message}`);
    }
  }

  let database;
  try {
    database = new DatabaseSync(dbPath);
  } catch (err) {
    return openMemoryFallback("PERSISTENCE_UNAVAILABLE", `Could not open the local database: ${err.message}`);
  }

  try {
    database.exec("PRAGMA foreign_keys = ON;");
  } catch (err) {
    try {
      database.close();
    } catch {
      // already unusable — nothing further to release
    }
    return openMemoryFallback("PERSISTENCE_UNAVAILABLE", `Could not configure the local database: ${err.message}`);
  }

  if (!isMemory) {
    let integrityOk = false;
    try {
      const result = database.prepare("PRAGMA integrity_check").get();
      integrityOk = result?.integrity_check === "ok";
    } catch {
      integrityOk = false;
    }

    if (!integrityOk) {
      try {
        database.close();
      } catch {
        // already unusable
      }
      const backupPath = `${dbPath}.corrupt-${safeTimestampSuffix()}`;
      try {
        fs.renameSync(dbPath, backupPath);
      } catch {
        // If even the rename fails, do not attempt to touch dbPath further —
        // fall back to memory rather than risk overwriting a file we could
        // not safely move aside.
        return openMemoryFallback(
          "DATABASE_CORRUPT",
          "The local database failed its integrity check and could not be moved aside for preservation. Falling back to a fresh, non-durable store for this run.",
        );
      }
      // Recurse once against the now-vacated path to create a fresh store —
      // the corrupt file is preserved at backupPath, never deleted.
      const fresh = openAndBootstrap(dbPath);
      if (fresh.persistence.status === "PERSISTENCE_AVAILABLE") {
        return {
          db: fresh.db,
          persistence: {
            status: "DATABASE_CORRUPT",
            detail: `The previous local database failed its integrity check and was preserved at ${path.basename(backupPath)}. Conversation history before this point was not recovered; a fresh store is now active.`,
          },
        };
      }
      return fresh;
    }
  }

  let userVersion;
  try {
    userVersion = database.prepare("PRAGMA user_version").get().user_version;
  } catch (err) {
    try {
      database.close();
    } catch {
      // already unusable
    }
    return openMemoryFallback("PERSISTENCE_UNAVAILABLE", `Could not read schema version: ${err.message}`);
  }

  if (userVersion === 0) {
    try {
      createSchema(database);
    } catch (err) {
      try {
        database.close();
      } catch {
        // already unusable
      }
      return openMemoryFallback("MIGRATION_FAILED", `Initial schema creation failed: ${err.message}`);
    }
    return { db: database, persistence: { status: "PERSISTENCE_AVAILABLE", detail: "" } };
  }

  if (userVersion === SCHEMA_VERSION) {
    return { db: database, persistence: { status: "PERSISTENCE_AVAILABLE", detail: "" } };
  }

  if (userVersion < SCHEMA_VERSION) {
    try {
      applyMigrations(database, userVersion);
      return { db: database, persistence: { status: "PERSISTENCE_AVAILABLE", detail: "" } };
    } catch (err) {
      // The failed migration step already rolled back on its own connection;
      // do not keep writing against a store we could not safely upgrade.
      try {
        database.close();
      } catch {
        // already unusable
      }
      return openMemoryFallback(
        "MIGRATION_FAILED",
        `A schema migration failed and was rolled back: ${err.message}. The existing local database was left untouched.`,
      );
    }
  }

  // userVersion > SCHEMA_VERSION: a newer, unsupported schema. Never
  // downgrade, mutate, or recreate — fail closed.
  try {
    database.close();
  } catch {
    // already unusable
  }
  return openMemoryFallback(
    "MIGRATION_REQUIRED",
    `The local database's schema version (${userVersion}) is newer than this application supports (${SCHEMA_VERSION}). It was left untouched.`,
  );
}

function openMemoryFallback(status, detail) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  createSchema(database);
  return { db: database, persistence: { status, detail } };
}

function ensureDb() {
  if (!initialized) {
    initialized = true;
    const outcome = openAndBootstrap(resolveSessionsDbPath());
    db = outcome.db;
    statements = prepareStatements(db);
    persistence = outcome.persistence;
  }
  return db;
}

function toRecord(row) {
  if (!row) return undefined;
  return {
    session_id: row.session_id,
    title: row.title,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    archived_at: row.archived_at ?? null,
  };
}

function toMessageRecord(row) {
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    status: row.status,
  };
}

/** Live durable-store health, for Product Truth / Activity Dock surfacing. Never PERSISTENCE_UNAVAILABLE-shaped lies: this always reflects the actual connection currently in use. */
export function getPersistenceStatus() {
  ensureDb();
  return { ...persistence };
}

/**
 * Creates a session record. `title` must already be validated/trimmed by
 * the caller (server/routes/sessions.mjs) — this function does not
 * re-validate it, so callers stay responsible for the credential-shaped-
 * input check and the length cap before calling this.
 */
export function createSession(title) {
  ensureDb();
  const id = randomUUID();
  const timestamp = nowIso();
  const resolvedTitle = title && title.length > 0 ? title : DEFAULT_TITLE;
  try {
    statements.insertSession.run(id, resolvedTitle, timestamp, timestamp);
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not save the new session: ${err.message}`);
  }
  return { session_id: id, title: resolvedTitle, created_at: timestamp, last_activity_at: timestamp, archived_at: null };
}

/**
 * Deterministic ordering: most recently active first, with a session_id
 * tiebreak so two sessions created in the same millisecond still sort
 * consistently across repeated calls. Excludes archived sessions unless
 * `includeArchived` is set.
 */
export function listSessions({ includeArchived = false } = {}) {
  ensureDb();
  try {
    const rows = includeArchived ? statements.listSessionsIncludingArchived.all() : statements.listSessions.all();
    return rows.map(toRecord);
  } catch (err) {
    throw new SessionStoreError("PERSISTENCE_UNAVAILABLE", `Could not list sessions: ${err.message}`);
  }
}

/** Returns the session record, or undefined if the id is unknown. */
export function getSession(id) {
  ensureDb();
  try {
    return toRecord(statements.getSession.get(id));
  } catch (err) {
    throw new SessionStoreError("PERSISTENCE_UNAVAILABLE", `Could not read the session: ${err.message}`);
  }
}

/**
 * Advances last_activity_at to now. Returns the updated record, or
 * undefined if the id is unknown (callers must treat that as
 * SESSION_NOT_FOUND, not silently ignore it).
 */
export function touchSession(id) {
  ensureDb();
  const existing = getSession(id);
  if (!existing) return undefined;
  const timestamp = nowIso();
  try {
    statements.touchSession.run(timestamp, id);
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not update the session: ${err.message}`);
  }
  return { ...existing, last_activity_at: timestamp };
}

/**
 * Renames a session's title only. Does NOT advance last_activity_at — see
 * the implementation handoff §12: that field means "last conversational
 * activity," not "last modified in any way." Title must already be
 * validated/trimmed by the caller, same convention as createSession.
 * Returns the updated record, or undefined if the id is unknown.
 */
export function renameSession(id, title) {
  ensureDb();
  const existing = getSession(id);
  if (!existing) return undefined;
  const resolvedTitle = title && title.length > 0 ? title : existing.title;
  try {
    statements.renameSession.run(resolvedTitle, id);
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not rename the session: ${err.message}`);
  }
  return { ...existing, title: resolvedTitle };
}

/**
 * Sets or clears archived_at. Reversible: archiving and unarchiving both
 * go through this one function. Does NOT advance last_activity_at, same
 * reasoning as renameSession. Returns the updated record, or undefined if
 * the id is unknown.
 */
export function archiveSession(id, archived) {
  ensureDb();
  const existing = getSession(id);
  if (!existing) return undefined;
  const archivedAt = archived ? nowIso() : null;
  try {
    statements.archiveSession.run(archivedAt, id);
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not update the session's archive state: ${err.message}`);
  }
  return { ...existing, archived_at: archivedAt };
}

/**
 * Permanently removes a session row and, via `ON DELETE CASCADE` (active
 * because `PRAGMA foreign_keys = ON` was set on this connection at open
 * time), every one of its own message rows in the same statement. Returns
 * true if a row was actually deleted, false if the id was unknown. Never
 * touches any other session's rows — the WHERE clause is an exact match.
 */
export function deleteSession(id) {
  ensureDb();
  try {
    const result = statements.deleteSession.run(id);
    return result.changes > 0;
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not delete the session: ${err.message}`);
  }
}

/**
 * Persists a single message row. Only "user" and "assistant" roles are
 * ever accepted (also enforced at the schema level via a CHECK
 * constraint) — no internal/provider role, and no chain-of-thought. The
 * caller (server/routes/chat.mjs) is responsible for calling this with an
 * already-known-valid `sessionId` (it already looks the session up before
 * routing to the model) — this function trusts that, matching the
 * existing repository convention of validation happening once, at the
 * caller boundary.
 */
export function appendMessage({ sessionId, role, content, status = "complete" }) {
  ensureDb();
  if (!MESSAGE_ROLES.includes(role)) {
    throw new SessionStoreError("SAVE_FAILED", `"${role}" is not an accepted message role.`);
  }
  const id = randomUUID();
  const timestamp = nowIso();
  try {
    statements.insertMessage.run(id, sessionId, role, content, timestamp, status);
  } catch (err) {
    throw new SessionStoreError("SAVE_FAILED", `Could not save the message: ${err.message}`);
  }
  return { message_id: id, session_id: sessionId, role, content, created_at: timestamp, status };
}

/**
 * Returns a session's durable messages in deterministic order
 * (created_at ascending, message_id as a tiebreak). Does not check
 * whether the session itself exists — callers that need to distinguish
 * "empty history" from "unknown session" should call getSession() first,
 * matching the existing convention elsewhere in this module.
 */
export function listMessages(sessionId) {
  ensureDb();
  try {
    return statements.listMessages.all(sessionId).map(toMessageRecord);
  } catch (err) {
    throw new SessionStoreError("PERSISTENCE_UNAVAILABLE", `Could not read message history: ${err.message}`);
  }
}

/**
 * Test-only reset: discards any existing connection and opens a brand new
 * in-memory store, so each test file/case starts from an empty store
 * instead of leaking state across `node:test` cases in the same process —
 * and, critically, never touches the real production database path.
 */
export function __resetForTests() {
  if (db) {
    try {
      db.close();
    } catch {
      // already unusable — nothing to release
    }
  }
  initialized = true;
  const outcome = openAndBootstrap(":memory:");
  db = outcome.db;
  statements = prepareStatements(db);
  persistence = outcome.persistence;
}

/**
 * Test-only: opens this module against a specific path (a real temp file,
 * to prove restart/reopen behavior, or ":memory:") running the exact same
 * bootstrap logic production uses — including corruption/migration
 * handling. Never used for the real production path.
 */
export function __initForTests(dbPath) {
  if (db) {
    try {
      db.close();
    } catch {
      // already unusable — nothing to release
    }
  }
  initialized = true;
  const outcome = openAndBootstrap(dbPath);
  db = outcome.db;
  statements = prepareStatements(db);
  persistence = outcome.persistence;
  return { ...persistence };
}

/**
 * Test-only: closes the current connection without reinitializing
 * anything, so a subsequent __initForTests() against the same file path
 * simulates a real process restart (or, if a query is attempted before
 * reinitializing, simulates a mid-operation write/read failure).
 */
export function __closeForTests() {
  if (db) {
    try {
      db.close();
    } catch {
      // already unusable
    }
  }
}
