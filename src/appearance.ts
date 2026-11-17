// Applies the appearance settings: the light or dark palette and the board theme are attributes on
// the root element that `styles.css` reads, and the window frame follows the theme too.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createRoot } from "solid-js";
import { resolvedTheme, settings } from "./settings";

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
