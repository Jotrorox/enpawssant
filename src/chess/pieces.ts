import { type PieceSet, settings } from "../settings";
import type { Piece, PieceType } from "./board";

const URLS = import.meta.glob<string>("../assets/pieces/*/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

/** URL of the SVG image for a piece, in the chosen piece set unless `set` is given. */
export function pieceUrl(piece: Piece, set: PieceSet = settings.pieceSet): string {
  return URLS[`../assets/pieces/${set}/${piece.color}${piece.type.toUpperCase()}.svg`];
}

export const PIECE_NAMES: Record<PieceType, string> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

export function pieceLabel(piece: Piece): string {
  return `${piece.color === "w" ? "White" : "Black"} ${PIECE_NAMES[piece.type]}`;
}
