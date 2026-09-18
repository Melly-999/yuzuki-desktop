import type { HermesSearchResult } from "../lib/hermesApi";

export type SessionSearchStateKind =
  | "idle"
  | "searching"
  | "results"
  | "empty"
  | "error"
  | "hermes_unavailable"
  | "invalid_query";

export interface SessionSearchState {
  kind: SessionSearchStateKind;
  results: HermesSearchResult[];
  message: string | null;
}

export type SessionSearchEvent =
  | { type: "start" }
  | { type: "success"; results: HermesSearchResult[] }
  | { type: "invalid" | "unavailable" | "error"; message: string };

export const INITIAL_SESSION_SEARCH_STATE: SessionSearchState;
export function normalizeSessionSearchQuery(value: unknown):
  | { ok: true; query: string }
  | { ok: false; message: string };
export function reduceSessionSearchState(state: SessionSearchState, event: SessionSearchEvent): SessionSearchState;
