// Keeps the open tabs between launches, so the app reopens where the user left off. Games are
// stored in the same PGN shape the importer produces, with the current position as an index path.

import type { PgnGame } from "../chess/pgn";

const STORAGE_KEY = "enpawssant.workspace";
/** Bump when the stored shape changes; older data is then ignored rather than misread. */
const VERSION = 1;

export type SavedTab = {
  title: string;
  game: PgnGame;
  /** The current position as an `indexPath` into the game's move tree. */
  position: number[];
};

export type SavedWorkspace = {
  tabs: SavedTab[];
  /** Index of the active tab. */
  active: number;
};

export function loadWorkspace(): SavedWorkspace | undefined {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? parseWorkspace(text) : undefined;
  } catch {
    return undefined;
  }
}

export function saveWorkspace(workspace: SavedWorkspace) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeWorkspace(workspace));
  } catch {
    // Storage may be full or unavailable; the next launch then starts on an empty board.
  }
}

export function serializeWorkspace(workspace: SavedWorkspace): string {
  return JSON.stringify({ version: VERSION, ...workspace });
}

/** Reads stored workspace data, dropping tabs that don't look right. */
export function parseWorkspace(text: string): SavedWorkspace | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || data.version !== VERSION || !Array.isArray(data.tabs)) return undefined;
  const active = Number.isInteger(data.active) ? (data.active as number) : 0;
  // Keep the active tab selected even when tabs before it are dropped.
  const activeTab = data.tabs[active];
  const tabs = data.tabs.filter(isSavedTab);
  return { tabs, active: Math.max(0, tabs.indexOf(activeTab)) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isSavedTab(value: unknown): value is SavedTab {
  if (!isRecord(value) || typeof value.title !== "string") return false;
  if (!Array.isArray(value.position) || !value.position.every(Number.isInteger)) return false;
  const game = value.game;
  return (
    isRecord(game) &&
    typeof game.startFen === "string" &&
    Array.isArray(game.moves) &&
    Array.isArray(game.headers) &&
    game.headers.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length === 2 &&
        typeof tag[0] === "string" &&
        typeof tag[1] === "string",
    )
  );
}
