import { describe, expect, it } from "vitest";
import { START_FEN } from "./board";
import { parseFen, toFen } from "./rules";
import { enPassantSquares, looksLikeFen, possibleCastling, tidyPosition } from "./setup";

describe("looksLikeFen", () => {
  it("accepts full and partial FENs", () => {
    expect(looksLikeFen(START_FEN)).toBe(true);
    expect(looksLikeFen("  rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1\n")).toBe(
      true,
    );
    expect(looksLikeFen("4k3/8/8/8/8/8/8/4K3")).toBe(true);
    expect(looksLikeFen("4k3/8/8/8/8/8/8/4K3 w")).toBe(true);
  });

  it("rejects PGN and other text", () => {
    expect(looksLikeFen("1. e4 e5 2. Nf3 *")).toBe(false);
    expect(looksLikeFen('[Event "x"]')).toBe(false);
    expect(looksLikeFen("4k3/8/8/8/8/8/4K3 w - - 0 1")).toBe(false);
    expect(looksLikeFen("4k3/8/8/8/8/8/8/4K3 x - - 0 1")).toBe(false);
  });
});

describe("board editor rules", () => {
  it("offers castling only with king and rook at home", () => {
    expect(possibleCastling(parseFen(START_FEN))).toBe("KQkq");
    expect(possibleCastling(parseFen("r3k3/8/8/8/8/8/8/4K2R w - - 0 1"))).toBe("Kq");
    expect(possibleCastling(parseFen("4k3/8/8/8/8/8/8/R2K3R w - - 0 1"))).toBe("");
  });

  it("finds en passant squares next to a pawn that just moved two squares", () => {
    expect(enPassantSquares(parseFen("4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1"))).toEqual(["d6"]);
    // Without a pawn of ours beside it, there is no capture.
    expect(enPassantSquares(parseFen("4k3/8/8/3p4/8/8/8/4K3 w - - 0 1"))).toEqual([]);
    expect(enPassantSquares(parseFen("4k3/8/8/8/2pP4/8/8/4K3 b - - 0 1"))).toEqual(["d3"]);
  });

  it("tidies rights that no longer fit", () => {
    const pos = tidyPosition(parseFen("4k3/8/8/8/8/8/8/4K2R w KQkq e6 3 20"));
    expect(toFen(pos)).toBe("4k3/8/8/8/8/8/8/4K2R w K - 3 20");
  });
});
