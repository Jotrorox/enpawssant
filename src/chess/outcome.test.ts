import { describe, expect, test } from "vitest";
import { START_FEN } from "./board";
import { canMate, rulesOutcome, timeoutOutcome } from "./outcome";
import { makeMove, parseFen } from "./rules";

/** The positions after each of `moves` from `fen`, starting with `fen` itself. */
function play(fen: string, moves: string[]): string[] {
  const fens = [fen];
  for (const uci of moves) {
    const next = makeMove(fens[fens.length - 1], { from: uci.slice(0, 2), to: uci.slice(2, 4) });
    if (!next) throw new Error(`illegal move ${uci}`);
    fens.push(next.fen);
  }
  return fens;
}

describe("game outcomes", () => {
  test("nothing ends a normal game", () => {
    expect(rulesOutcome(play(START_FEN, ["e2e4", "e7e5"]))).toBeUndefined();
  });

  test("checkmate and stalemate", () => {
    expect(rulesOutcome(play(START_FEN, ["f2f3", "e7e5", "g2g4", "d8h4"]))).toEqual({
      result: "0-1",
      termination: "checkmate",
    });
    expect(rulesOutcome(["7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"])).toEqual({
      result: "1/2-1/2",
      termination: "stalemate",
    });
  });

  test("threefold repetition", () => {
    const knights = ["g1f3", "g8f6", "f3g1", "f6g8"];
    expect(rulesOutcome(play(START_FEN, knights))).toBeUndefined();
    expect(rulesOutcome(play(START_FEN, [...knights, ...knights]))).toEqual({
      result: "1/2-1/2",
      termination: "repetition",
    });
  });

  test("the fifty-move rule", () => {
    expect(rulesOutcome(["4k3/8/8/8/8/8/4R3/4K3 w - - 99 80"])).toBeUndefined();
    expect(rulesOutcome(["4k3/8/8/8/8/8/4R3/4K3 b - - 100 80"])).toEqual({
      result: "1/2-1/2",
      termination: "fiftyMoves",
    });
  });

  test("dead positions", () => {
    for (const fen of [
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
      "4k3/8/8/8/8/8/8/4KN2 w - - 0 1",
      "4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1",
    ]) {
      expect(rulesOutcome([fen])?.termination).toBe("insufficientMaterial");
    }
    // Bishops on opposite colours, a pawn or two knights can still mate, at least with help.
    for (const fen of [
      "4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1",
      "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
      "4k3/8/8/8/8/8/8/3NKN2 w - - 0 1",
    ]) {
      expect(rulesOutcome([fen])).toBeUndefined();
    }
  });
});

describe("running out of time", () => {
  test("loses, unless the other side can't mate", () => {
    expect(timeoutOutcome("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", "b")).toEqual({
      result: "1-0",
      termination: "timeout",
    });
    expect(timeoutOutcome("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", "w")).toEqual({
      result: "1/2-1/2",
      termination: "timeout",
    });
  });

  test("a lone minor piece can mate with the opponent's pawns in the way", () => {
    const pos = parseFen("4k3/4p3/8/8/8/8/8/4KN2 w - - 0 1");
    expect(canMate(pos, "w")).toBe(true);
    expect(canMate(pos, "b")).toBe(true);
    expect(canMate(parseFen("4k3/8/8/8/8/8/8/4KN2 w - - 0 1"), "w")).toBe(false);
  });
});
