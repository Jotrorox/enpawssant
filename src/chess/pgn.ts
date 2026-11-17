// PGN import and export. Parsing and writing happen in Rust (`chess-core::pgn`); these types
// mirror its serde output.

import { invoke } from "@tauri-apps/api/core";
import type { Score } from "./score";

export type PgnMove = {
  san: string;
  uci: string;
  /** Position after the move. */
  fen: string;
  nags?: number[];
  /** Comment before the move; only kept for the first move of a line. */
  startingComment?: string;
  comment?: string;
  /** From a `[%eval]` command; never a game result. */
  eval?: Exclude<Score, { result: unknown }>;
  /** How deep the engine searched for `eval`, if known (`[%eval 0.31,22]`). */
  evalDepth?: number;
  /**
   * The engine's best move in the position after this move, in UCI, as found by a game review.
   * Not part of PGN: Rust ignores it, but it survives in the saved workspace.
   */
  bestMove?: string;
  /** Lines that could have been played instead of this move. */
  variations?: PgnMove[][];
};

export type PgnGame = {
  /** Tag pairs such as `["White", "Whiskers"]`, in file order. */
  headers: [string, string][];
  startFen: string;
  /** A comment about the starting position, before the first move. */
  comment?: string;
  moves: PgnMove[];
};

export type ImportedGame = PgnGame & { warnings: string[] };

export type ParsedPgn = {
  games: ImportedGame[];
  /** Games that could not be read at all. */
  errors: string[];
  /** Whether the file has more games than were read. */
  truncated: boolean;
};

export type OpenedPgn = ParsedPgn & { name: string; path: string };

export const parsePgn = (text: string) => invoke<ParsedPgn>("pgn_parse", { text });

/** Shows an open dialog and reads the chosen file, or resolves to `null` when cancelled. */
export const openPgnFile = () => invoke<OpenedPgn | null>("pgn_open_file");

export const exportPgn = (game: PgnGame) => invoke<string>("pgn_export", { game });

/** A game written to a file. */
export type SavedPgn = { name: string; path: string };

/** Shows a save dialog and writes the game, resolving to where it went or `null` if cancelled. */
export const savePgnFile = (game: PgnGame, suggestedName: string) =>
  invoke<SavedPgn | null>("pgn_save_file", { game, suggestedName });

/** Writes the game to a PGN file it was saved to before, replacing the file. */
export const writePgnFile = (game: PgnGame, path: string) =>
  invoke<SavedPgn>("pgn_write_path", { game, path });

/** A file name for a game, without characters that file systems reject. */
export function pgnFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "game"}.pgn`;
}

export function header(game: Pick<PgnGame, "headers">, name: string): string | undefined {
  const value = game.headers.find(([key]) => key === name)?.[1].trim();
  // PGN uses `?` for unknown values.
  return value && !/^[?.]*$/.test(value) ? value : undefined;
}
