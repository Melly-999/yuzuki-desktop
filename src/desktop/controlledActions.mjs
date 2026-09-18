/**
 * Presentation state for one Hermes-owned bounded action.
 *
 * This module never classifies, authorizes, executes, retries, or verifies an
 * action. It only reduces the already-sanitized events that Hermes emitted so
 * the React surface can keep proposal, decision, execution, and verification
 * visibly distinct.
 */

export const CONTROLLED_ACTION_PHASE = Object.freeze({
  UNAVAILABLE: "UNAVAILABLE",
  READY: "READY",
  PROPOSED: "PROPOSED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  EXECUTING: "EXECUTING",
  VERIFIED: "VERIFIED",
  DENIED: "DENIED",
  FAILED: "FAILED",
});

const REQUIRED_BINDING_FIELDS = [
  "action_id",
  "operation",
  "target",
  "fixture_id",
  "fixed_title",
  "binding_digest",
];

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function failed(state, message) {
  return {
    ...state,
    phase: CONTROLLED_ACTION_PHASE.FAILED,
    approval: null,
    message,
  };
}

function actionIdOf(event) {
  if (event?.kind === "proposal") return event.proposal?.action_id;
  if (event?.kind === "approval") return event.approval?.action_id;
  if (event?.kind === "action_start") return event.action?.action_id;
  if (event?.kind === "receipt") return event.receipt?.action_id;
  if (event?.kind === "complete") return event.result?.receipt?.action_id ?? event.result?.action_id;
  return null;
}

export function createControlledActionState({ available = false, example = false } = {}) {
  return {
    phase: available ? CONTROLLED_ACTION_PHASE.READY : CONTROLLED_ACTION_PHASE.UNAVAILABLE,
    proposal: null,
    approval: null,
    receipt: null,
    message: null,
    example,
  };
}

/**
 * A decision control is rendered only for the complete action-bound envelope
 * Hermes promised. Missing material fields, broader choices, or persistable
 * approvals are presentation failures and remain non-actionable.
 */
export function isBoundCuaApproval(approval, expectedActionId = null) {
  if (!approval || approval.approval_kind !== "cua_fixture") return false;
  if (!REQUIRED_BINDING_FIELDS.every((field) => nonEmptyString(approval[field]))) return false;
  if (expectedActionId && approval.action_id !== expectedActionId) return false;
  if (!Array.isArray(approval.choices) || approval.choices.length !== 2) return false;
  if (approval.choices[0] !== "once" || approval.choices[1] !== "deny") return false;
  return approval.allow_session === false && approval.allow_permanent === false;
}

function reduceReceipt(state, receipt) {
  if (!receipt || !nonEmptyString(receipt.action_id)) {
    return failed(state, "Hermes returned an unreadable receipt. The action is not verified.");
  }
  const expectedActionId = state.proposal?.action_id ?? state.approval?.action_id ?? null;
  if (expectedActionId && receipt.action_id !== expectedActionId) {
    return failed(state, "The receipt did not match the reviewed action. The action is not verified.");
  }

  if (receipt.result === "DENIED") {
    return {
      ...state,
      phase: CONTROLLED_ACTION_PHASE.DENIED,
      approval: null,
      receipt,
      message: "Hermes denied the action. Nothing was executed.",
    };
  }
  if (
    receipt.result === "SUCCEEDED" &&
    receipt.verification?.outcome === "VERIFIED" &&
    receipt.end_state !== null
  ) {
    return {
      ...state,
      phase: CONTROLLED_ACTION_PHASE.VERIFIED,
      approval: null,
      receipt,
      message: null,
    };
  }
  return {
    ...state,
    phase: CONTROLLED_ACTION_PHASE.FAILED,
    approval: null,
    receipt,
    message:
      receipt.verification?.outcome === "UNKNOWN"
        ? "Hermes could not verify the terminal state. Observe again before another action."
        : "The bounded action did not complete with verified evidence.",
  };
}

