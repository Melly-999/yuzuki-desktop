import { useEffect, useRef, useState } from "react";
import {
  checkApiHealth,
  createHermesSession,
  resumeHermesSession,
  fetchHermesSessions,
  fetchPendingApprovals,
  fetchHermesStatus,
  respondToApproval,
  streamCuaFixtureAction,
  type CuaFixtureRequest,
  type CuaFixtureResponse,
  type CuaFixtureState,
  type CuaStreamEvent,
  type HermesApproval,
  type HermesRuntimeInfo,
  type HermesSearchResult,
  type HermesSessionSummary,
} from "../lib/hermesApi";
import "./desktop.css";
import { TopBar } from "./TopBar";
import { NavRail } from "./NavRail";
import { MainWorkspace } from "./MainWorkspace";
import { ContextRail } from "./ContextRail";
import { ActivityDock } from "./ActivityDock";
import { useDesktopPreferences } from "./useDesktopPreferences";
import type { ActivityEntry, RailTab, WorkspaceMode } from "./types";
import { IDLE_FILE_STATE, validateAndReadFile, type FileSourceState } from "./fileContext";
import { deriveKnowledgeCategories, deriveToday, greetingFor, layoutConstellation } from "./homeData";
import { resolveActiveSession } from "./sessionIdentity";
import { proposeAction, reviewProposal, approveProposal, rejectProposal, cancelProposal, applyMaterialUpdate, type ApprovalRequest } from "./approvals";
import {
  CONTROLLED_ACTION_PHASE,
  createControlledActionExample,
  createControlledActionState,
  isBoundCuaApproval,
  reduceControlledActionEvent,
  type ControlledActionPhase,
  type ControlledActionState,
} from "./controlledActions";

/**
 * Placeholder name for a conversation Hermes has just opened but that has
 * no turns yet. Hermes titles a conversation from its first message, so
 * this is deliberately a neutral label and never a claim about content.
 */
const NEW_CONVERSATION_TITLE = "New conversation";

/** Stop reasons after which Hermes has disposed the fixture binding. */
const CUA_BINDING_LOST_REASONS = new Set([
  "TARGET_LOST",
  "TARGET_CHANGED",
  "UNEXPECTED_MODAL",
  "VERIFICATION_FAILURE",
  "INTERNAL_FAILURE",
]);

let activityCounter = 0;
function nextActivityId() {
  activityCounter += 1;
  return `activity-${activityCounter}`;
}

/**
 * The Yuzuki Desktop shell: TopBar + NavRail (Zone A) + MainWorkspace
 * (Zone B) + ContextRail (Zone C) + ActivityDock (Zone D), per
 * docs/product/YUZUKI_DESKTOP_WORKSPACE_EXPERIENCE_CONTRACT.md. This is
 * the P0 shell only — real model-backed chat is not implemented here; the
 * chat pane talks to the existing local server's canned prototype
 * endpoint via the existing typed client, exactly as the mobile
 * `/app-preview` chat already does.
 */
