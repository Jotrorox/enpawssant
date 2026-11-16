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
  /** Lines that could have been played instead of this move. */
  variations?: PgnMove[][];
};

export type PgnGame = {
  /** Tag pairs such as `["White", "Whiskers"]`, in file order. */
  headers: [string, string][];
  startFen: string;
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

export type OpenedPgn = ParsedPgn & { name: string };

export const parsePgn = (text: string) => invoke<ParsedPgn>("pgn_parse", { text });

/** Shows an open dialog and reads the chosen file, or resolves to `null` when cancelled. */
export const openPgnFile = () => invoke<OpenedPgn | null>("pgn_open_file");

export const exportPgn = (game: PgnGame) => invoke<string>("pgn_export", { game });

/** Shows a save dialog and writes the game, resolving to the file name or `null` if cancelled. */
export const savePgnFile = (game: PgnGame, suggestedName: string) =>
  invoke<string | null>("pgn_save_file", { game, suggestedName });

export function header(game: Pick<PgnGame, "headers">, name: string): string | undefined {
  const value = game.headers.find(([key]) => key === name)?.[1].trim();
  // PGN uses `?` for unknown values.
  return value && !/^[?.]*$/.test(value) ? value : undefined;
}
