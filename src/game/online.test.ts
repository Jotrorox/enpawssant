import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { START_FEN } from "../chess/board";
import type { GameFull, GameState, GameStreamEvent } from "../chess/lichessPlay";
import { header } from "../chess/pgn";
import { mainline } from "../chess/review";
import { createOnlineGame, syncMainline } from "./online";
import { createGameSession } from "./session";

/** The open game stream's listener, so tests can play Lichess. */
let emit: ((event: GameStreamEvent) => void) | undefined;
let closeStream: ((closedByLichess: boolean) => void) | undefined;
const sentMoves: string[] = [];
let streamsOpened = 0;
let rejectMoves = false;

vi.mock("../chess/lichess", () => ({ markSignedOut: () => {} }));
vi.mock("../chess/lichessPlay", async (original) => ({
  ...(await original<typeof import("../chess/lichessPlay")>()),
  streamGame: (_id: string, onEvent: (event: GameStreamEvent) => void) => {
    emit = onEvent;
    streamsOpened += 1;
    return {
      done: new Promise<boolean>((resolve) => {
        closeStream = resolve;
      }),
      stop: () => closeStream?.(false),
    };
  },
  playMove: async (_id: string, uci: string) => {
    if (rejectMoves) throw { kind: "failed", message: "Not your turn, or game already over" };
    sentMoves.push(uci);
  },
  chatHistory: async () => [],
  gameAction: async () => {},
}));

const state = (moves: string, extra: Partial<GameState> = {}): GameState => ({
  type: "gameState",
  moves,
  wtime: 600_000,
  btime: 600_000,
  winc: 5000,
  binc: 5000,
  status: "started",
  ...extra,
});

const full = (moves = "", extra: Partial<GameFull> = {}): GameFull => ({
  type: "gameFull",
  id: "abcd1234",
  variant: { key: "standard", name: "Standard" },
  speed: "rapid",
  perf: { name: "Rapid" },
  rated: true,
  createdAt: Date.UTC(2026, 10, 17, 12),
  white: { id: "mochi", name: "Mochi", rating: 1500 },
  black: { id: "whiskers", name: "Whiskers", rating: 1620, title: "CM" },
  initialFen: "startpos",
  clock: { initial: 600_000, increment: 5000 },
  state: state(moves),
  ...extra,
});

function setup(username = "Mochi") {
  const session = createGameSession({ headers: [], startFen: START_FEN, moves: [] });
  const game = createOnlineGame(session, "abcd1234", { username: () => username });
  const moves = () =>
    mainline(session.tree).flatMap((id) => session.tree.nodes[id].move?.uci ?? []);
  return { session, game, moves };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "performance"] });
  emit = undefined;
  streamsOpened = 0;
  sentMoves.length = 0;
  rejectMoves = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncMainline", () => {
  const session = () => createGameSession({ headers: [], startFen: START_FEN, moves: [] });
  const line = (s: ReturnType<typeof session>) =>
    mainline(s.tree).flatMap((id) => s.tree.nodes[id].move?.uci ?? []);

  test("plays new moves and undoes takebacks", () => {
    const s = session();
    syncMainline(s, ["e2e4", "e7e5", "g1f3"]);
    expect(line(s)).toEqual(["e2e4", "e7e5", "g1f3"]);
    syncMainline(s, ["e2e4"]);
    expect(line(s)).toEqual(["e2e4"]);
    syncMainline(s, ["e2e4", "c7c5"]);
    expect(line(s)).toEqual(["e2e4", "c7c5"]);
  });

  test("keeps a move Lichess hasn't confirmed yet", () => {
    const s = session();
    syncMainline(s, ["e2e4", "e7e5"]);
    s.playFrom(mainline(s.tree)[2], { from: "g1", to: "f3" });
    syncMainline(s, ["e2e4", "e7e5"], "g1f3");
    expect(line(s)).toEqual(["e2e4", "e7e5", "g1f3"]);
    syncMainline(s, ["e2e4", "e7e5"]);
    expect(line(s)).toEqual(["e2e4", "e7e5"]);
  });

  test("reports a move it can't play", () => {
    const s = session();
    expect(syncMainline(s, ["e2e4", "e2e4"])).toBe("e2e4");
    expect(line(s)).toEqual(["e2e4"]);
  });
});

