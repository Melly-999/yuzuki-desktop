/**
 * Pure session-ID shape validation. No storage import here on purpose —
 * both the request-validation layer (chatValidation.mjs) and the route
 * layer (routes/sessions.mjs) need to shape-check an id before touching
 * the session store, and neither should have to depend on the store
 * singleton just to do that.
 */

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * True only for a well-formed session id (the shape sessionStore.mjs's
 * randomUUID()-based createSession() actually produces). This says
 * nothing about whether the id is a *known* session — that is a separate
 * store lookup, kept separate so callers can distinguish
 * "malformed" (400 INVALID_SESSION_ID) from "well-formed but
 * unknown" (404 SESSION_NOT_FOUND).
 */
export function isValidSessionId(id) {
  return typeof id === "string" && UUID_V4_PATTERN.test(id);
}
