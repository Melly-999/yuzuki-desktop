/**
 * Table-driven verification of docs/product/HERMES_CAPABILITY_STATE_ADAPTER_SPEC.md
 * §8's acceptance table, executed directly against the real adapter module
 * (no mock, no reimplementation) via Node's built-in TypeScript support —
 * no dependency was added to run this.
 *
 * Run with: node scripts/verify-capability-adapter.mjs
 */

import assert from "node:assert/strict";
import {
  classifyExternalActionOutcome,
  RUNTIME_ACTION_TIER_CLASSIFICATION,
  resolveWriteLocalTreatment,
  toCapabilityDisplayModel,
} from "../src/lib/capabilityStateAdapter.ts";

let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("Spec §8 rows 1-10 — toCapabilityDisplayModel:");

check("row 1: NOT IMPLEMENTED IN THIS PROTOTYPE -> unavailable, not actionable", () => {
  const m = toCapabilityDisplayModel("NOT IMPLEMENTED IN THIS PROTOTYPE");
  assert.equal(m.evidenceState, "UNAVAILABLE");
  assert.equal(m.label, "NOT IMPLEMENTED IN THIS PROTOTYPE");
  assert.equal(m.tone, "unavailable");
  assert.equal(m.actionable, false);
});

check("row 2: PROTOTYPE -> IMPLEMENTED, prototype, actionable", () => {
  const m = toCapabilityDisplayModel("PROTOTYPE");
  assert.equal(m.evidenceState, "IMPLEMENTED");
  assert.equal(m.label, "PROTOTYPE");
  assert.equal(m.tone, "prototype");
  assert.equal(m.actionable, true);
});

check("row 3: EXAMPLE DATA -> LIMITED, example, not actionable", () => {
  const m = toCapabilityDisplayModel("EXAMPLE DATA");
  assert.equal(m.evidenceState, "LIMITED");
  assert.equal(m.label, "EXAMPLE DATA");
  assert.equal(m.tone, "example");
  assert.equal(m.actionable, false);
});

check("row 4: PLANNED -> FUTURE, planned, not actionable", () => {
  const m = toCapabilityDisplayModel("PLANNED");
  assert.equal(m.evidenceState, "FUTURE");
  assert.equal(m.label, "PLANNED");
  assert.equal(m.tone, "planned");
  assert.equal(m.actionable, false);
});

check("row 5: COMING LATER -> FUTURE, planned, not actionable", () => {
  const m = toCapabilityDisplayModel("COMING LATER");
  assert.equal(m.evidenceState, "FUTURE");
  assert.equal(m.label, "COMING LATER");
  assert.equal(m.tone, "planned");
  assert.equal(m.actionable, false);
});

check("row 6: NOT_IMPLEMENTED_IN_THIS_PROTOTYPE (API snake_case) -> spaced label, unavailable", () => {
  const m = toCapabilityDisplayModel("NOT_IMPLEMENTED_IN_THIS_PROTOTYPE");
  assert.equal(m.evidenceState, "UNAVAILABLE");
  assert.equal(m.label, "NOT IMPLEMENTED IN THIS PROTOTYPE");
  assert.equal(m.tone, "unavailable");
  assert.equal(m.actionable, false);
});

check("row 7: DESIGNED_APPROVAL_BASED (API snake_case) -> SPECIFIED, designed", () => {
  const m = toCapabilityDisplayModel("DESIGNED_APPROVAL_BASED");
  assert.equal(m.evidenceState, "SPECIFIED");
  assert.equal(m.label, "DESIGNED / APPROVAL-BASED");
  assert.equal(m.tone, "designed");
  assert.equal(m.actionable, false);
});

check("row 8: NOT A LIVE PRODUCT -> UNAVAILABLE, unavailable", () => {
  const m = toCapabilityDisplayModel("NOT A LIVE PRODUCT");
  assert.equal(m.evidenceState, "UNAVAILABLE");
  assert.equal(m.label, "NOT A LIVE PRODUCT");
  assert.equal(m.tone, "unavailable");
  assert.equal(m.actionable, false);
});

check("row 9: unknown value fails closed, rendered verbatim uppercased", () => {
  const m = toCapabilityDisplayModel("totally-unknown-value-xyz");
  assert.equal(m.evidenceState, "UNAVAILABLE");
  assert.equal(m.label, "TOTALLY-UNKNOWN-VALUE-XYZ");
  assert.equal(m.tone, "unavailable");
  assert.equal(m.actionable, false);
});

check("row 10 (anchor regression): string containing both NOT IMPLEMENTED and PROTOTYPE resolves unavailable, never prototype", () => {
  const m = toCapabilityDisplayModel("NOT IMPLEMENTED IN THIS PROTOTYPE");
  assert.equal(m.tone, "unavailable");
  assert.notEqual(m.tone, "prototype");
});

