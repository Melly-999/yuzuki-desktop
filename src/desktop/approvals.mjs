/**
 * Bounded, ephemeral, session-scoped Review + Approvals state machine for
 * Yuzuki Desktop (YUZUKI-DESKTOP-REVIEW-APPROVALS-P0-IMPLEMENTATION-001).
 * Implements docs/product/YUZUKI_DESKTOP_REVIEW_APPROVALS_P0_CONTRACT.md.
 *
 * Written as plain JavaScript (not .ts) so this exact runtime file is
 * directly importable by both Vite (the Desktop client) and Node's test
 * runner (approvals.test.mjs) with zero build step — the same reasoning
 * server/lib/*.mjs already follows, applied to a frontend-owned module for
 * the first time in this repository. See approvals.d.ts for the paired
 * TypeScript declarations `.tsx` consumers get typechecked against.
 *
 * Mandatory distinctions this module exists to keep structurally visible
 * (contract §1), not merely documented in prose:
 *
 *   REVIEW             != APPROVAL
 *   APPROVAL           != EXECUTION
 *   EXECUTION ELIGIBLE != EXECUTED
 *   MODEL INTELLIGENCE != ACTION AUTHORITY
 *
 * No function in this module ever calls, schedules, or references any
 * executor. There is no execution path here to hide — EXECUTION_UNAVAILABLE
 * is not a placeholder for a future call site living elsewhere in this
 * file; it is this file's own, permanent, only possible terminal outcome
 * for an approved action, because P0 has no executor anywhere (contract
 * §9, §25).
 *
 * Only a real, explicit, user-driven UI action may ever call
 * approveProposal/rejectProposal/cancelProposal — see this module's own
 * exports: no function here accepts or interprets chat/model output text
 * as a decision (contract §23, "MODEL INTELLIGENCE != ACTION AUTHORITY").
 */

const TERMINAL_STATUSES = new Set(["APPROVED", "REJECTED", "CANCELLED", "STALE"]);

/**
 * Runtime action tiers this module accepts — reused verbatim from
 * src/lib/capabilityStateAdapter.ts's RuntimeActionTier, not redefined:
 * "READ" | "DRAFT" | "WRITE_LOCAL" | "EXTERNAL_ACTION".
 *
 * Tier -> approval requirement (contract §5, reconciled with the existing
 * RUNTIME_ACTION_TIER_CLASSIFICATION/resolveWriteLocalTreatment seam in
 * capabilityStateAdapter.ts): READ and DRAFT are DIRECT — no proposal is
 * ever created for them by this module at all (an ordinary chat turn needs
 * no Runtime request, contract §16 row for ConfirmationLevel NONE).
 * WRITE_LOCAL and EXTERNAL_ACTION both always require Review then Approval
 * here — WRITE_LOCAL because this repository holds no per-operation
 * ELIGIBLE table (capabilityStateAdapter.ts's own resolveWriteLocalTreatment
 * already refuses to resolve WRITE_LOCAL to anything but the fail-closed
 * treatment absent that evidence), and EXTERNAL_ACTION unconditionally per
 * contract §5's own table.
 */
export function requiresApproval(actionTier) {
  return actionTier === "WRITE_LOCAL" || actionTier === "EXTERNAL_ACTION";
}

function nowIso() {
  return new Date().toISOString();
}

