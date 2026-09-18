import { sendJson } from "../lib/json.mjs";
import {
  readJsonBody,
  looksLikeCredential,
  ChatRequestError,
} from "../lib/chatValidation.mjs";
import { isValidSessionId } from "../lib/sessionId.mjs";
import {
  createSession,
  listSessions,
  getSession,
  renameSession,
  archiveSession,
  deleteSession,
  listMessages,
  getPersistenceStatus,
  MAX_TITLE_LENGTH,
  SessionStoreError,
} from "../lib/sessionStore.mjs";

// Small relative to chat's MAX_BODY_BYTES (32 KiB) — a session-creation
// body only ever carries an optional short title, and PATCH/DELETE bodies
// are smaller still.
const MAX_SESSION_BODY_BYTES = 2 * 1024;

function sendError(res, err) {
  sendJson(res, err.status, {
    error: err.code,
    message: err.message,
    retryable: err.retryable,
    requires_next_run: err.requiresNextRun,
    ...err.details,
  });
}

/**
 * Maps a store-layer failure (the durable SQLite file could not be read
 * from or written to) onto the same normalized error envelope every other
 * route already uses. Never a silent 200/"success" — see
 * server/lib/sessionStore.mjs's own failure posture.
 */
function sendStoreError(res, err) {
  const status = err.code === "PERSISTENCE_UNAVAILABLE" ? 503 : 500;
  sendJson(res, status, {
    error: err.code,
    message: err.message,
    retryable: true,
    requires_next_run: null,
  });
}

function sendServerFailure(res) {
  sendJson(res, 500, {
    error: "SERVER_FAILURE",
    message: "The request could not be processed.",
    retryable: true,
    requires_next_run: null,
  });
}

/**
 * Validates a POST /api/sessions body. Only an optional `title` string is
 * accepted — any other field is rejected rather than silently ignored,
 * matching the same anti-field-smuggling posture as
 * chatValidation.mjs's validateChatRequest. Returns the trimmed title, or
 * undefined if none was supplied (createSession() applies its own default
 * in that case).
 */
function validateCreateSessionRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ChatRequestError("MALFORMED_REQUEST", "Request body must be a JSON object.");
  }

  const unexpected = Object.keys(body).filter((key) => key !== "title");
  if (unexpected.length > 0) {
    throw new ChatRequestError(
      "MALFORMED_REQUEST",
      `Unsupported field(s): ${unexpected.join(", ")}. Only "title" is accepted.`,
    );
  }

  if (body.title === undefined) {
    return undefined;
  }

  if (typeof body.title !== "string") {
    throw new ChatRequestError("MALFORMED_REQUEST", '"title" must be a string.');
  }

  const trimmed = body.title.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ChatRequestError(
      "MALFORMED_REQUEST",
      `"title" exceeds the ${MAX_TITLE_LENGTH}-character limit.`,
    );
  }

  if (looksLikeCredential(trimmed)) {
    // Same posture as chat's CREDENTIAL_SHAPED_INPUT_REJECTED: echoed back
    // only in this response, never logged or stored.
    throw new ChatRequestError(
      "CREDENTIAL_SHAPED_INPUT_REJECTED",
      "The title looks like it contains a credential or secret. It was not stored — only echoed back here so you can confirm and remove it before retrying.",
      { details: { echoed_title: trimmed } },
    );
  }

  return trimmed;
}

