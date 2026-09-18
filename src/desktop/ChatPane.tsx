import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  streamHermesChat,
  fetchHermesRoutingOptions,
  respondToApproval,
  type HermesApproval,
  type ApprovalChoice,
  cancelHermesTurn,
  getSessionMessages,
  type HermesRuntimeInfo,
  type ChatMode,
  type MessageRecord,
  type ModelRouteStatus,
  type HermesRoutingOption,
  type RoutingMode,
} from "../lib/hermesApi";
import { humanizeSnakeCase } from "../lib/capabilityStateAdapter";
import { deriveRuntimeStatus } from "./runtimeStatus";
import { StatusBadge } from "./StatusBadge";
import type { ActivityEntry, ChatBubble } from "./types";
import type { AdmittedFileSource } from "./fileContext";
import {
  buildRoutingRequest,
  describeRoutingProvenance,
  ROUTING_MODES,
  routingFailureMessage,
  selectableRoutingOptions,
} from "./routingUi.mjs";

type Props = {
  /**
   * The desktop's single runtime-state value, owned by DesktopShell and
   * read-only here. ChatPane used to keep its own copy, seeded only by
   * chat-stream events, which is why Chat could say the runtime was not
   * started while Home — reading the status endpoint — said Ready.
   */
  hermes: HermesRuntimeInfo | null;
  /** Report runtime state observed on the chat stream back to that owner. */
  onHermesInfo: (hermes: HermesRuntimeInfo) => void;
  sessionId: string | null;
  sessionTitle: string | null;
  serverReachable: boolean;
  onActivity: (entry: Omit<ActivityEntry, "id" | "at">) => void;
  /**
   * The current session's admitted local-file source, if any
   * (YUZUKI-DESKTOP-CONTEXT-FILES-P0-IMPLEMENTATION-001) — owned by
   * DesktopShell, read-only here. Selecting/reading a file never itself
   * calls sendChatMessage; only an explicit send captures a snapshot of
   * this value, exactly like sessionId/routeMode already are (see
   * sendText below).
   */
  fileContext: AdmittedFileSource | null;
  resumedHistory: { sessionId: string; messages: { role: string; text: string }[] } | null;
  /**
   * Text typed into Home's command entry before this session existed,
   * handed over so it survives the hop into Chat. It only ever seeds the
   * composer draft — it never sends, and it never overwrites a draft the
   * user has already started. Sending stays an explicit act in this pane.
   */
  initialDraft: { sessionId: string; text: string } | null;
};

type SessionChatState = {
  messages: ChatBubble[];
  draft: string;
  errorMessage: string | null;
  chatMode: ChatMode | null;
  modelRouteStatus: ModelRouteStatus | null;
  sending: boolean;
  /**
   * Durable-history hydration lifecycle for this session, independent of
   * `sending`/optimistic message state. "idle" means hydration hasn't
   * been attempted yet for this session; it only ever runs once per
   * session (see the hydration effect below) so switching back to an
   * already-hydrated session does not re-fetch pathologically.
   */
  historyStatus: "idle" | "loading" | "loaded" | "unavailable";
};

const EMPTY_SESSION_CHAT: SessionChatState = {
  messages: [],
  draft: "",
  errorMessage: null,
  chatMode: null,
  modelRouteStatus: null,
  sending: false,
  historyStatus: "idle",
};

function toChatBubble(message: MessageRecord): ChatBubble {
  return { id: message.message_id, role: message.role, text: message.content };
}

