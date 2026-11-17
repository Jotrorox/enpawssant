// Perft: count the leaf nodes of the legal move tree and compare against known-good totals. Any
// bug in move generation (castling, en passant, promotion, pins, checks) shows up as a mismatch.
// Positions and expected counts are from https://www.chessprogramming.org/Perft_Results.

import { describe, expect, test } from "vitest";
import { parseFen, perft, premoveDests } from "./rules";

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

describe("premoveDests", () => {
  const dests = (fen: string, square: string) =>
    [...(premoveDests(parseFen(fen), fen.includes(" w ") ? "b" : "w").get(square) ?? [])].sort();

  test("pawns push and may always capture", () => {
    // White premoves while Black is to move.
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
    expect(dests(fen, "e2")).toEqual(["d3", "e3", "e4", "f3"]);
    expect(dests(fen, "a2")).toEqual(["a3", "a4", "b3"]);
  });

  test("own pieces block, the opponent's don't", () => {
    const fen = "4k3/8/8/8/4p3/8/8/R3K2R b KQ - 0 1";
    // The rook goes up the a-file and along the first rank up to its own king.
    expect(dests(fen, "a1")).toEqual(
      ["a2", "a3", "a4", "a5", "a6", "a7", "a8", "b1", "c1", "d1"].sort(),
    );
    // The king may castle both ways while it has the rights.
    expect(dests(fen, "e1")).toEqual(["c1", "d1", "d2", "e2", "f1", "f2", "g1"]);
  });

  test("sliders see through opposing pieces", () => {
    const fen = "4k3/8/8/8/8/8/8/Q3K3 b - - 0 1";
    const queen = premoveDests(parseFen("4k3/4p3/8/8/8/8/8/4Q1K1 b - - 0 1"), "w").get("e1");
    expect(queen).toContain("e8");
    expect(dests(fen, "e1")).not.toContain("g1");
  });
});
