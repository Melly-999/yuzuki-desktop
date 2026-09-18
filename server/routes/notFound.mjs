import { sendJson } from "../lib/json.mjs";

/**
 * Fallback for any unmatched method/path under this API.
 */
export function handleNotFound(req, res) {
  sendJson(res, 404, {
    error: "NOT_FOUND",
    message: "Unknown HERMES API route.",
  });
}
