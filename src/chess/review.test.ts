import { describe, expect, test } from "vitest";
import { sampleGame } from "../data/mockGame";
import { NAG_CODES } from "./nag";
import {
  applyReview,
  finalScore,
  gameAccuracy,
  judgeMove,
  mainline,
  mainlineAccuracy,
  moveAccuracy,
  winPercent,
} from "./review";
import type { Score } from "./score";
import { type NodeId, treeFromPgn } from "./tree";

const cp = (value: number): Score => ({ cp: value });

describe("winning chances", () => {
  test("are even at 0.00 and capped at ten pawns", () => {
    expect(winPercent(cp(0))).toBe(50);
    expect(winPercent(cp(5000))).toBe(winPercent(cp(1000)));
    expect(winPercent({ mate: 3 })).toBe(winPercent(cp(1000)));
    expect(winPercent({ mate: -1 })).toBe(winPercent(cp(-1000)));
    expect(winPercent({ result: "1/2-1/2" })).toBe(50);
    expect(winPercent(cp(300))).toBeGreaterThan(winPercent(cp(100)));
  });
});

describe("move judgements", () => {
  test("follow the loss of winning chances for the side that moved", () => {
    expect(judgeMove(cp(30), cp(20), "w")).toBeUndefined();
    expect(judgeMove(cp(30), cp(-50), "w")).toBe("?!");
    expect(judgeMove(cp(30), cp(-100), "w")).toBe("?");
    expect(judgeMove(cp(30), cp(-300), "w")).toBe("??");
    // The same drop is good for Black.
    expect(judgeMove(cp(30), cp(-300), "b")).toBeUndefined();
    expect(judgeMove(cp(-30), cp(300), "b")).toBe("??");
  });

  test("forgive slips in positions that stay decided", () => {
    expect(judgeMove({ mate: 4 }, cp(1500), "w")).toBeUndefined();
    expect(judgeMove(cp(-2000), cp(-900), "b")).toBeUndefined();
  });

  test("catch moves that throw away a mate or walk into one", () => {
    expect(judgeMove({ mate: 2 }, cp(0), "w")).toBe("??");
    expect(judgeMove(cp(0), { mate: 1 }, "b")).toBe("??");
  });
});

describe("accuracy", () => {
  test("is 100 for moves that keep or improve the winning chances", () => {
    expect(moveAccuracy(60, 60)).toBe(100);
    expect(moveAccuracy(40, 70)).toBe(100);
    expect(moveAccuracy(60, 50)).toBeLessThan(100);
    expect(moveAccuracy(100, 0)).toBe(0);
  });

  test("is perfect for a game the engine agrees with", () => {
    const flat = Array.from({ length: 41 }, () => cp(20));
    const accuracy = gameAccuracy(flat, "w");
    expect(accuracy?.white).toBeCloseTo(100);
    expect(accuracy?.black).toBeCloseTo(100);
  });

  test("drops for the side that blundered", () => {
    const scores = Array.from({ length: 41 }, (_, i) => cp(i < 21 ? 20 : -400));
    // Position 21 follows move 21, White's 11th.
    const accuracy = gameAccuracy(scores, "w");
    expect(accuracy?.black).toBeCloseTo(100);
    expect(accuracy?.white).toBeLessThan(90);
  });

  test("works out for short games and games starting with Black", () => {
    expect(gameAccuracy([cp(0)], "w")).toBeUndefined();
    expect(gameAccuracy([cp(0), cp(0)], "w")).toBeUndefined();
    const short = gameAccuracy([cp(0), cp(-50), cp(-50), cp(200)], "b");
    expect(short).toBeDefined();
    for (const value of Object.values(short ?? {})) expect(Number.isFinite(value)).toBe(true);
    // Black's last move gave White a big plus; White never lost anything.
    expect(short?.white).toBeCloseTo(100);
    expect(short?.black).toBeLessThan(90);
  });
});

describe("final positions", () => {
  test("score checkmate and stalemate, and nothing else", () => {
    expect(finalScore("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")).toEqual({
      result: "0-1",
    });
    expect(finalScore("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toEqual({ result: "1/2-1/2" });
    expect(finalScore(sampleGame.startFen)).toBeUndefined();
  });
});

describe("applying a review", () => {
  // Root, e4, e5, Nf3, Nc6, Bc4, Bc5!, c3, Nf6.
  const reviewed = () => {
    const tree = treeFromPgn(sampleGame);
    const ids = mainline(tree);
    const values = [20, 30, 30, 30, 100, 100, 100, -300, -300];
    const scores = new Map<NodeId, Score>(ids.map((id, i) => [id, cp(values[i])]));
    applyReview(tree, scores);
    return { tree, ids };
  };

  test("stores evaluations and marks weak moves", () => {
    const { tree, ids } = reviewed();
    const nags = ids.map((id) => tree.nodes[id].nags);
    expect(tree.nodes[ids[4]].eval).toEqual(cp(100));
    expect(nags[4]).toEqual([NAG_CODES["?!"]]);
    expect(nags[7]).toEqual([NAG_CODES["??"]]);
    expect(nags[8]).toEqual([]);
  });

  test("keeps existing move-quality annotations and is idempotent", () => {
    const { tree, ids } = reviewed();
    // Bc5 was annotated "!" in the PGN.
    expect(tree.nodes[ids[6]].nags).toEqual([NAG_CODES["!"]]);
    const before = JSON.stringify(tree);
    applyReview(tree, new Map());
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("leaves variations alone and makes accuracy available", () => {
    const { tree, ids } = reviewed();
    const variation = tree.nodes[ids[5]].children[1];
    expect(tree.nodes[variation].eval).toBeUndefined();
    const accuracy = mainlineAccuracy(tree);
    expect(accuracy?.white).toBeLessThan(accuracy?.black ?? 0);
  });

  test("never writes a game result as an evaluation", () => {
    const tree = treeFromPgn({ ...sampleGame, moves: sampleGame.moves.slice(0, 1) });
    const [root, e4] = mainline(tree);
    applyReview(
      tree,
      new Map<NodeId, Score>([
        [root, cp(20)],
        [e4, { result: "1-0" }],
      ]),
    );
    expect(tree.nodes[e4].eval).toBeUndefined();
  });
});
