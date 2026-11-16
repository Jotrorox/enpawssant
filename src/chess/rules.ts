// Standard chess rules: legal move generation, making moves and SAN. Squares are indexed 0..63 with
// a1 = 0, h1 = 7 and h8 = 63, so `index & 7` is the file and `index >> 3` the rank.

import {
  type Color,
  FILES,
  type Piece,
  type PieceType,
  parsePlacement,
  type Square,
} from "./board";

export type Position = {
  board: (Piece | undefined)[];
  turn: Color;
  /** Remaining castling rights as a subset of `KQkq` (empty when none are left). */
  castling: string;
  epSquare?: number;
  halfmove: number;
  fullmove: number;
};

/** A move as the user makes it on the board. */
export type MoveInput = { from: Square; to: Square; promotion?: PieceType };

/** A move in UCI notation, such as `e2e4` or `e7e8q`, as board input. */
export function parseUciMove(uci: string): MoveInput {
  const promotion = uci[4] as PieceType | undefined;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: promotion || undefined };
}

type Move = {
  from: number;
  to: number;
  promotion?: PieceType;
  castle?: boolean;
  enPassant?: boolean;
};

const PROMOTIONS: PieceType[] = ["q", "r", "b", "n"];
const KNIGHT_STEPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const KING_STEPS = [...ROOK_DIRS, ...BISHOP_DIRS];

export const squareIndex = (square: Square) =>
  square.charCodeAt(0) - 97 + (Number(square[1]) - 1) * 8;
export const squareName = (index: number): Square => `${FILES[index & 7]}${(index >> 3) + 1}`;

const opponent = (color: Color): Color => (color === "w" ? "b" : "w");

/** The square `df` files and `dr` ranks away, or `undefined` when that is off the board. */
function step(square: number, df: number, dr: number): number | undefined {
  const file = (square & 7) + df;
  const rank = (square >> 3) + dr;
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : undefined;
}

export function parseFen(fen: string): Position {
  const [placement = "", turn = "w", castling = "-", ep = "-", halfmove, fullmove] = fen
    .trim()
    .split(/\s+/);
  const board: (Piece | undefined)[] = new Array(64).fill(undefined);
  for (const [square, piece] of parsePlacement(placement)) board[squareIndex(square)] = piece;
  return {
    board,
    turn: turn === "b" ? "b" : "w",
    castling: castling.replace(/[^KQkq]/g, ""),
    epSquare: /^[a-h][36]$/.test(ep) ? squareIndex(ep) : undefined,
    halfmove: Number(halfmove) || 0,
    fullmove: Number(fullmove) || 1,
  };
}

