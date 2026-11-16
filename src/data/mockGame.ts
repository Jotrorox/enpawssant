// Placeholder data for the game view until games and the opening explorer are wired to the
// backend.

import type { PgnGame } from "../chess/pgn";

export type ExplorerRow = {
  move: string;
  games: number;
  white: number;
  draw: number;
  black: number;
};

/** The sample game, in the shape the Rust PGN reader produces. Evaluations come from the engine. */
export const sampleGame: PgnGame = {
  headers: [
    ["Event", "Casual game"],
    ["White", "Whiskers"],
    ["Black", "Mochi"],
    ["WhiteElo", "1340"],
    ["BlackElo", "1200"],
    ["ECO", "C53"],
    ["Opening", "Italian Game: Classical"],
    ["Result", "*"],
  ],
  startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: [
    {
      san: "e4",
      uci: "e2e4",
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    },
    {
      san: "e5",
      uci: "e7e5",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    },
    {
      san: "Nf3",
      uci: "g1f3",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
    },
    {
      san: "Nc6",
      uci: "b8c6",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    },
    {
      san: "Bc4",
      uci: "f1c4",
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    },
    {
      san: "Bc5",
      uci: "f8c5",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      nags: [1],
      variations: [
        [
          {
            san: "Nf6",
            uci: "g8f6",
            fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
          },
          {
            san: "Ng5",
            uci: "f3g5",
            fen: "r1bqkb1r/pppp1ppp/2n2n2/4p1N1/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 5 4",
          },
          {
            san: "d5",
            uci: "d7d5",
            fen: "r1bqkb1r/ppp2ppp/2n2n2/3pp1N1/2B1P3/8/PPPP1PPP/RNBQK2R w KQkq - 0 5",
          },
          {
            san: "exd5",
            uci: "e4d5",
            fen: "r1bqkb1r/ppp2ppp/2n2n2/3Pp1N1/2B5/8/PPPP1PPP/RNBQK2R b KQkq - 0 5",
          },
          {
            san: "Na5",
            uci: "c6a5",
            fen: "r1bqkb1r/ppp2ppp/5n2/n2Pp1N1/2B5/8/PPPP1PPP/RNBQK2R w KQkq - 1 6",
            nags: [6],
            comment: "The Two Knights is sharper, but Mochi prefers a calm nap.",
          },
        ],
      ],
    },
    {
      san: "c3",
      uci: "c2c3",
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4",
    },
    {
      san: "Nf6",
      uci: "g8f6",
      fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
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