export function reduceControlledActionEvent(state, event) {
  if (!event || typeof event.kind !== "string") return state;

  if (event.kind === "proposal") {
    const proposal = event.proposal;
    if (!proposal || !["action_id", "operation", "target", "fixture_id", "fixed_title"].every((field) => nonEmptyString(proposal[field]))) {
      return failed(state, "Hermes returned an incomplete proposal. No decision is available.");
    }
    return {
      ...createControlledActionState({ available: true }),
      phase: CONTROLLED_ACTION_PHASE.PROPOSED,
      proposal,
    };
  }

  if (event.kind === "approval") {
    const expectedActionId = state.proposal?.action_id ?? null;
    if (!isBoundCuaApproval(event.approval, expectedActionId)) {
      return failed(state, "The approval was not bound to the exact proposal. No decision is available.");
    }
    const proposal = state.proposal ?? {
      action_id: event.approval.action_id,
      operation: event.approval.operation,
      target: event.approval.target,
      fixture_id: event.approval.fixture_id,
      fixed_title: event.approval.fixed_title,
      binding_digest: event.approval.binding_digest,
      expected_effect: event.approval.description,
      expires_at: event.approval.expires_at,
    };
    return {
      ...state,
      phase: CONTROLLED_ACTION_PHASE.AWAITING_APPROVAL,
      proposal,
      approval: event.approval,
      message: null,
      example: false,
    };
  }

  if (event.kind === "activity") {
    if (event.activity?.state === "APPROVED") {
      return { ...state, phase: CONTROLLED_ACTION_PHASE.APPROVED, approval: null, message: null };
    }
    if (event.activity?.state === "DENIED") {
      return { ...state, phase: CONTROLLED_ACTION_PHASE.DENIED, approval: null, message: "Hermes denied the action. Nothing was executed." };
    }
    return state;
  }

  if (event.kind === "action_start") {
    const expectedActionId = state.proposal?.action_id ?? state.approval?.action_id ?? null;
    if (!expectedActionId || actionIdOf(event) !== expectedActionId) {
      return failed(state, "Execution evidence did not match the reviewed action. The action is not verified.");
    }
    return { ...state, phase: CONTROLLED_ACTION_PHASE.EXECUTING, approval: null, message: null };
  }

  if (event.kind === "receipt") return reduceReceipt(state, event.receipt);

  if (event.kind === "complete") {
    if (event.result?.receipt) return reduceReceipt(state, event.result.receipt);
    if (event.result?.action_id) return reduceReceipt(state, event.result);
    if (event.result?.observation?.state) {
      return { ...createControlledActionState({ available: true }), phase: CONTROLLED_ACTION_PHASE.READY };
    }
    return state;
  }

  if (event.kind === "error") {
    return failed(state, typeof event.message === "string" ? event.message : "The bounded action failed.");
  }

  return state;
}

/** Dev/test-only visual states. Callers must keep `example: true` visible. */
export function createControlledActionExample(phase) {
  const actionId = "example-action";
  const proposal = {
    action_id: actionId,
    operation: "CLICK_TARGET",
    target: "INCREMENT_BUTTON",
    fixture_id: "example-fixture",
    fixed_title: "Yuzuki bounded fixture",
    binding_digest: "example-binding",
    expected_effect: "Increment the isolated fixture counter once.",
  };
  const approval = {
    request_id: "example-approval",
    session_id: "example-session",
    command: "CLICK_TARGET INCREMENT_BUTTON",
    description: proposal.expected_effect,
    pattern_key: "cua_fixture:CLICK_TARGET:INCREMENT_BUTTON",
    smart_denied: false,
    received_at: "",
    revision: "example-session:example-approval",
    state: "AWAITING_APPROVAL",
    approval_kind: "cua_fixture",
    action_id: actionId,
    operation: proposal.operation,
    target: proposal.target,
    fixture_id: proposal.fixture_id,
    fixed_title: proposal.fixed_title,
    binding_digest: proposal.binding_digest,
    choices: ["once", "deny"],
    allow_session: false,
    allow_permanent: false,
  };
  const base = { ...createControlledActionState({ available: phase !== CONTROLLED_ACTION_PHASE.UNAVAILABLE, example: true }), proposal };
  if (phase === CONTROLLED_ACTION_PHASE.AWAITING_APPROVAL) return { ...base, phase, approval };
  if (phase === CONTROLLED_ACTION_PHASE.EXECUTING) return { ...base, phase };
  if (phase === CONTROLLED_ACTION_PHASE.VERIFIED) {
    return {
      ...base,
      phase,
      receipt: {
        action_id: actionId,
        result: "SUCCEEDED",
        verification: { outcome: "VERIFIED", predicate: "Counter increments exactly once." },
        side_effect_summary: "Counter incremented exactly once.",
        resolved_target: { semantic_target: proposal.target, fixed_title: proposal.fixed_title, fixture_id: proposal.fixture_id },
        timestamps: { duration_ms: 184 },
      },
    };
  }
  if (phase === CONTROLLED_ACTION_PHASE.DENIED) return { ...base, phase, message: "Hermes denied the action. Nothing was executed." };
  if (phase === CONTROLLED_ACTION_PHASE.FAILED) return { ...base, phase, message: "Hermes could not verify the terminal state. No success is claimed." };
  if (phase === CONTROLLED_ACTION_PHASE.UNAVAILABLE) return { ...createControlledActionState({ example: true }) };
  return { ...base, phase };
}
