import type { ComponentProps } from "react";
import { ChatPane } from "./ChatPane";
import { HomeWorkspace } from "./HomeWorkspace";
import { StatusBadge } from "./StatusBadge";
import { KnowledgeConstellation } from "./knowledge";
import type { CuaFixtureRequest, CuaFixtureState, HermesRuntimeInfo, HermesSearchResult } from "../lib/hermesApi";
import type { ActivityEntry, WorkspaceMode } from "./types";
import type { AdmittedFileSource } from "./fileContext";
import { describeApprovalReason, getExecutionAvailability, type ApprovalRequest } from "./approvals";
import { CuaFixtureLab } from "./CuaFixtureLab";
import { ControlledActionReview } from "./ControlledActionReview";
import type { ControlledActionState } from "./controlledActions";

/**
 * The in-workspace mode-tab strip was removed: it duplicated NavRail for the
 * same WorkspaceMode value, giving the shell two competing primary
 * navigations, and it advertised four modes that render only a PLANNED
 * placeholder. NavRail is now the single navigation. These modes are still
 * routable and still render their honestly labelled placeholder below.
 */
const PLACEHOLDER_COPY: Record<
  Exclude<WorkspaceMode, "chat" | "approval" | "search">,
  { title: string; body: string }
> = {
  today: { title: "Today", body: "A daily orientation surface for Yuzuki Desktop." },
  document: { title: "Document", body: "Review or draft a document alongside your conversation." },
  task: { title: "Task", body: "Inspect a proposed or tracked task." },
  preview: { title: "Preview", body: "View generated or attached content." },
};

const TIER_REASON: Readonly<Record<ApprovalRequest["actionTier"], string>> = {
  READ: "Reads existing information — no approval needed.",
  DRAFT: "Prepares content without acting on it — no approval needed.",
  WRITE_LOCAL: "This would write to your device.",
  EXTERNAL_ACTION: "This would leave your device.",
};

const TERMINAL_COPY: Readonly<Record<string, string>> = {
  REJECTED: "You declined this proposal. Nothing happened.",
  CANCELLED: "This proposal was dismissed before any decision was made. Nothing happened.",
  STALE: "This proposal changed after it was reviewed, so the earlier decision no longer applies. A new proposal is required.",
};

type Props = {
  activeMode: WorkspaceMode;
  /** The shell's single runtime-state value, forwarded to Chat. */
  hermes: HermesRuntimeInfo | null;
  onHermesInfo: (hermes: HermesRuntimeInfo) => void;
  home: ComponentProps<typeof HomeWorkspace>;
  initialDraft: { sessionId: string; text: string } | null;
  sessionId: string | null;
  sessionTitle: string | null;
  serverReachable: boolean;
  onActivity: (entry: Omit<ActivityEntry, "id" | "at">) => void;
  fileContext: AdmittedFileSource | null;
  approvals: ApprovalRequest[];
  selectedApprovalId: string | null;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onDismiss: (approvalId: string) => void;
  resumedHistory: { sessionId: string; messages: { role: string; text: string }[] } | null;
  onOpenSearchSession: (result: HermesSearchResult) => Promise<boolean>;
  cuaEnabled: boolean;
  cuaFixtureId: string | null;
  cuaObservedState: CuaFixtureState | null;
  cuaRunning: boolean;
  cuaError: string | null;
  onRunCua: (request: CuaFixtureRequest) => void;
  controlledAction: ControlledActionState;
  controlledActionDeciding: boolean;
  onControlledActionApproveOnce: () => void;
  onControlledActionDeny: () => void;
  knowledgeInspectingId: string | null;
  onKnowledgeInspectingChange: (id: string | null) => void;
};

