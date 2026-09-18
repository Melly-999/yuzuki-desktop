/**
 * Deterministic synthetic fixtures for public screenshots and demos.
 *
 * FIXTURE_CLASS: SYNTHETIC_PUBLIC_FIXTURE
 * REAL_USER_STATE_USED: NO
 *
 * Isolation is structural, not conventional: every value below is an
 * in-memory repository-owned constant. Nothing here opens a database,
 * reads a profile directory, spawns a runtime, or touches the real
 * Hermes SessionDB — so a fixture render cannot observe, mutate, or leak
 * personal state even by accident. The mode is off unless
 * `YUZUKI_PUBLIC_FIXTURE=1` is set explicitly; it is never inferred.
 *
 * Timestamps are fixed so repeated captures are byte-stable.
 */

/** Fixed synthetic clock: 2026-01-15T09:00:00Z. Never "now". */
const FIXTURE_EPOCH_MS = 1_768_467_600_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function publicFixtureEnabled(env = process.env) {
  return env.YUZUKI_PUBLIC_FIXTURE === "1";
}

/**
 * A READY runtime, described in the same shape `HermesBridge.describe()`
 * returns. Generic profile/provider/model wording only — no private
 * deployment identifier and no real model tag.
 */
export function fixtureStatus() {
  return {
    state: "HERMES_READY",
    detail: "Local runtime ready (public fixture).",
    profile: "yuzuki-local",
    provider: "local (loopback)",
    model: "local-model",
    routing: { mode: "PRIVATE", model_id: null },
    session_id: "fixture-session-0001",
    connected: true,
    pending_approvals: 0,
  };
}

/** Synthetic conversation list, matching `listSessions()`'s row shape. */
export function fixtureSessions() {
  return [
    {
      id: "fixture-session-0001",
      title: "Plan a weekend project",
      preview: "Outline the steps, then pick one to start with.",
      started_at: FIXTURE_EPOCH_MS,
      message_count: 6,
      source: "local",
    },
    {
      id: "fixture-session-0002",
      title: "Review release notes",
      preview: "Summarise what changed since the previous version.",
      started_at: FIXTURE_EPOCH_MS - 2 * HOUR,
      message_count: 4,
      source: "local",
    },
    {
      id: "fixture-session-0003",
      title: "Explore local knowledge",
      preview: "Show how the saved notes connect to each other.",
      started_at: FIXTURE_EPOCH_MS - 26 * HOUR,
      message_count: 9,
      source: "local",
    },
    {
      id: "fixture-session-0004",
      title: "Prepare a project brief",
      preview: "Draft the goals, scope, and open questions.",
      started_at: FIXTURE_EPOCH_MS - 50 * HOUR,
      message_count: 3,
      source: "local",
    },
  ];
}

/**
 * Deterministic search over the synthetic list only. Same matching rule
 * every time, so a captured search screenshot is reproducible.
 */
export function fixtureSearch(query, limit = 20) {
  const needle = String(query || "").trim().toLowerCase();
  const results = fixtureSessions()
    .filter((row) => !needle || `${row.title} ${row.preview}`.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((row) => ({
      sessionId: row.id,
      title: row.title,
      timestamp: row.started_at,
      snippet: row.preview,
    }));
  return { query: String(query || ""), results };
}

/**
 * Policy-approved ADVANCED choices, in the shape the read-only
 * routing.options projection returns. Synthetic ids and display names.
 */
export function fixtureRoutingOptions() {
  return {
    status: "READY",
    models: [
      {
        id: "local-model",
        displayName: "Local model",
        provider: "local",
        locality: "local",
        selectable: true,
        status: "READY",
        lifecycle: "active",
        capabilities: ["chat"],
        budgetClass: "local",
      },
      {
        id: "example-fast-model",
        displayName: "Example fast model",
        provider: "example-provider",
        locality: "cloud",
        selectable: true,
        status: "READY",
        lifecycle: "active",
        capabilities: ["chat", "tools"],
        budgetClass: "low",
      },
      {
        id: "example-deep-model",
        displayName: "Example deep model",
        provider: "example-provider",
        locality: "cloud",
        selectable: true,
        status: "READY",
        lifecycle: "active",
        capabilities: ["chat", "tools", "reasoning"],
        budgetClass: "high",
      },
    ],
  };
}
