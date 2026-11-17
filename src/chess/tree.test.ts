import { describe, expect, test } from "vitest";
import { sampleGame } from "../test/sampleGame";
import { toggleQualityNag } from "./nag";
import { type MoveInput, makeMove } from "./rules";
import {
  addMove,
  deleteNode,
  emptyTree,
  type GameTree,
  indexPath,
  isMainline,
  lineEnd,
  makeMainline,
  type NodeId,
  nodeAtIndexPath,
  pathTo,
  treeFromPgn,
  treeToPgn,
  variationCount,
} from "./tree";

/** Plays `input` after `parentId`, failing the test if the move is illegal. */
function play(tree: GameTree, parentId: NodeId, input: MoveInput): NodeId {
  const result = makeMove(tree.nodes[parentId].fen, input);
  if (!result) throw new Error(`illegal move ${input.from}${input.to}`);
  return addMove(tree, parentId, result);
}

const mainline = (tree: GameTree) => pathTo(tree, lineEnd(tree, tree.rootId));
const sans = (moves: { san: string }[]) => moves.map((move) => move.san);

describe("move tree", () => {
  test("reads the sample game with its variation", () => {
    const tree = treeFromPgn(sampleGame);
    expect(mainline(tree)).toHaveLength(9);
    expect(variationCount(tree)).toBe(1);
    expect(treeToPgn(tree, sampleGame.headers).moves[5].variations?.map(sans)).toEqual([
      ["Nf6", "Ng5", "d5", "exd5", "Na5"],
    ]);
  });

  test("turns a different move into a variation and follows an existing one", () => {
    const tree = treeFromPgn(sampleGame);
    const main = mainline(tree);
    const afterBc5 = main[6];

    const d4 = play(tree, afterBc5, { from: "d2", to: "d4" });
    expect(play(tree, afterBc5, { from: "d2", to: "d4" })).toBe(d4);
    expect(play(tree, afterBc5, { from: "c2", to: "c3" })).toBe(main[7]);
    expect(mainline(tree)).toEqual(main);
    expect(isMainline(tree, d4)).toBe(false);
    expect(variationCount(tree)).toBe(2);

    const exd4 = play(tree, d4, { from: "e5", to: "d4" });
    expect(tree.nodes[exd4].move?.san).toBe("exd4");
    const c3 = treeToPgn(tree, []).moves[6];
    expect(c3.san).toBe("c3");
    expect(c3.variations?.map(sans)).toEqual([["d4", "exd4"]]);
  });

  test("promotes a variation to the main line", () => {
    const tree = treeFromPgn(sampleGame);
    const afterBc5 = mainline(tree)[6];
    const exd4 = play(tree, play(tree, afterBc5, { from: "d2", to: "d4" }), {
      from: "e5",
      to: "d4",
    });

    makeMainline(tree, exd4);
    expect(isMainline(tree, exd4)).toBe(true);
    const moves = treeToPgn(tree, []).moves;
    expect(sans(moves.slice(6))).toEqual(["d4", "exd4"]);
    expect(moves[6].variations?.map(sans)).toEqual([["c3", "Nf6"]]);
  });

  test("deletes a move with everything after it", () => {
    const tree = treeFromPgn(sampleGame);
    const afterBc5 = mainline(tree)[6];
    const d4 = play(tree, afterBc5, { from: "d2", to: "d4" });
    const exd4 = play(tree, d4, { from: "e5", to: "d4" });

    deleteNode(tree, d4);
    expect(tree.nodes[d4]).toBeUndefined();
    expect(tree.nodes[exd4]).toBeUndefined();
    expect(treeToPgn(tree, sampleGame.headers)).toEqual(
      treeToPgn(treeFromPgn(sampleGame), sampleGame.headers),
    );
  });

  test("survives a round trip through PGN form", () => {
    const tree = treeFromPgn(sampleGame);
    const pgn = treeToPgn(tree, sampleGame.headers);
    expect(treeToPgn(treeFromPgn(pgn), sampleGame.headers)).toEqual(pgn);
  });

  test("finds a node again by its index path after a round trip", () => {
    const tree = treeFromPgn(sampleGame);
    const afterBc5 = mainline(tree)[6];
    const nf6 = play(tree, play(tree, afterBc5, { from: "d2", to: "d4" }), {
      from: "g8",
      to: "f6",
    });

    const path = indexPath(tree, nf6);
    expect(path).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    const restored = treeFromPgn(treeToPgn(tree, []));
    expect(restored.nodes[nodeAtIndexPath(restored, path)].fen).toBe(tree.nodes[nf6].fen);
    expect(nodeAtIndexPath(restored, [])).toBe(restored.rootId);
    // A path that runs past the tree stops at the last node it reaches.
    expect(nodeAtIndexPath(restored, [0, 5, 0])).toBe(mainline(restored)[1]);
  });

  test("numbers plies from the starting FEN", () => {
    const tree = emptyTree("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 3 30");
    expect(tree.nodes[tree.rootId].ply).toBe(59);
    const castle = play(tree, tree.rootId, { from: "e8", to: "c8" });
    expect(tree.nodes[castle].move).toMatchObject({ san: "O-O-O", uci: "e8c8" });
    expect(tree.nodes[castle].ply).toBe(60);
  });
});

describe("annotations", () => {
  test("a move has at most one move-quality NAG", () => {
    expect(toggleQualityNag([1, 14], "?")).toEqual([2, 14]);
    expect(toggleQualityNag([2, 14], "?")).toEqual([14]);
  });

  test("promotions include the piece in UCI", () => {
    expect(
      makeMove("8/P6k/8/8/8/8/8/K7 w - - 0 1", { from: "a7", to: "a8", promotion: "n" })?.uci,
    ).toBe("a7a8n");
  });
});
