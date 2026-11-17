import { describe, expect, it } from "vitest";
import { colorOf, dateRange, isoDay } from "./online";

describe("date ranges", () => {
  it("covers both days completely, in local time", () => {
    const filter = dateRange("2024-03-01", "2024-03-31");
    expect(filter).toEqual({
      kind: "between",
      since: new Date(2024, 2, 1).getTime(),
      until: new Date(2024, 3, 1).getTime() - 1,
    });
  });

  it("leaves empty ends open", () => {
    expect(dateRange("", "")).toEqual({ kind: "between", since: null, until: null });
    expect(dateRange("2024-12-31", "")).toEqual({
      kind: "between",
      since: new Date(2024, 11, 31).getTime(),
      until: null,
    });
  });

  it("formats days for date inputs", () => {
    expect(isoDay(new Date(2024, 0, 5))).toBe("2024-01-05");
  });
});

describe("colorOf", () => {
  const game = {
    headers: [
      ["White", "Whiskers"],
      ["Black", "MochiTheCat"],
    ] as [string, string][],
  };

  it("finds the player's colour regardless of case", () => {
    expect(colorOf(game, "whiskers")).toBe("w");
    expect(colorOf(game, " mochithecat ")).toBe("b");
  });

  it("knows nothing about other players", () => {
    expect(colorOf(game, "Tom")).toBeUndefined();
    expect(colorOf(game, "")).toBeUndefined();
  });
});
