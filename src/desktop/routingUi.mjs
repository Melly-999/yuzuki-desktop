export const ROUTING_MODES = Object.freeze([
  { value: "PRIVATE", label: "Private", description: "Local only. No cloud fallback." },
  { value: "SAVER", label: "Saver", description: "Cost-aware approved route." },
  { value: "FAST", label: "Fast", description: "Low-latency approved route." },
  { value: "SMART", label: "Smart", description: "Balanced approved route." },
  { value: "DEEP", label: "Deep", description: "Reasoning-oriented route." },
  { value: "CREATIVE", label: "Creative", description: "Creative-task route." },
  { value: "ADVANCED", label: "Advanced", description: "Choose an approved model manually." },
]);

const ROUTING_MODE_VALUES = new Set(ROUTING_MODES.map((mode) => mode.value));

export const ROUTING_FAILURE_MESSAGES = Object.freeze({
  ROUTING_NOT_CONFIGURED: "Model routing is not configured for this profile.",
  PROVIDER_NOT_CONFIGURED: "The selected model provider is not configured for this profile.",
  PROVIDER_DISABLED: "The selected model provider is disabled for this profile.",
  PROVIDER_UNAVAILABLE: "The selected model provider is currently unavailable.",
  MODEL_NOT_FOUND: "That model is no longer available in the approved registry.",
  MODEL_DISALLOWED: "That model is not allowed by the current routing policy.",
  MODEL_INCAPABLE: "That model cannot satisfy this request.",
  LOCAL_ROUTE_UNAVAILABLE: "No eligible local model is available. No cloud route was substituted.",
  REGISTRY_UNAVAILABLE: "Model list unavailable.",
});

export function routingFailureMessage(status) {
  return ROUTING_FAILURE_MESSAGES[status] ?? "Hermes could not resolve the requested route.";
}

export function buildRoutingRequest(routingMode, requestedModelId) {
  if (!ROUTING_MODE_VALUES.has(routingMode)) throw new Error("INVALID_ROUTING_MODE");
  if (routingMode !== "ADVANCED") return { routingMode };
  const modelId = typeof requestedModelId === "string" ? requestedModelId.trim() : "";
  if (!modelId) throw new Error("MODEL_NOT_SELECTED");
  return { routingMode, requestedModelId: modelId };
}

export function selectableRoutingOptions(models) {
  return Array.isArray(models) ? models.filter((model) => model?.selectable === true) : [];
}

export function describeRoutingProvenance(routing) {
  if (!routing || typeof routing !== "object") return null;
  const mode = typeof routing.requested_mode === "string" ? routing.requested_mode : null;
  const fallback = routing.fallback_occurred === true;
  if (fallback && (mode === "PRIVATE" || mode === "ADVANCED")) {
    return { kind: "violation", text: `${mode} route contract violation: Hermes reported a fallback.` };
  }
  if (fallback) {
    return {
      kind: "fallback",
      text: `Fallback used${routing.fallback_reason ? `: ${routing.fallback_reason}` : "."}`,
    };
  }
  if (routing.routing_status && routing.routing_status !== "READY") {
    return { kind: "error", text: routingFailureMessage(routing.routing_status) };
  }
  const served = [routing.served_model, routing.served_provider, routing.locality]
    .filter((value) => typeof value === "string" && value)
    .join(" · ");
  return served ? { kind: "ready", text: served } : null;
}
