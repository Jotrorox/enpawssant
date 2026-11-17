import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { START_FEN } from "../chess/board";
import type { OpponentRequest } from "../chess/engine";
import { header } from "../chess/pgn";
import { mainline } from "../chess/review";
import { createEngineGame, engineGameHeaders, type PlaySettings } from "./play";
import { createGameSession } from "./session";

/** The engine's replies, in order; each request takes the next one. */
let replies: string[] = [];
const requests: OpponentRequest[] = [];

vi.mock("../chess/engine", () => ({
  requestOpponentMove: async (request: OpponentRequest) => {
    requests.push(request);
    return replies.shift();
  },
}));

function setup(settings: PlaySettings) {
  const session = createGameSession({
    headers: engineGameHeaders(settings, "Stockfish 19", new Date(2026, 10, 17)),
    startFen: START_FEN,
    moves: [],
  });
  const game = createEngineGame(session, settings);
  const moves = () =>
    mainline(session.tree).flatMap((id) => session.tree.nodes[id].move?.uci ?? []);
  const play = (uci: string) => game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  return { session, game, moves, play };
}

/** Lets the mocked engine answer. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "performance"] });
  replies = [];
  requests.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("games against the engine", () => {
  test("headers name the players, the engine's strength and the time control", () => {
    const headers = engineGameHeaders(
      {
        color: "b",
        strength: { elo: 1500 },
        timeControl: { initialMs: 300_000, incrementMs: 3000 },
      },
      "Stockfish 19",
      new Date(2026, 10, 17),
    );
    const game = { headers };
    expect(header(game, "White")).toBe("Stockfish 19 (1500)");
    expect(header(game, "Black")).toBe("You");
    expect(header(game, "WhiteElo")).toBe("1500");
    expect(header(game, "Date")).toBe("2026.11.17");
    expect(header(game, "TimeControl")).toBe("300+3");
  });

  test("the engine answers the user's moves and mates them", async () => {
    replies = ["e7e5", "d8h4"];
    const { session, game, moves, play } = setup({ color: "w", strength: { skill: 3 } });
    expect(game.canMove()).toBe(true);
    play("f2f3");
    expect(game.canMove()).toBe(false);
    await settle();
    expect(moves()).toEqual(["f2f3", "e7e5"]);
    expect(requests[0]).toMatchObject({ moves: ["f2f3"], newGame: true, strength: { skill: 3 } });
    expect(requests[0].clock).toBeUndefined();

    play("g2g4");
    await settle();
    expect(requests[1]).toMatchObject({ moves: ["f2f3", "e7e5", "g2g4"], newGame: false });
    expect(game.outcome()).toEqual({ result: "0-1", termination: "checkmate" });
    expect(requests).toHaveLength(2);
    expect(header({ headers: session.headers() }, "Result")).toBe("0-1");
    game.dispose();
  });

  test("the engine moves first when the user plays Black, and the user can resign", async () => {
    replies = ["d2d4"];
    const control = { initialMs: 60_000, incrementMs: 1000 };
    const { session, game, moves } = setup({
      color: "b",
      strength: { elo: 2000 },
      timeControl: control,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(moves()).toEqual(["d2d4"]);
    expect(requests[0].clock).toEqual({
      whiteMs: 60_000,
      blackMs: 60_000,
      whiteIncMs: 1000,
      blackIncMs: 1000,
    });
    // White's clock ran until the engine answered, then gained the increment.
    expect(game.timeLeft("w")).toBe(61_000);
    expect(game.timeLeft("b")).toBeLessThan(60_000);
    expect(game.clockRunning()).toBe("b");

    game.resign();
    expect(game.outcome()).toEqual({ result: "1-0", termination: "resignation" });
    expect(header({ headers: session.headers() }, "Termination")).toBe("normal");
    expect(game.canMove()).toBe(false);
    game.dispose();
  });

  test("running out of time loses", async () => {
    const { session, game } = setup({
      color: "w",
      strength: { elo: 1500 },
      timeControl: { initialMs: 5000, incrementMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(5200);
    expect(game.outcome()).toEqual({ result: "0-1", termination: "timeout" });
    expect(header({ headers: session.headers() }, "Termination")).toBe("time forfeit");
    game.dispose();
  });

  test("moves only count at the end of the game", async () => {
    replies = ["e7e5"];
    const { session, game, moves, play } = setup({ color: "w", strength: { skill: 10 } });
    play("e2e4");
    await settle();
    session.first();
    expect(game.canMove()).toBe(false);
    play("d2d4");
    expect(moves()).toEqual(["e2e4", "e7e5"]);
    session.last();
    expect(game.canMove()).toBe(true);
    game.dispose();
  });

  test("engine failures pause the game until retried", async () => {
    replies = [];
    const { game, play } = setup({
      color: "w",
      strength: { skill: 10 },
      timeControl: { initialMs: 60_000, incrementMs: 0 },
    });
    play("e2e4");
    await settle();
    expect(game.error()).toBe("the engine had no move");
    expect(game.clockRunning()).toBeUndefined();

    replies = ["e7e5"];
    game.retry();
    await settle();
    expect(game.error()).toBeUndefined();
    expect(game.turn()).toBe("w");
    expect(game.clockRunning()).toBe("w");
    game.dispose();
  });

  test("deleting moves hands the clock back to the side to move", async () => {
    replies = ["e7e5"];
    const { session, game, moves, play } = setup({
      color: "w",
      strength: { skill: 10 },
      timeControl: { initialMs: 60_000, incrementMs: 0 },
    });
    play("e2e4");
    await settle();
    expect(game.clockRunning()).toBe("w");
    session.remove(mainline(session.tree)[2]);
    expect(moves()).toEqual(["e2e4"]);
    expect(game.clockRunning()).toBe("b");
    game.dispose();
  });

  test("the engine isn't asked to move once the user mates it", async () => {
    replies = ["f2f3", "g2g4"];
    const { game, play } = setup({ color: "b", strength: { skill: 0 } });
    await settle();
    play("e7e5");
    await settle();
    play("d8h4");
    await settle();
    expect(game.outcome()).toEqual({ result: "0-1", termination: "checkmate" });
    expect(requests).toHaveLength(2);
    game.dispose();
  });
});
