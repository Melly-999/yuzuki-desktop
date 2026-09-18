import { toCapabilityDisplayModel } from "../lib/capabilityStateAdapter";

/**
 * Desktop-local re-implementation of App.tsx's StatusBadge — same markup
 * shape and the same global `.status-badge`/`.status-badge-*`/`.status-dot`
 * CSS classes already defined in styles.css, and the same canonical
 * `toCapabilityDisplayModel` adapter. Kept local rather than importing from
 * App.tsx so the mobile/marketing monolith stays untouched by this task.
 */
export function StatusBadge({ status }: { status: string }) {
  const { label, tone } = toCapabilityDisplayModel(status);
  return (
    <span className={`status-badge status-badge-${tone}`}>
      <span aria-hidden className="status-dot" />
      {label}
    </span>
  );
}
