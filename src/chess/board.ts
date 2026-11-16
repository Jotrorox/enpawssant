export type Color = "w" | "b";
export type PieceType = "k" | "q" | "r" | "b" | "n" | "p";
export type Piece = { color: Color; type: PieceType };

/** A square name such as `e4`. */
export type Square = string;

/** An engine suggestion drawn on the board; `strength` (0..1) sets its weight. */
export type Arrow = { from: Square; to: Square; strength: number };

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

/** Placement of a FEN as a map from square name to piece. */
export function parsePlacement(fen: string): Map<Square, Piece> {
  const pieces = new Map<Square, Piece>();
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, rowIndex) => {
    const rank = 8 - rowIndex;
    let file = 0;
    for (const char of row) {
      const empty = Number(char);
      if (empty) {
        file += empty;
        continue;
      }
      const lower = char.toLowerCase() as PieceType;
      pieces.set(`${FILES[file]}${rank}`, { color: char === lower ? "b" : "w", type: lower });
      file += 1;
    }
  });
  return pieces;
}

/** Zero-based file and rank indices of a square (`a1` is `[0, 0]`). */
export function squareIndices(square: Square): [file: number, rank: number] {
  return [square.charCodeAt(0) - 97, Number(square[1]) - 1];
}

/** Top-left grid cell (column, row) of a square for the given board orientation. */
export function squareToCell(square: Square, orientation: Color): [x: number, y: number] {
  const [file, rank] = squareIndices(square);
  return orientation === "w" ? [file, 7 - rank] : [7 - file, rank];
}

/** Squares in display order (top-left to bottom-right) for the given orientation. */
export function displaySquares(orientation: Color): Square[] {
  const squares: Square[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const file = orientation === "w" ? x : 7 - x;
      const rank = orientation === "w" ? 8 - y : y + 1;
      squares.push(`${FILES[file]}${rank}`);
    }
  }
  return squares;
}

export function isLightSquare(square: Square): boolean {
  const [file, rank] = squareIndices(square);
  return (file + rank) % 2 === 1;
}

/** The side to move in a FEN. */
export function fenTurn(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

/** Index of the next move to be played in a FEN's position (0 is White's first move). */
export function fenPlyIndex(fen: string): number {
  const fullmove = Number(fen.split(" ")[5]) || 1;
  return (fullmove - 1) * 2 + (fenTurn(fen) === "b" ? 1 : 0);
}

/**
 * Move number prefix for the move made at `plyIndex` (0 is White's first move): `5.` for White,
 * `5...` for Black when `forceBlack` is set (e.g. at the start of a line), otherwise nothing.
 */
export function moveNumberPrefix(plyIndex: number, forceBlack = false): string | undefined {
  const number = Math.floor(plyIndex / 2) + 1;
  if (plyIndex % 2 === 0) return `${number}.`;
  return forceBlack ? `${number}...` : undefined;
}

/** Square at a grid cell (column, row) for the given board orientation. */
export function cellToSquare(x: number, y: number, orientation: Color): Square {
  return orientation === "w" ? `${FILES[x]}${8 - y}` : `${FILES[7 - x]}${y + 1}`;
}
