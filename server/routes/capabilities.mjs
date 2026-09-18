import { sendJson } from "../lib/json.mjs";
import { CAPABILITIES } from "../lib/productTruth.mjs";
import { getPersistenceStatus } from "../lib/sessionStore.mjs";

/**
 * GET /api/capabilities — machine-readable capability registry. Every
 * entry names a future or in-progress capability and its product-truth
 * status; none are live. See server/lib/productTruth.mjs for the single
 * source of truth these values are drawn from.
 *
 * `session_persistence` is the one entry computed live rather than served
 * as a static string: its status reflects the durable store's actual,
 * current health (PERSISTENCE_AVAILABLE / PERSISTENCE_UNAVAILABLE /
 * DATABASE_CORRUPT / MIGRATION_FAILED / MIGRATION_REQUIRED) rather than a
 * fixed claim — see server/lib/sessionStore.mjs's failure posture.
 */
export function handleCapabilities(req, res) {
  const persistence = getPersistenceStatus();
  sendJson(res, 200, {
    ok: true,
    capabilities: {
      ...CAPABILITIES,
      session_persistence: {
        ...CAPABILITIES.session_persistence,
        status: persistence.status,
        ...(persistence.detail ? { detail: persistence.detail } : {}),
      },
    },
  });
}