function ApprovalCard({
  request,
  onApprove,
  onReject,
  onDismiss,
}: {
  request: ApprovalRequest;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onDismiss: (approvalId: string) => void;
}) {
  const tierClass = `dz-approval-tier-${request.actionTier.toLowerCase().replace(/_/g, "-")}`;
  const executionAvailability = getExecutionAvailability(request);

  return (
    <div className="dz-approval-card">
      <div className={`dz-approval-tier-badge ${tierClass}`}>{request.actionTier.replace(/_/g, " ")}</div>

      <dl className="dz-approval-fields">
        <div>
          <dt>Action</dt>
          <dd>{request.actionSummary}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{request.targetSummary}</dd>
        </div>
        <div>
          <dt>Why approval is required</dt>
          <dd>{TIER_REASON[request.actionTier] ?? describeApprovalReason(request.actionTier)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{request.status.replace(/_/g, " ")}</dd>
        </div>
      </dl>

      {request.status === "APPROVAL_REQUIRED" && (
        <div className="dz-approval-actions">
          <button type="button" className="dz-approval-approve" onClick={() => onApprove(request.approvalId)}>
            Approve
          </button>
          <button type="button" className="dz-approval-reject" onClick={() => onReject(request.approvalId)}>
            Reject
          </button>
          <button type="button" className="dz-approval-dismiss" onClick={() => onDismiss(request.approvalId)}>
            Dismiss
          </button>
        </div>
      )}

      {request.status === "APPROVED" && (
        <div className="dz-approval-outcome" role="status">
          <p className="dz-approval-outcome-approved">Approved.</p>
          {executionAvailability === "EXECUTION_UNAVAILABLE" && (
            <p className="dz-approval-outcome-execution">
              Execution unavailable — no executor is connected to this decision. Approving does not mean this
              action happened; nothing was sent, saved, or changed.
            </p>
          )}
        </div>
      )}

      {TERMINAL_COPY[request.status] && (
        <p className="dz-approval-outcome" role="status">
          {TERMINAL_COPY[request.status]}
        </p>
      )}
    </div>
  );
}

export function MainWorkspace({
  activeMode,
  hermes,
  onHermesInfo,
  home,
  initialDraft,
  sessionId,
  sessionTitle,
  serverReachable,
  onActivity,
  fileContext,
  approvals,
  selectedApprovalId,
  onApprove,
  onReject,
  onDismiss,
  resumedHistory,
  onOpenSearchSession,
  cuaEnabled,
  cuaFixtureId,
  cuaObservedState,
  cuaRunning,
  cuaError,
  onRunCua,
  controlledAction,
  controlledActionDeciding,
  onControlledActionApproveOnce,
  onControlledActionDeny,
  knowledgeInspectingId,
  onKnowledgeInspectingChange,
}: Props) {
  const selectedApproval = approvals.find((request) => request.approvalId === selectedApprovalId) ?? null;

  return (
    <main className="dz-main" id="dz-main-content">
      <div className="dz-main-body" style={activeMode === "search" ? { padding: 0 } : undefined}>
        {activeMode === "chat" && (
          <ChatPane
            hermes={hermes}
            onHermesInfo={onHermesInfo}
            sessionId={sessionId}
            sessionTitle={sessionTitle}
            serverReachable={serverReachable}
            onActivity={onActivity}
            fileContext={fileContext}
            resumedHistory={resumedHistory}
            initialDraft={initialDraft}
          />
        )}

        {activeMode === "search" && (
          <KnowledgeConstellation
            inspectingId={knowledgeInspectingId}
            onInspectingChange={onKnowledgeInspectingChange}
          />
        )}

        {activeMode === "approval" &&
          (selectedApproval ? (
            <div className="dz-placeholder dz-placeholder-approval">
              <ApprovalCard request={selectedApproval} onApprove={onApprove} onReject={onReject} onDismiss={onDismiss} />
            </div>
          ) : (
            <ControlledActionReview
              state={controlledAction}
              deciding={controlledActionDeciding}
              onApproveOnce={onControlledActionApproveOnce}
              onDeny={onControlledActionDeny}
            />
          ))}

        {activeMode !== "chat" &&
          activeMode !== "approval" &&
          activeMode !== "search" && (
          <div className="dz-placeholder">
            <StatusBadge status="PLANNED" />
            <h2>{PLACEHOLDER_COPY[activeMode].title}</h2>
            <p>{PLACEHOLDER_COPY[activeMode].body}</p>
            <p className="dz-placeholder-note">Not connected in this prototype.</p>
          </div>
        )}
      </div>
    </main>
  );
}
