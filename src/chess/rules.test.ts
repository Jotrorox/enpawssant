// Perft: count the leaf nodes of the legal move tree and compare against known-good totals. Any
// bug in move generation (castling, en passant, promotion, pins, checks) shows up as a mismatch.
// Positions and expected counts are from https://www.chessprogramming.org/Perft_Results.

import { describe, expect, test } from "vitest";
import { parseFen, perft } from "./rules";

const CASES: { name: string; fen: string; counts: number[] }[] = [
  {
    name: "start position",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    counts: [20, 400, 8902, 197281],
  },
  {
    name: "Kiwipete",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    counts: [48, 2039, 97862],
  },
  {
    name: "position 3 (en passant, discovered checks)",
    fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    counts: [14, 191, 2812, 43238, 674624],
  },
  {
    name: "position 4 (promotions, castling through check)",
    fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    counts: [6, 264, 9467, 422333],
  },
  {
    name: "position 4 mirrored",
    fen: "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
    counts: [6, 264, 9467, 422333],
  },
  {
    name: "position 5",
    fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    counts: [44, 1486, 62379],
  },
  {
    name: "position 6",
    fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    counts: [46, 2079, 89890],
  },
];

describe("perft", () => {
  for (const { name, fen, counts } of CASES) {
    const pos = parseFen(fen);
    test.each(counts.map((nodes, i) => ({ depth: i + 1, nodes })))(
      `${name} depth $depth = $nodes`,
      ({ depth, nodes }) => {
        expect(perft(pos, depth)).toBe(nodes);
      },
    );
  }
});
