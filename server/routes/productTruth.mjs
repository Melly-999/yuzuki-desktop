import { sendJson } from "../lib/json.mjs";
import {
  PROJECT_STATUS,
  WHAT_EXISTS,
  WHAT_DOES_NOT_EXIST,
  FUTURE_CAPABILITY_LABELING_RULE,
  NO_LIVE_INTEGRATION_DISCLAIMER,
} from "../lib/productTruth.mjs";

/**
 * GET /api/product-truth — makes the product-truth baseline in
 * docs/context-pack/04_PRODUCT_TRUTH_AND_SAFETY.md machine-readable, so a
 * future frontend/API wiring task can render it instead of hardcoding
 * copy that can drift from the documented truth.
 */
export function handleProductTruth(req, res) {
  sendJson(res, 200, {
    ok: true,
    project_status: PROJECT_STATUS,
    prototype_warning:
      "HERMES is a frontend visual prototype with a local API scaffold. It is not production.",
    what_exists: WHAT_EXISTS,
    what_does_not_exist: WHAT_DOES_NOT_EXIST,
    future_capability_labeling_rule: FUTURE_CAPABILITY_LABELING_RULE,
    no_live_integration_disclaimer: NO_LIVE_INTEGRATION_DISCLAIMER,
  });
}
