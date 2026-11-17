import { describe, expect, it } from "vitest";
import {
  judgeMove,
  opponentName,
  type PuzzleData,
  playedMove,
  playUci,
  puzzleGame,
  solverSide,
  streakTarget,
  themeLabel,
} from "./puzzles";

// From the Lichess puzzle database: Black plays Bxg3, then White wins material.
const PUZZLE: PuzzleData = {
  id: "00008",
  fen: "r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24",
  moves: ["f2g3", "e6e7", "b2b1", "b3c1", "b1c1", "h6c1"],
  rating: 1819,
  popularity: 95,
  plays: 10446,
  themes: ["crushing", "hangingPiece", "long", "middlegame"],
  gameUrl: "https://lichess.org/787zsVup/black#48",
};

/** The position before the solver's move at `index`. */
function positionAt(puzzle: PuzzleData, index: number): string {
  let fen = puzzle.fen;
  for (const uci of puzzle.moves.slice(0, index)) {
    const move = playUci(fen, uci);
    if (!move) throw new Error(`illegal ${uci}`);
    fen = move.fen;
  }
  return fen;
}

const play = (fen: string, uci: string) => {
  const move = playUci(fen, uci);
  if (!move) throw new Error(`illegal ${uci}`);
  return move;
};

describe("judgeMove", () => {
  it("accepts the solution move by move", () => {
    expect(solverSide(PUZZLE)).toBe("w");
    expect(judgeMove(PUZZLE, 1, play(positionAt(PUZZLE, 1), "e6e7"))).toBe("correct");
    expect(judgeMove(PUZZLE, 3, play(positionAt(PUZZLE, 3), "b3c1"))).toBe("correct");
    expect(judgeMove(PUZZLE, 5, play(positionAt(PUZZLE, 5), "h6c1"))).toBe("solved");
  });

  it("rejects other moves", () => {
    expect(judgeMove(PUZZLE, 1, play(positionAt(PUZZLE, 1), "h6h7"))).toBe("wrong");
  });

  it("accepts any checkmate as the last move", () => {
    // White mates with either rook; the puzzle only lists Ra8#.
    const mate: PuzzleData = {
      ...PUZZLE,
      id: "mate",
      fen: "6k1/5ppp/8/8/8/8/5PPP/R3R1K1 b - - 0 1",
      moves: ["g8h8", "a1a8"],
      themes: ["mateIn1"],
    };
    const fen = positionAt(mate, 1);
    expect(judgeMove(mate, 1, play(fen, "a1a8"))).toBe("solved");
    expect(judgeMove(mate, 1, play(fen, "e1e8"))).toBe("solved");
    expect(judgeMove(mate, 1, play(fen, "e1e7"))).toBe("wrong");
  });
});

describe("puzzleGame", () => {
  it("turns the solution into a game starting before the opponent's move", () => {
    const game = puzzleGame(PUZZLE);
    expect(game.startFen).toBe(PUZZLE.fen);
    expect(game.moves.map((move) => move.san)).toEqual([
      "Bxg3",
      "Rxe7",
      "Qb1+",
      "Nc1",
      "Qxc1+",
      "Qxc1",
    ]);
    expect(game.headers).toContainEqual(["Event", "Purrzle 00008"]);
  });
});

it("makes streaks harder with every solve, up to a limit", () => {
  expect(streakTarget(0)).toBeLessThan(streakTarget(1));
  expect(streakTarget(10)).toBeLessThan(streakTarget(20));
  expect(streakTarget(1000)).toBe(2900);
});

it("names themes", () => {
  expect(themeLabel("mateIn2")).toBe("Mate in 2");
  expect(themeLabel("discoveredAttack")).toBe("Discovered attack");
  expect(themeLabel("advancedPawn")).toBe("Advanced pawn");
  expect(themeLabel("middlegame")).toBe("Middlegame");
});

describe("puzzles from your own games", () => {
  // A made-up blunder: after Black's Bxg3, White played Qh5?? instead of Re7.
  const OWN: PuzzleData = {
    ...PUZZLE,
    id: "own-abc-48",
    moves: ["f2g3", "e6e7"],
    rating: 0,
    themes: ["crushing", "oneMove"],
    gameUrl: "",
    origin: {
      game: "ABC",
      ply: 48,
      played: "Qh5",
      loss: 31.5,
      white: "Mochi",
      black: "Tofu",
      date: "2026.05.06",
      event: "Casual",
    },
  };

  it("names the move played in the game and the opponent", () => {
    expect(playedMove(OWN)).toBe("25.Qh5??");
    expect(opponentName(OWN)).toBe("Tofu");
    expect(playedMove(PUZZLE)).toBeUndefined();
    const origin = OWN.origin as NonNullable<PuzzleData["origin"]>;
    expect(opponentName({ ...OWN, origin: { ...origin, black: "" } })).toBe("your opponent");
  });

  it("opens with the players of the game", () => {
    const game = puzzleGame(OWN);
    expect(game.headers).toContainEqual(["White", "Mochi"]);
    expect(game.headers).toContainEqual(["Annotator", "In the game: 25.Qh5??"]);
    expect(game.moves.map((m) => m.uci)).toEqual(["f2g3", "e6e7"]);
  });

  it("labels their themes", () => {
    expect(themeLabel("oneMove")).toBe("One move");
    expect(themeLabel("equality")).toBe("Saves the game");
  });
});
