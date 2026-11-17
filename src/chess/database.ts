// Frontend side of the game database in `src-tauri/src/database.rs`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import type { ExplorerResult } from "./explorer";
import type { PgnGame } from "./pgn";

export type GameSummary = {
  id: number;
  white: string;
  black: string;
  whiteElo: number | null;
  blackElo: number | null;
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  date: string;
  event: string;
  site: string;
  eco: string;
  opening: string;
  plies: number;
  /** For position searches: the first ply at which the game reached the position. */
  ply: number | null;
};

export type SearchQuery = {
  /** Matches players, event, site and opening; every word must match. */
  text?: string;
  /** Matches either player. */
  player?: string;
  /** Matches the ECO code or opening name. */
  opening?: string;
  result?: string;
  /** Games that reached this position in their main line. */
  fen?: string;
  offset: number;
  limit: number;
};

export type SearchResult = { games: GameSummary[]; total: number };

export type DatabaseStats = { games: number; path: string };

export type ImportProgress = {
  file: string;
  filesDone: number;
  filesTotal: number;
  bytesRead: number;
  bytesTotal: number;
  imported: number;
  duplicates: number;
  failed: number;
};

export type ImportSummary = {
  imported: number;
  duplicates: number;
  failed: number;
  cancelled: boolean;
  messages: string[];
};

export type AddedGame = { id: number | null; duplicate: boolean };

export const databaseStats = () => invoke<DatabaseStats>("db_stats");

export const searchGames = (query: SearchQuery) => invoke<SearchResult>("db_search", { query });

export const loadGame = (id: number) => invoke<PgnGame>("db_game", { id });

export const deleteGame = (id: number) => invoke<void>("db_delete_game", { id });

export const clearDatabase = () => invoke<void>("db_clear");

export const addGame = (game: PgnGame) => invoke<AddedGame>("db_add_game", { game });

export const exploreDatabase = (fen: string) => invoke<ExplorerResult>("db_explorer", { fen });

/** Shared by every view, so the explorer and the database view notice new games. */
const changes = createRoot(() => createSignal(0));

/** Changes whenever games are added or removed. */
export const databaseVersion = changes[0];
export const databaseChanged = () => changes[1]((n) => n + 1);

/** The import that is running, if any, so every view can show it. */
const running = createRoot(() => createSignal<ImportProgress>());
export const importProgress = running[0];

async function runImport(
  start: (channel: Channel<ImportProgress>) => Promise<ImportSummary | null>,
): Promise<ImportSummary | null> {
  const channel = new Channel<ImportProgress>();
  channel.onmessage = (progress) => running[1](progress);
  try {
    return await start(channel);
  } finally {
    running[1](undefined);
    databaseChanged();
  }
}

/** Asks for PGN files and imports them, resolving to `null` when the dialog is cancelled. */
export const importFiles = () =>
  runImport((onProgress) => invoke<ImportSummary | null>("db_import_files", { onProgress }));

/** Imports PGN files by path, e.g. dropped on the window. */
export const importPaths = (paths: string[]) =>
  runImport((onProgress) => invoke<ImportSummary>("db_import_paths", { paths, onProgress }));

export const cancelImport = () => invoke<void>("db_cancel_import");

/** Whether `text` looks like a FEN (at least its piece placement), for the search box. */
export function looksLikeFen(text: string): boolean {
  const placement = text.trim().split(/\s+/)[0] ?? "";
  const ranks = placement.split("/");
  return (
    ranks.length === 8 &&
    ranks.every((rank) => {
      if (!/^[pnbrqkPNBRQK1-8]+$/.test(rank)) return false;
      let squares = 0;
      for (const char of rank) squares += /\d/.test(char) ? Number(char) : 1;
      return squares === 8;
    })
  );
}

/** Completes a bare piece placement to a full FEN, assuming White to move. */
export function completeFen(text: string): string {
  const fields = text.trim().split(/\s+/);
  const defaults = ["", "w", "-", "-", "0", "1"];
  return defaults.map((fallback, i) => fields[i] ?? fallback).join(" ");
}

export function formatResult(result: GameSummary["result"]): string {
  return result === "1/2-1/2" ? "½-½" : result;
}
