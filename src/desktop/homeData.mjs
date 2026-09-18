import { deriveRuntimeStatus, runtimeTodayRowState } from "./runtimeStatus.mjs";

/**
 * Pure derivation for the Yuzuki V1 Home surface.
 *
 * Every value produced here is derived from something the app actually
 * observed. The hard rule this module exists to enforce: `fetchHermesSessions`
 * and `fetchPendingApprovals` both swallow transport errors and return `[]`,
 * so an empty array alone can mean EITHER "nothing there" OR "could not
 * reach the local service". Rendering "0" from that would be a fabricated
 * live status. Availability is therefore always a SEPARATE input here, and
 * an unavailable source resolves to an `unavailable` row — never to zero.
 */

/** Hermes timestamps arrive in seconds; tolerate ms without guessing wrong. */
export function toEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

export function isSameLocalDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Greeting is a function of the local clock only — never a claim about the
 * user, their schedule, or anything Yuzuki "noticed".
 */
export function greetingFor(nowMs) {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Categories the V1 Knowledge Preview can speak to. Only `conversations` is
 * ever backed by a real index; the rest are declared not-indexed so the
 * preview shows the SHAPE of the context, absences included, rather than
 * implying a graph that already understands everything.
 */
export const UNINDEXED_CATEGORIES = Object.freeze([
  Object.freeze({ id: "projects", label: "Projects" }),
  Object.freeze({ id: "notes", label: "Notes" }),
  Object.freeze({ id: "people", label: "People" }),
  Object.freeze({ id: "tasks", label: "Tasks" }),
]);

export function deriveKnowledgeCategories({ hermesSessions, hermesAvailable }) {
  const conversations = hermesAvailable
    ? { id: "conversations", label: "Conversations", state: "indexed", count: hermesSessions.length }
    : { id: "conversations", label: "Conversations", state: "unavailable", count: null };
  return [conversations, ...UNINDEXED_CATEGORIES.map((c) => ({ id: c.id, label: c.label, state: "not_indexed", count: null }))];
}

/**
 * Lay conversations out as a time-ordered star field.
 *
 *   x = when it started (older left, newer right)
 *   y = how long it ran (more messages sit higher)
 *   radius + brightness = the same two measurements, reinforced
 *
 * Both axes are real measurements, which is what earns this visualization
 * its place over a plain list. When a dimension carries no variance (one
 * conversation, or every conversation the same length) the layout centres
 * that axis and reports `hasVolumeVariance: false`, so the caller can drop
 * the axis legend instead of implying a spread that is not there.
 */
export function layoutConstellation(hermesSessions) {
  const points = [];
  for (const session of hermesSessions) {
    const at = toEpochMs(session.started_at);
    if (at === null) continue;
    const rawCount = session.message_count;
    const messageCount =
      typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : null;
    points.push({ id: session.id, title: session.title, at, messageCount });
  }
  if (points.length === 0) {
    return { stars: [], oldestAt: null, newestAt: null, hasVolumeVariance: false };
  }

  points.sort((a, b) => a.at - b.at);
  const oldestAt = points[0].at;
  const newestAt = points[points.length - 1].at;
  const timeSpan = newestAt - oldestAt;

  const counts = points.map((p) => p.messageCount ?? 0);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const countSpan = maxCount - minCount;
  const hasVolumeVariance = countSpan > 0;

  const stars = points.map((point) => {
    const timeNorm = timeSpan > 0 ? (point.at - oldestAt) / timeSpan : 0.5;
    const volumeNorm = hasVolumeVariance ? ((point.messageCount ?? 0) - minCount) / countSpan : 0.5;
    return {
      id: point.id,
      title: point.title,
      at: point.at,
      messageCount: point.messageCount,
      // Inset from the edges so a star at either extreme is never clipped.
      x: 0.06 + timeNorm * 0.88,
      y: 0.82 - volumeNorm * 0.64,
      // Floor raised in correction pass 1: a 2.6 radius rendered a ~5px dot
      // that collided with its neighbours and was hard to aim at.
      radius: 3.6 + volumeNorm * 4.4,
      // Recency drives brightness, so "what I was just doing" reads first.
      brightness: 0.42 + timeNorm * 0.58,
    };
  });

  return { stars, oldestAt, newestAt, hasVolumeVariance };
}

/**
 * Retained for the Home surface's prose. Delegates to the one canonical
 * interpretation in runtimeStatus.mjs rather than re-deriving it, so Home
 * and Chat can no longer drift apart.
 */
export function describeHermesState(hermes) {
  return deriveRuntimeStatus(hermes).detail;
}

/**
 * The Today rows. Availability is always explicit: a source that could not
 * be reached yields `state: "unavailable"`, never a zero count.
 */
export function deriveToday({
  hermesSessions,
  hermesSessionsAvailable,
  approvals,
  approvalsAvailable,
  hermes,
  nowMs,
}) {
  const rows = [];

  if (!hermesSessionsAvailable) {
    rows.push({
      id: "conversations",
      label: "Conversations today",
      state: "unavailable",
      detail: "Hermes conversation history is unreachable.",
    });
  } else {
    const startedToday = hermesSessions.filter((session) => {
      const at = toEpochMs(session.started_at);
      return at !== null && isSameLocalDay(at, nowMs);
    });
    rows.push(
      startedToday.length > 0
        ? { id: "conversations", label: "Conversations today", state: "present", count: startedToday.length, items: startedToday }
        : { id: "conversations", label: "Conversations today", state: "empty", detail: "Nothing yet today." },
    );
  }

  if (!approvalsAvailable) {
    rows.push({ id: "approvals", label: "Waiting on you", state: "unavailable", detail: "Approval queue unreachable." });
  } else {
    rows.push(
      approvals.length > 0
        ? { id: "approvals", label: "Waiting on you", state: "present", count: approvals.length, items: approvals }
        : { id: "approvals", label: "Waiting on you", state: "empty", detail: "No decisions pending." },
    );
  }

  // The runtime row reads the same derivation Chat's status line reads.
  // It keys off the lifecycle state, not `connected`: a connected runtime
  // with no model loaded is Degraded, never the word "Ready".
  const runtime = deriveRuntimeStatus(hermes);
  rows.push({
    id: "runtime",
    label: "Yuzuki runtime",
    state: runtimeTodayRowState(runtime.kind),
    detail: runtime.detail,
  });

  return rows;
}

/**
 * Data categories Yuzuki has no connection to at all. Listed explicitly so
 * Today reads as an honest account of what is and is not wired up, instead
 * of quietly omitting them and letting the surface look complete.
 */
export const NOT_CONNECTED_SOURCES = Object.freeze([
  Object.freeze({ id: "calendar", label: "Calendar" }),
  Object.freeze({ id: "email", label: "Email" }),
  Object.freeze({ id: "reminders", label: "Reminders" }),
]);
