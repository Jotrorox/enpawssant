// Game review: judging moves and scoring each player's accuracy from engine evaluations. The
// formulas follow lichess (`lila/modules/analyse/.../AccuracyPercent.scala` and `Advice.scala`), so
// numbers are comparable to what players see there.

import { type Color, fenTurn } from "./board";
import { NAG_CODES, type Nag, qualityNag } from "./nag";
import { hasLegalMoves, inCheck, parseFen } from "./rules";
import type { Score } from "./score";
import { type GameTree, lineEnd, type MoveNode, type NodeId, pathTo } from "./tree";

/** Accuracy per side in percent (0..100). */
export type Accuracy = { white: number; black: number };

/** Centipawns beyond this count as completely winning; mates count as this much. */
const CP_CEILING = 1000;

/** White's chance of winning in percent (0..100), with evaluations capped at ±10 pawns. */
export function winPercent(score: Score): number {
  const cp =
    "cp" in score
      ? Math.max(-CP_CEILING, Math.min(CP_CEILING, score.cp))
      : "mate" in score
        ? Math.sign(score.mate) * CP_CEILING
        : { "1-0": CP_CEILING, "0-1": -CP_CEILING, "1/2-1/2": 0 }[score.result];
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** How many percentage points of winning chances `mover` gave away with a move. */
function winLoss(before: Score, after: Score, mover: Color): number {
  const loss = winPercent(before) - winPercent(after);
  return mover === "w" ? loss : -loss;
}

/** Losses of winning chances, in percentage points, that make a move an inaccuracy and worse. */
const JUDGEMENTS: [minLoss: number, nag: ReviewNag][] = [
  [15, "??"],
  [10, "?"],
  [5, "?!"],
];

/** `??`, `?` or `?!` for a blunder, mistake or inaccuracy by `mover`; nothing for a fine move. */
export function judgeMove(before: Score, after: Score, mover: Color): ReviewNag | undefined {
  const loss = winLoss(before, after, mover);
  return JUDGEMENTS.find(([minLoss]) => loss >= minLoss)?.[1];
}

/** Accuracy of one move from its mover's winning chances before and after it. */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const raw =
    103.1668100711649 * Math.exp(-0.04354415386753951 * (winBefore - winAfter)) - 3.166924740191411;
  // lichess adds a point for the imprecision of the analysis.
  return Math.max(0, Math.min(100, raw + 1));
}

/**
 * Each player's accuracy over a line of positions, given the evaluation of every one of them
 * (the starting position included) and who moves first.
 *
 * Moves are weighted by how volatile the game was around them, so a slip in a quiet position
 * costs more than one in a wild tactical sequence. The result is the mean of that weighted mean
 * and the harmonic mean, which punishes single bad moves. Undefined unless both players moved.
 */
export function gameAccuracy(scores: readonly Score[], firstMover: Color): Accuracy | undefined {
  const moves = scores.length - 1;
  if (moves < 2) return undefined;
  const wins = scores.map(winPercent);

  // One window of positions per move: the first few share the opening window.
  const size = Math.max(2, Math.min(8, Math.floor(moves / 10)));
  const windows: number[][] = [];
  for (let i = 0; i < Math.min(size, wins.length) - 2; i++) windows.push(wins.slice(0, size));
  for (let i = 0; i + size <= wins.length || i === 0; i++) windows.push(wins.slice(i, i + size));
  const weights = windows.map((window) => Math.max(0.5, Math.min(12, standardDeviation(window))));

  const bySide: Record<Color, { accuracy: number; weight: number }[]> = { w: [], b: [] };
  for (let i = 0; i < moves; i++) {
    const mover: Color = i % 2 === 0 ? firstMover : firstMover === "w" ? "b" : "w";
    const [before, after] =
      mover === "w" ? [wins[i], wins[i + 1]] : [100 - wins[i], 100 - wins[i + 1]];
    bySide[mover].push({ accuracy: moveAccuracy(before, after), weight: weights[i] });
  }

  const sideAccuracy = (entries: { accuracy: number; weight: number }[]) => {
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    const weighted = entries.reduce((sum, e) => sum + e.accuracy * e.weight, 0) / totalWeight;
    const harmonic =
      entries.length / entries.reduce((sum, e) => sum + 1 / Math.max(1, e.accuracy), 0);
    return (weighted + harmonic) / 2;
  };
  return { white: sideAccuracy(bySide.w), black: sideAccuracy(bySide.b) };
}

