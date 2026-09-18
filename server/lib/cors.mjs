/**
 * Minimal CORS handling for the local HERMES API scaffold.
 *
 * Only localhost/127.0.0.1 origins (any port) are reflected back, since
 * this server is a local development scaffold, not a deployed API — see
 * docs/backend/HERMES_BACKEND_READINESS_PLAN.md. No production CORS
 * policy is implied by this file.
 *
 * `tauri.localhost` is included alongside `localhost`/`127.0.0.1` because
 * that is the Tauri desktop shell's real page origin for a bundled release
 * build (Tauri's Windows asset protocol serves the app from
 * `http://tauri.localhost`, not from a `localhost`/`127.0.0.1` URL) — see
 * `src-tauri/src/main.rs`'s `WebviewUrl::App` usage. Without it, the
 * desktop app's own in-page fetches to this API are blocked by the
 * browser's CORS enforcement even though the server itself responds fine
 * (curl and other non-browser clients don't enforce CORS, so this gap is
 * invisible to anything but the actual webview).
 */
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?$/;

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN_PATTERN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Handles an OPTIONS preflight request. Returns true if it handled (and
 * ended) the response, so the caller should stop further routing.
 */
export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
