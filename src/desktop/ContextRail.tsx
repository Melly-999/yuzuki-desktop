import { useRef, type ChangeEvent, type KeyboardEvent } from "react";
import type { RailTab, WorkspaceMode } from "./types";
import { StatusBadge } from "./StatusBadge";
import { FILE_PICKER_ACCEPT, describeFileSourceState, type FileSourceState } from "./fileContext";
import type { ApprovalRequest } from "./approvals";
import type { ControlledActionState } from "./controlledActions";
import { KnowledgeInspector } from "./knowledge/KnowledgeInspector";

const TAB_LABEL: Readonly<Record<RailTab, string>> = {
  context: "Context",
  files: "Files",
  review: "Review",
  approvals: "Approvals",
};

type Props = {
  /**
   * The rail modes that belong to what the user is currently doing. The rail
   * is one contextual surface, not four permanent panels — DesktopShell
   * decides which modes apply and hides the rail entirely where none do.
   */
  tabs: RailTab[];
  activeTab: RailTab;
  onTabChange: (tab: RailTab) => void;
  sessionSelected: boolean;
  fileState: FileSourceState;
  onFileSelected: (file: File) => void;
  onFileRemoved: () => void;
  approvals: ApprovalRequest[];
  onOpenApproval: (approvalId: string) => void;
  controlledAction: ControlledActionState;
  activeMode: WorkspaceMode;
  knowledgeInspectingId: string | null;
  onKnowledgeInspectClose: () => void;
};

const APPROVAL_STATUS_LABEL: Readonly<Record<ApprovalRequest["status"], string>> = {
  REVIEW_REQUIRED: "Review required",
  APPROVAL_REQUIRED: "Approval required",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  STALE: "Stale",
};

