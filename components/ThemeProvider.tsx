"use client";

import * as React from "react";

/**
 * Theme system for the operator console.
 *
 * Three user-selectable modes:
 *  - `light`  force light
 *  - `dark`   force dark (the design reference)
 *  - `system` follow the OS `prefers-color-scheme`
 *
 * The *resolved* theme (`light` | `dark`) is what actually toggles the
 * `.dark` class on `<html>` (Tailwind `darkMode: ["class"]`). The chosen
 * mode persists to `localStorage` under `STORAGE_KEY`; `system` re-resolves
 * live as the OS preference changes.
 *
 * A tiny inline bootstrap script in `app/layout.tsx` applies the correct
 * class BEFORE first paint to avoid a flash of the wrong theme; this provider
 * then takes over on hydration and keeps everything in sync.
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const STORAGE_KEY = "voxhorizon-theme";

type ThemeContextValue = {
  /** The user's chosen mode (may be `system`). */
  theme: Theme;
  /** The concrete theme currently applied to the document. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Cycle light -> dark -> system -> light. */
  toggleTheme: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyClass(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/**
 * The inline bootstrap that runs before React hydrates. Stringified into a
 * `<script>` in the document head so the `.dark` class is set on the very
 * first paint. Kept dependency-free and defensive (wrapped in try/catch so a
 * blocked `localStorage` never breaks render). `defaultDark` mirrors the
 * dark-mode-first design default.
 */
export const themeBootstrapScript = `(function(){try{var k=${JSON.stringify(
  STORAGE_KEY,
)};var t=localStorage.getItem(k);if(t!=="light"&&t!=="dark"&&t!=="system"){t="dark";}var d=t==="dark"||(t==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;if(d){e.classList.add("dark");e.style.colorScheme="dark";}else{e.classList.remove("dark");e.style.colorScheme="light";}}catch(_){}})();`;

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
    resolve(defaultTheme),
  );

  // On mount, adopt the persisted choice (the bootstrap already painted it).
  React.useEffect(() => {
    let stored: Theme | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      /* localStorage may be unavailable; fall back to the default */
    }
    const initial = stored ?? defaultTheme;
    setThemeState(initial);
    const r = resolve(initial);
    setResolvedTheme(r);
    applyClass(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the document + resolved theme in sync whenever the mode changes.
  React.useEffect(() => {
    const r = resolve(theme);
    setResolvedTheme(r);
    applyClass(r);
  }, [theme]);

  // When in `system` mode, react live to OS preference flips.
  React.useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = getSystemTheme();
      setResolvedTheme(r);
      applyClass(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const toggleTheme = React.useCallback(() => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  }, [theme, setTheme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the theme. Returns a safe inert fallback when called outside a
 * provider (e.g. an isolated component test) so consumers never crash.
 */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  return {
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
    toggleTheme: () => {},
  };
}
