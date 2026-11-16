export type Color = "w" | "b";
export type PieceType = "k" | "q" | "r" | "b" | "n" | "p";
export type Piece = { color: Color; type: PieceType };

/** A square name such as `e4`. */
export type Square = string;

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

/** Formats a white-relative evaluation in pawns, e.g. `+0.35`. */
export function formatEval(pawns: number): string {
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

/** White's expected share (0..1) for a white-relative evaluation in pawns. */
export function whiteShare(pawns: number): number {
  // Logistic curve used by lichess for its eval bar.
  return 1 / (1 + Math.exp(-0.368208 * pawns));
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
