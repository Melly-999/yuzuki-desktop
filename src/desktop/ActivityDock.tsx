import type { ActivityEntry } from "./types";

/**
 * The full product-truth label for each tag. Kept verbatim — these are the
 * anchors AGENTS.md requires — but carried in the accessible name and the
 * tooltip, with a short state word rendered on the surface. A column of
 * repeated "NOT IMPLEMENTED IN THIS PROTOTYPE" chips turned the dock into a
 * log terminal and buried the one line that actually mattered.
 */
const TAG_LABEL: Record<ActivityEntry["tag"], string> = {
  prototype: "PROTOTYPE",
  example: "EXAMPLE DATA",
  designed: "DESIGNED / APPROVAL-BASED",
  unavailable: "NOT IMPLEMENTED IN THIS PROTOTYPE",
  error: "FAILED",
};

/**
 * The short word carried on the surface. State is never conveyed by colour
 * alone — every entry renders this word alongside its dot.
 */
const TAG_WORD: Record<ActivityEntry["tag"], string> = {
  prototype: "Done",
  example: "Example",
  designed: "Decision",
  unavailable: "Unavailable",
  error: "Failed",
};

function formatTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

/**
 * Activity, not Terminal — see
 * docs/product/YUZUKI_DESKTOP_WORKSPACE_EXPERIENCE_CONTRACT.md §7. Every
 * entry here is derived from a real state change this shell actually
 * observed (a session was created/selected, a chat request completed or
 * failed, the local server became unreachable) — never a fabricated or
 * simulated tool/model event. Raw diagnostics stay out of this normal-mode
 * surface entirely.
 */
export function ActivityDock({ entries }: { entries: ActivityEntry[] }) {
  const latest = entries[0] ?? null;

  return (
    <section className={`dz-dock${entries.length === 0 ? " is-empty" : ""}`} aria-label="Activity">
      <div className="dz-dock-header">
        <span className="dz-dock-title">Activity</span>
        {latest && (
          <span className="dz-dock-latest" aria-live="polite">
            <span className={`dz-dock-dot dz-dock-dot-${latest.tag}`} aria-hidden />
            <span className="dz-dock-latest-title">{latest.title}</span>
            <span className="dz-dock-latest-state">{TAG_WORD[latest.tag]}</span>
          </span>
        )}
      </div>
      <div className="dz-dock-list">
        {entries.length === 0 && <p className="dz-dock-empty">Nothing has happened yet this session.</p>}
        {entries.map((entry) => (
          <article key={entry.id} className={`dz-dock-entry dz-dock-entry-${entry.tag}`}>
            <span className={`dz-dock-dot dz-dock-dot-${entry.tag}`} aria-hidden />
            <span className="dz-dock-entry-title">{entry.title}</span>
            <span className="dz-dock-entry-detail">{entry.detail ?? ""}</span>
            <span className="dz-dock-entry-state" title={TAG_LABEL[entry.tag]}>
              <span className="sr-only">{TAG_LABEL[entry.tag]}</span>
              <span aria-hidden>{TAG_WORD[entry.tag]}</span>
            </span>
            <time className="dz-dock-entry-time" dateTime={entry.at}>
              {formatTime(entry.at)}
            </time>
          </article>
        ))}
      </div>
    </section>
  );
}