const SAFE_CHAT_ERRORS: Readonly<Record<string, string>> = {
  INVALID_ROUTE: "That route is not supported. Choose Auto, Balanced, Deep, or Local.",
  LOCAL_MODEL_NOT_AVAILABLE: "Local chat is not available yet. No cloud route was substituted.",
  PROVIDER_NOT_CONFIGURED: "Model-backed chat is implemented but the provider is not configured.",
  AUTH_FAILURE: "The model provider could not authenticate. No reply was generated.",
  RATE_LIMITED: "The model provider is temporarily rate limited. No reply was generated.",
  QUOTA_EXHAUSTED: "The model provider quota is exhausted. No reply was generated.",
  BILLING_NOT_AVAILABLE: "Provider billing is not available. No reply was generated.",
  PROVIDER_LIMIT_UNKNOWN: "The provider reported an unclassified limit. No reply was generated.",
  REQUEST_TIMEOUT: "The model request timed out. No reply was generated.",
  CANCELLED: "The model request was cancelled. No reply was generated.",
  PROVIDER_ERROR: "The model provider could not complete the request. No reply was generated.",
  MALFORMED_PROVIDER_RESPONSE: "The model provider returned no usable reply.",
  INVALID_CONTEXT: "The attached file couldn't be included — its context was malformed.",
  CONTEXT_TOO_LARGE: "The attached file's text is too long to include.",
  ROUTING_NOT_CONFIGURED: routingFailureMessage("ROUTING_NOT_CONFIGURED"),
  PROVIDER_DISABLED: routingFailureMessage("PROVIDER_DISABLED"),
  PROVIDER_UNAVAILABLE: routingFailureMessage("PROVIDER_UNAVAILABLE"),
  MODEL_NOT_FOUND: routingFailureMessage("MODEL_NOT_FOUND"),
  MODEL_DISALLOWED: routingFailureMessage("MODEL_DISALLOWED"),
  MODEL_INCAPABLE: routingFailureMessage("MODEL_INCAPABLE"),
  LOCAL_ROUTE_UNAVAILABLE: routingFailureMessage("LOCAL_ROUTE_UNAVAILABLE"),
  REGISTRY_UNAVAILABLE: routingFailureMessage("REGISTRY_UNAVAILABLE"),
};

function safeChatError(code: string, normalizedMessage: string): string {
  return SAFE_CHAT_ERRORS[code] ?? normalizedMessage;
}

