import { describe, expect, test } from "vitest";
import { sampleGame } from "../test/sampleGame";
import { NAG_CODES } from "./nag";
import {
  finalScore,
  gameAccuracy,
  judgeMove,
  mainline,
  mainlineAccuracy,
  moveAccuracy,
  recordReview,
  reviewCoverage,
  reviewNag,
  winPercent,
} from "./review";
import type { Score } from "./score";
import { type GameTree, type NodeId, treeFromPgn } from "./tree";

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

describe("recording a review", () => {
  const DEPTH = 16;
  // Root, e4, e5, Nf3, Nc6, Bc4, Bc5!, c3, Nf6.
  const VALUES = [20, 30, 30, 30, 100, 100, 100, -300, -300];
  const record = (tree: GameTree, ids: NodeId[], indices: number[], depth = DEPTH) => {
    for (const i of indices) {
      recordReview(tree, ids[i], { score: cp(VALUES[i]), depth, bestMove: "a2a3" }, DEPTH);
    }
  };
  const reviewed = () => {
    const tree = treeFromPgn(sampleGame);
    const ids = mainline(tree);
    record(
      tree,
      ids,
      ids.map((_, i) => i),
    );
    return { tree, ids };
  };

  test("stores evaluations, depths and best moves, and marks weak moves", () => {
    const { tree, ids } = reviewed();
    const nags = ids.map((id) => tree.nodes[id].nags);
    expect(tree.nodes[ids[4]]).toMatchObject({ eval: cp(100), evalDepth: DEPTH, bestMove: "a2a3" });
    expect(nags[4]).toEqual([NAG_CODES["?!"]]);
    expect(nags[7]).toEqual([NAG_CODES["??"]]);
    expect(nags[8]).toEqual([]);
    expect(reviewNag(nags[7])).toBe("??");
  });

  test("keeps existing move-quality annotations and is idempotent", () => {
    const { tree, ids } = reviewed();
    // Bc5 was annotated "!" in the PGN.
    expect(tree.nodes[ids[6]].nags).toEqual([NAG_CODES["!"]]);
    expect(reviewNag(tree.nodes[ids[6]].nags)).toBeUndefined();
    const before = JSON.stringify(tree);
    record(
      tree,
      ids,
      ids.map((_, i) => i),
    );
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("judges a move only once both of its positions are reviewed deep enough", () => {
    const tree = treeFromPgn(sampleGame);
    const ids = mainline(tree);
    record(tree, ids, [7]);
    expect(tree.nodes[ids[7]].nags).toEqual([]);
    // A shallow or imported evaluation of the position before doesn't count.
    record(tree, ids, [6], DEPTH - 1);
    expect(tree.nodes[ids[7]].nags).toEqual([]);
    // Recorded out of order, the move after is judged too.
    record(tree, ids, [6, 8]);
    expect(tree.nodes[ids[7]].nags).toEqual([NAG_CODES["??"]]);
    expect(reviewCoverage(tree, DEPTH)).toEqual({ done: 3, total: 9 });
  });

  test("leaves variations alone and makes accuracy available", () => {
    const { tree, ids } = reviewed();
    const variation = tree.nodes[ids[5]].children[1];
    expect(tree.nodes[variation].eval).toBeUndefined();
    expect(reviewCoverage(tree, DEPTH)).toEqual({ done: 9, total: 9 });
    const accuracy = mainlineAccuracy(tree);
    expect(accuracy?.white).toBeLessThan(accuracy?.black ?? 0);
  });

  test("never writes a game result as an evaluation, but counts the position as reviewed", () => {
    // Fool's mate.
    const tree = treeFromPgn({
      startFen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
      moves: [
        {
          san: "Qh4#",
          uci: "d8h4",
          fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
        },
      ],
    });
    const [root, mate] = mainline(tree);
    expect(reviewCoverage(tree, DEPTH)).toEqual({ done: 1, total: 2 });
    recordReview(tree, root, { score: { mate: -1 }, depth: DEPTH }, DEPTH);
    recordReview(tree, mate, { score: { result: "0-1" }, depth: DEPTH }, DEPTH);
    expect(tree.nodes[mate].eval).toBeUndefined();
    expect(tree.nodes[mate].nags).toEqual([]);
    expect(reviewCoverage(tree, DEPTH)).toEqual({ done: 2, total: 2 });
  });
});
