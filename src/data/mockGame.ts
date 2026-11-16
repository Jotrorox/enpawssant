// Placeholder data for the game view until games, analysis and the opening explorer are wired to
// the backend.

import type { Square } from "../chess/board";

export type Nag = "!!" | "!" | "!?" | "?!" | "?";

export const NAGS: readonly Nag[] = ["!!", "!", "!?", "?!", "?"];

export type GameMove = {
  san: string;
  from: Square;
  to: Square;
  /** Position after the move. */
  fen: string;
  /** White-relative evaluation in pawns after the move. */
  eval: number;
  nag?: Nag;
};

export type Variation = {
  /** Ply index (1-based) of the mainline move this variation replaces. */
  ply: number;
  moves: { san: string; nag?: Nag }[];
  comment?: string;
};

export type EngineLine = { eval: number; moves: string[] };

export type Arrow = { from: Square; to: Square; strength: number };

export type Analysis = {
  depth: number;
  maxDepth: number;
  nodesPerSecond: string;
  lines: EngineLine[];
  arrows: Arrow[];
  coach: string;
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
export const START_EVAL = 0.2;

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
      eval: 0.3,
    },
    {
      san: "e5",
      from: "e7",
      to: "e5",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      eval: 0.25,
    },
    {
      san: "Nf3",
      from: "g1",
      to: "f3",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      eval: 0.32,
    },
    {
      san: "Nc6",
      from: "b8",
      to: "c6",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
      eval: 0.28,
    },
    {
      san: "Bc4",
      from: "f1",
      to: "c4",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
      eval: 0.38,
    },
    {
      san: "Bc5",
      from: "f8",
      to: "c5",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      eval: 0.3,
      nag: "!",
    },
    {
      san: "c3",
      from: "c2",
      to: "c3",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4",
      eval: 0.42,
    },
    {
      san: "Nf6",
      from: "g8",
      to: "f6",
      fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
      eval: 0.35,
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

/** Engine output keyed by ply. Only the final position has been analysed so far. */
export const analysisByPly: Record<number, Analysis> = {
  8: {
    depth: 28,
    maxDepth: 41,
    nodesPerSecond: "2.4 Mn/s",
    lines: [
      {
        eval: 0.35,
        moves: ["d4", "exd4", "cxd4", "Bb4+", "Bd2", "Bxd2+", "Nbxd2", "d5", "exd5", "Nxd5"],
      },
      { eval: 0.22, moves: ["d3", "d6", "O-O", "O-O", "a4", "a6", "Re1", "Ba7", "h3", "h6"] },
      { eval: 0.15, moves: ["b4", "Bb6", "d3", "d6", "a4", "a5", "b5", "Ne7", "O-O", "O-O"] },
    ],
    arrows: [
      { from: "d2", to: "d4", strength: 1 },
      { from: "b2", to: "b4", strength: 0.45 },
    ],
    coach:
      "c3 was played to support d4. Push it now and strike the center before Black castles, nya!",
  },
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
