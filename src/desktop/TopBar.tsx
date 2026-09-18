import type { LayoutId, ThemeId } from "./types";
import { StatusBadge } from "./StatusBadge";

const LAYOUTS: { id: LayoutId; label: string }[] = [
  { id: "companion", label: "Companion" },
  { id: "focus", label: "Focus" },
  { id: "workspace", label: "Workspace" },
  { id: "review", label: "Review" },
];

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "violet", label: "Yuzuki Violet" },
  { id: "ember", label: "Yuzuki Ember" },
];

type Props = {
  sessionTitle: string | null;
  serverState: "checking" | "reachable" | "unreachable";
  layout: LayoutId;
  onLayoutChange: (layout: LayoutId) => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
};

export function TopBar({ sessionTitle, serverState, layout, onLayoutChange, theme, onThemeChange }: Props) {
  return (
    <header className="dz-topbar">
      <div className="dz-topbar-identity">
        <span className="dz-topbar-mark" aria-hidden />
        <span className="dz-topbar-name">Yuzuki</span>
        <span className="dz-topbar-divider" aria-hidden>
          /
        </span>
        <span className="dz-topbar-session">{sessionTitle ?? "No conversation selected"}</span>
      </div>

      <div className="dz-topbar-controls">
        <div className="dz-segment" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={layout === option.id}
              className={`dz-segment-btn${layout === option.id ? " is-active" : ""}`}
              onClick={() => onLayoutChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="dz-segment" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className={`dz-segment-btn dz-theme-dot dz-theme-dot-${option.id}${
                theme === option.id ? " is-active" : ""
              }`}
              onClick={() => onThemeChange(option.id)}
              title={option.label}
            >
              <span className="sr-only">{option.label}</span>
            </button>
          ))}
        </div>

        <StatusBadge
          status={
            serverState === "reachable"
              ? "PROTOTYPE"
              : serverState === "unreachable"
                ? "NOT IMPLEMENTED IN THIS PROTOTYPE"
                : "PROTOTYPE"
          }
        />

        <button type="button" className="dz-icon-btn" aria-label="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
