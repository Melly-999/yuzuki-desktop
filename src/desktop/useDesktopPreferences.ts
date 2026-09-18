import { useEffect, useState } from "react";
import type { LayoutId, ThemeId } from "./types";

/**
 * Purely cosmetic, non-sensitive local UI preference (theme + layout
 * choice only). Never store chat/session content here — see
 * docs/product/YUZUKI_DESKTOP_WORKSPACE_EXPERIENCE_CONTRACT.md §10 and
 * §15, and docs/product/YUZUKI_DESKTOP_RUNTIME_INTEGRATION_READINESS.md
 * §18. Falls back to the defaults if localStorage is unavailable
 * (private browsing, disabled storage) or holds an unrecognized value.
 */
const THEME_KEY = "yuzuki-desktop-theme";
const LAYOUT_KEY = "yuzuki-desktop-layout";

const VALID_THEMES: ThemeId[] = ["violet", "ember"];
const VALID_LAYOUTS: LayoutId[] = ["companion", "focus", "workspace", "review"];

function readPreference<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored && (valid as readonly string[]).includes(stored) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing / disabled storage — the preference simply doesn't
    // persist this session. Never throw for a cosmetic preference.
  }
}

export function useDesktopPreferences() {
  const [theme, setThemeState] = useState<ThemeId>(() => readPreference(THEME_KEY, VALID_THEMES, "violet"));
  const [layout, setLayoutState] = useState<LayoutId>(() =>
    readPreference(LAYOUT_KEY, VALID_LAYOUTS, "workspace"),
  );

  useEffect(() => {
    writePreference(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    writePreference(LAYOUT_KEY, layout);
  }, [layout]);

  return { theme, setTheme: setThemeState, layout, setLayout: setLayoutState };
}