describe("createOnlineGame", () => {
  test("follows the game, its players and clocks", async () => {
    const { session, game, moves } = setup();
    expect(game.playing()).toBe(true);
    expect(game.connection()).toBe("connecting");
    emit?.(full("e2e4 e7e5"));
    await settle();
    expect(game.connection()).toBe("live");
    expect(game.color()).toBe("w");
    expect(moves()).toEqual(["e2e4", "e7e5"]);
    expect(header({ headers: session.headers() }, "Black")).toBe("CM Whiskers");
    expect(header({ headers: session.headers() }, "TimeControl")).toBe("600+5");
    expect(game.opponentName()).toBe("CM Whiskers");
    expect(game.clockRunning()).toBe("w");
    vi.advanceTimersByTime(1000);
    expect(game.timeLeft("w")).toBe(599_000);
    expect(game.timeLeft("b")).toBe(600_000);
  });

  test("waits to take moves until the user's side is known", async () => {
    const { game } = setup("");
    emit?.(full());
    await settle();
    expect(game.turn()).toBe("w");
    expect(game.canMove()).toBe(false);
  });

  test("tells the user's side from the players", async () => {
    const { game } = setup("WHISKERS");
    emit?.(full());
    await settle();
    expect(game.color()).toBe("b");
    expect(game.canMove()).toBe(false);
  });

  test("starts the clocks once both players have moved", async () => {
    const { game } = setup();
    emit?.(full("e2e4"));
    await settle();
    expect(game.clockRunning()).toBeUndefined();
    expect(game.canAbort()).toBe(true);
  });

  test("shows the user's move at once and sends it", async () => {
    const { game, moves } = setup();
    emit?.(full("e2e4 e7e5"));
    await settle();
    game.move({ from: "g1", to: "f3" });
    expect(moves()).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(game.confirming()).toBe(true);
    expect(game.clockRunning()).toBe("b");
    // A state from before the move doesn't undo it.
    emit?.(state("e2e4 e7e5"));
    expect(moves()).toEqual(["e2e4", "e7e5", "g1f3"]);
    await settle();
    expect(sentMoves).toEqual(["g1f3"]);
    emit?.(state("e2e4 e7e5 g1f3"));
    expect(game.confirming()).toBe(false);
    expect(game.canMove()).toBe(false);
  });

  test("plays a premove as soon as the opponent's move arrives", async () => {
    const { game, moves } = setup();
    emit?.(full("e2e4 e7e5"));
    await settle();
    game.move({ from: "g1", to: "f3" });
    // Still waiting for Lichess to confirm, and already queueing the next move.
    game.setPremove({ from: "f1", to: "c4" });
    emit?.(state("e2e4 e7e5 g1f3"));
    expect(game.premove()).toEqual({ from: "f1", to: "c4" });
    emit?.(state("e2e4 e7e5 g1f3 b8c6"));
    expect(moves()).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]);
    expect(game.premove()).toBeUndefined();
    await settle();
    expect(sentMoves).toEqual(["g1f3", "f1c4"]);
  });

  test("takes a refused move back", async () => {
    const { game, moves } = setup();
    emit?.(full("e2e4 e7e5"));
    await settle();
    rejectMoves = true;
    game.move({ from: "g1", to: "f3" });
    await settle();
    expect(moves()).toEqual(["e2e4", "e7e5"]);
    expect(game.error()).toBe("Not your turn, or game already over");
    expect(game.canMove()).toBe(true);
  });

  test("ends with Lichess's result and stops reconnecting", async () => {
    const { session, game } = setup();
    emit?.(full("e2e4 e7e5"));
    await settle();
    emit?.(state("e2e4 e7e5", { status: "resign", winner: "white" }));
    closeStream?.(true);
    await settle();
    expect(game.outcome()).toEqual({ result: "1-0", termination: "resignation" });
    expect(game.playing()).toBe(false);
    expect(game.connection()).toBe("closed");
    expect(header({ headers: session.headers() }, "Result")).toBe("1-0");
  });

  test("reconnects when the stream drops during the game", async () => {
    const { game } = setup();
    emit?.(full("e2e4"));
    await settle();
    expect(streamsOpened).toBe(1);
    closeStream?.(true);
    await settle();
    expect(game.connection()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(streamsOpened).toBe(2);
    emit?.(full("e2e4 e7e5"));
    expect(game.connection()).toBe("live");
  });

  test("shows offers and the opponent leaving", async () => {
    const { game } = setup();
    emit?.(full("e2e4 e7e5", { state: state("e2e4 e7e5", { bdraw: true }) }));
    await settle();
    expect(game.theirOffers()).toEqual({ draw: true, takeback: false });
    expect(game.yourOffers()).toEqual({ draw: false, takeback: false });
    emit?.({ type: "opponentGone", gone: true, claimWinInSeconds: 10 });
    expect(game.opponentGone()?.claimIn).toBe(10);
    vi.advanceTimersByTime(10_000);
    expect(game.opponentGone()?.claimIn).toBe(0);
    emit?.({ type: "opponentGone", gone: false });
    expect(game.opponentGone()).toBeUndefined();
  });

  test("starts from the game's own position", async () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    const { session } = setup();
    emit?.(full("", { initialFen: fen }));
    await settle();
    expect(session.tree.nodes[session.tree.rootId].fen).toBe(fen);
  });
});