/** A short, bounded preview — never the full admitted text, per the accepted contract's own "do not build a document viewer" instruction. */
function previewText(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

export function ContextRail({
  tabs,
  activeTab,
  onTabChange,
  sessionSelected,
  fileState,
  onFileSelected,
  onFileRemoved,
  approvals,
  onOpenApproval,
  controlledAction,
  activeMode,
  knowledgeInspectingId,
  onKnowledgeInspectClose,
}: Props) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input's value so selecting the SAME file again still fires
    // a change event (browsers otherwise suppress a repeat "no-op"
    // selection) — needed for the "replace" flow to work every time.
    event.target.value = "";
    if (file) onFileSelected(file);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const nextIndex =
      event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    onTabChange(tabs[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  const fileErrorMessage = describeFileSourceState(fileState);
  const admittedFile = fileState.kind === "ready" ? fileState : null;
  const controlledActionVisible = controlledAction.phase !== "UNAVAILABLE" && controlledAction.phase !== "READY";

  return (
    <aside className="dz-rail" aria-label={tabs.map((tab) => TAB_LABEL[tab]).join(" and ")}>
      <div className="dz-rail-tabs" role="tablist" aria-label="Context rail tabs">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`dz-tab-${tab}`}
            aria-selected={activeTab === tab}
            aria-controls={`dz-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={`dz-rail-tab${activeTab === tab ? " is-active" : ""}`}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      {activeTab === "context" && (
        <div className="dz-rail-panel" role="tabpanel" id="dz-panel-context" aria-labelledby="dz-tab-context">
          {activeMode === "search" && knowledgeInspectingId ? (
            <KnowledgeInspector nodeId={knowledgeInspectingId} onClose={onKnowledgeInspectClose} />
          ) : sessionSelected ? (
            <>
              {admittedFile ? (
                <div className="dz-context-source">
                  <p className="dz-context-source-title">{admittedFile.filename}</p>
                  <p className="dz-rail-hint">Local only — not yet included in any request. Session-only; gone if this session ends.</p>
                </div>
              ) : (
                <p className="dz-rail-empty">No admitted context for this session.</p>
              )}
              <p className="dz-rail-hint">
                Context shown here would be limited to what you explicitly attach or reference — never a
                general memory or account connection.
              </p>
            </>
          ) : (
            <p className="dz-rail-empty">Select or start a conversation to see its context.</p>
          )}
        </div>
      )}

      {activeTab === "files" && (
        <div className="dz-rail-panel" role="tabpanel" id="dz-panel-files" aria-labelledby="dz-tab-files">
          {!sessionSelected && <p className="dz-rail-empty">Select or start a conversation to attach a file.</p>}

          {sessionSelected && (
            <>
              {/* Always mounted (never conditionally removed) so a NEW selection
                  while one is already admitted correctly replaces it — see
                  the implementation handoff §8/§16's "selecting a second
                  file replaces the first" decision. Only the visible
                  trigger label changes between "Add file" and "Replace
                  file". */}
              <input
                ref={fileInputRef}
                type="file"
                accept={FILE_PICKER_ACCEPT}
                onChange={handleFileInputChange}
                className="dz-file-input"
                id="dz-file-input"
              />

              {!admittedFile && (
                <>
                  <p className="dz-rail-empty">No file attached.</p>
                  <label htmlFor="dz-file-input" className="dz-file-add-button">
                    Add file
                  </label>
                  <p className="dz-rail-hint">
                    One local file at a time — .txt, .md, .json, or .csv, up to 100 KB. Read locally in your
                    browser; nothing is uploaded until you send a chat message.
                  </p>
                  {fileState.kind === "reading" && <p className="dz-rail-hint" role="status">Reading file…</p>}
                  {fileErrorMessage && (
                    <p className="dz-rail-hint dz-rail-hint-error" role="alert">
                      {fileErrorMessage}
                    </p>
                  )}
                </>
              )}

              {admittedFile && (
                <div className="dz-file-admitted">
                  <p className="dz-file-admitted-name">{admittedFile.filename}</p>
                  <p className="dz-rail-hint">
                    {admittedFile.text.length.toLocaleString()} character{admittedFile.text.length === 1 ? "" : "s"} —
                    read locally, not yet sent. Included with your next chat message only if you send one.
                  </p>
                  {admittedFile.text.length > 0 && (
                    <pre className="dz-file-preview">{previewText(admittedFile.text)}</pre>
                  )}
                  <div className="dz-file-actions">
                    <label htmlFor="dz-file-input" className="dz-file-add-button">
                      Replace file
                    </label>
                    <button type="button" className="dz-file-remove-button" onClick={onFileRemoved}>
                      Remove file
                    </button>
                  </div>
                  {fileErrorMessage && (
                    <p className="dz-rail-hint dz-rail-hint-error" role="alert">
                      {fileErrorMessage}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "review" &&
        (() => {
          // Review lists every proposal at this session, any status — a
          // compact "what would appear here" list (contract §14), not only
          // the pending-decision queue (that's the narrower Approvals tab
          // below).
          if (approvals.length === 0 && !controlledActionVisible) {
            return (
              <div className="dz-rail-panel" role="tabpanel" id="dz-panel-review" aria-labelledby="dz-tab-review">
                <p className="dz-rail-empty">Nothing awaiting review.</p>
                <p className="dz-rail-hint">
                  When a proposed draft or action exists, it appears here first — before anything can be approved.
                </p>
              </div>
            );
          }
          return (
            <div className="dz-rail-panel" role="tabpanel" id="dz-panel-review" aria-labelledby="dz-tab-review">
              {controlledActionVisible && (
                <div className="dz-approval-list-item" aria-current="true">
                  <span className="dz-approval-list-summary">
                    {String(controlledAction.proposal?.expected_effect ?? "Bounded controlled action")}
                  </span>
                  <span className="dz-approval-list-status">{controlledAction.phase.replace(/_/g, " ")}</span>
                </div>
              )}
              {approvals.map((request) => (
                <button
                  key={request.approvalId}
                  type="button"
                  className="dz-approval-list-item"
                  onClick={() => onOpenApproval(request.approvalId)}
                >
                  <span className="dz-approval-list-summary">{request.actionSummary}</span>
                  <span className="dz-approval-list-status">{APPROVAL_STATUS_LABEL[request.status]}</span>
                </button>
              ))}
            </div>
          );
        })()}

      {activeTab === "approvals" &&
        (() => {
          // Approvals is narrower than Review: only items actually at
          // APPROVAL_REQUIRED (contract §14) — the pending-decision queue.
          const pending = approvals.filter((request) => request.status === "APPROVAL_REQUIRED");
          const controlledPending = controlledAction.phase === "AWAITING_APPROVAL";
          if (pending.length === 0 && !controlledPending) {
            return (
              <div className="dz-rail-panel" role="tabpanel" id="dz-panel-approvals" aria-labelledby="dz-tab-approvals">
                <p className="dz-rail-empty">No approval-requiring capability enabled.</p>
                <StatusBadge status="DESIGNED / APPROVAL-BASED" />
                <p className="dz-rail-hint">
                  Decision preview only: rendering this rail authorizes nothing and enforces nothing.
                </p>
              </div>
            );
          }
          return (
            <div className="dz-rail-panel" role="tabpanel" id="dz-panel-approvals" aria-labelledby="dz-tab-approvals">
              {controlledPending && (
                <div className="dz-approval-list-item dz-approval-tier-write-local" aria-current="true">
                  <span className="dz-approval-list-summary">
                    {String(controlledAction.proposal?.expected_effect ?? "Bounded controlled action")}
                  </span>
                  <span className="dz-approval-list-status">Approval required</span>
                </div>
              )}
              {pending.map((request) => (
                <button
                  key={request.approvalId}
                  type="button"
                  className={`dz-approval-list-item dz-approval-tier-${request.actionTier.toLowerCase().replace(/_/g, "-")}`}
                  onClick={() => onOpenApproval(request.approvalId)}
                >
                  <span className="dz-approval-list-summary">{request.actionSummary}</span>
                  <span className="dz-approval-list-status">Approval required</span>
                </button>
              ))}
            </div>
          );
        })()}
    </aside>
  );
}