export function toFen(pos: Position): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pos.board[rank * 8 + file];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    rows.push(empty ? row + empty : row);
  }
  const ep = pos.epSquare === undefined ? "-" : squareName(pos.epSquare);
  return `${rows.join("/")} ${pos.turn} ${pos.castling || "-"} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/** Whether any piece of `by` attacks `square`. */
function isAttacked(board: Position["board"], square: number, by: Color): boolean {
  const is = (index: number | undefined, ...types: PieceType[]) => {
    if (index === undefined) return false;
    const piece = board[index];
    return piece !== undefined && piece.color === by && types.includes(piece.type);
  };

  // An attacking pawn sits one rank behind the square from its own point of view.
  const pawnRank = by === "w" ? -1 : 1;
  if (is(step(square, -1, pawnRank), "p") || is(step(square, 1, pawnRank), "p")) return true;
  if (KNIGHT_STEPS.some(([df, dr]) => is(step(square, df, dr), "n"))) return true;
  if (KING_STEPS.some(([df, dr]) => is(step(square, df, dr), "k"))) return true;

  const slides = (dirs: number[][], types: PieceType[]) =>
    dirs.some(([df, dr]) => {
      let index = step(square, df, dr);
      while (index !== undefined && !board[index]) index = step(index, df, dr);
      return is(index, ...types);
    });
  return slides(ROOK_DIRS, ["r", "q"]) || slides(BISHOP_DIRS, ["b", "q"]);
}

function kingSquare(board: Position["board"], color: Color): number {
  return board.findIndex((piece) => piece?.color === color && piece.type === "k");
}

function pseudoLegalMoves(pos: Position): Move[] {
  const { board, turn } = pos;
  const enemy = opponent(turn);
  const moves: Move[] = [];
  const own = (index: number) => board[index]?.color === turn;

  const pushPawn = (from: number, to: number, extra?: Partial<Move>) => {
    const lastRank = turn === "w" ? 7 : 0;
    if (to >> 3 === lastRank) {
      for (const promotion of PROMOTIONS) moves.push({ from, to, promotion });
    } else {
      moves.push({ from, to, ...extra });
    }
  };

  const steps = (from: number, offsets: number[][]) => {
    for (const [df, dr] of offsets) {
      const to = step(from, df, dr);
      if (to !== undefined && !own(to)) moves.push({ from, to });
    }
  };

  const slides = (from: number, dirs: number[][]) => {
    for (const [df, dr] of dirs) {
      let to = step(from, df, dr);
      while (to !== undefined && !board[to]) {
        moves.push({ from, to });
        to = step(to, df, dr);
      }
      if (to !== undefined && !own(to)) moves.push({ from, to });
    }
  };

  board.forEach((piece, from) => {
    if (!piece || piece.color !== turn) return;
    switch (piece.type) {
      case "p": {
        const forward = turn === "w" ? 1 : -1;
        const one = step(from, 0, forward);
        if (one !== undefined && !board[one]) {
          pushPawn(from, one);
          const two = step(from, 0, 2 * forward);
          const startRank = turn === "w" ? 1 : 6;
          if (from >> 3 === startRank && two !== undefined && !board[two]) {
            moves.push({ from, to: two });
          }
        }
        for (const df of [-1, 1]) {
          const to = step(from, df, forward);
          if (to === undefined) continue;
          if (board[to]?.color === enemy) pushPawn(from, to);
          else if (to === pos.epSquare) moves.push({ from, to, enPassant: true });
        }
        break;
      }
      case "n":
        steps(from, KNIGHT_STEPS);
        break;
      case "b":
        slides(from, BISHOP_DIRS);
        break;
      case "r":
        slides(from, ROOK_DIRS);
        break;
      case "q":
        slides(from, KING_STEPS);
        break;
      case "k": {
        steps(from, KING_STEPS);
        const home = turn === "w" ? 4 : 60;
        if (from !== home || isAttacked(board, home, enemy)) break;
        const [kingSide, queenSide] = turn === "w" ? ["K", "Q"] : ["k", "q"];
        const rookAt = (index: number) =>
          board[index]?.color === turn && board[index]?.type === "r";
        if (
          pos.castling.includes(kingSide) &&
          rookAt(home + 3) &&
          !board[home + 1] &&
          !board[home + 2] &&
          !isAttacked(board, home + 1, enemy)
        ) {
          moves.push({ from, to: home + 2, castle: true });
        }
        if (
          pos.castling.includes(queenSide) &&
          rookAt(home - 4) &&
          !board[home - 1] &&
          !board[home - 2] &&
          !board[home - 3] &&
          !isAttacked(board, home - 1, enemy)
        ) {
          moves.push({ from, to: home - 2, castle: true });
        }
        break;
      }
    }
  });
  return moves;
}

/** The board after `move`, without updating any other state. */
function movePieces(board: Position["board"], move: Move): Position["board"] {
  const next = board.slice();
  const piece = next[move.from];
  if (!piece) return next;
  next[move.to] = move.promotion ? { color: piece.color, type: move.promotion } : piece;
  next[move.from] = undefined;
  if (move.enPassant) next[move.to + (piece.color === "w" ? -8 : 8)] = undefined;
  if (move.castle) {
    const [rookFrom, rookTo] =
      move.to > move.from ? [move.from + 3, move.from + 1] : [move.from - 4, move.from - 1];
    next[rookTo] = next[rookFrom];
    next[rookFrom] = undefined;
  }
  return next;
}

function legalMoves(pos: Position): Move[] {
  const enemy = opponent(pos.turn);
  return pseudoLegalMoves(pos).filter((move) => {
    const board = movePieces(pos.board, move);
    const king = kingSquare(board, pos.turn);
    return king < 0 || !isAttacked(board, king, enemy);
  });
}

function playMove(pos: Position, move: Move): Position {
  const piece = pos.board[move.from];
  const board = movePieces(pos.board, move);
  const capture = pos.board[move.to] !== undefined || move.enPassant === true;

  let castling = pos.castling;
  if (piece?.type === "k") castling = castling.replace(pos.turn === "w" ? /[KQ]/g : /[kq]/g, "");
  const cornerRights: Record<number, string> = { 0: "Q", 7: "K", 56: "q", 63: "k" };
  for (const square of [move.from, move.to]) {
    const right = cornerRights[square];
    if (right) castling = castling.replace(right, "");
  }

  const next: Position = {
    board,
    turn: opponent(pos.turn),
    castling,
    epSquare:
      piece?.type === "p" && Math.abs(move.to - move.from) === 16
        ? (move.from + move.to) / 2
        : undefined,
    halfmove: piece?.type === "p" || capture ? 0 : pos.halfmove + 1,
    fullmove: pos.turn === "b" ? pos.fullmove + 1 : pos.fullmove,
  };
  // Only record an en passant square when the capture is actually possible.
  if (next.epSquare !== undefined && !legalMoves(next).some((m) => m.enPassant)) {
    next.epSquare = undefined;
  }
  return next;
}

export function hasLegalMoves(pos: Position): boolean {
  return legalMoves(pos).length > 0;
}

export function inCheck(pos: Position): boolean {
  const king = kingSquare(pos.board, pos.turn);
  return king >= 0 && isAttacked(pos.board, king, opponent(pos.turn));
}

/** The king's square when the side to move is in check. */
export function checkSquare(pos: Position): Square | undefined {
  return inCheck(pos) ? squareName(kingSquare(pos.board, pos.turn)) : undefined;
}

/** Legal destination squares for each square holding a movable piece. */
export function legalDests(pos: Position): Map<Square, Square[]> {
  const dests = new Map<Square, Square[]>();
  for (const move of legalMoves(pos)) {
    const from = squareName(move.from);
    const to = squareName(move.to);
    const list = dests.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    dests.set(from, list);
  }
  return dests;
}

export function isPromotion(pos: Position, from: Square, to: Square): boolean {
  const piece = pos.board[squareIndex(from)];
  return piece?.type === "p" && (to[1] === "8" || to[1] === "1");
}

function findMove(pos: Position, input: MoveInput): Move | undefined {
  const from = squareIndex(input.from);
  const to = squareIndex(input.to);
  return legalMoves(pos).find(
    (move) =>
      move.from === from &&
      move.to === to &&
      (move.promotion === undefined || move.promotion === (input.promotion ?? "q")),
  );
}

function toSan(pos: Position, move: Move): string {
  const piece = pos.board[move.from];
  if (!piece) return "";
  let san: string;
  if (move.castle) {
    san = move.to > move.from ? "O-O" : "O-O-O";
  } else {
    const capture = pos.board[move.to] !== undefined || move.enPassant === true;
    const target = squareName(move.to);
    if (piece.type === "p") {
      san = `${capture ? `${FILES[move.from & 7]}x` : ""}${target}`;
      if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
    } else {
      const rivals = legalMoves(pos).filter(
        (m) => m.to === move.to && m.from !== move.from && pos.board[m.from]?.type === piece.type,
      );
      let disambiguation = "";
      if (rivals.length > 0) {
        const fromName = squareName(move.from);
        if (!rivals.some((m) => (m.from & 7) === (move.from & 7))) disambiguation = fromName[0];
        else if (!rivals.some((m) => m.from >> 3 === move.from >> 3)) disambiguation = fromName[1];
        else disambiguation = fromName;
      }
      san = `${piece.type.toUpperCase()}${disambiguation}${capture ? "x" : ""}${target}`;
    }
  }
  const after = playMove(pos, move);
  if (inCheck(after)) san += legalMoves(after).length === 0 ? "#" : "+";
  return san;
}

/**
 * Plays a move on a FEN, returning its SAN, UCI and the resulting FEN, or `undefined` if illegal.
 */
export function makeMove(
  fen: string,
  input: MoveInput,
): { san: string; uci: string; fen: string } | undefined {
  const pos = parseFen(fen);
  const move = findMove(pos, input);
  if (!move) return undefined;
  const uci = `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
  return { san: toSan(pos, move), uci, fen: toFen(playMove(pos, move)) };
}

/** Number of leaf nodes `depth` plies deep, for testing move generation. */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  return moves.reduce((total, move) => total + perft(playMove(pos, move), depth - 1), 0);
}
