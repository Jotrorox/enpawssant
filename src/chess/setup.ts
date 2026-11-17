// Setting up positions by hand: the board editor's rules and recognising pasted FENs. Rust has the
// final say on whether a position can be used (`position_check`, built on shakmaty).

import { invoke } from "@tauri-apps/api/core";
import type { Piece, Square } from "./board";
import { type Position, squareIndex, squareName } from "./rules";

/** Checks a position, resolving to its cleaned-up FEN or rejecting with why it can't be used. */
export const checkPosition = (fen: string) => invoke<string>("position_check", { fen });

const RANK = "[pnbrqkPNBRQK1-8]{1,8}";
const FEN_PATTERN = new RegExp(
  `^(${RANK}/){7}${RANK}(\\s+[wb](\\s+(-|[KQkq]{1,4})(\\s+(-|[a-h][36])(\\s+\\d+(\\s+\\d+)?)?)?)?)?$`,
);

/** Whether `text` looks like a FEN (possibly just the piece placement) rather than a PGN. */
export function looksLikeFen(text: string): boolean {
  return FEN_PATTERN.test(text.trim());
}

/** Castling rights and the squares the king and rook must stand on for each. */
const CASTLING: { right: string; king: Square; rook: Square; color: "w" | "b" }[] = [
  { right: "K", king: "e1", rook: "h1", color: "w" },
  { right: "Q", king: "e1", rook: "a1", color: "w" },
  { right: "k", king: "e8", rook: "h8", color: "b" },
  { right: "q", king: "e8", rook: "a8", color: "b" },
];

const isPiece = (piece: Piece | undefined, color: "w" | "b", type: Piece["type"]) =>
  piece?.color === color && piece.type === type;

/** The castling rights (`KQkq`) whose king and rook are on their starting squares. */
export function possibleCastling(pos: Position): string {
  return CASTLING.filter(
    ({ king, rook, color }) =>
      isPiece(pos.board[squareIndex(king)], color, "k") &&
      isPiece(pos.board[squareIndex(rook)], color, "r"),
  )
    .map(({ right }) => right)
    .join("");
}

/**
 * Squares the side to move could capture en passant on, i.e. where the opponent's pawn could just
 * have moved two squares past and one of our pawns stands next to it.
 */
export function enPassantSquares(pos: Position): Square[] {
  const white = pos.turn === "w";
  // Ranks (0-based) of the passed square, the pawn that passed it and the square it came from.
  const [passed, pawn, origin] = white ? [5, 4, 6] : [2, 3, 1];
  const them = white ? "b" : "w";
  const squares: Square[] = [];
  for (let file = 0; file < 8; file++) {
    const at = (rank: number, f = file) => (f < 0 || f > 7 ? undefined : pos.board[rank * 8 + f]);
    if (at(passed) || at(origin) || !isPiece(at(pawn), them, "p")) continue;
    if (isPiece(at(pawn, file - 1), pos.turn, "p") || isPiece(at(pawn, file + 1), pos.turn, "p")) {
      squares.push(squareName(passed * 8 + file));
    }
  }
  return squares;
}

/** `pos` with castling rights and en passant squares that no longer fit the board dropped. */
export function tidyPosition(pos: Position): Position {
  const possible = possibleCastling(pos);
  const castling = [...pos.castling].filter((right) => possible.includes(right)).join("");
  const ep =
    pos.epSquare !== undefined && enPassantSquares(pos).includes(squareName(pos.epSquare))
      ? pos.epSquare
      : undefined;
  return { ...pos, castling, epSquare: ep };
}
