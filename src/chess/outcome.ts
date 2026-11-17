// How a game ends: by the rules (mate, stalemate, repetition, the fifty-move rule, dead positions)
// or by a player (time, resignation). Draws by repetition and the fifty-move rule are applied
// automatically, as they are against an engine on most sites.

import type { Color } from "./board";
import { hasLegalMoves, inCheck, type Position, parseFen } from "./rules";
import type { GameResult } from "./score";

export type Termination =
  | "checkmate"
  | "stalemate"
  | "repetition"
  | "fiftyMoves"
  | "insufficientMaterial"
  | "timeout"
  | "resignation";

export type Outcome = { result: GameResult; termination: Termination };

const winFor = (side: Color): GameResult => (side === "w" ? "1-0" : "0-1");

/**
 * How the game ended by the rules after the positions in `fens` (oldest first), or `undefined`
 * while it goes on. Only the last position can end it, as earlier ones would have.
 */
export function rulesOutcome(fens: readonly string[]): Outcome | undefined {
  const last = fens[fens.length - 1];
  if (!last) return undefined;
  const pos = parseFen(last);
  if (!hasLegalMoves(pos)) {
    return inCheck(pos)
      ? { result: winFor(pos.turn === "w" ? "b" : "w"), termination: "checkmate" }
      : { result: "1/2-1/2", termination: "stalemate" };
  }
  if (!canMate(pos, "w") && !canMate(pos, "b")) {
    return { result: "1/2-1/2", termination: "insufficientMaterial" };
  }
  const key = repetitionKey(last);
  if (fens.filter((fen) => repetitionKey(fen) === key).length >= 3) {
    return { result: "1/2-1/2", termination: "repetition" };
  }
  if (pos.halfmove >= 100) return { result: "1/2-1/2", termination: "fiftyMoves" };
  return undefined;
}

/** The outcome when `side` runs out of time: a loss, or a draw if the other side can't mate. */
export function timeoutOutcome(fen: string, side: Color): Outcome {
  const other = side === "w" ? "b" : "w";
  return canMate(parseFen(fen), other)
    ? { result: winFor(other), termination: "timeout" }
    : { result: "1/2-1/2", termination: "timeout" };
}

export function resignationOutcome(side: Color): Outcome {
  return { result: winFor(side === "w" ? "b" : "w"), termination: "resignation" };
}

/**
 * Whether `side` has enough material to mate at all: a lone king or a king and one minor piece
 * can't. Two bishops on the same colour count as one, as long as nobody has a knight.
 */
export function canMate(pos: Position, side: Color): boolean {
  const pieces = pos.board.flatMap((piece, index) => (piece ? [{ ...piece, index }] : []));
  if (pieces.some((p) => p.type === "p" || p.type === "r" || p.type === "q")) {
    return pieces.some((p) => p.color === side && p.type !== "k");
  }
  const minors = pieces.filter((p) => p.type === "n" || p.type === "b");
  const own = minors.filter((p) => p.color === side);
  if (own.length === 0) return false;
  // With only bishops left, all on squares of one colour, no mate is possible.
  const squareColor = (index: number) => ((index & 7) + (index >> 3)) % 2;
  const bishopsOnOneColor =
    minors.every((p) => p.type === "b") &&
    new Set(minors.map((p) => squareColor(p.index))).size === 1;
  if (bishopsOnOneColor) return false;
  // A lone minor piece mates only with the help of enemy pieces to block its king in.
  return own.length >= 2 || minors.length > own.length;
}

/** The part of a FEN that makes two positions the same for repetitions. */
function repetitionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** A sentence for the end of a game, e.g. `Checkmate. White wins.` */
export function describeOutcome(outcome: Outcome): string {
  const winner = outcome.result === "1-0" ? "White" : "Black";
  switch (outcome.termination) {
    case "checkmate":
      return `Checkmate. ${winner} wins.`;
    case "stalemate":
      return "Stalemate. It's a draw.";
    case "repetition":
      return "Draw by threefold repetition.";
    case "fiftyMoves":
      return "Draw by the fifty-move rule.";
    case "insufficientMaterial":
      return "Draw. Nobody has enough material left to mate.";
    case "timeout":
      return outcome.result === "1/2-1/2"
        ? "Time ran out, but there's nothing left to mate with. It's a draw."
        : `${winner} wins on time.`;
    case "resignation":
      return `${outcome.result === "1-0" ? "Black" : "White"} resigned. ${winner} wins.`;
  }
}

/** The PGN `Termination` tag for an outcome. */
export function pgnTermination(outcome: Outcome): string {
  return outcome.termination === "timeout" ? "time forfeit" : "normal";
}
