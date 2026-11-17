import { describe, expect, it } from "vitest";
import {
  hasNag,
  OBSERVATION_NAGS,
  otherNagSymbols,
  POSITION_NAGS,
  toggleNagChoice,
  toggleQualityNag,
} from "./nag";

const choice = (list: typeof POSITION_NAGS, symbol: string) => {
  const found = list.find((c) => c.symbol === symbol);
  if (!found) throw new Error(`no choice ${symbol}`);
  return found;
};

describe("NAGs", () => {
  it("keeps one position assessment", () => {
    const better = choice(POSITION_NAGS, "±");
    const unclear = choice(POSITION_NAGS, "∞");
    expect(toggleNagChoice([1], better, "w")).toEqual([1, 16]);
    expect(toggleNagChoice([1, 16], unclear, "w")).toEqual([1, 13]);
    expect(toggleNagChoice([1, 13], unclear, "w")).toEqual([1]);
  });

  it("uses the mover's code for side-specific remarks", () => {
    const initiative = choice(OBSERVATION_NAGS, "↑");
    expect(toggleNagChoice([], initiative, "w")).toEqual([36]);
    expect(toggleNagChoice([], initiative, "b")).toEqual([37]);
    // Either code counts, and toggling removes both.
    expect(hasNag([37], initiative)).toBe(true);
    expect(toggleNagChoice([37], initiative, "w")).toEqual([]);
  });

  it("combines remarks and sorts quality, assessment, remarks", () => {
    const novelty = choice(OBSERVATION_NAGS, "N");
    const winning = choice(POSITION_NAGS, "+−");
    const nags = toggleNagChoice(toggleNagChoice([], novelty, "w"), winning, "w");
    expect(nags).toEqual([18, 146]);
    expect(toggleQualityNag(nags, "!")).toEqual([1, 18, 146]);
    expect(otherNagSymbols([146, 18, 1])).toBe("+−N");
  });

  it("shows standard symbols", () => {
    expect(otherNagSymbols([36, 41, 33, 11])).toBe("=↑→⟳");
  });
});
