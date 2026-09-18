/**
 * Canonical capability-state adapter, implementing
 * docs/product/HERMES_CAPABILITY_STATE_ADAPTER_SPEC.md.
 *
 * This is the single place capability/status text is translated into a
 * user-facing label, badge tone, evidence state, and actionability. It
 * replaces the ad hoc, order-dependent substring matching that previously
 * lived inline in `StatusBadge` (src/App.tsx) — the exact defect that let
 * `NOT IMPLEMENTED IN THIS PROTOTYPE` render with the plain `PROTOTYPE`
 * tone (HERMES-FINAL-UI-POLISH-QA-001 §4). `toCapabilityDisplayModel` is
 * total and fails closed: it never throws, and any input it cannot
 * recognize renders with `unavailable` tone rather than a positive-sounding
 * default (spec §6 rules 7–8).
 *
 * This module implements presentation only. It does not activate any
 * capability, resolve `WRITE_LOCAL` (spec §4, §9 rule 8), or imply Runtime
 * enforcement (spec §9 rule 3).
 */

/** Spec §1 — the seven-state internal evidence model. Never rendered directly. */
export type CapabilityEvidenceState =
  | "IMPLEMENTED"
  | "LIMITED"
  | "SPECIFIED"
  | "PROPOSED"
  | "FUTURE"
  | "UNAVAILABLE"
  | "PROHIBITED";

/** Spec §2 — the approved, human-readable label set. */
export type CapabilityDisplayLabel =
  | "PROTOTYPE"
  | "UI CONCEPT"
  | "EXAMPLE DATA"
  | "PLANNED"
  | "COMING LATER"
  | "DESIGNED / APPROVAL-BASED"
  | "EXPLORATORY / SPEC ONLY"
  | "NOT IMPLEMENTED IN THIS PROTOTYPE"
  | "NOT A LIVE PRODUCT"
  | "IMPLEMENTED NOT LIVE VERIFIED"
  | "FOUNDATION"
  | "IN PROGRESS";

/** Spec §3 — the six CSS tone families. */
export type CapabilityTone =
  | "prototype"
  | "example"
  | "planned"
  | "designed"
  | "foundation"
  | "unavailable";

/** Spec §4 — Runtime action tiers this UI concept maps onto (Runtime-canonical ordering). */
export type RuntimeActionTier = "READ" | "DRAFT" | "WRITE_LOCAL" | "EXTERNAL_ACTION";

/** Spec §4.1 — required sub-classification for any EXTERNAL_ACTION-tier capability. */
export type ExternalActionOutcome = "EXPLICIT_APPROVAL" | "HARD_BLOCKED" | "UNKNOWN";

/**
 * The single display model a component should consume. `label` is typed as
 * `string`, not the narrower `CapabilityDisplayLabel`, because an
 * unrecognized input must still render its own text verbatim rather than
 * being replaced or hidden (spec §6 rule 7) — only the *tone* fails closed,
 * never the visible text.
 */
export type CapabilityDisplayModel = {
  evidenceState: CapabilityEvidenceState;
  label: string;
  tone: CapabilityTone;
  actionable: boolean;
  /** Present when evidenceState is LIMITED, SPECIFIED, or PROPOSED and a limiting dimension is known. */
  limitingDimension?: string;
};

type ExactMatchEntry = {
  evidenceState: CapabilityEvidenceState;
  label: CapabilityDisplayLabel;
  tone: CapabilityTone;
  actionable: boolean;
  limitingDimension?: string;
};

/**
 * Exact matches for every currently-defined API enum value (snake_case) and
 * UI label string (spaced), per spec §5 and the §5.1 formatting-variant
 * note: a `SNAKE_CASE` API value and its `Title Case` UI label are the same
 * canonical label and must resolve identically. Exact match is checked
 * before any substring precedence rule (spec §6 rule 1/2) — this is also
 * where snake_case-to-spaced translation is centralized, replacing the
 * scattered `label.replace(/_/g, " ")` calls the spec calls out (§5.1, §10).
 */