function randomApprovalId() {
  // Reuses the platform-native UUID generator already used throughout this
  // repository for session_id/message_id/turn_id (node:crypto's
  // randomUUID server-side; the Web Crypto equivalent here, since this
  // module runs in the browser) — no new identity-generation mechanism.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node test-runner fallback (older Node without a global `crypto`) —
  // never reached in the shipped browser build.
  return `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function materialFields(request) {
  return {
    actionTier: request.actionTier,
    actionSummary: request.actionSummary,
    targetSummary: request.targetSummary,
    targetKind: request.targetKind,
  };
}

/**
 * True if any of the six contract §13 material dimensions differ. This
 * repository's proposal shape covers four of the six named fields
 * directly (targetSummary, actionTier, actionSummary, targetKind); the
 * other two ("any time/date or amount embedded in the summary" and
 * dataSensitivity) are explicitly folded into actionSummary/targetKind
 * respectively per the contract's own §13 table ("content-level change,
 * covered by the summary field above, not a separate mechanism").
 */
export function isMaterialChange(a, b) {
  return (
    a.actionTier !== b.actionTier ||
    a.actionSummary !== b.actionSummary ||
    a.targetSummary !== b.targetSummary ||
    a.targetKind !== b.targetKind
  );
}

/**
 * Creates a brand-new Approval Request (contract §7). Every call mints a
 * fresh approvalId — this is the whole of this module's replay defense
 * (contract §24): two proposals with byte-identical fields still receive
 * different, independent identities, so a semantically-similar re-ask can
 * never silently inherit a prior decision.
 *
 * Only WRITE_LOCAL/EXTERNAL_ACTION proposals are meaningful inputs here —
 * a READ/DRAFT-tier "proposal" needs no Approval Request at all
 * (requiresApproval() above); callers should not invoke this for those
 * tiers, though doing so is harmless (it starts at REVIEW_REQUIRED and can
 * only ever be reviewed, never gated on approval it doesn't need — see
 * reviewProposal()).
 */
export function proposeAction({ sessionId, actionTier, actionSummary, targetSummary, targetKind }) {
  return {
    approvalId: randomApprovalId(),
    sessionId,
    actionTier,
    actionSummary,
    targetSummary,
    targetKind,
    status: "REVIEW_REQUIRED",
    createdAt: nowIso(),
  };
}

/**
 * Moves a REVIEW_REQUIRED proposal to APPROVAL_REQUIRED once the user has
 * actually opened Review (contract §6: "Review must occur before Approval
 * ... no control may skip straight to an approval prompt"). A no-op
 * (returns the same request unchanged) if called from any other state —
 * reviewing does not un-terminate a decided proposal.
 */
export function reviewProposal(request) {
  if (request.status !== "REVIEW_REQUIRED") return request;
  return { ...request, status: "APPROVAL_REQUIRED" };
}

/**
 * Records the user's approval — and ONLY the user's, since this is the
 * sole path that can ever set status "APPROVED" and it takes no
 * model/chat input of any kind. Requires the exact approvalId AND the
 * exact sessionId the proposal was raised under (contract §21, §24 —
 * cross-session reuse must be rejected, not merely discouraged). Approving
 * a WRITE_LOCAL/EXTERNAL_ACTION proposal never itself executes anything —
 * there is no executor for this function to call, so it always leaves the
 * caller to separately render EXECUTION_UNAVAILABLE (see
 * getExecutionAvailability below) rather than folding that fact into this
 * status value, keeping "APPROVED" and "EXECUTION_UNAVAILABLE" two visibly
 * distinct fields, never merged into one word (contract §9).
 */
export function approveProposal(request, { approvalId, sessionId }) {
  if (request.sessionId !== sessionId) {
    throw new Error("Cross-session approval rejected: this approval_id does not belong to the given session.");
  }
  if (request.approvalId !== approvalId) {
    throw new Error("approval_id mismatch: cannot approve a different proposal.");
  }
  if (request.status !== "APPROVAL_REQUIRED") return request;
  return { ...request, status: "APPROVED", decidedAt: nowIso() };
}

/** Symmetric to approveProposal — same identity/session guards, sets REJECTED (contract §12). */
export function rejectProposal(request, { approvalId, sessionId }) {
  if (request.sessionId !== sessionId) {
    throw new Error("Cross-session rejection rejected: this approval_id does not belong to the given session.");
  }
  if (request.approvalId !== approvalId) {
    throw new Error("approval_id mismatch: cannot reject a different proposal.");
  }
  if (request.status !== "APPROVAL_REQUIRED" && request.status !== "REVIEW_REQUIRED") return request;
  return { ...request, status: "REJECTED", decidedAt: nowIso() };
}

/**
 * Abandons a proposal before any decision was recorded (contract §12 —
 * distinct from REJECTED, which is an explicit decline). A no-op on an
 * already-terminal request: a decision, once made, is not retroactively
 * "cancelled."
 */
export function cancelProposal(request, { approvalId, sessionId }) {
  if (request.sessionId !== sessionId) {
    throw new Error("Cross-session cancellation rejected: this approval_id does not belong to the given session.");
  }
  if (request.approvalId !== approvalId) {
    throw new Error("approval_id mismatch: cannot cancel a different proposal.");
  }
  if (TERMINAL_STATUSES.has(request.status)) return request;
  return { ...request, status: "CANCELLED", decidedAt: nowIso() };
}

/**
 * Applies newer proposal data to an existing request. If any material
 * field (contract §13) actually changed, the request becomes STALE
 * regardless of its current status (even APPROVED — approval never equals
 * execution, so there is always a window in which the underlying proposal
 * could still change, contract §13). A cosmetic-only update (no material
 * field changed) is a no-op. A request that is already REJECTED/CANCELLED
 * never gets silently mutated back to life by this function — a materially
 * different proposal after a terminal decision requires a brand-new
 * proposeAction() call (a new approvalId), never a mutation of the old one.
 */
export function applyMaterialUpdate(request, updatedFields) {
  if (request.status === "REJECTED" || request.status === "CANCELLED") return request;
  if (!isMaterialChange(materialFields(request), updatedFields)) return request;
  return { ...request, ...updatedFields, status: "STALE", decidedAt: undefined };
}

/**
 * The execution-availability fact for a request — always, structurally,
 * EXECUTION_UNAVAILABLE for any APPROVED request at P0, because no
 * executor exists anywhere in this codebase to consult (contract §9,
 * §25). Kept as its own function (not folded into `status`) specifically
 * so "approved" and "cannot execute" remain two separately-computed,
 * separately-rendered facts, never collapsed into one.
 */
export function getExecutionAvailability(request) {
  return request.status === "APPROVED" ? "EXECUTION_UNAVAILABLE" : "N/A";
}

/** True once a request can no longer transition (contract §8's four decided/stale states). */
export function isTerminal(request) {
  return TERMINAL_STATUSES.has(request.status);
}

/** Compact, human-readable "why approval is required" text (contract §15) — never the raw tier enum alone. */
export function describeApprovalReason(actionTier) {
  if (actionTier === "EXTERNAL_ACTION") return "This would leave your device.";
  if (actionTier === "WRITE_LOCAL") return "This would write to your device.";
  return "";
}
