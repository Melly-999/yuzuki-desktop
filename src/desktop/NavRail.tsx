import type { WorkspaceMode } from "./types";

/**
 * Primary navigation is restricted to product areas that actually exist.
 *
 * The previous list advertised "Reminders", "Files" and "Projects", which
 * routed to modes whose own workspace copy reads "PLANNED — not connected in
 * this prototype". A nav item is a capability claim, so naming three
 * unbuilt features as first-class destinations broke the planned-capability
 * rule in AGENTS.md. Those modes still exist in the type and still render
 * their labelled placeholder if routed to; they are simply no longer
 * advertised as places to go.
 */
const DESTINATIONS: { id: WorkspaceMode; label: string; icon: string }[] = [
  { id: "chat", label: "Chats", icon: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { id: "search", label: "Search", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3" },
  { id: "approval", label: "Review", icon: "M12 3l7.5 3v6c0 4.2-3 7.5-7.5 9-4.5-1.5-7.5-4.8-7.5-9V6z M9 12l2 2 4-4" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg className="dz-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      {d.split(" M").map((segment, index) => (
        <path key={index} d={index === 0 ? segment : `M${segment}`} />
      ))}
    </svg>
  );
}

type Props = {
  activeMode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  /** Requests genuinely awaiting a human decision. Zero renders no badge. */
  pendingApprovalCount: number;
  onCreateSession: () => void;
  creatingSession: boolean;
};

export function NavRail({
  activeMode,
  onModeChange,
  pendingApprovalCount,
  onCreateSession,
  creatingSession,
}: Props) {
  return (
    <nav className="dz-nav" aria-label="Yuzuki navigation">
      {/* Every control below carries an explicit accessible name rather
          than relying on its visible <span className="dz-nav-label">. Those
          labels are `display: none` in the companion/focus/review layouts
          (see desktop.css), which removes them from the accessibility tree
          entirely and left these buttons unnamed in three of the four
          layouts. An explicit aria-label takes precedence over content, so
          the name is stable in every layout and nothing visible changes. */}
      <button
        type="button"
        className="dz-new-conversation"
        onClick={onCreateSession}
        disabled={creatingSession}
        aria-label={creatingSession ? "Creating conversation" : "New conversation"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="dz-nav-label">{creatingSession ? "Creating…" : "New conversation"}</span>
      </button>

      <div className="dz-nav-group">
        {DESTINATIONS.map((destination) => (
          <button
            key={destination.id}
            type="button"
            className={`dz-nav-item${activeMode === destination.id ? " is-active" : ""}`}
            onClick={() => onModeChange(destination.id)}
            aria-current={activeMode === destination.id ? "page" : undefined}
            // An explicit aria-label replaces the whole name computation,
            // so the pending count has to be folded INTO it — it can no
            // longer ride along as an `sr-only` child. The count is still
            // spelled out rather than left as a bare number, and it only
            // appears when there are real pending requests.
            aria-label={
              destination.id === "approval" && pendingApprovalCount > 0
                ? `${destination.label}, ${pendingApprovalCount} awaiting your decision`
                : destination.label
            }
          >
            <Icon d={destination.icon} />
            <span className="dz-nav-label">{destination.label}</span>
            {/* Purely visual now: the count above is what gets announced. */}
            {destination.id === "approval" && pendingApprovalCount > 0 && (
              <span className="dz-nav-badge" aria-hidden>
                {pendingApprovalCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="dz-nav-spacer" />

      <button type="button" className="dz-nav-account" aria-label="Settings">
        <span className="dz-nav-avatar" aria-hidden />
        <span className="dz-nav-label">Settings</span>
      </button>
    </nav>
  );
}
