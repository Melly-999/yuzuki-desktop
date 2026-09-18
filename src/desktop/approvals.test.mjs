import assert from "node:assert/strict";
import test from "node:test";
import {
  requiresApproval,
  isMaterialChange,
  proposeAction,
  reviewProposal,
  approveProposal,
  rejectProposal,
  cancelProposal,
  applyMaterialUpdate,
  getExecutionAvailability,
  isTerminal,
  describeApprovalReason,
} from "./approvals.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";

function makeProposal(overrides = {}) {
  return proposeAction({
    sessionId,
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "Send an email to Alex",
    targetSummary: "alex@example.com",
    targetKind: "email_recipient",
    ...overrides,
  });
}

function refFor(request) {
  return { approvalId: request.approvalId, sessionId: request.sessionId };
}

// --- Permission tiers (contract §5, §16) ---

test("READ and DRAFT never require approval; WRITE_LOCAL and EXTERNAL_ACTION always do", () => {
  assert.equal(requiresApproval("READ"), false);
  assert.equal(requiresApproval("DRAFT"), false);
  assert.equal(requiresApproval("WRITE_LOCAL"), true);
  assert.equal(requiresApproval("EXTERNAL_ACTION"), true);
});

// --- Review surface (contract §6) ---

test("a new proposal starts at REVIEW_REQUIRED, not APPROVAL_REQUIRED — Review must occur first", () => {
  const request = makeProposal();
  assert.equal(request.status, "REVIEW_REQUIRED");
});

test("reviewing a REVIEW_REQUIRED proposal moves it to APPROVAL_REQUIRED", () => {
  const reviewed = reviewProposal(makeProposal());
  assert.equal(reviewed.status, "APPROVAL_REQUIRED");
});

test("reviewing is a no-op from any other state (cannot re-review a decided proposal)", () => {
  // Reviewing an already-APPROVAL_REQUIRED request must not regress or
  // otherwise mutate it.
  const stillApprovalRequired = reviewProposal(reviewProposal(makeProposal()));
  assert.equal(stillApprovalRequired.status, "APPROVAL_REQUIRED");

  const reviewed = reviewProposal(makeProposal());
  const approved = approveProposal(reviewed, refFor(reviewed));
  const reReviewed = reviewProposal(approved);
  assert.equal(reReviewed.status, "APPROVED", "reviewing an already-decided request must not change its status");
});

// --- Approval transitions (contract §7, §8, §9) ---

test("explicit approval transitions APPROVAL_REQUIRED to APPROVED, bound to the exact approval_id", () => {
  const reviewed = reviewProposal(makeProposal());
  const approved = approveProposal(reviewed, refFor(reviewed));
  assert.equal(approved.status, "APPROVED");
  assert.ok(approved.decidedAt);
});

test("approval cannot skip Review — approving a still-REVIEW_REQUIRED proposal is a no-op", () => {
  const request = makeProposal();
  const attempted = approveProposal(request, refFor(request));
  assert.equal(attempted.status, "REVIEW_REQUIRED");
});

test("an approved EXTERNAL_ACTION proposal reports EXECUTION_UNAVAILABLE, distinct from its own APPROVED status", () => {
  const reviewed = reviewProposal(makeProposal({ actionTier: "EXTERNAL_ACTION" }));
  const approved = approveProposal(reviewed, refFor(reviewed));
  assert.equal(approved.status, "APPROVED");
  assert.equal(getExecutionAvailability(approved), "EXECUTION_UNAVAILABLE");
});

test("an approved WRITE_LOCAL proposal also reports EXECUTION_UNAVAILABLE — no executor exists for any tier", () => {
  const reviewed = reviewProposal(makeProposal({ actionTier: "WRITE_LOCAL", targetKind: "local_file" }));
  const approved = approveProposal(reviewed, refFor(reviewed));
  assert.equal(getExecutionAvailability(approved), "EXECUTION_UNAVAILABLE");
});

test("a request that has not been approved reports N/A execution availability, never EXECUTION_UNAVAILABLE prematurely", () => {
  assert.equal(getExecutionAvailability(makeProposal()), "N/A");
  const reviewed = reviewProposal(makeProposal());
  assert.equal(getExecutionAvailability(reviewed), "N/A");
  const rejected = rejectProposal(reviewed, refFor(reviewed));
  assert.equal(getExecutionAvailability(rejected), "N/A", "a rejected request must never report EXECUTION_UNAVAILABLE — that implies it was approved");
});

test("Reject transitions to REJECTED and is terminal", () => {
  const reviewed = reviewProposal(makeProposal());
  const rejected = rejectProposal(reviewed, refFor(reviewed));
  assert.equal(rejected.status, "REJECTED");
  assert.ok(isTerminal(rejected));
});

test("Reject also works directly from REVIEW_REQUIRED (declining before an approval prompt is even shown)", () => {
  const request = makeProposal();
  const rejected = rejectProposal(request, refFor(request));
  assert.equal(rejected.status, "REJECTED");
});

test("Cancel transitions an undecided request to CANCELLED and is terminal", () => {
  const request = makeProposal();
  const cancelled = cancelProposal(request, refFor(request));
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(isTerminal(cancelled));
});

test("Cancel is a no-op on an already-decided (terminal) request", () => {
  const reviewed = reviewProposal(makeProposal());
  const approved = approveProposal(reviewed, refFor(reviewed));
  const cancelled = cancelProposal(approved, refFor(approved));
  assert.equal(cancelled.status, "APPROVED", "an approved decision must not be retroactively cancelled");
});

// --- Staleness (contract §13) ---

