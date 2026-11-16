import { describe, expect, it } from "vitest";
import { positionKey, resultShares, totalGames } from "./explorer";

describe("resultShares", () => {
  it("rounds to whole percentages that add up to 100", () => {
    for (const counts of [
      { white: 1, draws: 1, black: 1 },
      { white: 820, draws: 640, black: 580 },
      { white: 5, draws: 0, black: 1 },
      { white: 1, draws: 0, black: 200 },
    ]) {
      const shares = resultShares(counts);
      expect(shares.white + shares.draw + shares.black).toBe(100);
      expect(Math.min(shares.white, shares.draw, shares.black)).toBeGreaterThanOrEqual(0);
    }
    expect(resultShares({ white: 2, draws: 1, black: 1 })).toEqual({
      white: 50,
      draw: 25,
      black: 25,
    });
  });

  it("is all zero without games", () => {
    expect(resultShares({ white: 0, draws: 0, black: 0 })).toEqual({ white: 0, draw: 0, black: 0 });
    expect(totalGames({ white: 3, draws: 2, black: 1 })).toBe(6);
  });
});

describe("positionKey", () => {
  it("ignores the move counters", () => {
    const italian = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3";
    const transposed = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 9 30";
    expect(positionKey(italian)).toBe(positionKey(transposed));
    expect(positionKey(italian)).not.toBe(positionKey(italian.replace(" b ", " w ")));
  });
});
