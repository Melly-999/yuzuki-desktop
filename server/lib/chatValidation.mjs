/**
 * Request reading and validation for POST /api/chat. No provider call,
 * no persistence, and no logging of message content happens anywhere in
 * this module — see docs/backend/HERMES_BACKEND_READINESS_PLAN.md §2.2.
 * (An optional `session_id` field, added by HERMES-CHAT-SESSION-IDENTITY-
 * API-001, is shape-validated here but never itself chat content — see
 * server/lib/sessionId.mjs and server/lib/sessionStore.mjs. An optional
 * `context` field, added by YUZUKI-DESKTOP-CONTEXT-FILES-P0-
 * IMPLEMENTATION-001, is bounded, validated plain text from one
 * explicitly user-selected local file — never a path, never parsed
 * structurally, never treated as anything but reference data.)
 */

import { isValidSessionId } from "./sessionId.mjs";
import { ROUTE_MODE } from "./modelRouting.mjs";

export const MAX_MESSAGE_LENGTH = 4000;
/**
 * 64 KiB — re-derived (not silently reused) from the original 32 KiB once
 * the optional `context` field (YUZUKI-DESKTOP-CONTEXT-FILES-P0-
 * IMPLEMENTATION-001) could be present: worst-case message (4,000 chars)
 * + worst-case context text (MAX_CONTEXT_TEXT_LENGTH, 8,000 chars) +
 * filename + JSON overhead comfortably fits with headroom. A request
 * carrying no `context` field is unaffected — a larger ceiling only ever
 * accepts more, never fewer, of what already worked.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Maximum characters accepted in an admitted file's decoded text (context.text). */
export const MAX_CONTEXT_TEXT_LENGTH = 8000;
/** Maximum characters accepted for a context source's filename — reuses sessionStore.mjs's MAX_TITLE_LENGTH precedent rather than inventing a new number. */
export const MAX_CONTEXT_FILENAME_LENGTH = 200;
/** Case-insensitive, extension-authoritative — matches the client picker's own accepted-type list exactly (no MIME sniffing anywhere). */
export const ALLOWED_CONTEXT_EXTENSIONS = [".txt", ".md", ".json", ".csv"];

/**
 * True if `text` contains a C0 control character other than tab, line
 * feed, or carriage return — the same rule the client applies before
 * ever reading a file (src/desktop/fileContext.ts), re-run server-side
 * as defense-in-depth. The server never blindly trusts client-side
 * validation. Deliberately built from numeric character codes rather
 * than a regex character class of literal control bytes, so the source
 * of this file itself never has to contain an unescaped control
 * character.
 */
export function containsBinaryLikeControlChars(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isControlChar = code <= 0x1f;
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d; // tab, LF, CR
    if (isControlChar && !isAllowedWhitespace) return true;
  }
  return false;
}

/**
 * Normalized error for a rejected chat request. `code` and `message`
 * feed the response shape in
 * docs/backend/HERMES_MODEL_ROUTING_READINESS_ADDENDUM.md §10.3.
 */
export class ChatRequestError extends Error {
  constructor(code, message, { status = 400, retryable = false, requiresNextRun = null, details = {} } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requiresNextRun = requiresNextRun;
    this.details = details;
  }
}

/**
 * Patterns for input that looks like a pasted credential or secret,
 * rather than a chat message. Deliberately pattern-shaped (key formats,
 * bearer tokens, JWTs, key=value secrets) rather than keyword-only, to
 * avoid false-positiving on ordinary prose that merely mentions
 * "password" or "token".
 */
const CREDENTIAL_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/i, // Anthropic-style key
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i, // bearer token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["']?[A-Za-z0-9\-_.]{8,}["']?/i, // key=value secret
];

export function looksLikeCredential(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reads and JSON-parses a request body, enforcing MAX_BODY_BYTES both
 * from a declared Content-Length (rejected before reading) and while
 * streaming (in case Content-Length is absent, wrong, or chunked).
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume(); // drain without buffering
      reject(
        new ChatRequestError(
          "REQUEST_TOO_LARGE",
          `Request body exceeds the ${maxBytes}-byte limit.`,
          { status: 413 },
        ),
      );
      return;
    }

    let received = 0;
    const chunks = [];
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      fn(value);
    };

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        settle(
          reject,
          new ChatRequestError(
            "REQUEST_TOO_LARGE",
            `Request body exceeds the ${maxBytes}-byte limit.`,
            { status: 413 },
          ),
        );
        // Drain and discard the rest of the body rather than destroying
        // the socket: destroying req also tears down res, which would
        // stop the 413 response above from ever reaching the client.
        // Draining also keeps a keep-alive connection framed correctly
        // for whatever request follows on the same socket.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        settle(
          reject,
          new ChatRequestError("INVALID_INPUT", "Request body must be valid JSON."),
        );
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        settle(
          reject,
          new ChatRequestError("INVALID_INPUT", "Request body must be valid JSON."),
        );
        return;
      }
      settle(resolve, parsed);
    });

    req.on("error", () => {
      settle(
        reject,
        new ChatRequestError("INVALID_INPUT", "Request body could not be read."),
      );
    });
  });
}

/**
 * Validates the optional `context` field: `{ filename: string, text:
 * string }`, the bounded plain text of one explicitly user-selected local
 * file (YUZUKI-DESKTOP-CONTEXT-FILES-P0-IMPLEMENTATION-001). Returns
 * `undefined` if `context` itself is absent — the field is fully
 * optional and every existing context-less call must behave identically.
 *
 * No `source_type` discriminator: P0 has exactly one kind of source, and
 * adding a discriminator for a union of one is premature.
 */
