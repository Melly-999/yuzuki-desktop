/**
 * The single runtime-state interpretation for the whole desktop.
 *
 * Before this module there were two: Home derived its "Yuzuki runtime" row
 * from `hermes.connected` (a transport fact), while Chat rendered
 * `hermes.state` (a lifecycle fact) out of its own separately-owned copy of
 * the runtime info. The two disagreed in two distinct ways, both of them
 * real rather than transient:
 *
 *   1. Chat's copy started `null` and was only ever written by chat-stream
 *      events, so before the first turn of a session Chat said "Local
 *      runtime not started" while Home — reading the status endpoint — said
 *      Ready. Same machine, same instant, two answers.
 *   2. `connected` is not readiness. A runtime that is connected but has no
 *      model loaded (`MODEL_NOT_READY`) satisfied `connected === true`, so
 *      Home rendered the literal word "Ready" for a runtime that could not
 *      answer a single turn.
 *
 * Both surfaces now call `deriveRuntimeStatus` on the same object, so a
 * disagreement is no longer representable. `connected` is used only where
 * it is actually the question being asked: a transport that is down
 * downgrades an otherwise-ready state, but it can never upgrade one.
 */

/**
 * Canonical runtime kinds, ordered from "cannot serve a turn" to "serving".
 * `word` is the one-word badge; `detail` is the sentence beneath it.
 */
export const RUNTIME_KIND = Object.freeze({
  UNKNOWN: "unknown",
  STARTING: "starting",
  DEGRADED: "degraded",
  FAILED: "failed",
  READY: "ready",
  WORKING: "working",
});

const WORD_FOR_KIND = Object.freeze({
  [RUNTIME_KIND.UNKNOWN]: "Unknown",
  [RUNTIME_KIND.STARTING]: "Starting",
  [RUNTIME_KIND.DEGRADED]: "Degraded",
  [RUNTIME_KIND.FAILED]: "Failed",
  [RUNTIME_KIND.READY]: "Ready",
  [RUNTIME_KIND.WORKING]: "Working",
});

/** Which kinds can actually serve a turn right now. */
const CAN_SERVE = Object.freeze(new Set([RUNTIME_KIND.READY, RUNTIME_KIND.WORKING]));

/**
 * Interpret raw Hermes runtime info into the one shape every surface reads.
 *
 * `hermes === null` means the status source itself could not be read. That
 * is reported as UNKNOWN — never as "not started", which is a claim about
 * the runtime that an unreadable source cannot support.
 */
export function deriveRuntimeStatus(hermes) {
  if (!hermes) {
    return {
      kind: RUNTIME_KIND.UNKNOWN,
      word: "Unknown",
      detail: "Runtime state unknown.",
      canServeTurn: false,
    };
  }

  const where = hermes.model ? hermes.model : hermes.profile ? `profile ${hermes.profile}` : "local runtime";
  let kind;
  let detail;

  switch (hermes.state) {
    case "HERMES_READY":
      kind = RUNTIME_KIND.READY;
      detail = `Ready — ${where}.`;
      break;
    case "HERMES_STARTING":
      kind = RUNTIME_KIND.STARTING;
      detail = "Starting up.";
      break;
    case "MODEL_NOT_READY":
      // Connected is not ready: this runtime cannot answer a turn.
      kind = RUNTIME_KIND.DEGRADED;
      detail = "Connected, but no model is ready.";
      break;
    case "REQUEST_RUNNING":
      kind = RUNTIME_KIND.WORKING;
      detail = `Working — ${where}.`;
      break;
    case "REQUEST_FAILED":
      kind = RUNTIME_KIND.FAILED;
      detail = hermes.detail || "The last request failed.";
      break;
    default:
      kind = RUNTIME_KIND.DEGRADED;
      detail = hermes.detail || "Not connected.";
      break;
  }

  // A dropped transport downgrades a state that would otherwise claim
  // readiness. It never upgrades one — an unreachable runtime is not made
  // ready by a stale `state` field.
  if (!hermes.connected && CAN_SERVE.has(kind)) {
    kind = RUNTIME_KIND.DEGRADED;
    detail = hermes.detail || "The local runtime is not connected.";
  }

  return { kind, word: WORD_FOR_KIND[kind], detail, canServeTurn: CAN_SERVE.has(kind) };
}

/**
 * Map the canonical kind onto Home's TodayRow vocabulary. Only a runtime
 * that can genuinely serve a turn is allowed to reach `present`, which is
 * what Home renders as the word "Ready".
 */
export function runtimeTodayRowState(kind) {
  if (kind === RUNTIME_KIND.UNKNOWN) return "unavailable";
  if (CAN_SERVE.has(kind)) return "present";
  return "degraded";
}
