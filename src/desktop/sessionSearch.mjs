export const INITIAL_SESSION_SEARCH_STATE = Object.freeze({ kind: "idle", results: [], message: null });

export function normalizeSessionSearchQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length < 2 || query.length > 200 || /[\u0000-\u001f]/.test(query)) {
    return { ok: false, message: "Enter 2–200 printable characters." };
  }
  return { ok: true, query };
}

export function reduceSessionSearchState(state, event) {
  if (event.type === "start") return { kind: "searching", results: [], message: null };
  if (event.type === "success") {
    return event.results.length > 0
      ? { kind: "results", results: event.results, message: null }
      : { kind: "empty", results: [], message: null };
  }
  if (event.type === "invalid") return { kind: "invalid_query", results: [], message: event.message };
  if (event.type === "unavailable") return { kind: "hermes_unavailable", results: [], message: event.message };
  if (event.type === "error") return { kind: "error", results: [], message: event.message };
  return state;
}
