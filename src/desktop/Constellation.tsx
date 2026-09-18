import type { CSSProperties } from "react";
import { isSameLocalDay } from "./homeData";
import type { ConstellationLayout, KnowledgeCategory } from "./homeData";

/**
 * The V1 Knowledge Preview.
 *
 * This is deliberately NOT a graph engine: no physics, no inferred
 * relationships, no embeddings, no persistence. It is a two-axis plot of
 * conversations Hermes already owns — x is when a conversation started,
 * y is how long it ran — which is what earns it a place over a plain list.
 *
 * Accessibility: the field itself (horizon, path) is decorative and hidden
 * from assistive tech. Every conversation is a real, focusable button in
 * chronological DOM order carrying its own text label, and Home repeats the
 * same conversations as a text list below, so nothing here is conveyed by
 * position or brightness alone.
 */

function formatWhen(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(atMs));
}

function formatAxisDate(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(atMs));
}

function formatAxisTime(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(atMs));
}

function describeStar(title: string, atMs: number, messageCount: number | null): string {
  const when = formatWhen(atMs);
  if (messageCount === null) return `${title} — ${when}. Open conversation.`;
  return `${title} — ${when}, ${messageCount} message${messageCount === 1 ? "" : "s"}. Open conversation.`;
}

type Props = {
  layout: ConstellationLayout;
  categories: KnowledgeCategory[];
  /** False when the local service could not be reached at all. */
  hermesAvailable: boolean;
  onOpenConversation: (sessionId: string, title: string) => void;
  busySessionId: string | null;
};

export function Constellation({ layout, categories, hermesAvailable, onOpenConversation, busySessionId }: Props) {
  const { stars, oldestAt, newestAt, hasVolumeVariance } = layout;
  const unindexed = categories.filter((category) => category.state === "not_indexed");
  const conversations = categories.find((category) => category.id === "conversations");

  const spansOneDay = oldestAt !== null && newestAt !== null && isSameLocalDay(oldestAt, newestAt);

  const path =
    stars.length > 1
      ? stars.map((star, index) => `${index === 0 ? "M" : "L"}${(star.x * 100).toFixed(2)},${(star.y * 100).toFixed(2)}`).join(" ")
      : null;

  return (
    <section className="dz-constellation" aria-labelledby="dz-constellation-title">
      <div className="dz-constellation-head">
        <h2 id="dz-constellation-title">What Yuzuki has to work with</h2>
        <p className="dz-constellation-sub">
          {hermesAvailable && conversations?.state === "indexed"
            ? `${conversations.count} conversation${conversations.count === 1 ? "" : "s"} on this device. Nothing else is indexed yet.`
            : "The local conversation index could not be read."}
        </p>
      </div>

      <div className="dz-constellation-field">
        <svg className="dz-constellation-canvas" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
          {path && <path className="dz-constellation-path" d={path} vectorEffect="non-scaling-stroke" />}
          <path className="dz-constellation-horizon" d="M0,96 Q50,88 100,96" vectorEffect="non-scaling-stroke" />
        </svg>

        {!hermesAvailable && (
          <p className="dz-constellation-state" role="status">
            Not connected — the local Yuzuki service is unreachable, so nothing can be read from this device yet.
          </p>
        )}

        {hermesAvailable && stars.length === 0 && (
          <p className="dz-constellation-state" role="status">
            Nothing here yet. Your first conversation becomes the first point on this map.
          </p>
        )}

        {stars.length > 0 && (
          <ul className="dz-constellation-stars">
            {stars.map((star, index) => (
              <li
                key={star.id}
                style={
                  {
                    left: `${star.x * 100}%`,
                    top: `${star.y * 100}%`,
                    // Drives the one orchestrated entrance on this surface:
                    // a single staggered settle, disabled under
                    // prefers-reduced-motion.
                    "--dz-star-i": index,
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className="dz-star"
                  disabled={busySessionId !== null}
                  aria-label={describeStar(star.title, star.at, star.messageCount)}
                  onClick={() => onOpenConversation(star.id, star.title)}
                >
                  <span
                    className="dz-star-dot"
                    style={{ width: `${star.radius * 2}px`, height: `${star.radius * 2}px`, opacity: star.brightness }}
                  />
                  <span className="dz-star-tip" aria-hidden>
                    <span className="dz-star-tip-title">{star.title}</span>
                    <span className="dz-star-tip-meta">
                      {formatWhen(star.at)}
                      {star.messageCount !== null ? ` · ${star.messageCount} message${star.messageCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {stars.length > 0 && oldestAt !== null && newestAt !== null && (
        <div className="dz-constellation-axis">
          {/* When the whole span sits inside one day, dates at both ends
              render identically and say nothing — so the ends switch to
              clock times and the day itself moves into the legend. */}
          <span>{spansOneDay ? formatAxisTime(oldestAt) : formatAxisDate(oldestAt)}</span>
          <span className="dz-constellation-legend">
            {spansOneDay ? `${formatAxisDate(newestAt)} · ` : ""}
            {hasVolumeVariance ? "left to right: oldest to newest · higher: longer conversation" : "left to right: oldest to newest"}
          </span>
          <span>{spansOneDay ? formatAxisTime(newestAt) : formatAxisDate(newestAt)}</span>
        </div>
      )}

      <ul className="dz-constellation-absent">
        {unindexed.map((category) => (
          <li key={category.id}>
            <span className="dz-constellation-absent-label">{category.label}</span>
            <span className="dz-constellation-absent-state">not indexed</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