export function DesktopShell() {
  const cuaEnabled = import.meta.env.DEV && new URLSearchParams(window.location.search).get("cua_fixture") === "1";
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { theme, setTheme, layout, setLayout } = useDesktopPreferences();
  const [serverState, setServerState] = useState<"checking" | "reachable" | "unreachable">("checking");
  const [resumedHermesSession, setResumedHermesSession] = useState<{
    sessionId: string;
    title: string;
    messages: { role: string; text: string }[];
  } | null>(null);
  // The ONE selected-session identity every consumer reads. Only a
  // Hermes-owned session may answer "which conversation is on screen?".
  const activeSession = resolveActiveSession({ resumed: resumedHermesSession });
  const activeSessionId = activeSession.sessionId;
  const activeSessionTitle = activeSession.title;
  const [creatingSession, setCreatingSession] = useState(false);
  const [activeMode, setActiveMode] = useState<WorkspaceMode>("chat");
  // Home's data sources. Availability is tracked SEPARATELY from the arrays
  // because fetchHermesSessions/fetchPendingApprovals both swallow transport
  // errors and return [] — so an empty array alone cannot be rendered as a
  // real zero without inventing a live status. See homeData.mjs.
  const [hermesSessions, setHermesSessions] = useState<HermesSessionSummary[]>([]);
  const [hermesSessionsAvailable, setHermesSessionsAvailable] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<HermesApproval[]>([]);
  const [approvalsAvailable, setApprovalsAvailable] = useState(false);
  const [hermesInfo, setHermesInfo] = useState<HermesRuntimeInfo | null>(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  // Text typed into Home's command entry, handed to ChatPane once the new
  // session exists. Seeds the composer only; never sends.
  const [pendingDraft, setPendingDraft] = useState<{ sessionId: string; text: string } | null>(null);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("context");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [knowledgeInspectingId, setKnowledgeInspectingId] = useState<string | null>(null);
  // Ephemeral, session-scoped, client-only file context
  // (YUZUKI-DESKTOP-CONTEXT-FILES-P0-IMPLEMENTATION-001). Never written to
  // localStorage, never reconstructed from SQLite/Durable Sessions — a
  // page reload or app restart clears it, by design (contract §8).
  const [fileContextBySession, setFileContextBySession] = useState<Record<string, FileSourceState>>({});
  // Ephemeral, session-scoped Review + Approvals state
  // (YUZUKI-DESKTOP-REVIEW-APPROVALS-P0-IMPLEMENTATION-001). Approval
  // eligibility is EPHEMERAL_P0 — never written to SQLite, never restored
  // after a reload/restart (contract §20). Nothing in this shipped app
  // calls proposeAction() during normal use; see the dev-only QA hook
  // below for how a proposal is ever created at all today.
  const [approvalsBySession, setApprovalsBySession] = useState<Record<string, ApprovalRequest[]>>({});
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  // Presentation state only. Hermes still owns action identity, authority,
  // execution and verification; this reducer consumes its bounded events.
  const [controlledAction, setControlledAction] = useState<ControlledActionState>(() => createControlledActionState());
  const [controlledActionDeciding, setControlledActionDeciding] = useState(false);
  const [cuaFixtureId, setCuaFixtureId] = useState<string | null>(null);
  const [cuaObservedState, setCuaObservedState] = useState<CuaFixtureState | null>(null);
  const [cuaRunning, setCuaRunning] = useState(false);
  const [cuaError, setCuaError] = useState<string | null>(null);

  function logActivity(entry: Omit<ActivityEntry, "id" | "at">) {
    setActivity((prev) => [{ ...entry, id: nextActivityId(), at: new Date().toISOString() }, ...prev].slice(0, 20));
  }

  /**
   * Load the Hermes-owned sources Home reads. Yuzuki stores none of this and
   * owns no second index — these are straight reads of the canonical
   * Hermes-side state.
   *
   * `fetchHermesSessions` and `fetchPendingApprovals` return [] on transport
   * failure, so they cannot themselves distinguish empty from unreachable.
   * `fetchHermesStatus` returns null on failure and is served by the same
   * bridge, so it is used as the real availability signal: if the bridge is
   * not answering, both sources are marked unavailable rather than zero.
   */
  async function loadHomeData() {
    setHomeLoading(true);
    const status = await fetchHermesStatus();
    if (!mountedRef.current) return;
    setHermesInfo(status);

    const bridgeAnswering = status !== null;
    if (!bridgeAnswering) {
      setHermesSessions([]);
      setHermesSessionsAvailable(false);
      setPendingApprovals([]);
      setApprovalsAvailable(false);
      setHomeLoading(false);
      return;
    }

    const [sessions, approvals] = await Promise.all([fetchHermesSessions(), fetchPendingApprovals()]);
    if (!mountedRef.current) return;
    setHermesSessions(sessions);
    setHermesSessionsAvailable(true);
    setPendingApprovals(approvals);
    setApprovalsAvailable(true);
    if (cuaEnabled) {
      const pendingCua = approvals.find((approval) => isBoundCuaApproval(approval));
      if (pendingCua) {
        setControlledAction((previous) =>
          reduceControlledActionEvent(previous, { kind: "approval", approval: pendingCua }),
        );
      }
    }
    setHomeLoading(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    checkApiHealth(controller.signal).then((outcome) => {
      if (!mountedRef.current) return;
      setServerState(outcome.kind === "reachable" ? "reachable" : "unreachable");
    });
    void loadHomeData();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "New conversation" opens a real canonical Hermes conversation and
   * adopts it, because Hermes — not Yuzuki — owns conversation identity.
   *
   * It deliberately does NOT create a local durable-session row any more.
   * A local row is not a conversation: it made the shell display a fresh
   * conversation while the bridge still pointed at the previous canonical
   * session, so the next turn was appended to the OLD conversation.
   * Adopting the new Hermes id into `resumedHermesSession` is what makes
   * the transcript, composer, banner, Context rail and Activity context
   * all name the same new session (see resolveActiveSession).
   */
  async function handleCreateSession() {
    if (creatingSession) return;
    setCreatingSession(true);
    const created = await createHermesSession();
    if (!mountedRef.current) return;
    setCreatingSession(false);

    if (!created) {
      // Fail visibly and leave the previous conversation exactly as it
      // was. Showing an empty "new conversation" Hermes never opened
      // would be the same false-canonical state this path exists to fix.
      logActivity({
        title: "Could not start a new conversation",
        detail: "The local Hermes runtime did not open a new conversation.",
        tag: "error",
      });
      return;
    }

    setResumedHermesSession({ sessionId: created.session_id, title: NEW_CONVERSATION_TITLE, messages: [] });
    setActiveMode("chat");
    logActivity({ title: "New conversation", detail: created.session_id, tag: "prototype" });
  }

  /**
   * Home's command entry. Creates a real session through the existing
   * endpoint and carries the typed text across as a composer draft — it
   * never sends on the user's behalf.
   */
  async function handleStartConversation(draft: string) {
    if (creatingSession) return;
    setCreatingSession(true);
    const created = await createHermesSession();
    if (!mountedRef.current) return;
    setCreatingSession(false);

    if (!created) {
      logActivity({
        title: "Could not start a new conversation",
        detail: "The local Hermes runtime did not open a new conversation.",
        tag: "error",
      });
      return;
    }

    setResumedHermesSession({ sessionId: created.session_id, title: NEW_CONVERSATION_TITLE, messages: [] });
    setPendingDraft(draft ? { sessionId: created.session_id, text: draft } : null);
    setActiveMode("chat");
    logActivity({ title: "New conversation", detail: created.session_id, tag: "prototype" });
  }

  /**
   * Opening a conversation from Home reuses the exact same explicit
   * search → session.resume → Chat flow the Search workspace uses. No new
   * resume path, no second session owner.
   */
  async function handleOpenConversationFromHome(sessionId: string, title: string) {
    if (openingSessionId) return;
    setOpeningSessionId(sessionId);
    const resumed = await resumeHermesSession(sessionId);
    if (!mountedRef.current) return;
    setOpeningSessionId(null);
    if (!resumed) {
      logActivity({ title: "Could not open conversation", detail: title, tag: "error" });
      return;
    }
    setResumedHermesSession({ sessionId: resumed.session_id, title, messages: resumed.messages });
    setActiveMode("chat");
    logActivity({ title: "Hermes conversation resumed", detail: title, tag: "prototype" });
  }

  async function handleOpenSearchSession(result: HermesSearchResult): Promise<boolean> {
    const resumed = await resumeHermesSession(result.sessionId);
    if (!mountedRef.current) return false;
    if (!resumed) {
      logActivity({ title: "Could not open conversation", detail: result.title, tag: "error" });
      return false;
    }
    setResumedHermesSession({ sessionId: resumed.session_id, title: result.title, messages: resumed.messages });
    setActiveMode("chat");
    logActivity({ title: "Hermes conversation resumed", detail: result.title, tag: "prototype" });
    return true;
  }

  function handleModeChange(mode: WorkspaceMode) {
    setActiveMode(mode);
    if (mode !== "search") setKnowledgeInspectingId(null);
  }

  const currentFileState = activeSessionId ? (fileContextBySession[activeSessionId] ?? IDLE_FILE_STATE) : IDLE_FILE_STATE;

  async function handleFileSelected(file: File) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const previousState = fileContextBySession[sessionId] ?? IDLE_FILE_STATE;
    setFileContextBySession((prev) => ({ ...prev, [sessionId]: { kind: "reading" } }));
    logActivity({ title: "File selected", detail: file.name, tag: "prototype" });

    const result = await validateAndReadFile(file);
    if (!mountedRef.current) return;

    if (result.kind === "ready") {
      setFileContextBySession((prev) => ({ ...prev, [sessionId]: result }));
      logActivity({ title: "File ready", detail: result.filename, tag: "prototype" });
      return;
    }

    // Never silently discard an already-admitted, still-valid file just
    // because a later replacement attempt failed — restore it. The
    // rejection reason is still surfaced via the Activity Dock entry
    // below (and, when there was nothing previously admitted, via the
    // rejection state itself rendered in the Files rail).
    setFileContextBySession((prev) => ({
      ...prev,
      [sessionId]: previousState.kind === "ready" ? previousState : result,
    }));
    logActivity({ title: "File rejected", detail: result.kind, tag: "error" });
  }

  function handleFileRemoved() {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const filename = fileContextBySession[sessionId]?.kind === "ready" ? (fileContextBySession[sessionId] as { filename: string }).filename : undefined;
    setFileContextBySession((prev) => ({ ...prev, [sessionId]: IDLE_FILE_STATE }));
    logActivity({ title: "File removed", detail: filename, tag: "prototype" });
  }

  const currentApprovals = activeSessionId ? (approvalsBySession[activeSessionId] ?? []) : [];

  function updateApproval(approvalId: string, updater: (request: ApprovalRequest) => ApprovalRequest) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    setApprovalsBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).map((request) => (request.approvalId === approvalId ? updater(request) : request)),
    }));
  }

  function handleOpenApproval(approvalId: string) {
    if (!activeSessionId) return;
    const request = currentApprovals.find((r) => r.approvalId === approvalId);
    if (!request) return;
    if (request.status === "REVIEW_REQUIRED") {
      // Opening a proposal for inspection here IS the Review step (contract
      // §6) — Approval is never offered without it. Only a real user
      // navigation to this surface triggers this transition; no model/chat
      // output can do so.
      updateApproval(approvalId, reviewProposal);
      logActivity({ title: "Approval requested", detail: request.actionSummary, tag: "designed" });
    }
    setSelectedApprovalId(approvalId);
    setActiveMode("approval");
  }

  function handleApproveApproval(approvalId: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    updateApproval(approvalId, (request) => approveProposal(request, { approvalId, sessionId }));
    const request = currentApprovals.find((r) => r.approvalId === approvalId);
    logActivity({ title: "Approved", detail: request?.actionSummary, tag: "designed" });
    logActivity({ title: "Execution unavailable", detail: request?.actionSummary, tag: "unavailable" });
  }

  function handleRejectApproval(approvalId: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    updateApproval(approvalId, (request) => rejectProposal(request, { approvalId, sessionId }));
    const request = currentApprovals.find((r) => r.approvalId === approvalId);
    logActivity({ title: "Rejected", detail: request?.actionSummary, tag: "designed" });
  }

  function handleDismissApproval(approvalId: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    updateApproval(approvalId, (request) => cancelProposal(request, { approvalId, sessionId }));
    const request = currentApprovals.find((r) => r.approvalId === approvalId);
    logActivity({ title: "Approval cancelled", detail: request?.actionSummary, tag: "designed" });
  }

  function handleCuaEvent(event: CuaStreamEvent) {
    setControlledAction((previous) => reduceControlledActionEvent(previous, event));
    if (event.kind === "approval") {
      setActiveMode("approval");
      setActiveRailTab("approvals");
    } else if (event.kind === "activity") {
      logActivity({
        title: event.activity.title,
        detail: event.activity.detail,
        tag: event.activity.state === "FAILED" ? "error" : "designed",
      });
    } else if (event.kind === "receipt") {
      setCuaObservedState(event.receipt.end_state);
      if (CUA_BINDING_LOST_REASONS.has(event.receipt.reason ?? "")) setCuaFixtureId(null);
    } else if (event.kind === "complete") {
      const result = event.result as CuaFixtureResponse;
      if (result.fixture_id) setCuaFixtureId(result.fixture_id);
      if (result.observation?.state) setCuaObservedState(result.observation.state);
      if (result.receipt?.end_state !== undefined) setCuaObservedState(result.receipt.end_state);
      if (result.end_state !== undefined) setCuaObservedState(result.end_state);
    } else if (event.kind === "error") {
      setCuaError(`${event.code}: ${event.message}`);
      logActivity({ title: "Bounded action unavailable", detail: event.message, tag: "error" });
    }
  }

  async function handleRunCua(request: CuaFixtureRequest) {
    if (!cuaEnabled || cuaRunning) return;
    setCuaRunning(true);
    setCuaError(null);
    setControlledAction(createControlledActionState({ available: true }));
    await streamCuaFixtureAction(request, { onEvent: handleCuaEvent });
    if (mountedRef.current) setCuaRunning(false);
  }

  async function handleControlledActionDecision(choice: "once" | "deny") {
    const approval = controlledAction.approval;
    if (!approval || !isBoundCuaApproval(approval, controlledAction.proposal?.action_id ?? null)) return;
    setControlledActionDeciding(true);
    const result = await respondToApproval(approval.request_id, choice);
    if (!mountedRef.current) return;
    setControlledActionDeciding(false);
    if (!result.ok) {
      const message = result.message ?? "Hermes did not accept the decision. The action remains blocked.";
      setCuaError(`${result.error ?? "APPROVAL_FAILED"}: ${message}`);
      setControlledAction((previous) =>
        reduceControlledActionEvent(previous, { kind: "error", code: result.error ?? "APPROVAL_FAILED", message }),
      );
    }
  }

  useEffect(() => {
    // Dev-only QA/test seam — stripped entirely from production builds by
    // Vite's static replacement of import.meta.env.DEV. Nothing in this
    // shipped app ever calls proposeAction() in normal daily use: the
    // accepted contract explicitly forbids fabricating a proposal to
    // populate these panels for daily use, and no Runtime decision engine
    // is wired into this repository to originate one for real. This hook
    // exists solely so the real, already-implemented state machine and UI
    // can be exercised end-to-end during development/QA without shipping
    // a discoverable "create a fake proposal" control to real users.
    if (!import.meta.env.DEV) return;
    const globalWindow = window as unknown as Record<string, unknown>;
    globalWindow.__yuzukiApprovalsDebug__ = {
      propose: (input: { sessionId: string; actionTier: ApprovalRequest["actionTier"]; actionSummary: string; targetSummary: string; targetKind: string }) => {
        const request = proposeAction(input);
        setApprovalsBySession((prev) => ({ ...prev, [input.sessionId]: [...(prev[input.sessionId] ?? []), request] }));
        return request.approvalId;
      },
      // QA-only: exercises the STALE transition (contract §13) against a
      // real, already-admitted request — there is no live UI trigger for
      // this in daily use, since nothing here re-proposes an action with
      // updated fields automatically.
      mutate: (sessionId: string, approvalId: string, updatedFields: { actionTier: ApprovalRequest["actionTier"]; actionSummary: string; targetSummary: string; targetKind: string }) => {
        setApprovalsBySession((prev) => ({
          ...prev,
          [sessionId]: (prev[sessionId] ?? []).map((request) =>
            request.approvalId === approvalId ? applyMaterialUpdate(request, updatedFields) : request,
          ),
        }));
      },
    };
    globalWindow.__yuzukiControlledActionsDebug__ = {
      preview: (phase: ControlledActionPhase) => {
        setControlledAction(createControlledActionExample(phase));
        setSelectedApprovalId(null);
        setActiveMode("approval");
      },
    };
    return () => {
      delete globalWindow.__yuzukiApprovalsDebug__;
      delete globalWindow.__yuzukiControlledActionsDebug__;
    };
  }, []);

  const todayRows = deriveToday({
    hermesSessions,
    hermesSessionsAvailable,
    approvals: pendingApprovals,
    approvalsAvailable,
    hermes: hermesInfo,
    nowMs: Date.now(),
  });
  const constellation = layoutConstellation(hermesSessions);
  const knowledgeCategories = deriveKnowledgeCategories({ hermesSessions, hermesAvailable: hermesSessionsAvailable });
  const recentSessions = [...hermesSessions].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)).slice(0, 5);

  /**
   * One contextual rail, not four always-present panels. The rail shows only
   * the modes that belong to what the user is currently doing, and is absent
   * entirely on the full-width surfaces (Home, Search) where it would have
   * nothing to say.
   */
  // Requests still awaiting a human decision for the selected session. A
  // pending decision has to stay visible from wherever the user actually is:
  // when the rail became contextual, a proposal raised mid-conversation had
  // no entry point from Chat at all. Chat therefore gains a Review tab
  // exactly while something is genuinely awaiting review, and the nav item
  // carries the same count.
  const actionableApprovals = currentApprovals.filter(
    (request) => request.status === "REVIEW_REQUIRED" || request.status === "APPROVAL_REQUIRED",
  );
  const controlledActionAwaiting = controlledAction.phase === CONTROLLED_ACTION_PHASE.AWAITING_APPROVAL;
  const pendingDecisionCount = actionableApprovals.length + (controlledActionAwaiting ? 1 : 0);
  const RAIL_TABS_BY_MODE: Partial<Record<WorkspaceMode, RailTab[]>> = {
    chat: pendingDecisionCount > 0 ? ["context", "files", "review"] : ["context", "files"],
    approval: ["review", "approvals"],
    search: ["context"],
  };
  const railTabs = RAIL_TABS_BY_MODE[activeMode] ?? null;
  const effectiveRailTab: RailTab = railTabs
    ? railTabs.includes(activeRailTab)
      ? activeRailTab
      : railTabs[0]
    : activeRailTab;

  return (
    <>
      <div className="dz-unsupported">
        <div className="dz-unsupported-card">
          <h1>Yuzuki Desktop needs more room</h1>
          <p>
            This workspace is designed for windows at least 1024px wide. Widen this window, or use the{" "}
            <a href="/app-preview">Yuzuki mobile companion preview</a> instead.
          </p>
        </div>
      </div>
      <div className="dz-shell" data-theme={theme} data-layout={layout} data-rail={railTabs ? "shown" : "hidden"}>
        <a className="skip-link" href="#dz-main-content">
          Skip to main content
        </a>
        <TopBar
          sessionTitle={activeSessionTitle}
          serverState={serverState}
          layout={layout}
          onLayoutChange={setLayout}
          theme={theme}
          onThemeChange={setTheme}
        />
        <div className="dz-body">
          <NavRail
            activeMode={activeMode}
            onModeChange={handleModeChange}
            pendingApprovalCount={pendingDecisionCount}
            onCreateSession={handleCreateSession}
            creatingSession={creatingSession}
          />
          <MainWorkspace
            activeMode={activeMode}
            hermes={hermesInfo}
            onHermesInfo={setHermesInfo}
            initialDraft={pendingDraft}
            home={{
              greeting: greetingFor(Date.now()),
              todayRows,
              todayLoading: homeLoading,
              constellation,
              categories: knowledgeCategories,
              hermesAvailable: hermesSessionsAvailable,
              recentSessions,
              serverReachable: serverState === "reachable",
              creatingSession,
              busySessionId: openingSessionId,
              onStartConversation: (draft) => void handleStartConversation(draft),
              onOpenConversation: (sessionId, title) => void handleOpenConversationFromHome(sessionId, title),
              onGoToSearch: () => setActiveMode("search"),
            }}
            sessionId={activeSessionId}
            sessionTitle={activeSessionTitle}
            serverReachable={serverState === "reachable"}
            onActivity={logActivity}
            fileContext={
              currentFileState.kind === "ready" ? { filename: currentFileState.filename, text: currentFileState.text } : null
            }
            approvals={currentApprovals}
            selectedApprovalId={selectedApprovalId}
            onApprove={handleApproveApproval}
            onReject={handleRejectApproval}
            onDismiss={handleDismissApproval}
            resumedHistory={resumedHermesSession}
            onOpenSearchSession={handleOpenSearchSession}
            cuaEnabled={cuaEnabled}
            cuaFixtureId={cuaFixtureId}
            cuaObservedState={cuaObservedState}
            cuaRunning={cuaRunning}
            cuaError={cuaError}
            onRunCua={(request) => void handleRunCua(request)}
            controlledAction={controlledAction}
            controlledActionDeciding={controlledActionDeciding}
            onControlledActionApproveOnce={() => void handleControlledActionDecision("once")}
            onControlledActionDeny={() => void handleControlledActionDecision("deny")}
            knowledgeInspectingId={knowledgeInspectingId}
            onKnowledgeInspectingChange={setKnowledgeInspectingId}
          />
          {railTabs && (
            <ContextRail
              tabs={railTabs}
              activeTab={effectiveRailTab}
              onTabChange={setActiveRailTab}
              sessionSelected={activeSessionId !== null}
              fileState={currentFileState}
              onFileSelected={handleFileSelected}
              onFileRemoved={handleFileRemoved}
              approvals={currentApprovals}
              onOpenApproval={handleOpenApproval}
              controlledAction={controlledAction}
              activeMode={activeMode}
              knowledgeInspectingId={knowledgeInspectingId}
              onKnowledgeInspectClose={() => setKnowledgeInspectingId(null)}
            />
          )}
        </div>
        <ActivityDock entries={activity} />
      </div>
    </>
  );
}
