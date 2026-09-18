import type { HermesRoutingOption, HermesRoutingProvenance, RoutingMode } from "../lib/hermesApi";

export interface RoutingModeOption {
  value: RoutingMode;
  label: string;
  description: string;
}

export const ROUTING_MODES: ReadonlyArray<RoutingModeOption>;
export const ROUTING_FAILURE_MESSAGES: Readonly<Record<string, string>>;
export function routingFailureMessage(status: string): string;
export function buildRoutingRequest(
  routingMode: RoutingMode,
  requestedModelId?: string | null,
): { routingMode: RoutingMode; requestedModelId?: string };
export function selectableRoutingOptions(models: HermesRoutingOption[]): HermesRoutingOption[];
export function describeRoutingProvenance(
  routing: HermesRoutingProvenance | null | undefined,
): { kind: "ready" | "fallback" | "violation" | "error"; text: string } | null;
