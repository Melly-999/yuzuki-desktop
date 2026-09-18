import type { HermesRuntimeInfo } from "../lib/hermesApi";
import type { TodayRowState } from "./homeData";

export type RuntimeKind = "unknown" | "starting" | "degraded" | "failed" | "ready" | "working";

export declare const RUNTIME_KIND: Readonly<{
  UNKNOWN: "unknown";
  STARTING: "starting";
  DEGRADED: "degraded";
  FAILED: "failed";
  READY: "ready";
  WORKING: "working";
}>;

export interface RuntimeStatus {
  kind: RuntimeKind;
  /** One-word badge, e.g. "Ready" / "Degraded". */
  word: string;
  /** The sentence shown beneath the badge. */
  detail: string;
  /** True only when the runtime could actually serve a turn right now. */
  canServeTurn: boolean;
}

export function deriveRuntimeStatus(hermes: HermesRuntimeInfo | null | undefined): RuntimeStatus;
export function runtimeTodayRowState(kind: RuntimeKind): TodayRowState;