function validateContext(context) {
  if (context === undefined) return undefined;

  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new ChatRequestError("INVALID_CONTEXT", '"context" must be a JSON object.');
  }

  const unexpected = Object.keys(context).filter((key) => key !== "filename" && key !== "text");
  if (unexpected.length > 0) {
    throw new ChatRequestError(
      "INVALID_CONTEXT",
      `Unsupported field(s) in "context": ${unexpected.join(", ")}. Only "filename" and "text" are accepted.`,
    );
  }

  if (typeof context.filename !== "string") {
    throw new ChatRequestError("INVALID_CONTEXT", '"context.filename" is required and must be a string.');
  }
  const filename = context.filename.trim();
  if (filename.length === 0 || filename.length > MAX_CONTEXT_FILENAME_LENGTH) {
    throw new ChatRequestError(
      "INVALID_CONTEXT",
      `"context.filename" must be 1-${MAX_CONTEXT_FILENAME_LENGTH} characters.`,
    );
  }
  // A genuine browser-sourced File.name never contains a path separator —
  // this is defense-in-depth against a malformed/malicious client, and
  // directly enforces path privacy at the server boundary too, not only
  // architecturally by never asking for a path in the first place.
  if (filename.includes("/") || filename.includes("\\")) {
    throw new ChatRequestError("INVALID_CONTEXT", '"context.filename" must not contain a path separator.');
  }
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex === -1 ? "" : filename.slice(dotIndex).toLowerCase();
  if (!ALLOWED_CONTEXT_EXTENSIONS.includes(extension)) {
    throw new ChatRequestError(
      "INVALID_CONTEXT",
      `"context.filename" must end in one of: ${ALLOWED_CONTEXT_EXTENSIONS.join(", ")}.`,
    );
  }

  if (typeof context.text !== "string") {
    throw new ChatRequestError("INVALID_CONTEXT", '"context.text" is required and must be a string.');
  }
  if (context.text.length > MAX_CONTEXT_TEXT_LENGTH) {
    throw new ChatRequestError(
      "CONTEXT_TOO_LARGE",
      `"context.text" exceeds the ${MAX_CONTEXT_TEXT_LENGTH}-character limit.`,
    );
  }
  // 0-length text is valid (an admitted empty file) — never rejected here.
  if (containsBinaryLikeControlChars(context.text)) {
    throw new ChatRequestError("INVALID_CONTEXT", '"context.text" appears to contain binary data, not text.');
  }
  if (looksLikeCredential(context.text)) {
    // Same posture as message's own CREDENTIAL_SHAPED_INPUT_REJECTED:
    // echoed back only in this response, never logged or stored. The
    // scanner is content-shape-based, not source-based — no reason to
    // exempt file-derived text from the same protective check applied to
    // typed text.
    throw new ChatRequestError(
      "CREDENTIAL_SHAPED_INPUT_REJECTED",
      "The attached file looks like it contains a credential or secret. It was not stored, logged, or forwarded — only echoed back here so you can confirm and remove it before resending.",
      { details: { echoed_context_text: context.text } },
    );
  }

  return { filename, text: context.text };
}

/**
 * Validates a parsed chat request body. Only `message`, `session_id`,
 * `route_mode`, and the optional `context` are accepted — any other
 * field is rejected, so a future run cannot smuggle a new field (a
 * location, an account reference) past this endpoint without that
 * change being visible as a validation failure. See readiness plan
 * §2.2's "Future expansion risk" note.
 *
 * Returns the normalized message, route mode, and (if present) context.
 * Provider/model identifiers remain server-owned and cannot be supplied
 * through this request boundary.
 */
export function validateChatRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ChatRequestError("INVALID_INPUT", "Request body must be a JSON object.");
  }

  const unexpected = Object.keys(body).filter(
    (key) => key !== "message" && key !== "session_id" && key !== "route_mode" && key !== "context",
  );
  if (unexpected.length > 0) {
    throw new ChatRequestError(
      "INVALID_INPUT",
      `Unsupported field(s): ${unexpected.join(", ")}. Only "message", "session_id", "route_mode", and "context" are accepted.`,
    );
  }

  if (body.session_id !== undefined && !isValidSessionId(body.session_id)) {
    throw new ChatRequestError("INVALID_SESSION_ID", '"session_id" is not a recognizable session id.');
  }

  const routeMode = body.route_mode ?? ROUTE_MODE.AUTO;
  if (typeof routeMode !== "string" || !Object.values(ROUTE_MODE).includes(routeMode)) {
    throw new ChatRequestError(
      "INVALID_ROUTE",
      '"route_mode" must be one of AUTO, BALANCED, DEEP, or LOCAL.',
    );
  }

  if (typeof body.message !== "string") {
    throw new ChatRequestError("INVALID_INPUT", '"message" is required and must be a string.');
  }

  const trimmed = body.message.trim();
  if (trimmed.length === 0) {
    throw new ChatRequestError("INVALID_INPUT", '"message" must not be empty or whitespace-only.');
  }

  if (body.message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatRequestError(
      "MESSAGE_TOO_LONG",
      `"message" exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`,
    );
  }

  if (looksLikeCredential(body.message)) {
    // Echoed back (not persisted, not logged) per readiness plan §2.2 —
    // "reject anything that looks like a credential/secret being pasted
    // for storage (echo back, do not persist)". The value is returned
    // only in this same synchronous HTTP response to the caller that
    // already has it; it is never written to a log, console, or store.
    throw new ChatRequestError(
      "CREDENTIAL_SHAPED_INPUT_REJECTED",
      "The message looks like it contains a credential or secret. It was not stored, logged, or forwarded — only echoed back here so you can confirm and remove it before resending.",
      { details: { echoed_message: trimmed } },
    );
  }

  const context = validateContext(body.context);

  return { message: trimmed, routeMode, context };
}
