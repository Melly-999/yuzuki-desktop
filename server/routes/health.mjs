import { sendJson } from "../lib/json.mjs";
import { SERVICE_NAME } from "../lib/productTruth.mjs";

/**
 * GET /api/health — confirms the scaffold process is up and states,
 * plainly, that it makes no live model calls, memory writes, or external
 * integrations. Not a claim about a deployed/production service.
 */
export function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    service: SERVICE_NAME,
    mode: "prototype",
    status: "SCAFFOLD_READY",
    live_model_calls: false,
    memory_writes: false,
    external_integrations: false,
  });
}
