import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROLLED_ACTION_PHASE,
  createControlledActionExample,
  createControlledActionState,
  isBoundCuaApproval,
  reduceControlledActionEvent,
} from "./controlledActions.mjs";

const proposal = {
  action_id: "action-1",
  operation: "CLICK_TARGET",
  target: "INCREMENT_BUTTON",
  fixture_id: "fixture-1",
  fixed_title: "Yuzuki CUA Fixture",
  binding_digest: "digest-1",
  expected_effect: "Increment the counter once.",
};

const approval = {
  request_id: "request-1",
  session_id: "session-1",
  command: "CLICK_TARGET INCREMENT_BUTTON",
  description: "Increment the counter once.",
  pattern_key: "cua_fixture:CLICK_TARGET:INCREMENT_BUTTON",
  smart_denied: false,
  received_at: "2026-09-06T00:00:00.000Z",
  revision: "session-1:request-1",
  state: "AWAITING_APPROVAL",
  approval_kind: "cua_fixture",
  action_id: "action-1",
  operation: "CLICK_TARGET",
  target: "INCREMENT_BUTTON",
  fixture_id: "fixture-1",
  fixed_title: "Yuzuki CUA Fixture",
  binding_digest: "digest-1",
  choices: ["once", "deny"],
  allow_session: false,
  allow_permanent: false,
};

function receipt(overrides = {}) {
  return {
    schema_version: 1,
    action_id: "action-1",
    approval_request_id: "request-1",
    session_id: "session-1",
    requested_operation: "CLICK_TARGET",
    resolved_target: {
      semantic_target: "INCREMENT_BUTTON",
      fixed_title: "Yuzuki CUA Fixture",
      fixture_id: "fixture-1",
      binding_digest: "digest-1",
    },
    timestamps: { started_monotonic: 1, ended_monotonic: 1.2, duration_ms: 200 },
    start_state: { counter: 0, revision: 0, echo_length: 0, echo_sha256: "0".repeat(64) },
    end_state: { counter: 1, revision: 1, echo_length: 0, echo_sha256: "0".repeat(64) },
    result: "SUCCEEDED",
    verification: { outcome: "VERIFIED", predicate: "Counter increments exactly once." },
    side_effect_summary: "Counter incremented exactly once.",
    driver: { version: "0.23.2", permission_mode: "bounded", manifest_sha256: "a".repeat(64) },
    reason: null,
    ...overrides,
  };
}

test("the presentation lifecycle follows Hermes events without granting authority", () => {
  let state = createControlledActionState({ available: true });
  state = reduceControlledActionEvent(state, { kind: "proposal", proposal });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.PROPOSED);
  state = reduceControlledActionEvent(state, { kind: "approval", approval });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.AWAITING_APPROVAL);
  state = reduceControlledActionEvent(state, { kind: "activity", activity: { state: "APPROVED", title: "Permission approved" } });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.APPROVED);
  state = reduceControlledActionEvent(state, { kind: "action_start", action: { action_id: "action-1" } });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.EXECUTING);
  state = reduceControlledActionEvent(state, { kind: "receipt", receipt: receipt() });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.VERIFIED);
});

test("only the exact once/deny non-persistable envelope is actionable", () => {
  assert.equal(isBoundCuaApproval(approval, "action-1"), true);
  assert.equal(isBoundCuaApproval({ ...approval, choices: ["once", "session", "deny"] }, "action-1"), false);
  assert.equal(isBoundCuaApproval({ ...approval, allow_session: true }, "action-1"), false);
  assert.equal(isBoundCuaApproval({ ...approval, action_id: "other-action" }, "action-1"), false);
  assert.equal(isBoundCuaApproval({ ...approval, binding_digest: undefined }, "action-1"), false);
});

test("mismatched action evidence fails closed instead of becoming verified", () => {
  let state = reduceControlledActionEvent(createControlledActionState({ available: true }), { kind: "proposal", proposal });
  state = reduceControlledActionEvent(state, { kind: "approval", approval: { ...approval, action_id: "other-action" } });
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.FAILED);
  assert.equal(state.approval, null);

  state = reduceControlledActionEvent(
    { ...createControlledActionState({ available: true }), proposal },
    { kind: "receipt", receipt: receipt({ action_id: "other-action" }) },
  );
  assert.equal(state.phase, CONTROLLED_ACTION_PHASE.FAILED);
});

test("denied, failed, unknown, and unavailable remain distinct terminal presentations", () => {
  const withProposal = { ...createControlledActionState({ available: true }), proposal };
  assert.equal(
    reduceControlledActionEvent(withProposal, { kind: "receipt", receipt: receipt({ result: "DENIED", verification: { outcome: "NOT_APPLICABLE", predicate: "No action." } }) }).phase,
    CONTROLLED_ACTION_PHASE.DENIED,
  );
  assert.equal(
    reduceControlledActionEvent(withProposal, { kind: "receipt", receipt: receipt({ result: "FAILED", end_state: null, verification: { outcome: "UNKNOWN", predicate: "Unknown." } }) }).phase,
    CONTROLLED_ACTION_PHASE.FAILED,
  );
  assert.equal(createControlledActionState().phase, CONTROLLED_ACTION_PHASE.UNAVAILABLE);
});

test("every dev visual state is explicitly marked as example evidence", () => {
  for (const phase of ["AWAITING_APPROVAL", "EXECUTING", "VERIFIED", "DENIED", "FAILED", "UNAVAILABLE"]) {
    const state = createControlledActionExample(phase);
    assert.equal(state.example, true);
    assert.equal(state.phase, phase);
  }
});
