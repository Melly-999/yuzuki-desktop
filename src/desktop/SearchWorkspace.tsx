import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { searchHermesSessions, type HermesSearchResult } from "../lib/hermesApi";
import {
  INITIAL_SESSION_SEARCH_STATE,
  normalizeSessionSearchQuery,
  reduceSessionSearchState,
} from "./sessionSearch";

type Props = {
  serverReachable: boolean;
  onOpenSession: (result: HermesSearchResult) => Promise<boolean>;
};

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1000));
}

export function SearchWorkspace({ serverReachable, onOpenSession }: Props) {
  const [query, setQuery] = useState("");
  const [state, dispatch] = useReducer(reduceSessionSearchState, INITIAL_SESSION_SEARCH_STATE);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeSessionSearchQuery(query);
    if (!normalized.ok) {
      dispatch({ type: "invalid", message: normalized.message });
      return;
    }
    if (!serverReachable) {
      dispatch({ type: "unavailable", message: "The local Yuzuki service is unavailable." });
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "start" });
    const outcome = await searchHermesSessions(normalized.query, { limit: 20, signal: controller.signal });
    if (controller.signal.aborted) return;
    if (outcome.kind === "success") dispatch({ type: "success", results: outcome.results });
    else if (outcome.kind === "invalid_query") dispatch({ type: "invalid", message: outcome.message });
    else if (outcome.kind === "unavailable") dispatch({ type: "unavailable", message: outcome.message });
    else dispatch({ type: "error", message: outcome.message });
  }

  async function openResult(result: HermesSearchResult) {
    if (openingSessionId) return;
    setOpeningSessionId(result.sessionId);
    const opened = await onOpenSession(result);
    if (!opened) {
      setOpeningSessionId(null);
      dispatch({ type: "error", message: "The matching conversation could not be opened." });
    }
  }

  return (
    <section className="dz-search" aria-labelledby="dz-search-title">
      <div className="dz-search-heading">
        <h2 id="dz-search-title">Search local conversations</h2>
        <p>Full-text search of this Hermes profile. Results are not added to your current prompt.</p>
      </div>
      <form className="dz-search-form" onSubmit={(event) => void runSearch(event)}>
        <label htmlFor="dz-search-input" className="sr-only">Search conversations</label>
        <input
          id="dz-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations…"
          autoComplete="off"
        />
        <button type="submit" disabled={state.kind === "searching"}>Search</button>
      </form>

      <div className="dz-search-status" aria-live="polite">
        {state.kind === "idle" && <p>Enter at least two characters, then submit.</p>}
        {state.kind === "searching" && <p>Searching local history…</p>}
        {state.kind === "empty" && <p>No matching conversations found.</p>}
        {(state.kind === "invalid_query" || state.kind === "error" || state.kind === "hermes_unavailable") && (
          <p role="alert">{state.message}</p>
        )}
      </div>

      {state.kind === "results" && (
        <ol className="dz-search-results" aria-label="Conversation search results">
          {state.results.map((result) => (
            <li key={result.sessionId}>
              <button
                type="button"
                className="dz-search-result"
                disabled={openingSessionId !== null}
                onClick={() => void openResult(result)}
              >
                <span className="dz-search-result-title">{result.title}</span>
                <time>{formatTimestamp(result.timestamp)}</time>
                <span className="dz-search-result-snippet">{result.snippet || "Matching conversation"}</span>
                <span className="dz-search-result-action">
                  {openingSessionId === result.sessionId ? "Opening…" : "Open conversation"}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
