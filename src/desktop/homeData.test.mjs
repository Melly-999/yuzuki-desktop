import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveKnowledgeCategories,
  deriveToday,
  describeHermesState,
  greetingFor,
  isSameLocalDay,
  layoutConstellation,
  toEpochMs,
} from "./homeData.mjs";

function hermesSessionAt(date, id = "s1") {
  return { id, title: `Session ${id}`, preview: "", started_at: date.getTime() / 1000, message_count: 1, source: "hermes" };
}

test("toEpochMs accepts seconds and milliseconds without guessing wrong", () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs(-5), null);
  assert.equal(toEpochMs("1700000000"), null);
  assert.equal(toEpochMs(Number.NaN), null);
});

test("isSameLocalDay compares calendar days, not 24-hour windows", () => {
  const lateMonday = new Date(2026, 0, 5, 23, 50).getTime();
  const earlyTuesday = new Date(2026, 0, 6, 0, 10).getTime();
  const laterMonday = new Date(2026, 0, 5, 8, 0).getTime();
  assert.equal(isSameLocalDay(lateMonday, earlyTuesday), false, "20 minutes apart but a different day");
  assert.equal(isSameLocalDay(lateMonday, laterMonday), true);
});

test("greeting is derived from the clock alone and never claims to know the user", () => {
  assert.equal(greetingFor(new Date(2026, 0, 5, 2, 0).getTime()), "Still up");
  assert.equal(greetingFor(new Date(2026, 0, 5, 9, 0).getTime()), "Good morning");
  assert.equal(greetingFor(new Date(2026, 0, 5, 14, 0).getTime()), "Good afternoon");
  assert.equal(greetingFor(new Date(2026, 0, 5, 21, 0).getTime()), "Good evening");
});

test("an unreachable approval queue reports unavailable, never zero", () => {
  const rows = deriveToday({
    hermesSessions: [],
    hermesSessionsAvailable: true,
    approvals: [],
    approvalsAvailable: false,
    hermes: null,
    nowMs: Date.now(),
  });
  const approvals = rows.find((row) => row.id === "approvals");
  assert.equal(approvals.state, "unavailable");
  assert.equal(approvals.count, undefined, "an unreachable source must not present a count at all");
});

test("an empty but reachable approval queue is genuinely empty", () => {
  const rows = deriveToday({
    hermesSessions: [],
    hermesSessionsAvailable: true,
    approvals: [],
    approvalsAvailable: true,
    hermes: null,
    nowMs: Date.now(),
  });
  assert.equal(rows.find((row) => row.id === "approvals").state, "empty");
});

test("unreachable Hermes history reports unavailable, never an empty day", () => {
  const rows = deriveToday({
    hermesSessions: [],
    hermesSessionsAvailable: false,
    approvals: [],
    approvalsAvailable: true,
    hermes: null,
    nowMs: Date.now(),
  });
  assert.equal(rows.find((row) => row.id === "conversations").state, "unavailable");
  assert.equal(rows.find((row) => row.id === "storage"), undefined, "legacy Yuzuki storage is not a conversation source");
});

test("Today counts only canonical Hermes conversations started on the current calendar day", () => {
  const now = new Date(2026, 0, 6, 10, 0);
  const rows = deriveToday({
    hermesSessions: [
      hermesSessionAt(new Date(2026, 0, 6, 9, 0), "today-a"),
      hermesSessionAt(new Date(2026, 0, 6, 1, 0), "today-b"),
      hermesSessionAt(new Date(2026, 0, 5, 23, 59), "yesterday"),
      { ...hermesSessionAt(new Date(2026, 0, 6, 2, 0), "malformed"), started_at: 0 },
    ],
    hermesSessionsAvailable: true,
    approvals: [],
    approvalsAvailable: true,
    hermes: null,
    nowMs: now.getTime(),
  });
  const conversations = rows.find((row) => row.id === "conversations");
  assert.equal(conversations.state, "present");
  assert.equal(conversations.count, 2);
});

test("knowledge categories only ever claim conversations are indexed", () => {
  const categories = deriveKnowledgeCategories({
    hermesSessions: [{ id: "a", title: "A", preview: "", started_at: 1, message_count: 2, source: "hermes" }],
    hermesAvailable: true,
  });
  const indexed = categories.filter((category) => category.state === "indexed");
  assert.deepEqual(
    indexed.map((category) => category.id),
    ["conversations"],
  );
  assert.equal(indexed[0].count, 1);
  for (const category of categories.filter((c) => c.id !== "conversations")) {
    assert.equal(category.state, "not_indexed");
    assert.equal(category.count, null, "an unindexed category must never carry a count");
  }
});

test("knowledge conversations report unavailable when Hermes could not be reached", () => {
  const categories = deriveKnowledgeCategories({ hermesSessions: [], hermesAvailable: false });
  const conversations = categories.find((category) => category.id === "conversations");
  assert.equal(conversations.state, "unavailable");
  assert.equal(conversations.count, null, "an unreachable index must not render as zero");
});

test("constellation places older conversations left and longer ones higher", () => {
  const layout = layoutConstellation([
    { id: "old-short", title: "Old", preview: "", started_at: 1000, message_count: 2, source: "hermes" },
    { id: "new-long", title: "New", preview: "", started_at: 2000, message_count: 40, source: "hermes" },
  ]);
  const [older, newer] = layout.stars;
  assert.equal(older.id, "old-short");
  assert.ok(older.x < newer.x, "older sits left of newer");
  assert.ok(newer.y < older.y, "the longer conversation sits higher");
  assert.ok(newer.radius > older.radius);
  assert.ok(newer.brightness > older.brightness, "the more recent conversation is brighter");
  assert.equal(layout.hasVolumeVariance, true);
});

test("constellation stays inside its field and reports absent variance honestly", () => {
  const layout = layoutConstellation([
    { id: "a", title: "A", preview: "", started_at: 1000, message_count: 5, source: "hermes" },
    { id: "b", title: "B", preview: "", started_at: 2000, message_count: 5, source: "hermes" },
  ]);
  assert.equal(layout.hasVolumeVariance, false, "identical lengths must not imply a spread");
  for (const star of layout.stars) {
    assert.ok(star.x >= 0 && star.x <= 1, "x stays within the field");
    assert.ok(star.y >= 0 && star.y <= 1, "y stays within the field");
  }
});

test("constellation drops entries with no usable timestamp instead of inventing one", () => {
  const layout = layoutConstellation([
    { id: "good", title: "Good", preview: "", started_at: 1000, message_count: 1, source: "hermes" },
    { id: "bad", title: "Bad", preview: "", started_at: 0, message_count: 1, source: "hermes" },
  ]);
  assert.deepEqual(
    layout.stars.map((star) => star.id),
    ["good"],
  );
});

test("an empty constellation reports no time span rather than a fabricated one", () => {
  const layout = layoutConstellation([]);
  assert.deepEqual(layout.stars, []);
  assert.equal(layout.oldestAt, null);
  assert.equal(layout.newestAt, null);
});

test("runtime description never claims readiness the state does not support", () => {
  assert.match(describeHermesState({ state: "HERMES_READY", model: "local-7b", connected: true, detail: "", profile: null, provider: null, session_id: null }), /Ready/);
  assert.match(describeHermesState({ state: "MODEL_NOT_READY", model: null, connected: true, detail: "", profile: null, provider: null, session_id: null }), /no model is ready/);
  assert.equal(describeHermesState(null), "Runtime state unknown.");
});
