// App-wide preferences from the settings dialog: appearance, sound and how many engine lines to
// show. They live in local storage. Engine threads and hash are options of the engine itself and
// are kept with the engine setup in Rust instead (see `chess/engines.ts`).

import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export type ThemeMode = "system" | "light" | "dark";
export type BoardTheme = "blush" | "mint" | "lavender" | "sky" | "tabby" | "tuxedo";
export type PieceSet = "cburnett" | "chessnut" | "fantasy" | "spatial";

export type Settings = {
  theme: ThemeMode;
  boardTheme: BoardTheme;
  pieceSet: PieceSet;
  /** Sound volume from 0 to 100. Muting from the board toolbar is separate. */
  volume: number;
  /** Engine lines shown in the analysis panel. */
  multipv: number;
};

export const THEME_MODES: readonly { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Board colours; `light` and `dark` are the squares, for the previews in the settings. */
export const BOARD_THEMES: readonly {
  value: BoardTheme;
  label: string;
  light: string;
  dark: string;
}[] = [
  { value: "blush", label: "Blush", light: "#fdeef2", dark: "#f3b2c4" },
  { value: "mint", label: "Mint", light: "#eef6ec", dark: "#a3cfae" },
  { value: "lavender", label: "Lavender", light: "#f1eefb", dark: "#bbaee2" },
  { value: "sky", label: "Sky", light: "#eaf3fb", dark: "#97bcdd" },
  { value: "tabby", label: "Tabby", light: "#f0d9b5", dark: "#b88a64" },
  { value: "tuxedo", label: "Tuxedo", light: "#c8c2d3", dark: "#6c6380" },
];

export const PIECE_SETS: readonly { value: PieceSet; label: string }[] = [
  { value: "cburnett", label: "Classic" },
  { value: "chessnut", label: "Chessnut" },
  { value: "fantasy", label: "Fantasy" },
  { value: "spatial", label: "Spatial" },
];

/** Stockfish's limit in `engine.rs`. */
export const MAX_MULTIPV = 5;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  boardTheme: "blush",
  pieceSet: "cburnett",
  volume: 75,
  multipv: 3,
};

const STORAGE_KEY = "enpawssant.settings";

const oneOf = <T extends string>(options: readonly { value: T }[], value: unknown, fallback: T) =>
  options.some((option) => option.value === value) ? (value as T) : fallback;

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

/** Reads stored settings, falling back to the default for anything missing or unknown. */
function parseSettings(text: string | null): Settings {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable settings are replaced by the defaults.
  }
  const d = DEFAULT_SETTINGS;
  return {
    theme: oneOf(THEME_MODES, data.theme, d.theme),
    boardTheme: oneOf(BOARD_THEMES, data.boardTheme, d.boardTheme),
    pieceSet: oneOf(PIECE_SETS, data.pieceSet, d.pieceSet),
    volume: clampInt(data.volume, 0, 100, d.volume),
    multipv: clampInt(data.multipv, 1, MAX_MULTIPV, d.multipv),
  };
}

const state = createRoot(() => {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Without storage the defaults are used.
  }
  const [settings, setSettings] = createStore<Settings>(parseSettings(stored));
  const prefersDark =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const [systemDark, setSystemDark] = createSignal(prefersDark?.matches ?? false);
  prefersDark?.addEventListener("change", (event) => setSystemDark(event.matches));
  return { settings, setSettings, systemDark };
});

export const settings = state.settings;

export function updateSettings(changes: Partial<Settings>) {
  state.setSettings(parseSettings(JSON.stringify({ ...state.settings, ...changes })));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    // Settings then only last until the app closes.
  }
}

/** The light or dark theme in effect, resolving "system". */
export function resolvedTheme(): "light" | "dark" {
  if (settings.theme === "system") return state.systemDark() ? "dark" : "light";
  return settings.theme;
}