function standardDeviation(values: readonly number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

/** The result of a position without legal moves, as a score; undefined while the game goes on. */
export function finalScore(fen: string): Score | undefined {
  const position = parseFen(fen);
  if (hasLegalMoves(position)) return undefined;
  if (!inCheck(position)) return { result: "1/2-1/2" };
  return { result: fenTurn(fen) === "w" ? "0-1" : "1-0" };
}

/** A node's stored evaluation, or its result when the game is over there. */
function storedScore(node: MoveNode): Score | undefined {
  return node.eval ?? finalScore(node.fen);
}

/** Ids of the main line, root included. */
export function mainline(tree: GameTree): NodeId[] {
  return pathTo(tree, lineEnd(tree, tree.rootId));
}

/** Each player's accuracy on the main line, once every position on it has an evaluation. */
export function mainlineAccuracy(tree: GameTree): Accuracy | undefined {
  const scores: Score[] = [];
  for (const id of mainline(tree)) {
    const score = storedScore(tree.nodes[id]);
    if (!score) return undefined;
    scores.push(score);
  }
  return gameAccuracy(scores, fenTurn(tree.nodes[tree.rootId].fen));
}

/** What a game review found for one position. */
export type ReviewedPosition = {
  /** White-relative; a result for positions without legal moves. */
  score: Score;
  /** How deep the engine searched. */
  depth: number;
  /** The engine's best move there, in UCI. */
  bestMove?: string;
};

/**
 * A node's evaluation if the engine searched it at least `depth` deep, or its result when the game
 * is over there. Only a line's last position can be over, so others skip the legality check.
 */
export function reviewedScore(node: MoveNode, depth: number): Score | undefined {
  if (node.eval && (node.evalDepth ?? 0) >= depth) return node.eval;
  return node.children.length === 0 ? finalScore(node.fen) : undefined;
}

/** How many main-line positions a review to `depth` has covered, out of all of them. */
export function reviewCoverage(tree: GameTree, depth: number): { done: number; total: number } {
  const ids = mainline(tree);
  const done = ids.filter((id) => reviewedScore(tree.nodes[id], depth) !== undefined).length;
  return { done, total: ids.length };
}

/**
 * Writes what a review found for one position into the tree (use inside `produce`), then judges
 * the moves into and out of it once the positions on both sides have been reviewed to `depth`:
 * inaccuracies, mistakes and blunders get a NAG. Moves that already carry a move-quality
 * annotation keep it, so a reviewer's own `!` or `?` survives and reviewing again changes nothing.
 *
 * Results are recorded as they come in, so a review that is stopped keeps what it found and can
 * pick up where it left off.
 */
export function recordReview(tree: GameTree, id: NodeId, result: ReviewedPosition, depth: number) {
  const node = tree.nodes[id];
  if (!node) return;
  // PGN `[%eval]` has no way to say "checkmate"; the position itself does.
  if (!("result" in result.score)) {
    node.eval = result.score;
    node.evalDepth = result.depth;
    node.bestMove = result.bestMove;
  }
  if (node.parent !== undefined) judge(tree.nodes[node.parent], node, depth);
  const next = node.children[0];
  if (next !== undefined) judge(node, tree.nodes[next], depth);
}

function judge(parent: MoveNode, node: MoveNode, depth: number) {
  if (qualityNag(node.nags)) return;
  const before = reviewedScore(parent, depth);
  const after = reviewedScore(node, depth);
  if (!before || !after) return;
  const nag = judgeMove(before, after, fenTurn(parent.fen));
  if (nag) node.nags = [NAG_CODES[nag], ...node.nags];
}

/** The judgements a review hands out: inaccuracy, mistake and blunder. */
export type ReviewNag = "?!" | "?" | "??";

const REVIEW_NAGS: readonly Nag[] = ["?!", "?", "??"] satisfies ReviewNag[];

/** The move-quality annotation among `nags`, if it is one a review hands out. */
export function reviewNag(nags: readonly number[]): ReviewNag | undefined {
  const nag = qualityNag(nags);
  return nag && REVIEW_NAGS.includes(nag) ? (nag as ReviewNag) : undefined;
}
