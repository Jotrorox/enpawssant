import { describe, expect, test } from "vitest";
import {
  applyAccountEvent,
  type Challenge,
  challengeDirection,
  clockSpeed,
  type GameInfo,
  gameMoves,
  lichessOutcome,
  playerName,
  timeControlName,
  userColor,
} from "./lichessPlay";

const challenge = (id: string, challenger = "whiskers"): Challenge => ({
  id,
  url: `https://lichess.org/${id}`,
  status: "created",
  challenger: { id: challenger, name: challenger },
  destUser: { id: "mochi", name: "Mochi" },
  variant: { key: "standard", name: "Standard" },
  rated: false,
  speed: "rapid",
  timeControl: { type: "clock", limit: 600, increment: 5 },
  color: "random",
});

const game = (gameId: string): GameInfo => ({
  gameId,
  color: "white",
  fen: "",
  isMyTurn: true,
  opponent: { username: "Whiskers" },
});

describe("lichessOutcome", () => {
  test("maps Lichess statuses to results", () => {
    expect(lichessOutcome({ status: "started" })).toBeUndefined();
    expect(lichessOutcome({ status: "mate", winner: "black" })).toEqual({
      result: "0-1",
      termination: "checkmate",
    });
    expect(lichessOutcome({ status: "outoftime", winner: "white" })?.termination).toBe("timeout");
    expect(lichessOutcome({ status: "draw" })).toEqual({ result: "1/2-1/2", termination: "draw" });
    expect(lichessOutcome({ status: "timeout", winner: "white" })?.termination).toBe("abandonment");
    expect(lichessOutcome({ status: "aborted" })).toEqual({ result: "*", termination: "aborted" });
    expect(lichessOutcome({ status: "noStart", winner: "white" })?.result).toBe("*");
  });
});

test("reads moves, players and sides", () => {
  expect(gameMoves({ moves: "" })).toEqual([]);
  expect(gameMoves({ moves: "e2e4 e7e5" })).toEqual(["e2e4", "e7e5"]);
  expect(playerName({ aiLevel: 4 })).toBe("Lichess AI level 4");
  expect(playerName({ id: "whiskers", name: "Whiskers", title: "FM" })).toBe("FM Whiskers");
  const players = { white: { id: "mochi" }, black: { id: "whiskers" } };
  expect(userColor(players, "Whiskers")).toBe("b");
  expect(userColor(players, "someone")).toBeUndefined();
});

test("names time controls and speeds", () => {
  expect(timeControlName({ type: "clock", limitSeconds: 600, incrementSeconds: 5 })).toBe("10+5");
  expect(timeControlName({ type: "clock", limit: 30, increment: 0 })).toBe("½+0");
  expect(timeControlName({ type: "correspondence", daysPerTurn: 1 })).toBe("1 day");
  expect(timeControlName({ type: "correspondence", days: 3 })).toBe("3 days");
  expect(timeControlName({ type: "unlimited" })).toBe("Unlimited");
  expect(clockSpeed(180, 2)).toBe("blitz");
  expect(clockSpeed(600, 0)).toBe("rapid");
  expect(clockSpeed(600, 5)).toBe("rapid");
  expect(clockSpeed(1800, 0)).toBe("classical");
});

describe("account events", () => {
  test("keep the lists of challenges and games", () => {
    let lists = { challenges: [] as Challenge[], games: [] as GameInfo[] };
    lists = applyAccountEvent(lists, { type: "challenge", challenge: challenge("c1") });
    lists = applyAccountEvent(lists, { type: "challenge", challenge: challenge("c2") });
    lists = applyAccountEvent(lists, { type: "challenge", challenge: challenge("c1") });
    expect(lists.challenges.map((c) => c.id)).toEqual(["c2", "c1"]);
    lists = applyAccountEvent(lists, { type: "challengeDeclined", challenge: challenge("c2") });
    expect(lists.challenges.map((c) => c.id)).toEqual(["c1"]);
    lists = applyAccountEvent(lists, { type: "gameStart", game: game("g1") });
    lists = applyAccountEvent(lists, { type: "gameStart", game: game("g1") });
    expect(lists.games).toHaveLength(1);
    lists = applyAccountEvent(lists, { type: "gameFinish", game: game("g1") });
    expect(lists.games).toHaveLength(0);
  });

  test("tell incoming from outgoing challenges", () => {
    expect(challengeDirection(challenge("c1"), "Mochi")).toBe("in");
    expect(challengeDirection(challenge("c1", "mochi"), "Mochi")).toBe("out");
    expect(challengeDirection({ ...challenge("c1"), direction: "out" }, "Mochi")).toBe("out");
  });
});
