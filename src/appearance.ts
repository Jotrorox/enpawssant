// Applies the appearance settings: the light or dark palette and the board theme are attributes on
// the root element that `styles.css` reads, and the window frame follows the theme too.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createRoot } from "solid-js";
import { resolvedTheme, settings, updateSettings } from "./settings";

export function applyAppearance() {
  createRoot(() => {
    createEffect(() => {
      const root = document.documentElement;
      root.dataset.theme = resolvedTheme();
      root.dataset.boardTheme = settings.boardTheme;
    });
    createEffect(() => {
      const theme = settings.theme === "system" ? null : settings.theme;
      try {
        getCurrentWindow()
          .setTheme(theme)
          .catch(() => {});
      } catch {
        // Outside Tauri there is no window to theme.
      }
    });
  });
}

/**
 * Flips between the light and dark theme, as the toggle in the side rail does. With an `origin`
 * element the new theme spreads out from it in a growing circle where the browser supports view
 * transitions and the user hasn't asked for less motion.
 */
export function toggleTheme(origin?: Element) {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  const root = document.documentElement;
  const apply = () => {
    updateSettings({ theme: next });
    // The effect above does this too; setting it here makes sure the new snapshot has it.
    root.dataset.theme = next;
  };

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!origin || reduceMotion || typeof document.startViewTransition !== "function") {
    apply();
    return;
  }

  const rect = origin.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  root.classList.add("theme-switching");
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 560,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      ),
    )
    .catch(() => {});
  transition.finished.finally(() => root.classList.remove("theme-switching"));
}