const EXACT_MATCHES: Record<string, ExactMatchEntry> = {
  IMPLEMENTED_NOT_LIVE_VERIFIED: {
    evidenceState: "LIMITED",
    label: "IMPLEMENTED NOT LIVE VERIFIED",
    tone: "unavailable",
    actionable: false,
    limitingDimension: "implementation exists; live provider behavior is not verified",
  },
  NOT_IMPLEMENTED_IN_THIS_PROTOTYPE: {
    evidenceState: "UNAVAILABLE",
    label: "NOT IMPLEMENTED IN THIS PROTOTYPE",
    tone: "unavailable",
    actionable: false,
  },
  "NOT IMPLEMENTED IN THIS PROTOTYPE": {
    evidenceState: "UNAVAILABLE",
    label: "NOT IMPLEMENTED IN THIS PROTOTYPE",
    tone: "unavailable",
    actionable: false,
  },
  "NOT A LIVE PRODUCT": {
    evidenceState: "UNAVAILABLE",
    label: "NOT A LIVE PRODUCT",
    tone: "unavailable",
    actionable: false,
  },
  PLANNED: { evidenceState: "FUTURE", label: "PLANNED", tone: "planned", actionable: false },
  COMING_LATER: { evidenceState: "FUTURE", label: "COMING LATER", tone: "planned", actionable: false },
  "COMING LATER": { evidenceState: "FUTURE", label: "COMING LATER", tone: "planned", actionable: false },
  DESIGNED_APPROVAL_BASED: {
    evidenceState: "SPECIFIED",
    label: "DESIGNED / APPROVAL-BASED",
    tone: "designed",
    actionable: false,
  },
  "DESIGNED / APPROVAL-BASED": {
    evidenceState: "SPECIFIED",
    label: "DESIGNED / APPROVAL-BASED",
    tone: "designed",
    actionable: false,
  },
  EXPLORATORY_SPEC_ONLY: {
    evidenceState: "PROPOSED",
    label: "EXPLORATORY / SPEC ONLY",
    tone: "designed",
    actionable: false,
  },
  "EXPLORATORY / SPEC ONLY": {
    evidenceState: "PROPOSED",
    label: "EXPLORATORY / SPEC ONLY",
    tone: "designed",
    actionable: false,
  },
  PROTOTYPE: { evidenceState: "IMPLEMENTED", label: "PROTOTYPE", tone: "prototype", actionable: true },
  "UI CONCEPT": { evidenceState: "IMPLEMENTED", label: "UI CONCEPT", tone: "prototype", actionable: true },
  "EXAMPLE DATA": {
    evidenceState: "LIMITED",
    label: "EXAMPLE DATA",
    tone: "example",
    actionable: false,
    limitingDimension: "static example content; no live source connected",
  },
  FOUNDATION: { evidenceState: "IMPLEMENTED", label: "FOUNDATION", tone: "foundation", actionable: false },
  "IN PROGRESS": { evidenceState: "PROPOSED", label: "IN PROGRESS", tone: "foundation", actionable: false },
};

/**
 * Fail-closed mapping from any capability/status source value (a typed API
 * enum member, a `StatusLabel` literal, or free/composite text such as
 * `"PRIVATE PERSONAL AI • PROTOTYPE"` or a composed chat-status string) to
 * a `CapabilityDisplayModel`. Total: every input produces a result, no
 * input throws.
 *
 * Resolution order:
 * 1. Exact match against the known API-enum/UI-label table above.
 * 2. Substring precedence over free/composite text (spec §3.1, §6),
 *    negative/absolute-non-existence phrases checked first so a string
 *    that contains both `"NOT IMPLEMENTED"` and `"PROTOTYPE"` always
 *    resolves to `unavailable` — the exact regression this adapter exists
 *    to make structurally impossible (spec §8 row 10).
 * 3. Fail-closed fallback to `UNAVAILABLE`/`unavailable` for anything
 *    unrecognized, rendering the input text verbatim (spec §6 rule 7).
 */