function Bubble({ message }: { message: ChatBubble }) {
  return (
    <div className={`dz-bubble dz-bubble-${message.role}`}>
      <p>{message.text}</p>
      {message.productTruthLabels && message.productTruthLabels.length > 0 && (
        <div className="dz-bubble-labels">
          {message.productTruthLabels.map((label) => (
            <span key={label} className="dz-bubble-label">
              {humanizeSnakeCase(label)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Session-aware chat shell. Message state is a bounded in-memory map keyed
 * only by the canonical `session_id` — this is the rendered/cache view,
 * kept isolated per session during live use so conversations never mix
 * during a session switch or a late-arriving response. The server's
 * SQLite store (server/lib/sessionStore.mjs) is the durable authority:
 * each session is hydrated from GET /api/sessions/:id/messages once, the
 * first time it's viewed in this ChatPane instance (see the hydration
 * effect below), so a reload or app restart restores prior history
 * instead of starting blank.
 */
export function ChatPane({
  hermes,
  onHermesInfo,
  sessionId,
  sessionTitle,
  serverReachable,
  onActivity,
  fileContext,
  resumedHistory,
  initialDraft,
}: Props) {
  const mountedRef = useRef(true);
  const seededDraftRef = useRef(new Set<string>());
  const sendInFlightRef = useRef(new Set<string>());
  const [routingMode, setRoutingMode] = useState<RoutingMode>("PRIVATE");
  const [routingOptions, setRoutingOptions] = useState<HermesRoutingOption[]>([]);
  const [routingOptionsStatus, setRoutingOptionsStatus] = useState<"loading" | "ready" | "empty" | "unavailable">("loading");
  const [routingOptionsError, setRoutingOptionsError] = useState<string | null>(null);
  const [requestedModelId, setRequestedModelId] = useState("");
  const [sessionChats, setSessionChats] = useState<Record<string, SessionChatState>>({});
  // Runtime state is the shell's, not this pane's. Stream events refine
  // it through onHermesInfo so both surfaces move together.
  const hermesInfo = hermes;
  // The single permission request currently awaiting a decision. Hermes
  // blocks its agent thread until this is answered, so at most one is
  // outstanding per session at a time.
  const [pendingApproval, setPendingApproval] = useState<HermesApproval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!serverReachable) {
      setRoutingOptions([]);
      setRoutingOptionsStatus("unavailable");
      setRoutingOptionsError("Model list unavailable.");
      return;
    }
    const controller = new AbortController();
    setRoutingOptionsStatus("loading");
    setRoutingOptionsError(null);
    void fetchHermesRoutingOptions(controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === "unavailable") {
        setRoutingOptions([]);
        setRoutingOptionsStatus("unavailable");
        setRoutingOptionsError(routingFailureMessage(outcome.status));
        return;
      }
      const selectable = selectableRoutingOptions(outcome.models);
      setRoutingOptions(selectable);
      setRoutingOptionsStatus(selectable.length > 0 ? "ready" : "empty");
      setRoutingOptionsError(outcome.status === "READY" ? null : routingFailureMessage(outcome.status));
      setRequestedModelId((current) =>
        selectable.some((model) => model.id === current) ? current : (selectable[0]?.id ?? ""),
      );
    });
    return () => controller.abort();
  }, [serverReachable]);

  const currentChat = sessionId ? (sessionChats[sessionId] ?? EMPTY_SESSION_CHAT) : EMPTY_SESSION_CHAT;

  // Seed the composer once per session from Home's command entry. Guarded by
  // a per-session ref so re-renders never re-inject text the user has since
  // edited or cleared, and never overwrite a draft already in progress.
  useEffect(() => {
    if (!initialDraft || seededDraftRef.current.has(initialDraft.sessionId)) return;
    seededDraftRef.current.add(initialDraft.sessionId);
    const text = initialDraft.text;
    if (!text) return;
    setSessionChats((previous) => {
      const existing = previous[initialDraft.sessionId] ?? EMPTY_SESSION_CHAT;
      if (existing.draft) return previous;
      return { ...previous, [initialDraft.sessionId]: { ...existing, draft: text } };
    });
  }, [initialDraft]);

  function updateSessionChat(id: string, update: (current: SessionChatState) => SessionChatState) {
    setSessionChats((previous) => ({
      ...previous,
      [id]: update(previous[id] ?? EMPTY_SESSION_CHAT),
    }));
  }

  // Durable-history hydration: on first ever view of a given session in
  // this ChatPane instance, restore its saved messages from the server so
  // reload/restart isn't an empty thread. Runs at most once per session —
  // guarded by historyStatus, not by a dependency on sessionChats itself,
  // so it never turns into a refetch loop. SQLite/the server remains the
  // durable authority; this bounded client map remains the live, rendered
  // view once hydrated (see this file's own module comment).
  useEffect(() => {
    if (!sessionId) return;
    if (resumedHistory?.sessionId === sessionId) {
      updateSessionChat(sessionId, (current) => ({
        ...current,
        messages: resumedHistory.messages
          .filter((message): message is { role: "user" | "assistant"; text: string } =>
            message.role === "user" || message.role === "assistant",
          )
          .map((message, index) => ({
            id: `hermes-history-${sessionId}-${index}`,
            role: message.role,
            text: message.text,
          })),
        historyStatus: "loaded",
      }));
      return;
    }
    const existing = sessionChats[sessionId];
    if (existing && existing.historyStatus !== "idle") return;

    updateSessionChat(sessionId, (current) => ({ ...current, historyStatus: "loading" }));

    getSessionMessages(sessionId).then((outcome) => {
      if (!mountedRef.current) return;
      if (outcome.kind === "success") {
        updateSessionChat(sessionId, (current) => ({
          ...current,
          messages: outcome.data.map(toChatBubble),
          historyStatus: "loaded",
        }));
        if (outcome.data.length > 0) {
          onActivity({ title: "History restored", detail: sessionTitle ?? undefined, tag: "prototype" });
        }
        return;
      }
      updateSessionChat(sessionId, (current) => ({ ...current, historyStatus: "unavailable" }));
    });
    // Intentionally keyed on sessionId only — re-running per keystroke of
    // sessionChats/onActivity/sessionTitle would defeat the "once per
    // session" guarantee above; the effect reads their current values from
    // closure each time sessionId actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, resumedHistory]);

  function handleRouteChange(nextRoute: RoutingMode) {
    setRoutingMode(nextRoute);
    onActivity({
      title: "Route changed",
      detail: nextRoute,
      tag: nextRoute === "PRIVATE" ? "prototype" : "prototype",
    });
  }

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !sessionId || sendInFlightRef.current.has(sessionId) || !serverReachable) return;

    const requestSessionId = sessionId;
    const requestRouting = buildRoutingRequest(routingMode, requestedModelId);
    // Snapshot the currently-admitted file context at submit time, exactly
    // like session/route above — a file selected or removed after this
    // point must not affect this already-in-flight request.
    const requestContext = fileContext ?? undefined;
    const pendingUserId = `user-${requestSessionId}-${Date.now()}`;
    sendInFlightRef.current.add(requestSessionId);
    updateSessionChat(requestSessionId, (current) => ({
      ...current,
      messages: [...current.messages, { id: pendingUserId, role: "user", text: trimmed }],
      draft: "",
      errorMessage: null,
      sending: true,
    }));
    onActivity({ title: "Chat request started", detail: requestRouting.routingMode, tag: "prototype" });
    if (requestContext) {
      onActivity({ title: "Context included in request", detail: requestContext.filename, tag: "prototype" });
    }

    // The REAL local Hermes path. Deltas stream into a single assistant
    // bubble that is created empty and filled as the local model produces
    // tokens. On failure this reports the failure — it never retries into
    // the legacy USER_CHAT prototype route.
    const assistantId = `hermes-${requestSessionId}-${Date.now()}`;
    let streamed = "";
    let failed = false;

    updateSessionChat(requestSessionId, (current) => ({
      ...current,
      messages: [...current.messages, { id: assistantId, role: "assistant", text: "" }],
    }));

    const applyText = (text: string) => {
      updateSessionChat(requestSessionId, (current) => ({
        ...current,
        messages: current.messages.map((m) => (m.id === assistantId ? { ...m, text } : m)),
      }));
    };

    await streamHermesChat(trimmed, {
      ...requestRouting,
      onEvent: (event) => {
        if (!mountedRef.current) return;
        if (event.kind === "state") {
          onHermesInfo(event.hermes);
          return;
        }
        if (event.kind === "delta") {
          streamed += event.text;
          applyText(streamed);
          return;
        }
        if (event.kind === "complete") {
          if (event.hermes) onHermesInfo(event.hermes);
          applyText(streamed || event.text);
          return;
        }
        if (event.kind === "approval") {
          // A real Hermes permission request. Yuzuki only displays it; the
          // decision is a separate, explicit act by the user.
          setPendingApproval(event.approval);
          onActivity({
            title: "Permission requested",
            detail: event.approval.command || event.approval.description,
            tag: "error",
          });
          return;
        }
        if (event.kind === "activity") {
          onActivity({
            title: event.activity.title,
            detail: `${event.activity.state}${event.activity.detail ? ` — ${event.activity.detail}` : ""}`,
            tag: event.activity.state === "FAILED" || event.activity.state === "DENIED" ? "error" : "prototype",
          });
          if (
            event.activity.state === "APPROVED" ||
            event.activity.state === "DENIED" ||
            event.activity.state === "FAILED"
          ) {
            setPendingApproval((current) =>
              current && event.activity.request_id === current.request_id ? null : current,
            );
          }
          return;
        }
        // error
        failed = true;
        if (event.hermes) onHermesInfo(event.hermes);
        updateSessionChat(requestSessionId, (current) => ({
          ...current,
          // Drop the empty placeholder rather than leaving a blank reply
          // that could read as the model having answered with nothing.
          messages: current.messages.filter((m) => m.id !== assistantId || m.text.length > 0),
          errorMessage: safeChatError(event.code, event.message),
        }));
        onActivity({ title: "Hermes turn failed", detail: event.code, tag: "error" });
      },
    });

    sendInFlightRef.current.delete(requestSessionId);
    if (!mountedRef.current) return;

    updateSessionChat(requestSessionId, (current) => ({ ...current, sending: false }));
    if (!failed) {
      onActivity({ title: "Hermes turn completed", detail: "local runtime", tag: "prototype" });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendText(currentChat.draft);
  }

  /**
   * Relay ONE decision for the exact pending request. There is deliberately
   * no "always" or "for this session" control anywhere in this component —
   * the only decisions expressible are approve-once and deny, and the
   * request_id binds the answer to the operation the user actually saw.
   */
  async function decideApproval(choice: ApprovalChoice) {
    if (!pendingApproval || approvalBusy) return;
    const request = pendingApproval;
    setApprovalBusy(true);
    const outcome = await respondToApproval(request.request_id, choice);
    if (!mountedRef.current) return;
    setApprovalBusy(false);
    if (!outcome.ok) {
      // A stale request (the runtime moved on) must not look answered.
      setPendingApproval(null);
      onActivity({
        title: "Permission decision rejected",
        detail: outcome.error ?? "STALE_APPROVAL",
        tag: "error",
      });
      return;
    }
    setPendingApproval(null);
  }

  // One derivation, shared with Home's runtime row (runtimeStatus.mjs).
  const runtimeStatus = deriveRuntimeStatus(hermesInfo);
  const advancedUnavailable = routingMode === "ADVANCED"
    && (routingOptionsStatus !== "ready" || !requestedModelId);
  const disabled = currentChat.sending || !serverReachable || advancedUnavailable;
  const routingDescription = ROUTING_MODES.find((mode) => mode.value === routingMode)?.description;
  const provenance = describeRoutingProvenance(hermesInfo?.routing);

  if (!sessionId) {
    return (
      <div className="dz-chat-empty">
        <p>Start a new conversation, or select one from the sessions list.</p>
      </div>
    );
  }

  return (
    <div className="dz-chat">
      <div className="dz-chat-status">
        {/* Local Hermes runtime truth. READY is shown only once Hermes,
            the profile and the model have all actually resolved. */}
        <span className="dz-chat-status-note">{runtimeStatus.word}</span>
        {hermesInfo?.model && (
          <span className="dz-chat-status-note">
            {hermesInfo.model}
            {hermesInfo.provider ? ` · ${hermesInfo.provider}` : ""}
            {hermesInfo.profile ? ` · ${hermesInfo.profile}` : ""}
          </span>
        )}
        <span className="dz-chat-status-note">{runtimeStatus.detail}</span>
        {provenance && (
          <span className={`dz-chat-status-note dz-routing-provenance dz-routing-provenance-${provenance.kind}`}>
            {provenance.text}
          </span>
        )}
      </div>

      {provenance?.kind === "violation" && (
        <div className="dz-chat-banner dz-chat-banner-error" role="alert">{provenance.text}</div>
      )}
      {provenance?.kind === "fallback" && (
        <div className="dz-chat-banner dz-chat-banner-fallback" role="status">{provenance.text}</div>
      )}

      {pendingApproval && (
        // Review: a real Hermes permission request. Nothing has executed —
        // Hermes is blocked on this decision.
        <div className="dz-chat-banner dz-chat-banner-error" role="alertdialog" aria-label="Permission request">
          <strong>Hermes is asking permission</strong>
          <p>{pendingApproval.description || "A guarded operation requires your approval."}</p>
          {pendingApproval.command && <pre>{pendingApproval.command}</pre>}
          <p className="dz-chat-status-note">
            Nothing has run yet. Approving allows this one operation only — there is no "always allow".
          </p>
          <button type="button" disabled={approvalBusy} onClick={() => void decideApproval("once")}>
            Approve once
          </button>
          <button type="button" disabled={approvalBusy} onClick={() => void decideApproval("deny")}>
            Deny
          </button>
        </div>
      )}

      {!serverReachable && (
        <div className="dz-chat-banner dz-chat-banner-unavailable">
          Local server unavailable — start it with <code>npm run api:dev</code> to chat with {sessionTitle}.
        </div>
      )}
      {currentChat.errorMessage && (
        <div className="dz-chat-banner dz-chat-banner-error" role="alert">
          {currentChat.errorMessage}
        </div>
      )}

      {currentChat.historyStatus === "unavailable" && (
        <div className="dz-chat-banner dz-chat-banner-unavailable" role="status">
          This conversation's saved history could not be loaded right now. New messages will still be saved.
        </div>
      )}

      <div className="dz-chat-messages">
        {currentChat.historyStatus === "loading" && currentChat.messages.length === 0 && (
          <p className="dz-chat-empty-inline">Loading conversation history…</p>
        )}
        {currentChat.historyStatus !== "loading" && currentChat.messages.length === 0 && (
          <p className="dz-chat-empty-inline">No messages yet in this conversation.</p>
        )}
        {currentChat.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {currentChat.sending && (
          <div className="dz-bubble dz-bubble-assistant dz-bubble-thinking" role="status">
            Thinking…
          </div>
        )}
      </div>

      {fileContext && (
        <div className="dz-composer-attachment" role="status">
          <span className="dz-composer-attachment-icon" aria-hidden>
            📎
          </span>
          <span>
            <strong>{fileContext.filename}</strong> will be included with your next message —
            not sent anywhere yet.
          </span>
        </div>
      )}

      <div className="dz-routing-controls" aria-label="Model routing controls">
        <label className="dz-route-control">
          <span>Route</span>
          <select
            value={routingMode}
            onChange={(event) => handleRouteChange(event.target.value as RoutingMode)}
            aria-describedby="dz-routing-description"
          >
            {ROUTING_MODES.map((route) => (
              <option key={route.value} value={route.value}>
                {route.label}
              </option>
            ))}
          </select>
        </label>
        {routingMode === "ADVANCED" && (
          <label className="dz-route-control dz-model-control">
            <span>Approved model</span>
            <select
              value={requestedModelId}
              onChange={(event) => setRequestedModelId(event.target.value)}
              disabled={routingOptionsStatus !== "ready"}
            >
              {routingOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName} · {model.provider} · {model.locality} · {model.budgetClass}
                </option>
              ))}
            </select>
          </label>
        )}
        <p id="dz-routing-description" className="dz-routing-description">
          {routingMode === "PRIVATE" && <><strong>LOCAL ONLY</strong> · <strong>NO CLOUD FALLBACK</strong> · </>}
          {routingDescription}
        </p>
        {routingMode === "ADVANCED" && routingOptionsStatus === "loading" && (
          <p className="dz-routing-description" role="status">Loading approved models…</p>
        )}
        {routingMode === "ADVANCED" && routingOptionsStatus === "empty" && (
          <p className="dz-routing-description" role="status">No approved models are currently selectable.</p>
        )}
        {routingMode === "ADVANCED" && routingOptionsError && (
          <p className="dz-routing-description dz-routing-error" role="alert">{routingOptionsError}</p>
        )}
        {routingMode === "ADVANCED" && routingOptionsStatus === "ready" && requestedModelId && (() => {
          const model = routingOptions.find((option) => option.id === requestedModelId);
          return model ? (
            <p className="dz-routing-description">
              {model.locality.toUpperCase()} · {model.status} · {model.lifecycle} · {model.capabilities.join(", ")}
            </p>
          ) : null;
        })()}
      </div>

      <form className="dz-composer" onSubmit={handleSubmit}>
        <label htmlFor="dz-composer-input" className="sr-only">
          Message {sessionTitle}
        </label>
        <input
          id="dz-composer-input"
          type="text"
          value={currentChat.draft}
          onChange={(event) =>
            updateSessionChat(sessionId, (current) => ({ ...current, draft: event.target.value }))
          }
          disabled={disabled}
          placeholder={serverReachable ? "Message Yuzuki…" : "Reconnecting…"}
        />
        <button type="submit" disabled={disabled || currentChat.draft.trim().length === 0}>
          Send
        </button>
        {currentChat.sending && (
          // Cooperative interrupt of the running Hermes turn. It stops the
          // turn; it does not claim to have killed anything else.
          <button type="button" onClick={() => void cancelHermesTurn()}>
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