/** POST /api/sessions */
export async function handleCreateSession(req, res) {
  try {
    let body;
    try {
      body = await readJsonBody(req, MAX_SESSION_BODY_BYTES);
    } catch (err) {
      if (err instanceof ChatRequestError) {
        // readJsonBody's own errors are INVALID_INPUT/REQUEST_TOO_LARGE —
        // remap the generic "bad body" case to this route's own
        // MALFORMED_REQUEST vocabulary; keep REQUEST_TOO_LARGE's 413 as-is.
        if (err.code === "INVALID_INPUT") {
          throw new ChatRequestError("MALFORMED_REQUEST", "Request body must be valid JSON.");
        }
        throw err;
      }
      throw err;
    }

    const title = validateCreateSessionRequest(body);
    const session = createSession(title);
    sendJson(res, 200, { ok: true, session });
  } catch (err) {
    if (err instanceof ChatRequestError) {
      sendError(res, err);
      return;
    }
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}

/**
 * GET /api/sessions — `?include_archived=true` additionally includes
 * archived sessions. The response's `persistence` field is additive (an
 * existing caller reading only `sessions` is unaffected) and always
 * reflects the durable store's real, current health — never a hardcoded
 * "available" claim. See server/lib/sessionStore.mjs's getPersistenceStatus().
 */
export function handleListSessions(req, res, { includeArchived = false } = {}) {
  try {
    const sessions = listSessions({ includeArchived });
    sendJson(res, 200, { ok: true, sessions, persistence: getPersistenceStatus() });
  } catch (err) {
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}

/** GET /api/sessions/:id */
export function handleGetSession(req, res, id) {
  try {
    if (!isValidSessionId(id)) {
      sendJson(res, 400, {
        error: "INVALID_SESSION_ID",
        message: "The session id is not a recognizable id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    const session = getSession(id);
    if (!session) {
      sendJson(res, 404, {
        error: "SESSION_NOT_FOUND",
        message: "No session exists with that id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    sendJson(res, 200, { ok: true, session });
  } catch (err) {
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}

/**
 * Validates a PATCH /api/sessions/:id body. `{ title?: string, archived?:
 * boolean }` — one endpoint for both rename and archive/unarchive,
 * matching the accepted contract's own API-surface-minimization decision.
 * At least one field must be present; unexpected fields are rejected the
 * same way every other route in this scaffold rejects field smuggling.
 */
function validatePatchSessionRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ChatRequestError("MALFORMED_REQUEST", "Request body must be a JSON object.");
  }

  const unexpected = Object.keys(body).filter((key) => key !== "title" && key !== "archived");
  if (unexpected.length > 0) {
    throw new ChatRequestError(
      "MALFORMED_REQUEST",
      `Unsupported field(s): ${unexpected.join(", ")}. Only "title" and "archived" are accepted.`,
    );
  }

  if (body.title === undefined && body.archived === undefined) {
    throw new ChatRequestError("MALFORMED_REQUEST", 'At least one of "title" or "archived" must be supplied.');
  }

  let title;
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      throw new ChatRequestError("MALFORMED_REQUEST", '"title" must be a string.');
    }
    const trimmed = body.title.trim();
    if (trimmed.length > MAX_TITLE_LENGTH) {
      throw new ChatRequestError(
        "MALFORMED_REQUEST",
        `"title" exceeds the ${MAX_TITLE_LENGTH}-character limit.`,
      );
    }
    if (trimmed.length > 0) {
      if (looksLikeCredential(trimmed)) {
        throw new ChatRequestError(
          "CREDENTIAL_SHAPED_INPUT_REJECTED",
          "The title looks like it contains a credential or secret. It was not stored — only echoed back here so you can confirm and remove it before retrying.",
          { details: { echoed_title: trimmed } },
        );
      }
      title = trimmed;
    }
    // An empty/whitespace-only title after trimming is treated as "no title
    // supplied" — it never overwrites the existing title with blank text.
  }

  let archived;
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      throw new ChatRequestError("MALFORMED_REQUEST", '"archived" must be a boolean.');
    }
    archived = body.archived;
  }

  return { title, archived };
}

/** PATCH /api/sessions/:id — rename and/or archive/unarchive. */
export async function handlePatchSession(req, res, id) {
  try {
    if (!isValidSessionId(id)) {
      sendJson(res, 400, {
        error: "INVALID_SESSION_ID",
        message: "The session id is not a recognizable id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_SESSION_BODY_BYTES);
    } catch (err) {
      if (err instanceof ChatRequestError && err.code === "INVALID_INPUT") {
        throw new ChatRequestError("MALFORMED_REQUEST", "Request body must be valid JSON.");
      }
      throw err;
    }

    const { title, archived } = validatePatchSessionRequest(body);

    if (!getSession(id)) {
      sendJson(res, 404, {
        error: "SESSION_NOT_FOUND",
        message: "No session exists with that id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    let session;
    if (title !== undefined) {
      session = renameSession(id, title);
    }
    if (archived !== undefined) {
      session = archiveSession(id, archived);
    }

    sendJson(res, 200, { ok: true, session });
  } catch (err) {
    if (err instanceof ChatRequestError) {
      sendError(res, err);
      return;
    }
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}

/**
 * DELETE /api/sessions/:id — permanent, irreversible deletion. Requires an
 * explicit `{ "confirm": true }` body; the bare DELETE verb alone is never
 * sufficient, matching the Experience Contract's "no accidental
 * single-keystroke confirmation" principle.
 */
export async function handleDeleteSession(req, res, id) {
  try {
    if (!isValidSessionId(id)) {
      sendJson(res, 400, {
        error: "INVALID_SESSION_ID",
        message: "The session id is not a recognizable id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_SESSION_BODY_BYTES);
    } catch (err) {
      if (err instanceof ChatRequestError && err.code === "INVALID_INPUT") {
        throw new ChatRequestError("MALFORMED_REQUEST", "Request body must be valid JSON.");
      }
      throw err;
    }

    if (typeof body !== "object" || body === null || Array.isArray(body) || body.confirm !== true) {
      throw new ChatRequestError(
        "CONFIRMATION_REQUIRED",
        'Permanent deletion requires an explicit confirmation body: { "confirm": true }.',
      );
    }
    const unexpected = Object.keys(body).filter((key) => key !== "confirm");
    if (unexpected.length > 0) {
      throw new ChatRequestError(
        "MALFORMED_REQUEST",
        `Unsupported field(s): ${unexpected.join(", ")}. Only "confirm" is accepted.`,
      );
    }

    if (!getSession(id)) {
      sendJson(res, 404, {
        error: "SESSION_NOT_FOUND",
        message: "No session exists with that id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    deleteSession(id);
    sendJson(res, 200, { ok: true, session_id: id, deleted: true });
  } catch (err) {
    if (err instanceof ChatRequestError) {
      sendError(res, err);
      return;
    }
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}

/** GET /api/sessions/:id/messages — that session's durable messages, in order. */
export function handleGetSessionMessages(req, res, id) {
  try {
    if (!isValidSessionId(id)) {
      sendJson(res, 400, {
        error: "INVALID_SESSION_ID",
        message: "The session id is not a recognizable id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    if (!getSession(id)) {
      sendJson(res, 404, {
        error: "SESSION_NOT_FOUND",
        message: "No session exists with that id.",
        retryable: false,
        requires_next_run: null,
      });
      return;
    }

    sendJson(res, 200, { ok: true, session_id: id, messages: listMessages(id) });
  } catch (err) {
    if (err instanceof SessionStoreError) {
      sendStoreError(res, err);
      return;
    }
    sendServerFailure(res);
  }
}