export function toCapabilityDisplayModel(sourceValue: string): CapabilityDisplayModel {
  const raw = (sourceValue ?? "").trim();
  const upper = raw.toUpperCase();

  const exact = EXACT_MATCHES[raw] ?? EXACT_MATCHES[upper];
  if (exact) return { ...exact };

  if (upper.length === 0) {
    return { evidenceState: "UNAVAILABLE", label: "UNAVAILABLE", tone: "unavailable", actionable: false };
  }

  // Step 1 — prohibited/hard-blocked and absolute non-existence phrases,
  // checked before any positive-sounding substring (spec §3.1 rule 1, §6
  // rules 3–5). No current label uses "PROHIBITED"; this branch
  // pre-authorizes its precedence position per spec §6 rule 5.
  if (upper.includes("PROHIBITED")) {
    return { evidenceState: "PROHIBITED", label: upper, tone: "unavailable", actionable: false };
  }
  if (upper.includes("NOT IMPLEMENTED")) {
    return { evidenceState: "UNAVAILABLE", label: upper, tone: "unavailable", actionable: false };
  }

  // Step 2 — prototype-family phrases, only reachable once step 1 has
  // ruled out a negative phrase.
  if (upper.includes("PROTOTYPE") || upper.includes("UI CONCEPT")) {
    return { evidenceState: "IMPLEMENTED", label: upper, tone: "prototype", actionable: true };
  }

  // Step 3 — example content.
  if (upper.includes("EXAMPLE DATA")) {
    return { evidenceState: "LIMITED", label: upper, tone: "example", actionable: false };
  }

  // Step 4 — roadmap/future phrases.
  if (upper.includes("PLANNED") || upper.includes("COMING LATER")) {
    return { evidenceState: "FUTURE", label: upper, tone: "planned", actionable: false };
  }

  // Step 5 — written-but-not-built contracts.
  if (upper.includes("DESIGNED") || upper.includes("EXPLORATORY")) {
    return {
      evidenceState: upper.includes("EXPLORATORY") ? "PROPOSED" : "SPECIFIED",
      label: upper,
      tone: "designed",
      actionable: false,
    };
  }

  // Step 6 — exact-only match, never substring, per spec §3.1 rule 6.
  if (upper === "FOUNDATION" || upper === "IN PROGRESS") {
    return {
      evidenceState: upper === "FOUNDATION" ? "IMPLEMENTED" : "PROPOSED",
      label: upper,
      tone: "foundation",
      actionable: false,
    };
  }

  // Step 7 — fail-closed fallback (spec §6 rule 7): unrecognized text
  // renders verbatim with a conservative, never-positive tone.
  return { evidenceState: "UNAVAILABLE", label: upper, tone: "unavailable", actionable: false };
}

/**
 * Centralizes the snake_case-to-spaced text translation previously
 * duplicated as ad hoc `.replace(/_/g, " ")` calls in `describeChatState`,
 * `describePreSendState`, and `ChatBubble` (spec §5.1, §10). Used for
 * enum-shaped values (e.g. `ModelRouteStatus`) that are not themselves one
 * of the canonical capability display labels above.
 */
export function humanizeSnakeCase(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * Spec §4 — Runtime action-tier classification. Restated as a concrete
 * lookup so no call site invents its own tiering; ownership of the tiers
 * themselves remains Runtime-canonical (Product Unification Contract §10
 * rule 4). Not wired into any live UI call site today — no shipped
 * capability currently carries an action-tier annotation — kept here as
 * the documented contract boundary for when one does.
 */
export type RuntimeActionTierClassification = "DIRECT" | "PARTIAL" | "NEEDS_DECISION";

export const RUNTIME_ACTION_TIER_CLASSIFICATION: Readonly<
  Record<RuntimeActionTier, RuntimeActionTierClassification>
> = Object.freeze({
  READ: "DIRECT",
  DRAFT: "DIRECT",
  WRITE_LOCAL: "NEEDS_DECISION",
  EXTERNAL_ACTION: "PARTIAL",
});

/**
 * Spec §4.1 — required sub-classification for an `EXTERNAL_ACTION`-tier
 * capability. An `UNKNOWN` outcome fails closed to hard-blocked treatment
 * (no confirm control), never to `DIRECT`/confirmable — no autonomous or
 * unattended external action may ever be classified as confirmable
 * (spec §4.1, Product Strategy §8).
 */
export function classifyExternalActionOutcome(outcome: ExternalActionOutcome): {
  classification: "DIRECT" | "PROHIBITED" | "UNAVAILABLE";
  confirmable: boolean;
} {
  if (outcome === "EXPLICIT_APPROVAL") return { classification: "DIRECT", confirmable: true };
  if (outcome === "HARD_BLOCKED") return { classification: "PROHIBITED", confirmable: false };
  return { classification: "UNAVAILABLE", confirmable: false };
}

/**
 * Spec §4/§9 rule 8 — `WRITE_LOCAL` has no established Runtime tier and
 * must never be resolved by assumption or analogy. Absent
 * operation-specific governance evidence, this always returns the
 * stricter, fail-closed treatment. No call site may pass `true` today —
 * no such evidence currently exists in this repository.
 */
export function resolveWriteLocalTreatment(
  hasOperationSpecificEvidence: boolean,
): "NEEDS_DECISION" | "UNAVAILABLE" {
  return hasOperationSpecificEvidence ? "NEEDS_DECISION" : "UNAVAILABLE";
}
