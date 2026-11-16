// Placeholder data for the game view until games and the opening explorer are wired to the
// backend.

import type { Square } from "../chess/board";

export type Nag = "!!" | "!" | "!?" | "?!" | "?";

export const NAGS: readonly Nag[] = ["!!", "!", "!?", "?!", "?"];

export type GameMove = {
  san: string;
  from: Square;
  to: Square;
  /** Position after the move. */
  fen: string;
  nag?: Nag;
};

export type Variation = {
  /** Ply index (1-based) of the mainline move this variation replaces. */
  ply: number;
  moves: { san: string; nag?: Nag }[];
  comment?: string;
};

export type ExplorerRow = {
  move: string;
  games: number;
  white: number;
  draw: number;
  black: number;
};

export type Player = { name: string; rating: number; accuracy: number };

export type Game = {
  white: Player;
  black: Player;
  eco: string;
  opening: string;
  moves: GameMove[];
  variations: Variation[];
};

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const game: Game = {
  white: { name: "Whiskers", rating: 1340, accuracy: 94 },
  black: { name: "Mochi", rating: 1200, accuracy: 89 },
  eco: "C53",
  opening: "Italian Game: Classical",
  moves: [
    {
      san: "e4",
      from: "e2",
      to: "e4",
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    },
    {
      san: "e5",
      from: "e7",
      to: "e5",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    },
    {
      san: "Nf3",
      from: "g1",
      to: "f3",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
    },
    {
      san: "Nc6",
      from: "b8",
      to: "c6",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    },
    {
      san: "Bc4",
      from: "f1",
      to: "c4",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    },
    {
      san: "Bc5",
      from: "f8",
      to: "c5",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      nag: "!",
    },
    {
      san: "c3",
      from: "c2",
      to: "c3",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4",
    },
    {
      san: "Nf6",
      from: "g8",
      to: "f6",
      fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
    },
  ],
  variations: [
    {
      ply: 6,
      moves: [
        { san: "Nf6" },
        { san: "Ng5" },
        { san: "d5" },
        { san: "exd5" },
        { san: "Na5", nag: "?!" },
      ],
      comment: "The Two Knights is sharper, but Mochi prefers a calm nap.",
    },
  ],
};

/** The position the placeholder explorer data belongs to (the end of the sample game). */
export const EXPLORER_FEN =
  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5";

export type ExplorerSource = "masters" | "online" | "mine";

/** Opening explorer results keyed by source, for the final position only. */
export const explorer: Record<ExplorerSource, ExplorerRow[]> = {
  masters: [
    { move: "d4", games: 12408, white: 38, draw: 31, black: 31 },
    { move: "d3", games: 9870, white: 36, draw: 35, black: 29 },
    { move: "b4", games: 2113, white: 40, draw: 27, black: 33 },
    { move: "O-O", games: 1204, white: 35, draw: 30, black: 35 },
  ],
  online: [
    { move: "d4", games: 184_220, white: 49, draw: 6, black: 45 },
    { move: "d3", games: 141_032, white: 48, draw: 6, black: 46 },
    { move: "O-O", games: 51_870, white: 47, draw: 5, black: 48 },
    { move: "b4", games: 22_415, white: 50, draw: 4, black: 46 },
  ],
  mine: [],
};
