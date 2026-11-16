import type { Color } from "./board";

export type GameResult = "1-0" | "0-1" | "1/2-1/2";

/**
 * A White-relative evaluation: centipawns, moves to mate (positive when White mates), or the
 * result of a position with no legal moves.
 */
export type Score = { cp: number } | { mate: number } | { result: GameResult };

/** Formats a score for engine lines and notation, e.g. `+0.35`, `#3`, `#−2` or `0-1`. */
export function formatScore(score: Score): string {
  if ("cp" in score) return formatPawns(score.cp / 100);
  if ("mate" in score) return `#${score.mate < 0 ? "−" : ""}${Math.abs(score.mate)}`;
  return score.result === "1/2-1/2" ? "½-½" : score.result;
}

/** Compact label for the eval bar, e.g. `.35`, `1.2`, `M3` or `½`. */
export function barLabel(score: Score): string {
  if ("cp" in score) {
    const pawns = Math.abs(score.cp / 100);
    return pawns >= 10 ? pawns.toFixed(0) : pawns.toFixed(pawns >= 1 ? 1 : 2).replace(/^0/, "");
  }
  if ("mate" in score) return `M${Math.abs(score.mate)}`;
  return score.result === "1/2-1/2" ? "½" : score.result;
}

/** White's expected share (0..1) of the game. */
export function whiteShare(score: Score): number {
  if ("cp" in score) {
    // Logistic curve used by lichess for its eval bar.
    return 1 / (1 + Math.exp(-0.00368208 * score.cp));
  }
  if ("mate" in score) return score.mate > 0 ? 1 : 0;
  return { "1-0": 1, "0-1": 0, "1/2-1/2": 0.5 }[score.result];
}

/** The share of the game expected for `side`. */
export function shareFor(score: Score, side: Color): number {
  const white = whiteShare(score);
  return side === "w" ? white : 1 - white;
}

/** White-relative pawns, with mates and wins pinned to ±`MATE_PAWNS` for plotting. */
export function plotPawns(score: Score): number {
  if ("cp" in score) return score.cp / 100;
  return (whiteShare(score) * 2 - 1) * MATE_PAWNS;
}

const MATE_PAWNS = 10;

function formatPawns(pawns: number): string {
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}