test("a material change (target changes) makes an APPROVAL_REQUIRED proposal STALE", () => {
  const reviewed = reviewProposal(makeProposal());
  const updated = applyMaterialUpdate(reviewed, {
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "Send an email to Alex",
    targetSummary: "someone-else@example.com",
    targetKind: "email_recipient",
  });
  assert.equal(updated.status, "STALE");
});

test("a material change even after APPROVED makes it STALE — approval never equals execution, so the window remains open", () => {
  const reviewed = reviewProposal(makeProposal());
  const approved = approveProposal(reviewed, refFor(reviewed));
  const mutated = applyMaterialUpdate(approved, {
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "Send a DIFFERENT email to Alex",
    targetSummary: "alex@example.com",
    targetKind: "email_recipient",
  });
  assert.equal(mutated.status, "STALE");
});

test("a cosmetic-only update (no material field actually different) is a no-op, not STALE", () => {
  const reviewed = reviewProposal(makeProposal());
  const unchanged = applyMaterialUpdate(reviewed, {
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "Send an email to Alex",
    targetSummary: "alex@example.com",
    targetKind: "email_recipient",
  });
  assert.equal(unchanged.status, "APPROVAL_REQUIRED");
});

test("a STALE approval cannot be reused — approving/rejecting it is a no-op, a fresh proposal is required", () => {
  const reviewed = reviewProposal(makeProposal());
  const approved = approveProposal(reviewed, refFor(reviewed));
  const stale = applyMaterialUpdate(approved, {
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "Send a DIFFERENT email",
    targetSummary: "alex@example.com",
    targetKind: "email_recipient",
  });
  assert.equal(stale.status, "STALE");
  const reapproveAttempt = approveProposal(stale, refFor(stale));
  assert.equal(reapproveAttempt.status, "STALE", "a stale request cannot be approved directly — it is not APPROVAL_REQUIRED");
});

test("isMaterialChange treats each of the four tracked dimensions independently", () => {
  const base = { actionTier: "EXTERNAL_ACTION", actionSummary: "a", targetSummary: "b", targetKind: "c" };
  assert.equal(isMaterialChange(base, { ...base }), false);
  assert.equal(isMaterialChange(base, { ...base, actionTier: "WRITE_LOCAL" }), true);
  assert.equal(isMaterialChange(base, { ...base, actionSummary: "different" }), true);
  assert.equal(isMaterialChange(base, { ...base, targetSummary: "different" }), true);
  assert.equal(isMaterialChange(base, { ...base, targetKind: "different" }), true);
});

// --- Cross-session boundary (contract §21, §24) ---

test("approving with the wrong session_id is rejected outright, never silently authorizing across sessions", () => {
  const reviewed = reviewProposal(makeProposal());
  assert.throws(
    () => approveProposal(reviewed, { approvalId: reviewed.approvalId, sessionId: otherSessionId }),
    /[Cc]ross-session/,
  );
  // The request itself is untouched by the rejected attempt.
  assert.equal(reviewed.status, "APPROVAL_REQUIRED");
});

test("rejecting and cancelling are equally session-bound", () => {
  const reviewed = reviewProposal(makeProposal());
  assert.throws(() => rejectProposal(reviewed, { approvalId: reviewed.approvalId, sessionId: otherSessionId }), /[Cc]ross-session/);
  assert.throws(() => cancelProposal(reviewed, { approvalId: reviewed.approvalId, sessionId: otherSessionId }), /[Cc]ross-session/);
});

test("approving with a mismatched approval_id (same session) is rejected — approval_id, not session or text, is the binding identity", () => {
  const reviewed = reviewProposal(makeProposal());
  assert.throws(
    () => approveProposal(reviewed, { approvalId: "not-the-real-id", sessionId: reviewed.sessionId }),
    /approval_id mismatch/,
  );
});

// --- Replay (contract §24) ---

test("replaying/re-asking the same semantic action yields a brand-new, independent approval_id — never a reused one", () => {
  const first = makeProposal();
  const second = makeProposal(); // identical fields, same tier/summary/target
  assert.notEqual(first.approvalId, second.approvalId);
  // Deciding the first has zero effect on the second.
  const approvedFirst = approveProposal(reviewProposal(first), refFor(first));
  assert.equal(approvedFirst.status, "APPROVED");
  assert.equal(second.status, "REVIEW_REQUIRED");
});

test("a rejected request cannot be silently mutated back to an active state by applyMaterialUpdate", () => {
  const request = makeProposal();
  const rejected = rejectProposal(request, refFor(request));
  const attempted = applyMaterialUpdate(rejected, {
    actionTier: "EXTERNAL_ACTION",
    actionSummary: "totally different",
    targetSummary: "totally different",
    targetKind: "different_kind",
  });
  assert.equal(attempted.status, "REJECTED", "a decided REJECTED request must stay REJECTED, never silently reopened");
});

// --- Approval reason copy (contract §15) ---

test("describeApprovalReason names the concrete consequence, not the raw tier enum", () => {
  assert.match(describeApprovalReason("EXTERNAL_ACTION"), /leave your device/i);
  assert.match(describeApprovalReason("WRITE_LOCAL"), /write to your device/i);
});

// --- No executor exists anywhere in this module (contract §9, §17, §18 of the task) ---

test("this module exports no execution function of any kind", () => {
  const exportNames = ["requiresApproval", "isMaterialChange", "proposeAction", "reviewProposal", "approveProposal", "rejectProposal", "cancelProposal", "applyMaterialUpdate", "getExecutionAvailability", "isTerminal", "describeApprovalReason"];
  for (const name of exportNames) {
    assert.ok(!/execute|dispatch|^send|^create[A-Z]|^delete[A-Z]/i.test(name), `export "${name}" must not look like an executor`);
  }
});
