import { useState, type FormEvent } from "react";
import type { HermesSessionSummary } from "../lib/hermesApi";
import { Constellation } from "./Constellation";
import { NOT_CONNECTED_SOURCES, type ConstellationLayout, type KnowledgeCategory, type TodayRow } from "./homeData";

/**
 * Yuzuki V1 Home.
 *
 * Composition note: this surface deliberately uses no card containers. Its
 * hierarchy comes from type scale, spacing and one horizon — the boxed-card
 * grid is what turns a personal workspace into a dashboard, and it is the
 * failure mode this surface exists to avoid.
 *
 * Truth note: every number rendered here arrives already resolved from
 * homeData's derivation, which distinguishes "empty" from "unreachable".
 * Nothing on this surface counts an unreachable source as zero.
 */

const STATE_WORD: Record<TodayRow["state"], string> = {
  present: "Ready",
  empty: "Clear",
  degraded: "Degraded",
  unavailable: "Unavailable",
};

function summarize(rows: TodayRow[]): string {
  const parts: string[] = [];
  const conversations = rows.find((row) => row.id === "conversations");
  const approvals = rows.find((row) => row.id === "approvals");

  if (conversations?.state === "present") {
    parts.push(`${conversations.count} conversation${conversations.count === 1 ? "" : "s"} today`);
  } else if (conversations?.state === "empty") {
    parts.push("nothing opened yet today");
  } else if (conversations?.state === "unavailable") {
    parts.push("today's conversations unreadable");
  }

  if (approvals?.state === "present") {
    parts.push(`${approvals.count} decision${approvals.count === 1 ? "" : "s"} waiting on you`);
  } else if (approvals?.state === "unavailable") {
    parts.push("approval queue unreachable");
  }

  const unhealthy = rows.filter(
    (row) => (row.id === "storage" || row.id === "runtime") && (row.state === "degraded" || row.state === "unavailable"),
  );
  // The label is used as authored — lower-casing it turned "Yuzuki runtime"
  // into "yuzuki runtime" in the unavailable summary.
  for (const row of unhealthy) parts.push(`${row.label} ${STATE_WORD[row.state].toLowerCase()}`);

  if (parts.length === 0) return "Nothing needs you right now.";
  const sentence = parts.join(" · ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function formatWhen(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(atMs));
}

type Props = {
  greeting: string;
  todayRows: TodayRow[];
  todayLoading: boolean;
  constellation: ConstellationLayout;
  categories: KnowledgeCategory[];
  hermesAvailable: boolean;
  recentSessions: HermesSessionSummary[];
  serverReachable: boolean;
  creatingSession: boolean;
  busySessionId: string | null;
  onStartConversation: (draft: string) => void;
  onOpenConversation: (sessionId: string, title: string) => void;
  onGoToSearch: () => void;
};

export function HomeWorkspace({
  greeting,
  todayRows,
  todayLoading,
  constellation,
  categories,
  hermesAvailable,
  recentSessions,
  serverReachable,
  creatingSession,
  busySessionId,
  onStartConversation,
  onOpenConversation,
  onGoToSearch,
}: Props) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingSession || !serverReachable) return;
    onStartConversation(draft.trim());
    setDraft("");
  }

  return (
    <div className="dz-home">
      <section className="dz-home-hero" aria-labelledby="dz-home-title">
        <h1 id="dz-home-title" className="dz-home-greeting">
          {greeting}.
        </h1>
        <p className="dz-home-summary" aria-live="polite">
          {todayLoading ? "Reading local state…" : summarize(todayRows)}
        </p>

        <form className="dz-home-command" onSubmit={handleSubmit}>
          <label htmlFor="dz-home-command-input" className="sr-only">
            Start a conversation with Yuzuki
          </label>
          <input
            id="dz-home-command-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={serverReachable ? "Start something with Yuzuki…" : "Local service unreachable"}
            autoComplete="off"
            disabled={!serverReachable}
          />
          {/* Labelled "Start", not "New conversation": the nav rail already
              carries a "New conversation" action, and two identically
              labelled accent buttons a few hundred pixels apart read as the
              same control. This one is the submit for the field beside it. */}
          <button type="submit" className="dz-home-command-go" disabled={creatingSession || !serverReachable}>
            {creatingSession ? "Starting…" : "Start"}
          </button>
        </form>
        <p className="dz-home-command-hint">
          {serverReachable
            ? "Opens a new local conversation. Nothing is sent until you send it."
            : "Start the local Yuzuki service to begin a conversation."}
        </p>
      </section>

      <section className="dz-home-today" aria-labelledby="dz-home-today-title">
        <h2 id="dz-home-today-title">Today</h2>
        {/* While the reads are still in flight the rows are withheld rather
            than rendered as "Unavailable" — a pending read is not a failed
            one, and showing failure early would be its own small untruth. */}
        {todayLoading && <p className="dz-home-empty">Reading local state…</p>}
        <ul className="dz-today-rows" hidden={todayLoading}>
          {todayRows.map((row) => (
            <li key={row.id} className={`dz-today-row dz-today-row-${row.state}`}>
              <span className="dz-today-label">{row.label}</span>
              <span className="dz-today-value">
                {row.state === "present" && typeof row.count === "number" ? row.count : STATE_WORD[row.state]}
              </span>
              <span className="dz-today-detail">{row.detail ?? ""}</span>
            </li>
          ))}
        </ul>

        <p className="dz-today-absent-title">Not connected</p>
        <ul className="dz-today-absent">
          {NOT_CONNECTED_SOURCES.map((source) => (
            <li key={source.id}>
              <span>{source.label}</span>
              <span className="dz-today-absent-state">no account connected</span>
            </li>
          ))}
        </ul>
      </section>

      <Constellation
        layout={constellation}
        categories={categories}
        hermesAvailable={hermesAvailable}
        onOpenConversation={onOpenConversation}
        busySessionId={busySessionId}
      />

      <section className="dz-home-recent" aria-labelledby="dz-home-recent-title">
        <div className="dz-home-recent-head">
          <h2 id="dz-home-recent-title">Recent conversations</h2>
          <button type="button" className="dz-home-text-action" onClick={onGoToSearch}>
            Search all conversations
          </button>
        </div>

        {!hermesAvailable && <p className="dz-home-empty">The local conversation store could not be read.</p>}
        {hermesAvailable && recentSessions.length === 0 && (
          <p className="dz-home-empty">No conversations on this device yet.</p>
        )}

        {recentSessions.length > 0 && (
          <ul className="dz-home-recent-list">
            {recentSessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="dz-home-recent-item"
                  disabled={busySessionId !== null}
                  onClick={() => onOpenConversation(session.id, session.title)}
                >
                  <span className="dz-home-recent-title">{session.title}</span>
                  <span className="dz-home-recent-meta">
                    {formatWhen((session.started_at ?? 0) < 1e11 ? (session.started_at ?? 0) * 1000 : (session.started_at ?? 0))}
                    {typeof session.message_count === "number"
                      ? ` · ${session.message_count} message${session.message_count === 1 ? "" : "s"}`
                      : ""}
                  </span>
                  <span className="dz-home-recent-open">
                    {busySessionId === session.id ? "Opening…" : "Open"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
