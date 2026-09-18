import type { HermesApproval, HermesRuntimeInfo, HermesSessionSummary } from "../lib/hermesApi";

export type KnowledgeCategoryState = "indexed" | "not_indexed" | "unavailable";

export interface KnowledgeCategory {
  id: string;
  label: string;
  state: KnowledgeCategoryState;
  count: number | null;
}

export interface ConstellationStar {
  id: string;
  title: string;
  /** Epoch milliseconds. */
  at: number;
  messageCount: number | null;
  /** Normalized 0–1 within the plotted field. */
  x: number;
  y: number;
  radius: number;
  brightness: number;
}

export interface ConstellationLayout {
  stars: ConstellationStar[];
  oldestAt: number | null;
  newestAt: number | null;
  hasVolumeVariance: boolean;
}

export type TodayRowState = "present" | "empty" | "degraded" | "unavailable";

export interface TodayRow {
  id: string;
  label: string;
  state: TodayRowState;
  detail?: string;
  count?: number;
  items?: unknown[];
}

export interface NamedSource {
  id: string;
  label: string;
}

export function toEpochMs(value: unknown): number | null;
export function isSameLocalDay(aMs: number, bMs: number): boolean;
export function greetingFor(nowMs: number): string;
export function describeHermesState(hermes: HermesRuntimeInfo | null): string;
export function layoutConstellation(hermesSessions: HermesSessionSummary[]): ConstellationLayout;
export function deriveKnowledgeCategories(input: {
  hermesSessions: HermesSessionSummary[];
  hermesAvailable: boolean;
}): KnowledgeCategory[];
export function deriveToday(input: {
  hermesSessions: HermesSessionSummary[];
  hermesSessionsAvailable: boolean;
  approvals: HermesApproval[];
  approvalsAvailable: boolean;
  hermes: HermesRuntimeInfo | null;
  nowMs: number;
}): TodayRow[];

export const UNINDEXED_CATEGORIES: readonly NamedSource[];
export const NOT_CONNECTED_SOURCES: readonly NamedSource[];
