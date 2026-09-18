import type { CuaReceipt, CuaStreamEvent, HermesApproval } from "../lib/hermesApi";

export type ControlledActionPhase =
  | "UNAVAILABLE"
  | "READY"
  | "PROPOSED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFIED"
  | "DENIED"
  | "FAILED";

export type ControlledActionProposal = {
  action_id: string;
  operation: string;
  target: string;
  fixture_id: string;
  fixed_title: string;
  binding_digest?: string;
  expected_effect?: string;
  expires_at?: number;
  [key: string]: unknown;
};

export type ControlledActionState = {
  phase: ControlledActionPhase;
  proposal: ControlledActionProposal | null;
  approval: HermesApproval | null;
  receipt: CuaReceipt | null;
  message: string | null;
  example: boolean;
};

export const CONTROLLED_ACTION_PHASE: Readonly<Record<ControlledActionPhase, ControlledActionPhase>>;
export function createControlledActionState(options?: { available?: boolean; example?: boolean }): ControlledActionState;
export function isBoundCuaApproval(approval: HermesApproval | null | undefined, expectedActionId?: string | null): boolean;
export function reduceControlledActionEvent(state: ControlledActionState, event: CuaStreamEvent): ControlledActionState;
export function createControlledActionExample(phase: ControlledActionPhase): ControlledActionState;
