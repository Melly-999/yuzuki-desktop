import type { RuntimeActionTier } from "../lib/capabilityStateAdapter";

export type ApprovalStatus =
  | "REVIEW_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "STALE";
// NOT_REQUIRED is a fact about a tier (see requiresApproval), not a value
// this module's request objects ever carry — a READ/DRAFT action never
// gets an ApprovalRequest at all. EXECUTION_UNAVAILABLE is likewise never
// stored on `status` — see getExecutionAvailability. EXPIRED is
// P0_VISIBLE_FUTURE and unreachable; EXECUTION_PENDING/EXECUTED/
// EXECUTION_FAILED are DEFER and do not exist in this module.

export type MaterialFields = {
  actionTier: RuntimeActionTier;
  actionSummary: string;
  targetSummary: string;
  targetKind: string;
};

export type ApprovalRequest = MaterialFields & {
  approvalId: string;
  sessionId: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
};

export type ProposeActionInput = MaterialFields & { sessionId: string };
export type DecisionRef = { approvalId: string; sessionId: string };

export function requiresApproval(actionTier: RuntimeActionTier): boolean;
export function isMaterialChange(a: MaterialFields, b: MaterialFields): boolean;
export function proposeAction(input: ProposeActionInput): ApprovalRequest;
export function reviewProposal(request: ApprovalRequest): ApprovalRequest;
export function approveProposal(request: ApprovalRequest, ref: DecisionRef): ApprovalRequest;
export function rejectProposal(request: ApprovalRequest, ref: DecisionRef): ApprovalRequest;
export function cancelProposal(request: ApprovalRequest, ref: DecisionRef): ApprovalRequest;
export function applyMaterialUpdate(request: ApprovalRequest, updatedFields: MaterialFields): ApprovalRequest;
export function getExecutionAvailability(request: ApprovalRequest): "EXECUTION_UNAVAILABLE" | "N/A";
export function isTerminal(request: ApprovalRequest): boolean;
export function describeApprovalReason(actionTier: RuntimeActionTier): string;