console.log("\nAdditional precedence and fail-closed coverage:");

check("IMPLEMENTED_NOT_LIVE_VERIFIED maps exactly to a conservative unavailable tone", () => {
  const m = toCapabilityDisplayModel("IMPLEMENTED_NOT_LIVE_VERIFIED");
  assert.equal(m.evidenceState, "LIMITED");
  assert.equal(m.label, "IMPLEMENTED NOT LIVE VERIFIED");
  assert.equal(m.tone, "unavailable");
  assert.equal(m.actionable, false);
});

check("PROHIBITED-equivalent phrase takes precedence and never resolves positive", () => {
  const m = toCapabilityDisplayModel("PROHIBITED FOR THIS OPERATION");
  assert.equal(m.evidenceState, "PROHIBITED");
  assert.equal(m.tone, "unavailable");
});

check("composite string with both PROHIBITED and PROTOTYPE still resolves PROHIBITED, never prototype", () => {
  const m = toCapabilityDisplayModel("PROHIBITED IN THIS PROTOTYPE");
  assert.equal(m.evidenceState, "PROHIBITED");
  assert.notEqual(m.tone, "prototype");
});

check("composite hero string 'PRIVATE PERSONAL AI • PROTOTYPE' resolves prototype tone", () => {
  const m = toCapabilityDisplayModel("PRIVATE PERSONAL AI • PROTOTYPE");
  assert.equal(m.tone, "prototype");
});

check("EXPLORATORY / SPEC ONLY (spaced) -> PROPOSED, designed", () => {
  const m = toCapabilityDisplayModel("EXPLORATORY / SPEC ONLY");
  assert.equal(m.evidenceState, "PROPOSED");
  assert.equal(m.tone, "designed");
  assert.equal(m.actionable, false);
});

check("EXPLORATORY_SPEC_ONLY (API snake_case, pwa) -> PROPOSED, designed", () => {
  const m = toCapabilityDisplayModel("EXPLORATORY_SPEC_ONLY");
  assert.equal(m.evidenceState, "PROPOSED");
  assert.equal(m.label, "EXPLORATORY / SPEC ONLY");
  assert.equal(m.tone, "designed");
});

check("FOUNDATION is an exact match only, not a substring match", () => {
  const exact = toCapabilityDisplayModel("FOUNDATION");
  assert.equal(exact.tone, "foundation");
  const substring = toCapabilityDisplayModel("THE FOUNDATION OF THIS PLAN IS PLANNED");
  // "PLANNED" is checked before the exact-only FOUNDATION/IN PROGRESS step,
  // so this composite resolves planned, not foundation by accidental substring.
  assert.equal(substring.tone, "planned");
});

check("empty string fails closed to UNAVAILABLE/unavailable", () => {
  const m = toCapabilityDisplayModel("");
  assert.equal(m.evidenceState, "UNAVAILABLE");
  assert.equal(m.tone, "unavailable");
});

console.log("\nSpec §8 rows 11-15 — Runtime action-tier contract (types/constants, not wired into live UI):");

check("row 11/12: READ and DRAFT classify DIRECT", () => {
  assert.equal(RUNTIME_ACTION_TIER_CLASSIFICATION.READ, "DIRECT");
  assert.equal(RUNTIME_ACTION_TIER_CLASSIFICATION.DRAFT, "DIRECT");
});

check("row 13: EXTERNAL_ACTION explicit-approval outcome is confirmable/DIRECT", () => {
  const outcome = classifyExternalActionOutcome("EXPLICIT_APPROVAL");
  assert.equal(outcome.classification, "DIRECT");
  assert.equal(outcome.confirmable, true);
});

check("row 14: EXTERNAL_ACTION hard-blocked outcome renders no confirm control", () => {
  const outcome = classifyExternalActionOutcome("HARD_BLOCKED");
  assert.equal(outcome.classification, "PROHIBITED");
  assert.equal(outcome.confirmable, false);
});

check("row 14b: EXTERNAL_ACTION unknown outcome fails closed to non-confirmable, never DIRECT", () => {
  const outcome = classifyExternalActionOutcome("UNKNOWN");
  assert.notEqual(outcome.classification, "DIRECT");
  assert.equal(outcome.confirmable, false);
});

check("row 15: WRITE_LOCAL without operation-specific evidence resolves to the stricter UNAVAILABLE treatment", () => {
  assert.equal(RUNTIME_ACTION_TIER_CLASSIFICATION.WRITE_LOCAL, "NEEDS_DECISION");
  assert.equal(resolveWriteLocalTreatment(false), "UNAVAILABLE");
  assert.equal(resolveWriteLocalTreatment(true), "NEEDS_DECISION");
});

console.log(`\n${passed} checks passed.`);
