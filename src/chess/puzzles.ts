// Puzzles ("Purrzles"): frontend side of `src-tauri/src/puzzles.rs`, and the rules for playing one.
//
// A Lichess puzzle starts one move early: the first move is the opponent's, played automatically,
// and the solver plays every second move after it. The last move may be any checkmate, since
// mating puzzles often have more than one.
//
// Puzzles from the user's own blunders (`src-tauri/src/blunders.rs`) work the same way: the
// opponent's move before the blunder comes first, then the move the user missed.

import { Channel, invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import { type Color, fenPlyIndex, fenTurn } from "./board";
import type { PgnGame, PgnMove } from "./pgn";
import { hasLegalMoves, inCheck, makeMove, parseFen } from "./rules";

export type PuzzleData = {
  id: string;
  /** The position before the opponent's first move. */
  fen: string;
  /** UCI moves, starting with the opponent's. */
  moves: string[];
  rating: number;
  popularity: number;
  plays: number;
  themes: string[];
  gameUrl: string;
  /** For puzzles from the user's own games: where it comes from. */
  origin?: PuzzleOrigin;
};

/** The game a puzzle from the user's blunders comes from. */
export type PuzzleOrigin = {
  /** The game's fingerprint in the game database. */
  game: string;
  /** Moves played in the game before the blunder. */
  ply: number;
  /** The move played in the game, in SAN. */
  played: string;
  /** Winning chances the move gave away, in percentage points. */
  loss: number;
  white: string;
  black: string;
  date: string;
  event: string;
};

export type Mode = "rated" | "streak" | "mine";

export type Profile = {
  rating: number;
  rated: number;
  solved: number;
  failed: number;
  solveStreak: number;
  bestSolveStreak: number;
  bestRun: number;
};

export type Attempt = {
  puzzleId: string;
  at: number;
  mode: Mode;
  solved: boolean;
  ratingAfter: number;
};

export type PuzzleStatus = {
  count: number;
  source: "starter" | "lichess";
  profile: Profile;
  /** Newest first. */
  history: Attempt[];
  own: OwnStatus;
};

/** The puzzles from the user's own blunders. */
export type OwnStatus = {
  count: number;
  /** Never tried yet. */
  fresh: number;
  /** Missed the last time they were tried. */
  missed: number;
  /** Games searched for blunders so far. */
  scannedGames: number;
};

export type ScanProgress = {
  gamesDone: number;
  gamesTotal: number;
  positionsDone: number;
  positionsTotal: number;
  found: number;
  game: string;
};

export type ScanSummary = {
  scanned: number;
  found: number;
  cancelled: boolean;
  /** The user's games still waiting to be searched. */
  remaining: number;
};

export type RecordResult = { profile: Profile; ratingChange: number | null };

export type DownloadProgress = {
  phase: "download" | "import";
  bytes: number;
  total: number | null;
  imported: number;
};

export const puzzleStatus = () => invoke<PuzzleStatus>("puzzles_status");

export const nextPuzzle = (request: { target?: number; theme?: string; exclude?: string[] }) =>
  invoke<PuzzleData | null>("puzzles_next", { request });

/** The next puzzle from the user's blunders, or `null` when there are none yet. */
export const nextOwnPuzzle = (exclude: string[]) =>
  invoke<PuzzleData | null>("puzzles_next_own", { exclude });

/** Forgets the puzzles from the user's games and which games were searched. */
export const clearOwnPuzzles = () => invoke<PuzzleStatus>("puzzles_clear_own");

/** The blunder search that is running, if any, so it survives leaving the section. */
const scan = createRoot(() => createSignal<ScanProgress | "starting">());
export const blunderScan = scan[0];

/** Searches the user's games for blunders to make puzzles from. */
export async function findBlunders(): Promise<ScanSummary> {
  const channel = new Channel<ScanProgress>();
  channel.onmessage = (progress) => scan[1](progress);
  scan[1]("starting");
  try {
    return await invoke<ScanSummary>("puzzles_find_blunders", { onProgress: channel });
  } finally {
    scan[1](undefined);
  }
}

export const cancelBlunderSearch = () => invoke<void>("puzzles_cancel_blunders");

export const recordPuzzle = (id: string, mode: Mode, solved: boolean) =>
  invoke<RecordResult>("puzzles_record", { id, mode, solved });

export const finishRun = (length: number) => invoke<Profile>("puzzles_finish_run", { length });

export const resetPuzzleProgress = () => invoke<PuzzleStatus>("puzzles_reset_progress");

/** Downloads and imports the full Lichess puzzle database; `null` when cancelled. */
export function downloadPuzzles(onProgress: (progress: DownloadProgress) => void) {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;
  return invoke<number | null>("puzzles_download", { onProgress: channel });
}

export const cancelPuzzleDownload = () => invoke<void>("puzzles_cancel_download");

/** The side the solver plays: the side not making the first move. */
export function solverSide(puzzle: PuzzleData): Color {
  return fenTurn(puzzle.fen) === "w" ? "b" : "w";
}

export type MoveVerdict = "correct" | "solved" | "wrong";

/**
 * Judges the solver's move at `index` into `puzzle.moves`, given the move played and the position
 * it led to.
 */
export function judgeMove(
  puzzle: PuzzleData,
  index: number,
  played: { uci: string; fen: string },
): MoveVerdict {
  const last = index === puzzle.moves.length - 1;
  if (played.uci === puzzle.moves[index]) return last ? "solved" : "correct";
  if (last && isCheckmate(played.fen)) return "solved";
  return "wrong";
}

function isCheckmate(fen: string): boolean {
  const pos = parseFen(fen);
  return inCheck(pos) && !hasLegalMoves(pos);
}

/** Plays a UCI move on a FEN, or returns `undefined` if it is not legal there. */
export function playUci(fen: string, uci: string) {
  return makeMove(fen, {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: (uci[4] as "q" | "r" | "b" | "n" | undefined) || undefined,
  });
}

/**
 * The move the user played in the game instead of the solution, with its move number, e.g.
 * `23...Qh5??`. Only for puzzles from the user's own games.
 */
export function playedMove(puzzle: PuzzleData): string | undefined {
  const origin = puzzle.origin;
  const first = puzzle.moves[0];
  if (!origin || !first) return undefined;
  const after = playUci(puzzle.fen, first);
  if (!after) return undefined;
  const ply = fenPlyIndex(after.fen);
  const number = Math.floor(ply / 2) + 1;
  return `${number}${ply % 2 === 0 ? "." : "..."}${origin.played}??`;
}

/** The opponent in the game a puzzle from the user's blunders comes from. */
export function opponentName(puzzle: PuzzleData): string | undefined {
  const origin = puzzle.origin;
  if (!origin) return undefined;
  return (solverSide(puzzle) === "w" ? origin.black : origin.white) || "your opponent";
}

/** The puzzle and its solution as a game, to explore on the board. */
export function puzzleGame(puzzle: PuzzleData): PgnGame {
  const moves: PgnMove[] = [];
  let fen = puzzle.fen;
  for (const uci of puzzle.moves) {
    const move = playUci(fen, uci);
    if (!move) break;
    moves.push(move);
    fen = move.fen;
  }
  const origin = puzzle.origin;
  if (origin) {
    return {
      headers: [
        ["Event", `Purrzle from ${origin.event || "your game"}`],
        ["Date", origin.date || "????.??.??"],
        ["White", origin.white || "?"],
        ["Black", origin.black || "?"],
        ["Annotator", `In the game: ${playedMove(puzzle) ?? origin.played}`],
      ],
      startFen: puzzle.fen,
      moves,
    };
  }
  return {
    headers: [
      ["Event", `Purrzle ${puzzle.id}`],
      ["Site", puzzle.gameUrl || "https://lichess.org/training"],
      ["Annotator", `Puzzle rating ${puzzle.rating}`],
    ],
    startFen: puzzle.fen,
    moves,
  };
}

/** The rating streak mode aims for after `solved` puzzles: easy at first, then steadily harder. */
export function streakTarget(solved: number): number {
  return Math.min(2900, 850 + 55 * solved);
}

/** Lichess theme keys offered as filters, with friendlier names. */
export const THEMES: readonly { value: string; label: string }[] = [
  { value: "", label: "Any theme" },
  { value: "mateIn1", label: "Mate in 1" },
  { value: "mateIn2", label: "Mate in 2" },
  { value: "mateIn3", label: "Mate in 3" },
  { value: "fork", label: "Fork" },
  { value: "pin", label: "Pin" },
  { value: "skewer", label: "Skewer" },
  { value: "discoveredAttack", label: "Discovered attack" },
  { value: "sacrifice", label: "Sacrifice" },
  { value: "deflection", label: "Deflection" },
  { value: "hangingPiece", label: "Hanging piece" },
  { value: "trappedPiece", label: "Trapped piece" },
  { value: "backRankMate", label: "Back-rank mate" },
  { value: "promotion", label: "Promotion" },
  { value: "quietMove", label: "Quiet move" },
  { value: "defensiveMove", label: "Defensive move" },
  { value: "endgame", label: "Endgame" },
  { value: "rookEndgame", label: "Rook endgame" },
  { value: "pawnEndgame", label: "Pawn endgame" },
  { value: "opening", label: "Opening" },
];

/** Names for themes of puzzles from the user's games that the filter doesn't offer. */
const OTHER_THEMES: Record<string, string> = {
  oneMove: "One move",
  short: "Short",
  long: "Long",
  mate: "Checkmate",
  crushing: "Crushing",
  advantage: "Advantage",
  equality: "Saves the game",
};

/** A theme key such as `discoveredAttack` as words: `Discovered attack`. */
export function themeLabel(theme: string): string {
  const known = THEMES.find((entry) => entry.value === theme);
  if (known) return known.label;
  if (OTHER_THEMES[theme]) return OTHER_THEMES[theme];
  const words = theme.replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
export const openPuzzleGame = (url: string) => invoke<void>("puzzles_open_game", { url });
